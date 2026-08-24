import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuotePaymentProvider } from '../../src/services/payment/QuotePaymentProvider.js';

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
}));

const { db } = await import('../../src/db.js');
const { recoverOrphanQuotePayment } = await import(
  '../../src/services/QuotePaymentRecoveryService.js'
);

const ids = {
  quote: '10000000-0000-4000-8000-000000000001',
  version: '10000000-0000-4000-8000-000000000002',
  poster: '10000000-0000-4000-8000-000000000003',
  payment: '10000000-0000-4000-8000-000000000004',
};

const input = {
  quoteId: ids.quote,
  quoteVersionId: ids.version,
  posterId: ids.poster,
  paymentIntentId: 'pi_orphan_quote_payment_123',
  reasonCode: 'UNDERWRITING_CONTAINMENT' as const,
};

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ids.payment,
    task_id: null,
    provider: 'stripe',
    provider_payment_id: input.paymentIntentId,
    amount_cents: 12_500,
    status: 'PENDING',
    poster_email: 'poster@example.com',
    lead_email: 'poster@example.com',
    ...overrides,
  };
}

function provider() {
  return {
    createPaymentIntent: vi.fn(),
    verifySucceededPayment: vi.fn(),
    recoverOrphanPayment: vi.fn(),
  } satisfies QuotePaymentProvider;
}

function querySequence(...results: Array<Record<string, unknown>>) {
  const [initial, ...transactionResults] = results;
  vi.mocked(db.query).mockResolvedValueOnce(initial as never);
  const query = vi.fn();
  for (const result of transactionResults) query.mockResolvedValueOnce(result);
  vi.mocked(db.transaction).mockImplementation(async (work) => work(query));
  return query;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('quote payment orphan recovery', () => {
  it('voids a locked pending obligation and records one immutable recovery fact', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    const query = querySequence(
      { rows: [row()], rowCount: 1 },
      { rows: [row()], rowCount: 1 },
      { rows: [{ id: ids.payment }], rowCount: 1 },
      { rows: [{ id: 'recovery-event' }], rowCount: 1 },
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toEqual({
      success: true,
      data: {
        quoteId: ids.quote,
        quoteVersionId: ids.version,
        paymentIntentId: input.paymentIntentId,
        status: 'FAILED',
        recoveryAction: 'VOIDED',
        replayed: false,
      },
    });
    expect(quoteProvider.recoverOrphanPayment).toHaveBeenCalledWith({
      ...input,
      amountCents: 12_500,
      recoveryKey: ids.payment,
    });
    expect(String(vi.mocked(db.query).mock.calls[0]?.[0])).not.toContain('FOR UPDATE');
    expect(query.mock.calls[0]?.[0]).toContain('FOR UPDATE OF qp');
    expect(query.mock.calls[1]?.[1]).toEqual(['FAILED', ids.payment, 'PENDING']);
    expect(query.mock.calls[2]?.[1]).toEqual([
      ids.payment,
      ids.poster,
      'UNDERWRITING_CONTAINMENT',
      'VOIDED',
      'PENDING',
      'FAILED',
      'canceled',
      input.paymentIntentId,
      `quote-payment-recovery:${ids.payment}:FAILED`,
    ]);
    expect(quoteProvider.recoverOrphanPayment.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(db.transaction).mock.invocationCallOrder[0]!,
    );
    const sql = [
      ...vi.mocked(db.query).mock.calls,
      ...query.mock.calls,
    ].map(([statement]) => String(statement)).join('\n');
    expect(sql).not.toMatch(/\b(?:tasks|escrows)\b/i);
  });

  it('refunds an unmaterialized succeeded obligation without creating canonical state', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'REFUNDED',
        providerStatus: 'succeeded',
        providerOperationId: 're_quote_recovery_123',
      },
    });
    const query = querySequence(
      { rows: [row({ status: 'SUCCEEDED' })], rowCount: 1 },
      { rows: [row({ status: 'SUCCEEDED' })], rowCount: 1 },
      { rows: [{ id: ids.payment }], rowCount: 1 },
      { rows: [{ id: 'recovery-event' }], rowCount: 1 },
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toMatchObject({ status: 'REFUNDED', recoveryAction: 'REFUNDED' });
    expect(query.mock.calls[1]?.[1]).toEqual(['REFUNDED', ids.payment, 'SUCCEEDED']);
    expect(query.mock.calls[2]?.[1]).toContain('re_quote_recovery_123');
  });

  it.each([
    ['FAILED', 'VOIDED'],
    ['REFUNDED', 'REFUNDED'],
  ] as const)('replays terminal %s state without a provider or write effect', async (status, action) => {
    const quoteProvider = provider();
    const query = querySequence({ rows: [row({ status })], rowCount: 1 });

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toEqual({
      success: true,
      data: expect.objectContaining({ status, recoveryAction: action, replayed: true }),
    });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it.each([
    [row({ poster_email: 'attacker@example.com' }), 'QUOTE_PAYMENT_POSTER_MISMATCH'],
    [row({ provider: 'other' }), 'QUOTE_PAYMENT_PROVIDER_MISMATCH'],
    [row({ task_id: 'task-existing' }), 'QUOTE_PAYMENT_ALREADY_MATERIALIZED'],
  ])('rejects an ineligible obligation before provider work', async (lockedRow, code) => {
    const quoteProvider = provider();
    const query = querySequence({ rows: [lockedRow], rowCount: 1 });

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({ success: false, error: { code } });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('fails a mismatched payment identity without provider or database writes', async () => {
    const quoteProvider = provider();
    const query = querySequence({ rows: [], rowCount: 0 });

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_NOT_FOUND' },
    });
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('does not advance canonical status until the provider reaches a terminal fact', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: false,
      error: { code: 'PAYMENT_REFUND_PENDING', message: 'Refund is pending' },
    });
    const query = querySequence({ rows: [row({ status: 'SUCCEEDED' })], rowCount: 1 });

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({ success: false, error: { code: 'PAYMENT_REFUND_PENDING' } });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('fails closed when the locked compare-and-set loses authority', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    const query = querySequence(
      { rows: [row()], rowCount: 1 },
      { rows: [row()], rowCount: 1 },
      { rows: [], rowCount: 0 },
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_FAILED' },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('reconciles a concurrent identical terminal recovery without another write', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    const query = querySequence(
      { rows: [row()], rowCount: 1 },
      { rows: [row({ status: 'FAILED' })], rowCount: 1 },
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: true,
      data: { status: 'FAILED', recoveryAction: 'VOIDED', replayed: true },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('rejects a conflicting terminal state after processor recovery', async () => {
    const quoteProvider = provider();
    quoteProvider.recoverOrphanPayment.mockResolvedValueOnce({
      success: true,
      data: {
        disposition: 'VOIDED',
        providerStatus: 'canceled',
        providerOperationId: input.paymentIntentId,
      },
    });
    const query = querySequence(
      { rows: [row()], rowCount: 1 },
      { rows: [row({ status: 'REFUNDED' })], rowCount: 1 },
    );

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_CONFLICT' },
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('is unavailable when the isolated payment-creation cohort is enabled', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ENGINE_API_MODE', 'test');
    vi.stubEnv('STRIPE_MODE', 'test');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_recovery_conflict');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'enabled');
    const quoteProvider = provider();

    const result = await recoverOrphanQuotePayment(input, quoteProvider);

    expect(result).toMatchObject({
      success: false,
      error: { code: 'QUOTE_PAYMENT_RECOVERY_NOT_AVAILABLE' },
    });
    expect(db.query).not.toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
    expect(quoteProvider.recoverOrphanPayment).not.toHaveBeenCalled();
  });
});
