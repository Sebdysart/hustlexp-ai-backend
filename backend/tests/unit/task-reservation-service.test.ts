import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => {
  const query = vi.fn();
  return {
    db: {
      query,
      transaction: vi.fn(async (fn: (q: typeof query) => Promise<unknown>) => fn(query)),
    },
  };
});

vi.mock('../../src/logger', () => {
  const child = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() });
  return { logger: { child }, taskLogger: { child } };
});

import { db } from '../../src/db';
import { TaskReservationService, buildReservationRequestHash } from '../../src/services/TaskReservationService';

const query = vi.mocked(db.query);
const TASK_ID = '550e8400-e29b-41d4-a716-446655440000';
const WORKER_ID = '550e8400-e29b-41d4-a716-446655440001';
const ACTOR_ID = '550e8400-e29b-41d4-a716-446655440002';
const params = {
  engineTaskId: TASK_ID,
  hustlerRef: WORKER_ID,
  idempotencyKey: 'dispatch-wave-0001-attempt-01',
  actorId: ACTOR_ID,
};

beforeEach(() => {
  vi.clearAllMocks();
  query.mockReset();
  vi.mocked(db.transaction).mockImplementation(async (fn: any) => fn(query));
});

function eligibleTask(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    state: 'OPEN',
    worker_id: null,
    poster_id: '550e8400-e29b-41d4-a716-446655440009',
    risk_level: 'LOW',
    price: 2500,
    sensitive: false,
    trust_tier_required: 2,
    escrow_state: 'FUNDED',
    ...overrides,
  };
}

function eligibleWorker(overrides: Record<string, unknown> = {}) {
  return {
    id: WORKER_ID,
    default_mode: 'worker',
    trust_tier: 2,
    trust_hold: false,
    is_banned: false,
    account_status: 'ACTIVE',
    plan: 'free',
    stripe_connect_id: 'acct_ready_for_payouts',
    payouts_enabled: true,
    ...overrides,
  };
}

describe('TaskReservationService.reserve', () => {
  it('creates an engine-owned reservation for a funded eligible task', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // advisory lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // idempotency lookup
      .mockResolvedValueOnce({ rows: [eligibleTask()], rowCount: 1 } as never) // task lock + escrow
      .mockResolvedValueOnce({ rows: [eligibleWorker()], rowCount: 1 } as never) // worker lock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // active conflict check
      .mockResolvedValueOnce({ rows: [{ id: TASK_ID, state: 'ACCEPTED', worker_id: WORKER_ID }], rowCount: 1 } as never) // task update
      .mockResolvedValueOnce({ rows: [{ id: 'reservation-1' }], rowCount: 1 } as never) // reservation insert
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // request witness insert

    const result = await TaskReservationService.reserve(params);

    expect(result).toEqual({
      success: true,
      data: {
        reservationId: 'reservation-1',
        engineTaskId: TASK_ID,
        hustlerRef: WORKER_ID,
        state: 'ENGINE_RESERVED',
        idempotencyReplayed: false,
      },
    });
    const update = query.mock.calls.find(([sql]) => String(sql).includes('UPDATE tasks'));
    expect(String(update?.[0])).toContain("state = 'ACCEPTED'");
  });

  it('replays the same reservation request without touching the task', async () => {
    const requestHash = buildReservationRequestHash(params);
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // advisory lock
      .mockResolvedValueOnce({
        rows: [{
          request_hash: requestHash,
          reservation_id: 'reservation-1',
          task_id: TASK_ID,
          hustler_id: WORKER_ID,
          reservation_status: 'ACTIVE',
        }],
        rowCount: 1,
      } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ reservationId: 'reservation-1', idempotencyReplayed: true });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE tasks'))).toBe(false);
  });

  it('rejects reuse of an idempotency key for a different reservation', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [{ request_hash: 'different-hash', reservation_id: 'reservation-1' }],
        rowCount: 1,
      } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE tasks'))).toBe(false);
  });

  it('rejects an unfunded task', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask({ escrow_state: 'PENDING' })], rowCount: 1 } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('TASK_NOT_FUNDED');
  });

  it('rejects a hustler below the task trust requirement', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask({ trust_tier_required: 3 })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [eligibleWorker({ trust_tier: 2 })], rowCount: 1 } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('TRUST_TIER_INSUFFICIENT');
  });

  it('rejects a hustler who cannot receive an automatic payout', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [eligibleWorker({ stripe_connect_id: null, payouts_enabled: false })], rowCount: 1 } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('PAYOUT_ACCOUNT_REQUIRED');
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE tasks'))).toBe(false);
  });

  it('rejects a second active task for the same hustler', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [eligibleWorker()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'other-task' }], rowCount: 1 } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('HUSTLER_ALREADY_COMMITTED');
  });

  it('rejects a task that another hustler already reserved', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({
        rows: [eligibleTask({ state: 'ACCEPTED', worker_id: '550e8400-e29b-41d4-a716-446655440099' })],
        rowCount: 1,
      } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('RESERVATION_CONFLICT');
  });

  it('blocks in-home tasks from autonomous reservation', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask({ risk_level: 'IN_HOME' })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [eligibleWorker({ trust_tier: 4 })], rowCount: 1 } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('TASK_RISK_BLOCKED');
  });

  it('enforces the existing Pro-plan gate for high-risk tasks', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask({ risk_level: 'HIGH', trust_tier_required: 3 })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [eligibleWorker({ trust_tier: 3, plan: 'free' })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('PLAN_REQUIRED');
  });

  it('enforces a current background check for high-value tasks', async () => {
    query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask({ price: 50001 })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [eligibleWorker()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ exists: false }], rowCount: 1 } as never);

    const result = await TaskReservationService.reserve(params);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('BACKGROUND_CHECK_REQUIRED');
  });

  it('rejects a missing canonical engine task', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(TaskReservationService.reserve(params)).resolves.toMatchObject({
      success: false, error: { code: 'NOT_FOUND' },
    });
  });

  it('blocks poster self-assignment', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask({ poster_id: WORKER_ID })], rowCount: 1 } as never);
    await expect(TaskReservationService.reserve(params)).resolves.toMatchObject({
      success: false, error: { code: 'SELF_ASSIGNMENT_FORBIDDEN' },
    });
  });

  it('rejects missing and ineligible hustler accounts', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(TaskReservationService.reserve(params)).resolves.toMatchObject({
      success: false, error: { code: 'HUSTLER_NOT_FOUND' },
    });

    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [eligibleWorker({ trust_hold: true })], rowCount: 1 } as never);
    await expect(TaskReservationService.reserve(params)).resolves.toMatchObject({
      success: false, error: { code: 'HUSTLER_INELIGIBLE' },
    });
  });

  it('fails closed when the canonical task update loses a reservation race', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [eligibleTask()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [eligibleWorker()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    await expect(TaskReservationService.reserve(params)).resolves.toMatchObject({
      success: false, error: { code: 'RESERVATION_CONFLICT' },
    });
  });

  it('maps unexpected transaction failures to DB_ERROR', async () => {
    vi.mocked(db.transaction).mockRejectedValueOnce(new Error('reservation db unavailable'));
    await expect(TaskReservationService.reserve(params)).resolves.toMatchObject({
      success: false, error: { code: 'DB_ERROR' },
    });
  });
});
