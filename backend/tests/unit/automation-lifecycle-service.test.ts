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
  mapLifecycleRow,
  type RawLifecycleRow,
} from '../../src/services/AutomationLifecycleService';

const TASK_ID = '11111111-1111-4111-8111-111111111111';

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

beforeEach(() => vi.clearAllMocks());

describe('AutomationLifecycleService E1 lifecycle read', () => {
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
    }))).toMatchObject({ payoutState: 'RELEASED' });
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
    query.mock.results.length;
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

  it('records a machine-readable blocker for a pending PaymentIntent without claiming refund', async () => {
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
        refundState: 'BLOCKED',
        blockerCode: 'BLOCKED_PENDING_PAYMENT_INTENT_CANCELLATION',
      },
    });
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
