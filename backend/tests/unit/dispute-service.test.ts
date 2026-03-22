/**
 * DisputeService Unit Tests
 *
 * Tests: getById, create (authorization, self-dispute guard, TOCTOU lock pattern).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn(() => ''),
  };
});

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));

vi.mock('../../src/services/EscrowService', () => ({
  EscrowService: {
    lockForDispute: vi.fn().mockResolvedValue({ success: true, data: {} }),
    getById: vi.fn().mockResolvedValue({ success: true, data: { state: 'FUNDED' } }),
  },
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    getById: vi.fn().mockResolvedValue({
      success: true,
      data: { id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1' },
    }),
  },
}));

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: {
    createNotification: vi.fn().mockResolvedValue({ success: true }),
  },
}));

// DisputeService imports from '../lib/outbox-helpers.js'
vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../../src/db';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.resetAllMocks();
  // Restore transaction mock after resetAllMocks clears the implementation
  (mockDb.transaction as ReturnType<typeof vi.fn>).mockImplementation(
    (fn: (q: typeof mockDb.query) => Promise<unknown>) => fn(mockDb.query)
  );
});

describe('DisputeService', () => {
  describe('structural verification', () => {
    it('DisputeService module exists and can be imported', async () => {
      const mod = await import('../../src/services/DisputeService');
      expect(mod.DisputeService).toBeDefined();
    });

    it('DisputeService has expected methods', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');
      expect(typeof DisputeService.getById).toBe('function');
      expect(typeof DisputeService.create).toBe('function');
    });
  });

  describe('getById', () => {
    it('returns dispute when found', async () => {
      const dispute = {
        id: 'disp-1', task_id: 'task-1', poster_id: 'poster-1',
        worker_id: 'worker-1', state: 'OPEN', reason: 'test',
      };
      mockDb.query.mockResolvedValueOnce({ rows: [dispute], rowCount: 1 } as never);

      const { DisputeService } = await import('../../src/services/DisputeService');
      const result = await DisputeService.getById('disp-1');
      expect(result.success).toBe(true);
    });

    it('returns NOT_FOUND when dispute missing', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const { DisputeService } = await import('../../src/services/DisputeService');
      const result = await DisputeService.getById('disp-missing');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  describe('create — authorization guards', () => {
    it('returns FORBIDDEN when initiator is neither poster nor worker', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');
      const result = await DisputeService.create({
        taskId: 'task-1',
        escrowId: 'escrow-1',
        initiatedBy: 'rando-user',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'Bad work',
        description: 'Details',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FORBIDDEN');
        expect(result.error.message).toMatch(/poster or worker/i);
      }
    });

    // T53-3: A user who is both poster AND worker on a task should not be able to
    // dispute themselves. This would allow fraudulent escrow manipulation.
    it('T53-3: returns FORBIDDEN when poster_id === worker_id (self-dispute guard)', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');
      const result = await DisputeService.create({
        taskId: 'task-1',
        escrowId: 'escrow-1',
        initiatedBy: 'user-1',
        posterId: 'user-1',   // same user is both
        workerId: 'user-1',   // poster and worker
        reason: 'Self dispute',
        description: 'Trying to dispute myself',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('FORBIDDEN');
        expect(result.error.message).toMatch(/both the poster and worker/i);
      }
      // Must not have touched the database at all
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('T53-3: allows poster to dispute when poster !== worker', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      // Setup: transaction mock sequence for a valid dispute creation
      // 1. task FOR UPDATE → COMPLETED with completed_at within 48h
      const completedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 mins ago
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', state: 'COMPLETED', completed_at: completedAt, poster_id: 'poster-1', worker_id: 'worker-1' }], rowCount: 1 } as never)
        // 2. escrow FOR UPDATE → FUNDED
        .mockResolvedValueOnce({ rows: [{ id: 'escrow-1', state: 'FUNDED', amount: 5000, stripe_transfer_id: null, version: 1 }], rowCount: 1 } as never)
        // 3. escrow UPDATE → LOCKED_DISPUTE
        .mockResolvedValueOnce({ rows: [{ id: 'escrow-1', state: 'LOCKED_DISPUTE', version: 2 }], rowCount: 1 } as never)
        // 4. dispute INSERT
        .mockResolvedValueOnce({ rows: [{ id: 'disp-1', state: 'OPEN', version: 1 }], rowCount: 1 } as never)
        // 5. outbox INSERT (writeToOutbox uses the tx query fn)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await DisputeService.create({
        taskId: 'task-1',
        escrowId: 'escrow-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'Bad work',
        description: 'Details here',
      });

      expect(result.success).toBe(true);
    });

    it('T53-3: allows worker to dispute when poster !== worker', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      const completedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', state: 'COMPLETED', completed_at: completedAt, poster_id: 'poster-1', worker_id: 'worker-1' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'escrow-1', state: 'FUNDED', amount: 5000, stripe_transfer_id: null, version: 1 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'escrow-1', state: 'LOCKED_DISPUTE', version: 2 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'disp-1', state: 'OPEN', version: 1 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await DisputeService.create({
        taskId: 'task-1',
        escrowId: 'escrow-1',
        initiatedBy: 'worker-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'Never paid',
        description: 'Escrow never released',
      });

      expect(result.success).toBe(true);
    });
  });
});
