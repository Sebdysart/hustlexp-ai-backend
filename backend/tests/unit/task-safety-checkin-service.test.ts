import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }) },
}));

import { db } from '../../src/db';
import { TaskSafetyCheckinService } from '../../src/services/TaskSafetyCheckinService';

const POSTER_ID = '11111111-1111-4111-8111-111111111111';
const WORKER_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const CHECKIN_ID = '44444444-4444-4444-8444-444444444444';
const INCIDENT_ID = '55555555-5555-4555-8555-555555555555';
const IDEMPOTENCY_KEY = '66666666-6666-4666-8666-666666666666';

const mockDb = vi.mocked(db);

function task(state = 'ACCEPTED') {
  return { poster_id: POSTER_ID, worker_id: WORKER_ID, state };
}

function checkin(overrides: Record<string, unknown> = {}) {
  return {
    id: CHECKIN_ID,
    task_id: TASK_ID,
    participant_user_id: WORKER_ID,
    duration_minutes: 15,
    status: 'active',
    started_at: new Date('2026-07-18T20:00:00.000Z'),
    due_at: new Date('2026-07-18T20:15:00.000Z'),
    confirmed_at: null,
    escalated_at: null,
    escalation_incident_id: null,
    ...overrides,
  };
}

function requestHash(durationMinutes = 15) {
  return createHash('sha256').update(JSON.stringify({
    taskId: TASK_ID,
    participantUserId: WORKER_ID,
    durationMinutes,
  })).digest('hex');
}

describe('TaskSafetyCheckinService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb.query.mockReset();
    mockDb.transaction.mockReset();
    mockDb.transaction.mockImplementation(async (fn: any) => fn(mockDb.query));
  });

  it('starts one server-deadlined check-in with append-only evidence', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [checkin()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await TaskSafetyCheckinService.start({
      taskId: TASK_ID,
      participantUserId: WORKER_ID,
      durationMinutes: 15,
      idempotencyKey: IDEMPOTENCY_KEY,
    });

    expect(result).toMatchObject({ id: CHECKIN_ID, status: 'active', idempotencyReplayed: false });
    expect(mockDb.query.mock.calls[0][0]).toContain('FOR SHARE');
    expect(mockDb.query.mock.calls[3][0]).toContain('NOW() + make_interval');
    expect(mockDb.query.mock.calls[4][0]).toContain('task_safety_checkin_events');
  });

  it('replays the exact request and rejects a changed request under the same key', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ ...checkin(), request_hash: requestHash() }], rowCount: 1 } as any);
    await expect(TaskSafetyCheckinService.start({
      taskId: TASK_ID, participantUserId: WORKER_ID, durationMinutes: 15, idempotencyKey: IDEMPOTENCY_KEY,
    })).resolves.toMatchObject({ idempotencyReplayed: true });

    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ ...checkin(), request_hash: requestHash() }], rowCount: 1 } as any);
    await expect(TaskSafetyCheckinService.start({
      taskId: TASK_ID, participantUserId: WORKER_ID, durationMinutes: 30, idempotencyKey: IDEMPOTENCY_KEY,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('returns the existing active deadline instead of silently replacing it', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [checkin()], rowCount: 1 } as any);
    await expect(TaskSafetyCheckinService.start({
      taskId: TASK_ID, participantUserId: WORKER_ID, durationMinutes: 60, idempotencyKey: IDEMPOTENCY_KEY,
    })).resolves.toMatchObject({ id: CHECKIN_ID, duration_minutes: 15, activeAlreadyExisted: true });
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  it('hides task existence from a nonparticipant and blocks terminal-task starts', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as any);
    await expect(TaskSafetyCheckinService.start({
      taskId: TASK_ID,
      participantUserId: '77777777-7777-4777-8777-777777777777',
      durationMinutes: 15,
      idempotencyKey: IDEMPOTENCY_KEY,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    mockDb.query.mockResolvedValueOnce({ rows: [task('COMPLETED')], rowCount: 1 } as any);
    await expect(TaskSafetyCheckinService.start({
      taskId: TASK_ID, participantUserId: WORKER_ID, durationMinutes: 15, idempotencyKey: IDEMPOTENCY_KEY,
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('confirms only before the database clock deadline and records the actor', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [checkin({ status: 'confirmed', confirmed_at: new Date() })], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    await expect(TaskSafetyCheckinService.confirm(CHECKIN_ID, WORKER_ID))
      .resolves.toMatchObject({ status: 'confirmed' });
    expect(mockDb.query.mock.calls[0][0]).toContain('due_at > clock_timestamp()');
    expect(mockDb.query.mock.calls[1][1]).toEqual([
      CHECKIN_ID, WORKER_ID, 'Safety check-in confirmed before the deadline.',
    ]);
  });

  it('rejects late confirmation instead of racing the escalation worker', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [{ status: 'active', due_at: new Date('2026-07-18T20:15:00.000Z') }], rowCount: 1 } as any);
    await expect(TaskSafetyCheckinService.confirm(CHECKIN_ID, WORKER_ID))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('atomically escalates one overdue check-in into one urgent case without claiming contact delivery', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [checkin()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: INCIDENT_ID }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await TaskSafetyCheckinService.escalateDue(2);

    expect(result).toEqual({ escalated: 1, checkinIds: [CHECKIN_ID] });
    expect(mockDb.query.mock.calls[0][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(mockDb.query.mock.calls[1][0]).toContain("'vulnerable_person_safety', 'urgent'");
    expect(mockDb.query.mock.calls[1][0]).toContain('source_checkin_id');
    expect(mockDb.query.mock.calls[2][1]).toEqual(expect.arrayContaining([
      INCIDENT_ID,
      'HustleXP received the missed check-in escalation. Human acknowledgment is still pending.',
    ]));
    expect(mockDb.query.mock.calls[3][0]).toContain("'critical', 'trust_safety'");
    expect(JSON.stringify(mockDb.query.mock.calls[3][1])).not.toContain('contact_delivered');
    expect(mockDb.query.mock.calls[4][0]).toContain("status = 'escalated'");
  });
});
