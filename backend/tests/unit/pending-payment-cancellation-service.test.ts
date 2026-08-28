import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    transaction: vi.fn((fn: (query: typeof query) => Promise<unknown>) => fn(query)),
    cancel: vi.fn(),
    outbox: vi.fn(),
    error: vi.fn(),
  };
});

vi.mock('../../src/db', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));
vi.mock('../../src/services/StripePaymentIntentCancellationService', () => ({
  StripePaymentIntentCancellationService: { cancel: mocks.cancel },
}));
vi.mock('../../src/lib/outbox-helpers', () => ({ writeToOutbox: mocks.outbox }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.error }) },
}));

import {
  PendingPaymentCancellationService,
  type PendingPaymentCancellationInput,
} from '../../src/services/PendingPaymentCancellationService';

const INPUT: PendingPaymentCancellationInput = {
  escrowId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  reason: 'dispatch_expired_unfilled',
};

function escrow(overrides: Record<string, unknown> = {}) {
  return {
    id: INPUT.escrowId,
    state: 'PENDING',
    stripe_payment_intent_id: 'pi_live_controlled',
    stripe_refund_id: null,
    payment_intent_canceled_at: null,
    ...overrides,
  };
}

const rows = (value: unknown[] = [], rowCount = value.length) => ({ rows: value, rowCount }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.mockReset();
  mocks.transaction.mockImplementation((fn: (query: typeof mocks.query) => Promise<unknown>) => fn(mocks.query));
  mocks.outbox.mockResolvedValue({ id: 'outbox-1', idempotencyKey: `dispatch-expiry-refund:${INPUT.taskId}` });
});

describe('PendingPaymentCancellationService', () => {
  it('cancels a pending PaymentIntent and persists provider evidence', async () => {
    mocks.cancel.mockResolvedValueOnce({
      success: true,
      data: { paymentIntentId: 'pi_live_controlled', status: 'canceled', canceled: true, idempotencyReplayed: false },
    });
    mocks.query.mockResolvedValueOnce(rows([escrow()]))
      .mockResolvedValueOnce(rows([{ id: INPUT.escrowId }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await expect(PendingPaymentCancellationService.execute(INPUT)).resolves.toBeUndefined();
    expect(mocks.cancel).toHaveBeenCalledWith('pi_live_controlled');
    expect(mocks.query.mock.calls[1][0]).toContain('payment_intent_canceled_at');
    expect(mocks.query.mock.calls[2][0]).toContain("refund_state = 'NOT_REQUIRED'");
    expect(mocks.query.mock.calls[3][0]).toContain('PAYMENT_INTENT_CANCELED');
    expect(mocks.outbox).not.toHaveBeenCalled();
  });

  it('replays persisted cancellation without calling Stripe again', async () => {
    mocks.query.mockResolvedValueOnce(rows([escrow({ payment_intent_canceled_at: '2026-07-12T00:00:00.000Z' })]))
      .mockResolvedValueOnce(rows([{ id: INPUT.escrowId }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await PendingPaymentCancellationService.execute(INPUT);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(String(mocks.query.mock.calls[3][1][2])).toContain('"idempotencyReplayed":true');
  });

  it('escalates a succeeded PaymentIntent onto the idempotent refund rail', async () => {
    mocks.cancel.mockResolvedValueOnce({
      success: true,
      data: { paymentIntentId: 'pi_live_controlled', status: 'succeeded', canceled: false, idempotencyReplayed: false },
    });
    mocks.query.mockResolvedValueOnce(rows([escrow()]))
      .mockResolvedValueOnce(rows([escrow()]))
      .mockResolvedValueOnce(rows([{ id: INPUT.escrowId }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await PendingPaymentCancellationService.execute(INPUT);
    expect(mocks.outbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'escrow.refund_requested',
        idempotencyKey: `dispatch-expiry-refund:${INPUT.taskId}`,
      }),
      mocks.query,
    );
    expect(mocks.query.mock.calls[2][0]).toContain("state = 'LOCKED_DISPUTE'");
    expect(mocks.query.mock.calls[3][0]).toContain("refund_state = 'PENDING'");
  });

  it('routes a database-funded race to refund without another Stripe call', async () => {
    mocks.query.mockResolvedValueOnce(rows([escrow({ state: 'FUNDED' })]))
      .mockResolvedValueOnce(rows([escrow({ state: 'FUNDED' })]))
      .mockResolvedValueOnce(rows([{ id: INPUT.escrowId }]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());
    await PendingPaymentCancellationService.execute(INPUT);
    expect(mocks.cancel).not.toHaveBeenCalled();
    expect(mocks.outbox).toHaveBeenCalledOnce();
  });

  it('reconciles an already-refunded escrow without adding a second refund event', async () => {
    mocks.query.mockResolvedValueOnce(rows([escrow({ state: 'REFUNDED', stripe_refund_id: 're_1' })]))
      .mockResolvedValueOnce(rows([escrow({ state: 'REFUNDED', stripe_refund_id: 're_1' })]))
      .mockResolvedValueOnce(rows());
    await PendingPaymentCancellationService.execute(INPUT);
    expect(mocks.query.mock.calls[2][0]).toContain("refund_state = 'REFUNDED'");
    expect(mocks.outbox).not.toHaveBeenCalled();
  });

  it('reuses an existing dispute lock and queues the refund without another escrow transition', async () => {
    mocks.query.mockResolvedValueOnce(rows([escrow({ state: 'LOCKED_DISPUTE' })]))
      .mockResolvedValueOnce(rows([escrow({ state: 'LOCKED_DISPUTE' })]))
      .mockResolvedValueOnce(rows()).mockResolvedValueOnce(rows());

    await PendingPaymentCancellationService.execute(INPUT);

    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("SET state = 'LOCKED_DISPUTE'"))).toBe(false);
    expect(mocks.outbox).toHaveBeenCalledOnce();
  });

  it('fails loud when reconciliation loses or cannot find the escrow', async () => {
    mocks.query.mockResolvedValueOnce(rows([escrow({ state: 'FUNDED' })]))
      .mockResolvedValueOnce(rows());
    await expect(PendingPaymentCancellationService.execute(INPUT))
      .rejects.toThrow('not found during cancellation reconciliation');

    mocks.query.mockResolvedValueOnce(rows([escrow({ state: 'FUNDED' })]))
      .mockResolvedValueOnce(rows([escrow({ state: 'FUNDED' })]))
      .mockResolvedValueOnce(rows([], 0));
    await expect(PendingPaymentCancellationService.execute(INPUT))
      .rejects.toThrow('changed during cancellation-to-refund transition');
  });

  it('fails loud when the initial escrow identity does not exist', async () => {
    mocks.query.mockResolvedValueOnce(rows());
    await expect(PendingPaymentCancellationService.execute(INPUT))
      .rejects.toThrow(`Escrow ${INPUT.escrowId} not found`);
  });

  it('fails loud for missing provider identity, unsafe state, or provider failure', async () => {
    mocks.query.mockResolvedValueOnce(rows([escrow({ stripe_payment_intent_id: null })]));
    await expect(PendingPaymentCancellationService.execute(INPUT))
      .rejects.toThrow('no stripe_payment_intent_id');

    mocks.query.mockResolvedValueOnce(rows([escrow({ state: 'RELEASED' })]))
      .mockResolvedValueOnce(rows([escrow({ state: 'RELEASED' })]));
    await expect(PendingPaymentCancellationService.execute(INPUT))
      .rejects.toThrow('from RELEASED');

    mocks.query.mockResolvedValueOnce(rows([escrow()]));
    mocks.cancel.mockResolvedValueOnce({
      success: false,
      error: { code: 'STRIPE_ERROR', message: 'provider unavailable' },
    });
    await expect(PendingPaymentCancellationService.execute(INPUT))
      .rejects.toThrow('provider unavailable');
    expect(mocks.error).toHaveBeenCalled();
  });

  it('fails if provider cancellation succeeds but persistence loses the state race', async () => {
    mocks.cancel.mockResolvedValueOnce({
      success: true,
      data: { paymentIntentId: 'pi_live_controlled', status: 'canceled', canceled: true, idempotencyReplayed: false },
    });
    mocks.query.mockResolvedValueOnce(rows([escrow()])).mockResolvedValueOnce(rows([], 0));
    await expect(PendingPaymentCancellationService.execute(INPUT))
      .rejects.toThrow('changed before PaymentIntent cancellation persisted');
  });
});
