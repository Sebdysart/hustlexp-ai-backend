/**
 * instant-notification-worker.test.ts
 *
 * W47-2 FIX: Verifies the idempotency guard in processInstantNotificationJob.
 *
 * BullMQ has attempts:3 on the user_notifications queue. If a job times out
 * after the INSERT succeeds, BullMQ retries and would create a duplicate push
 * notification. The fix checks for an existing notification for this
 * hustler+taskId+category before calling createNotification.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
// Mocks — must be declared before any imports
// ────────────────────────────────────────────────────────────────────────────

const mockCheckFlags = vi.fn(() => ({ interruptsEnabled: true }));

vi.mock('../../src/db.js', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/services/NotificationService.js', () => ({
  NotificationService: {
    createNotification: vi.fn(),
  },
}));

vi.mock('../../src/jobs/queues.js', () => ({
  verifyJobSignature: vi.fn(() => true),
}));

vi.mock('../../src/logger.js', () => {
  const base = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => base,
  };
  return { logger: base, workerLogger: base };
});

// The worker uses dynamic import: await import('../services/InstantModeKillSwitch')
// We mock it at the module level — vi.mock hoists this before the import
vi.mock('../../src/services/InstantModeKillSwitch.js', () => ({
  InstantModeKillSwitch: {
    checkFlags: mockCheckFlags,
  },
}));

// ────────────────────────────────────────────────────────────────────────────
// Imports (after mocks)
// ────────────────────────────────────────────────────────────────────────────

import { db } from '../../src/db.js';
import { NotificationService } from '../../src/services/NotificationService.js';
import { processInstantNotificationJob } from '../../src/jobs/instant-notification-worker.js';
import type { Job } from 'bullmq';

const mockDb = vi.mocked(db);
const mockCreateNotification = vi.mocked(NotificationService.createNotification);

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function makeJob(overrides: Record<string, unknown> = {}): Job {
  return {
    id: 'job-001',
    data: {
      payload: {
        taskId: 'task-abc',
        hustlerId: 'hustler-xyz',
        riskLevel: 'LOW',
        sensitive: false,
        surgeLevel: 0,
        urgencyCopy: undefined,
        location: 'Downtown',
        ...overrides,
      },
    },
  } as unknown as Job;
}

function mockTaskRow(state = 'MATCHING') {
  mockDb.query.mockResolvedValueOnce({
    rows: [{
      id: 'task-abc',
      state,
      title: 'Help move boxes',
      price: 2500,
      instant_mode: true,
    }],
    rowCount: 1,
  } as never);
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('processInstantNotificationJob', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-establish kill switch default after resetAllMocks clears all mock impls
    mockCheckFlags.mockReturnValue({ interruptsEnabled: true });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // W47-2: Idempotency guard
  // ──────────────────────────────────────────────────────────────────────────

  describe('W47-2: idempotency guard — skip if notification already exists', () => {
    it('skips createNotification when a notification already exists for this hustler+taskId+category', async () => {
      const job = makeJob();

      // 1. Task lookup
      mockTaskRow('MATCHING');
      // 2. ONE-INTERRUPT-AT-A-TIME suppression UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // 3. Idempotency check — notification already exists
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'notif-existing' }], rowCount: 1 } as never);

      await processInstantNotificationJob(job);

      // createNotification must NOT have been called
      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('queries the correct table/columns for the idempotency check', async () => {
      const job = makeJob();

      mockTaskRow('MATCHING');
      // Suppression UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Idempotency check — notification already exists
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'notif-dup' }], rowCount: 1 } as never);

      await processInstantNotificationJob(job);

      // Find the SELECT query for the idempotency check
      const idempotencyCall = mockDb.query.mock.calls.find(
        ([sql]) => typeof sql === 'string' && (sql as string).includes('instant_task_available') && (sql as string).includes('SELECT')
      );
      expect(idempotencyCall).toBeDefined();

      const [sql, params] = idempotencyCall!;
      expect(sql).toContain('notifications');
      expect(sql).toContain('user_id');
      expect(sql).toContain('task_id');
      expect(sql).toContain("category = 'instant_task_available'");
      // params: [hustlerId, taskId]
      expect(params).toContain('hustler-xyz');
      expect(params).toContain('task-abc');
    });

    it('proceeds to createNotification when no existing notification is found', async () => {
      const job = makeJob();

      mockTaskRow('MATCHING');
      // Suppression UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Idempotency check — no existing notification
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      mockCreateNotification.mockResolvedValueOnce({ success: true, data: { id: 'notif-new' } } as never);

      await processInstantNotificationJob(job);

      expect(mockCreateNotification).toHaveBeenCalledTimes(1);
      expect(mockCreateNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'hustler-xyz',
          taskId: 'task-abc',
          category: 'instant_task_available',
        })
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Task state guard
  // ──────────────────────────────────────────────────────────────────────────

  describe('task state guard', () => {
    it('returns early (no createNotification) when task is no longer in MATCHING state', async () => {
      const job = makeJob();

      mockTaskRow('ASSIGNED'); // Task already accepted

      await processInstantNotificationJob(job);

      expect(mockCreateNotification).not.toHaveBeenCalled();
    });

    it('throws when task is not found', async () => {
      const job = makeJob();

      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await expect(processInstantNotificationJob(job)).rejects.toThrow('not found');
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // createNotification failure propagation
  // ──────────────────────────────────────────────────────────────────────────

  describe('createNotification error handling', () => {
    it('throws when createNotification returns success=false', async () => {
      const job = makeJob();

      mockTaskRow('MATCHING');
      // Suppression UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Idempotency check — not found, proceed
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      mockCreateNotification.mockResolvedValueOnce({
        success: false,
        error: { message: 'FCM token missing', code: 'PUSH_FAILED' },
      } as never);

      await expect(processInstantNotificationJob(job)).rejects.toThrow(
        'Failed to create instant notification'
      );
    });
  });
});
