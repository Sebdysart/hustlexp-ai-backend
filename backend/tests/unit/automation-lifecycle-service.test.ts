import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, transaction, writeToOutbox } = vi.hoisted(() => {
  const queryMock = vi.fn();
  return {
    query: queryMock,
    transaction: vi.fn((fn: (q: typeof queryMock) => Promise<unknown>) => fn(queryMock)),
    writeToOutbox: vi.fn(),
  };
});

vi.mock('../../src/db', () => ({ db: { query, transaction } }));
vi.mock('../../src/lib/outbox-helpers', () => ({ writeToOutbox }));
vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  AutomationLifecycleService,
  decodeLifecycleCursor,
  encodeLifecycleCursor,
  mapBridgeTaskState,
  mapLifecycleRow,
  type RawBridgeTaskStateRow,
  type RawLifecycleRow,
} from '../../src/services/AutomationLifecycleService';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';

function row(overrides: Partial<RawLifecycleRow> = {}): RawLifecycleRow {
  return {
    id: TASK_ID,
    task_state: 'OPEN',
    progress_state: 'POSTED',
    worker_id: null,
    created_at: '2026-07-10T12:00:00.000Z',
    updated_at: '2026-07-10T12:00:00.000Z',
    dispatch_expires_at: '2099-07-10T12:30:00.000Z',
    expiration_reason: null,
    refund_state: 'NOT_REQUIRED',
    refund_blocker: null,
    started_at: null,
    completion_message_delivered_at: null,
    completion_confirmed_at: null,
    payout_ready_at: null,
    payout_ready_reason: null,
    escrow_state: 'FUNDED',
    stripe_payment_intent_id: 'pi_test',
    stripe_refund_id: null,
    reservation_state: null,
    reserved_hustler_ref: null,
    proof_state: null,
    automation_classification: 'PRODUCTION',
    ...overrides,
  };
}

function bridgeRow(overrides: Partial<RawBridgeTaskStateRow> = {}): RawBridgeTaskStateRow {
  return {
    id: TASK_ID,
    task_state: 'COMPLETED',
    progress_state: 'COMPLETED',
    worker_id: WORKER_ID,
    automation_classification: 'CONTROLLED_TEST',
    completed_at: '2026-07-20T20:36:12.000Z',
    completion_confirmed_at: '2026-07-20T20:36:12.000Z',
    payout_ready_at: '2026-07-20T20:36:12.000Z',
    task_updated_at: '2026-07-20T20:36:12.000Z',
    escrow_id: '33333333-3333-4333-8333-333333333333',
    escrow_state: 'RELEASED',
    payout_provider: 'LOCAL_CERTIFICATION_TEST',
    provider_transfer_id: 'tr_hxos_test_0123456789abcdef0123456789abcdef',
    provider_transfer_status: 'paid',
    escrow_released_at: '2026-07-20T20:38:00.000Z',
    escrow_updated_at: '2026-07-20T20:38:00.000Z',
    reservation_id: '44444444-4444-4444-8444-444444444444',
    reservation_state: 'ACTIVE',
    reserved_hustler_ref: WORKER_ID,
    reservation_updated_at: '2026-07-20T20:15:00.000Z',
    proof_id: '55555555-5555-4555-8555-555555555555',
    proof_state: 'ACCEPTED',
    proof_updated_at: '2026-07-20T20:35:00.000Z',
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe('AutomationLifecycleService E1 lifecycle read', () => {
  it('returns decomposed bridge truth for one settled controlled TEST task', async () => {
    query.mockResolvedValueOnce({ rows: [bridgeRow()], rowCount: 1 });

    const result = await AutomationLifecycleService.getBridgeTaskState(TASK_ID);

    expect(result).toMatchObject({
      success: true,
      data: {
        engineTaskId: TASK_ID,
        lifecycleState: 'SETTLED',
        taskState: 'COMPLETED',
        progressState: 'COMPLETED',
        workerId: WORKER_ID,
        environment: 'TEST',
        isTest: true,
        payoutState: 'PAID',
        escrow: {
          state: 'RELEASED',
          payoutProvider: 'LOCAL_CERTIFICATION_TEST',
          providerTransferStatus: 'paid',
        },
        proof: { state: 'ACCEPTED' },
        reservation: { state: 'ACTIVE', hustlerRef: WORKER_ID },
        sourceUpdatedAt: '2026-07-20T20:38:00.000Z',
      },
    });
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).not.toMatch(/task_location_vault|exact_location|t\.location\b/i);
  });

  it('keeps production completion distinct from provider settlement', async () => {
    const mapped = mapBridgeTaskState(bridgeRow({
      automation_classification: 'PRODUCTION',
      escrow_state: 'FUNDED',
      payout_provider: null,
      provider_transfer_id: null,
      provider_transfer_status: null,
      escrow_released_at: null,
    }));

    expect(mapped).toMatchObject({
      lifecycleState: 'PAYOUT_READY',
      environment: 'PRODUCTION',
      isTest: false,
      payoutState: 'READY',
    });
  });

  it('fails closed on missing and inconsistent bridge state', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(AutomationLifecycleService.getBridgeTaskState(TASK_ID)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });

    query.mockResolvedValueOnce({
      rows: [bridgeRow({ provider_transfer_status: 'processing' })], rowCount: 1,
    });
    await expect(AutomationLifecycleService.getBridgeTaskState(TASK_ID)).resolves.toMatchObject({
      success: false, error: { code: 'INCONSISTENT_STATE' },
    });
  });

  it('maps bridge state database failures to DB_ERROR', async () => {
    query.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(AutomationLifecycleService.getBridgeTaskState(TASK_ID)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });

  it('derives the canonical lifecycle and never exposes exact address fields', async () => {
    query.mockResolvedValueOnce({ rows: [row()], rowCount: 1 });

    const result = await AutomationLifecycleService.listTasks({ limit: 20 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tasks[0]).toMatchObject({
      engineTaskId: TASK_ID,
      lifecycleState: 'DISPATCH_READY',
      paymentState: 'FUNDED',
      automationClassification: 'PRODUCTION',
      nextAutomaticAction: 'START_HARD_DISPATCH',
    });
    expect(result.data.tasks[0]).not.toHaveProperty('location');
    expect(result.data.tasks[0]).not.toHaveProperty('exactLocation');
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).not.toMatch(/task_location_vault|exact_location|t\.location\b/i);
  });

  it('uses stable bounded cursor pagination', async () => {
    const first = row();
    const second = row({ id: '22222222-2222-4222-8222-222222222222' });
    query.mockResolvedValueOnce({ rows: [first, second], rowCount: 2 });

    const result = await AutomationLifecycleService.listTasks({ limit: 1 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.tasks).toHaveLength(1);
    expect(decodeLifecycleCursor(result.data.nextCursor!)).toEqual({
      createdAt: '2026-07-10T12:00:00.000Z',
      id: TASK_ID,
    });
    expect(query.mock.calls[0]?.[1]).toEqual([null, null, 2]);
  });

  it('rejects malformed cursors before querying', async () => {
    const result = await AutomationLifecycleService.listTasks({ limit: 20, cursor: 'not-a-cursor' });
    expect(result).toMatchObject({ success: false, error: { code: 'INVALID_CURSOR' } });
    expect(query).not.toHaveBeenCalled();
  });

  it('round-trips a valid cursor', () => {
    const cursor = { createdAt: '2026-07-10T12:00:00.000Z', id: TASK_ID };
    expect(decodeLifecycleCursor(encodeLifecycleCursor(cursor))).toEqual(cursor);
  });

  it('rejects structurally decoded cursors with invalid date or id fields', () => {
    const malformed = Buffer.from(JSON.stringify({ createdAt: 'not-a-date', id: 'bad' })).toString('base64url');
    expect(() => decodeLifecycleCursor(malformed)).toThrow('INVALID_CURSOR');
  });

  it('maps payment-pending, refund, expiry, and released payout states', () => {
    expect(mapLifecycleRow(row({ escrow_state: 'PENDING' }))).toMatchObject({
      lifecycleState: 'PAYMENT_PENDING',
    });
    expect(mapLifecycleRow(row({ refund_blocker: 'BLOCKED_PROCESSOR' }))).toMatchObject({
      blockerCode: 'BLOCKED_PROCESSOR',
    });
    expect(mapLifecycleRow(row({
      task_state: 'EXPIRED', expiration_reason: 'UNFILLED', refund_state: 'PENDING',
    }))).toMatchObject({ lifecycleState: 'EXPIRED_UNFILLED', nextAutomaticAction: 'PROCESS_REFUND' });
    expect(mapLifecycleRow(row({
      task_state: 'EXPIRED', expiration_reason: 'UNFILLED', refund_state: 'BLOCKED',
    }))).toMatchObject({ lifecycleState: 'EXPIRED_UNFILLED', nextAutomaticAction: 'RESOLVE_REFUND_BLOCKER' });
    expect(mapLifecycleRow(row({
      dispatch_expires_at: '2020-01-01T00:00:00.000Z',
    }))).toMatchObject({ blockerCode: 'DISPATCH_EXPIRY_DUE', nextAutomaticAction: 'EXPIRE_UNFILLED' });
    expect(mapLifecycleRow(row({
      task_state: 'COMPLETED', progress_state: 'COMPLETED', escrow_state: 'RELEASED',
      payout_ready_at: '2026-07-10T13:00:00.000Z',
    }))).toMatchObject({ payoutState: 'RELEASED', nextAutomaticAction: null });
  });

  it('maps lifecycle read database failures to DB_ERROR', async () => {
    query.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(AutomationLifecycleService.listTasks({ limit: 20 })).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });

  it('maps completion to PAYOUT_READY without claiming payout release', () => {
    expect(mapLifecycleRow(row({
      task_state: 'COMPLETED',
      progress_state: 'COMPLETED',
      payout_ready_at: '2026-07-10T13:00:00.000Z',
      completion_confirmed_at: '2026-07-10T12:59:00.000Z',
    }))).toMatchObject({
      lifecycleState: 'PAYOUT_READY',
      completionState: 'CONFIRMED',
      payoutState: 'READY',
      nextAutomaticAction: 'AWAIT_PAYOUT_RELEASE',
    });
  });
});

describe('AutomationLifecycleService E2 expiry/refund', () => {
  it('atomically expires an unreserved funded task and emits one refund request', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // prior request
      .mockResolvedValueOnce({ rows: [{
        id: TASK_ID,
        state: 'MATCHING',
        worker_id: null,
        dispatch_expires_at: '2026-07-10T10:00:00.000Z',
        expiration_reason: null,
        refund_state: 'NOT_REQUIRED',
        refund_blocker: null,
        active_reservation: false,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', state: 'FUNDED', stripe_payment_intent_id: 'pi-1', stripe_refund_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1' }], rowCount: 1 }) // escrow lock
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID }], rowCount: 1 }) // task expiry
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // event
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // request witness
    writeToOutbox.mockResolvedValueOnce({ id: 'outbox-1', idempotencyKey: `dispatch-expiry-refund:${TASK_ID}` });

    const result = await AutomationLifecycleService.expireUnfilled({
      engineTaskId: TASK_ID,
      idempotencyKey: `dispatch-expiry:${TASK_ID}`,
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        lifecycleState: 'EXPIRED_UNFILLED',
        refundState: 'PENDING',
        blockerCode: null,
        idempotencyReplayed: false,
      },
    });
    expect(writeToOutbox).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'escrow.refund_requested', aggregateId: 'esc-1' }),
      query
    );
  });

  it('replays a witnessed request without another refund event', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        request_hash: expect.anything(),
        task_id: TASK_ID,
        result_code: 'EXPIRED_UNFILLED',
        refund_state: 'PENDING',
        blocker_code: null,
      }], rowCount: 1 });

    const key = `dispatch-expiry:${TASK_ID}`;
    const { buildDispatchExpiryRequestHash } = await import('../../src/services/AutomationLifecycleService');
    query.mockReset();
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        request_hash: buildDispatchExpiryRequestHash({ engineTaskId: TASK_ID, idempotencyKey: key }),
        task_id: TASK_ID,
        result_code: 'EXPIRED_UNFILLED',
        refund_state: 'PENDING',
        blocker_code: null,
      }], rowCount: 1 });

    const result = await AutomationLifecycleService.expireUnfilled({ engineTaskId: TASK_ID, idempotencyKey: key });

    expect(result).toMatchObject({ success: true, data: { idempotencyReplayed: true } });
    expect(writeToOutbox).not.toHaveBeenCalled();
  });

  it('queues idempotent cancellation for a pending PaymentIntent without claiming refund', async () => {
    writeToOutbox.mockResolvedValueOnce({
      id: 'outbox-cancel-1',
      idempotencyKey: `dispatch-expiry-cancel:${TASK_ID}`,
    });
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: TASK_ID,
        state: 'OPEN',
        worker_id: null,
        dispatch_expires_at: '2026-07-10T10:00:00.000Z',
        expiration_reason: null,
        refund_state: 'NOT_REQUIRED',
        refund_blocker: null,
        active_reservation: false,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', state: 'PENDING', stripe_payment_intent_id: 'pi-1', stripe_refund_id: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await AutomationLifecycleService.expireUnfilled({
      engineTaskId: TASK_ID,
      idempotencyKey: `dispatch-expiry:${TASK_ID}`,
    });

    expect(result).toMatchObject({
      success: true,
      data: {
        refundState: 'PENDING',
        blockerCode: null,
      },
    });
    expect(writeToOutbox).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'escrow.refund_requested',
        aggregateId: 'esc-1',
        idempotencyKey: `dispatch-expiry-cancel:${TASK_ID}`,
        payload: expect.objectContaining({
          task_id: TASK_ID,
          financial_action: 'cancel_pending_payment_intent',
        }),
      }),
      query,
    );
  });

  it('reconciles provider-canceled payment evidence without queuing another financial action', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: TASK_ID,
        state: 'OPEN',
        worker_id: null,
        dispatch_expires_at: '2026-07-10T10:00:00.000Z',
        expiration_reason: null,
        refund_state: 'PENDING',
        refund_blocker: null,
        active_reservation: false,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        id: 'esc-1',
        state: 'PENDING',
        stripe_payment_intent_id: 'pi-1',
        stripe_refund_id: null,
        payment_intent_canceled_at: '2026-07-12T13:00:00.000Z',
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await AutomationLifecycleService.expireUnfilled({
      engineTaskId: TASK_ID,
      idempotencyKey: `dispatch-expiry:${TASK_ID}`,
    });

    expect(result).toMatchObject({
      success: true,
      data: { refundState: 'NOT_REQUIRED', blockerCode: null },
    });
    expect(writeToOutbox).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'no escrow',
      escrowRows: [],
      expected: { refundState: 'NOT_REQUIRED', blockerCode: null },
    },
    {
      name: 'pending escrow without a provider intent',
      escrowRows: [{
        id: 'esc-1', state: 'PENDING', stripe_payment_intent_id: null,
        stripe_refund_id: null, payment_intent_canceled_at: null,
      }],
      expected: { refundState: 'NOT_REQUIRED', blockerCode: null },
    },
    {
      name: 'escrow in provider-refunded state without a stored refund id',
      escrowRows: [{
        id: 'esc-1', state: 'REFUNDED', stripe_payment_intent_id: 'pi-1',
        stripe_refund_id: null, payment_intent_canceled_at: null,
      }],
      expected: { refundState: 'REFUNDED', blockerCode: null },
    },
    {
      name: 'stored provider refund evidence before local state reconciliation',
      escrowRows: [{
        id: 'esc-1', state: 'PENDING', stripe_payment_intent_id: 'pi-1',
        stripe_refund_id: 're-1', payment_intent_canceled_at: null,
      }],
      expected: { refundState: 'REFUNDED', blockerCode: null },
    },
  ])('reconciles $name without another financial action', async ({ escrowRows, expected }) => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: TASK_ID,
        state: 'OPEN',
        worker_id: null,
        dispatch_expires_at: '2026-07-10T10:00:00.000Z',
        expiration_reason: null,
        refund_state: 'NOT_REQUIRED',
        refund_blocker: null,
        active_reservation: false,
      }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: escrowRows, rowCount: escrowRows.length })
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const result = await AutomationLifecycleService.expireUnfilled({
      engineTaskId: TASK_ID,
      idempotencyKey: `dispatch-expiry:${TASK_ID}`,
    });

    expect(result).toMatchObject({ success: true, data: expected });
    expect(writeToOutbox).not.toHaveBeenCalled();
  });

  it('refuses expiry if a reservation exists', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        id: TASK_ID,
        state: 'MATCHING',
        worker_id: null,
        dispatch_expires_at: '2026-07-10T10:00:00.000Z',
        expiration_reason: null,
        refund_state: 'NOT_REQUIRED',
        refund_blocker: null,
        active_reservation: true,
      }], rowCount: 1 });

    const result = await AutomationLifecycleService.expireUnfilled({
      engineTaskId: TASK_ID,
      idempotencyKey: `dispatch-expiry:${TASK_ID}`,
    });
    expect(result).toMatchObject({ success: false, error: { code: 'TASK_NOT_UNFILLED' } });
  });

  it('bounds the scheduler batch to 100', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const result = await AutomationLifecycleService.expireDue({ limit: 10_000 });
    expect(result).toMatchObject({ success: true, data: { inspected: 0 } });
    expect(query.mock.calls[0]?.[1]).toEqual([100]);
  });
});
