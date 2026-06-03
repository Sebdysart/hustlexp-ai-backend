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

  // T60-4: DisputeService.create must guard against workerId=null.
  // If a task has no assigned worker, a dispute cannot have a payout target.
  describe('T60-4: create returns INVALID_TASK when workerId is null', () => {
    it('T60-4: returns INVALID_TASK error when workerId is null (no assigned worker)', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      const result = await DisputeService.create({
        taskId: 'task-1',
        escrowId: 'escrow-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: null as unknown as string, // simulate null worker
        reason: 'No worker assigned',
        description: 'Cannot dispute with no worker',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_TASK');
        expect(result.error.message).toMatch(/no assigned worker/i);
      }
      // Must not touch the database — guard fires before transaction
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('T60-4: create proceeds normally when workerId is a non-empty string', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      const completedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', state: 'COMPLETED', completed_at: completedAt, poster_id: 'poster-1', worker_id: 'worker-1' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'escrow-1', state: 'FUNDED', amount: 5000, stripe_transfer_id: null, version: 1 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'escrow-1', state: 'LOCKED_DISPUTE', version: 2 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'disp-1', state: 'OPEN', version: 1 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // outbox INSERT

      const result = await DisputeService.create({
        taskId: 'task-1',
        escrowId: 'escrow-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'Bad work',
        description: 'Details',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('T59-3: task state update to DISPUTED happens atomically within dispute-creation transaction', () => {
    it('T59-3: when creating dispute on PROOF_SUBMITTED task, task UPDATE to DISPUTED is called within the same transaction (not as separate db.query)', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      // Track all calls to the transaction query function vs the module-level db.query
      const transactionQueryCalls: string[] = [];
      const moduleQueryCalls: string[] = [];

      // Override transaction to capture calls to the in-transaction query fn
      (mockDb.transaction as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (fn: (q: typeof mockDb.query) => Promise<unknown>) => {
          const txQuery = vi.fn((...args: unknown[]) => {
            if (typeof args[0] === 'string') {
              transactionQueryCalls.push(args[0]);
            }
            // Delegate to mockDb.query for return values
            return (mockDb.query as ReturnType<typeof vi.fn>)(...args);
          });

          // Track module-level db.query calls separately
          (mockDb.query as ReturnType<typeof vi.fn>).mockImplementation((...args: unknown[]) => {
            if (typeof args[0] === 'string') {
              moduleQueryCalls.push(args[0]);
            }
            return Promise.resolve({ rows: [], rowCount: 0 });
          });

          return fn(txQuery as typeof mockDb.query);
        }
      );

      // Setup mock sequence: PROOF_SUBMITTED task, FUNDED escrow, lock, dispute insert, outbox, task UPDATE
      mockDb.query
        // task FOR UPDATE → PROOF_SUBMITTED
        .mockResolvedValueOnce({ rows: [{ id: 'task-1', state: 'PROOF_SUBMITTED', completed_at: null, poster_id: 'poster-1', worker_id: 'worker-1' }], rowCount: 1 } as never)
        // escrow FOR UPDATE → FUNDED
        .mockResolvedValueOnce({ rows: [{ id: 'escrow-1', state: 'FUNDED', amount: 5000, stripe_transfer_id: null, version: 1 }], rowCount: 1 } as never)
        // escrow UPDATE → LOCKED_DISPUTE
        .mockResolvedValueOnce({ rows: [{ id: 'escrow-1', state: 'LOCKED_DISPUTE', version: 2 }], rowCount: 1 } as never)
        // dispute INSERT
        .mockResolvedValueOnce({ rows: [{ id: 'disp-1', state: 'OPEN', version: 1 }], rowCount: 1 } as never)
        // outbox INSERT
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        // T59-3: UPDATE tasks SET state='DISPUTED' (must be within transaction)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await DisputeService.create({
        taskId: 'task-1',
        escrowId: 'escrow-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'Bad work',
        description: 'Details',
      });

      expect(result.success).toBe(true);

      // The task UPDATE to DISPUTED must have gone through the transaction query fn
      const txDisputedUpdate = transactionQueryCalls.find(
        (sql) => sql.includes('UPDATE tasks') && sql.includes('DISPUTED')
      );
      expect(txDisputedUpdate).toBeDefined();

      // The task UPDATE to DISPUTED must NOT have been a separate module-level db.query call
      const moduleDisputedUpdate = moduleQueryCalls.find(
        (sql) => sql.includes('UPDATE tasks') && sql.includes('DISPUTED')
      );
      expect(moduleDisputedUpdate).toBeUndefined();
    });
  });

  describe('T61-1: COMPLETED task transitions to DISPUTED when dispute is created', () => {
    it('T61-1: creates dispute on COMPLETED task and transitions task to DISPUTED within the transaction', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      // Set completed_at to just now (within 48h window)
      const recentlyCompleted = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString(); // 1 hour ago

      mockDb.query
        // 1. task FOR UPDATE → COMPLETED (within 48h window)
        .mockResolvedValueOnce({
          rows: [{ id: 'task-1', state: 'COMPLETED', completed_at: recentlyCompleted, poster_id: 'poster-1', worker_id: 'worker-1' }],
          rowCount: 1,
        } as never)
        // 2. escrow FOR UPDATE → RELEASED (completed tasks typically have released escrow)
        .mockResolvedValueOnce({
          rows: [{ id: 'escrow-1', state: 'RELEASED', amount: 5000, stripe_transfer_id: null, version: 1 }],
          rowCount: 1,
        } as never)
        // 3. escrow UPDATE → LOCKED_DISPUTE
        .mockResolvedValueOnce({
          rows: [{ id: 'escrow-1', state: 'LOCKED_DISPUTE', version: 2 }],
          rowCount: 1,
        } as never)
        // 4. dispute INSERT
        .mockResolvedValueOnce({
          rows: [{ id: 'disp-1', state: 'OPEN', version: 1 }],
          rowCount: 1,
        } as never)
        // 5. outbox INSERT (dispute.created)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        // 6. T61-1: UPDATE tasks SET state='DISPUTED' WHERE state='COMPLETED'
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await DisputeService.create({
        taskId: 'task-1',
        escrowId: 'escrow-1',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'Completed work not as described',
        description: 'The delivered work does not match spec',
      });

      expect(result.success).toBe(true);

      // Verify that the UPDATE tasks ... COMPLETED → DISPUTED query was issued
      const allSqls = mockDb.query.mock.calls.map(c => c[0] as string);
      const completedToDisputed = allSqls.find(
        (sql) => sql.includes('UPDATE tasks') && sql.includes('DISPUTED') && sql.includes("state = 'COMPLETED'")
      );
      expect(completedToDisputed).toBeDefined();
    });

    it('T61-1: does NOT emit a COMPLETED→DISPUTED update for PROOF_SUBMITTED tasks (guard is state-specific)', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      mockDb.query
        // task FOR UPDATE → PROOF_SUBMITTED
        .mockResolvedValueOnce({
          rows: [{ id: 'task-2', state: 'PROOF_SUBMITTED', completed_at: null, poster_id: 'poster-1', worker_id: 'worker-1' }],
          rowCount: 1,
        } as never)
        // escrow FOR UPDATE → FUNDED
        .mockResolvedValueOnce({
          rows: [{ id: 'escrow-2', state: 'FUNDED', amount: 5000, stripe_transfer_id: null, version: 1 }],
          rowCount: 1,
        } as never)
        // escrow UPDATE → LOCKED_DISPUTE
        .mockResolvedValueOnce({
          rows: [{ id: 'escrow-2', state: 'LOCKED_DISPUTE', version: 2 }],
          rowCount: 1,
        } as never)
        // dispute INSERT
        .mockResolvedValueOnce({
          rows: [{ id: 'disp-2', state: 'OPEN', version: 1 }],
          rowCount: 1,
        } as never)
        // outbox INSERT
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        // PROOF_SUBMITTED → DISPUTED update
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await DisputeService.create({
        taskId: 'task-2',
        escrowId: 'escrow-2',
        initiatedBy: 'poster-1',
        posterId: 'poster-1',
        workerId: 'worker-1',
        reason: 'Proof looks wrong',
        description: 'The proof submitted is invalid',
      });

      expect(result.success).toBe(true);

      // Verify PROOF_SUBMITTED → DISPUTED was used (not COMPLETED → DISPUTED)
      const allSqls = mockDb.query.mock.calls.map(c => c[0] as string);
      const proofToDisputed = allSqls.find(
        (sql) => sql.includes('UPDATE tasks') && sql.includes('DISPUTED') && sql.includes("state = 'PROOF_SUBMITTED'")
      );
      expect(proofToDisputed).toBeDefined();

      // The COMPLETED → DISPUTED variant must NOT appear
      const completedToDisputed = allSqls.find(
        (sql) => sql.includes('UPDATE tasks') && sql.includes('DISPUTED') && sql.includes("state = 'COMPLETED'")
      );
      expect(completedToDisputed).toBeUndefined();
    });
  });

  // PR1: these guards exercise the two fields read off the now-`Task`-typed task row
  // (task.state at the includes() guard, task.completed_at at the 48h window check).
  // They lock in the runtime behavior so the `db.query<Task>` typing change cannot
  // silently alter dispute-window enforcement.
  describe('PR1: task-state and 48h dispute-window guards (db.query<Task> typing)', () => {
    const baseCreateArgs = {
      taskId: 'task-1',
      escrowId: 'escrow-1',
      initiatedBy: 'poster-1',
      posterId: 'poster-1',
      workerId: 'worker-1',
      reason: 'Bad work',
      description: 'Details',
    };

    it('rejects a dispute on a task in a non-disputable state (e.g. ACCEPTED) — exercises task.state guard', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      // Only the task FOR UPDATE query is reached before the state guard throws.
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'ACCEPTED', completed_at: null, poster_id: 'poster-1', worker_id: 'worker-1' }],
        rowCount: 1,
      } as never);

      const result = await DisputeService.create({ ...baseCreateArgs });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
        expect(result.error.message).toMatch(/completed tasks or tasks with submitted proof/i);
      }
      // Guard fires before the escrow lock.
      const sqls = mockDb.query.mock.calls.map((c) => c[0] as string);
      expect(sqls.some((s) => s.includes('FROM escrows'))).toBe(false);
    });

    it('rejects a dispute on a COMPLETED task whose completed_at is older than the 48h window — exercises new Date(task.completed_at)', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      const fiftyHoursAgo = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'COMPLETED', completed_at: fiftyHoursAgo, poster_id: 'poster-1', worker_id: 'worker-1' }],
        rowCount: 1,
      } as never);

      const result = await DisputeService.create({ ...baseCreateArgs });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
        expect(result.error.message).toMatch(/within 48 hours/i);
      }
    });

    // Caveat 1 (review): the `if (!task.completed_at)` guard must reject null — not just
    // undefined — BEFORE `new Date(task.completed_at)` runs. Otherwise new Date(null) → epoch 0,
    // and every COMPLETED task with a null timestamp would be wrongly rejected as "outside window"
    // (or, worse, silently accepted). This asserts the explicit "missing completed_at" path fires.
    it('caveat-1: rejects a COMPLETED task with null completed_at before constructing a Date', async () => {
      const { DisputeService } = await import('../../src/services/DisputeService');

      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'task-1', state: 'COMPLETED', completed_at: null, poster_id: 'poster-1', worker_id: 'worker-1' }],
        rowCount: 1,
      } as never);

      const result = await DisputeService.create({ ...baseCreateArgs });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
        expect(result.error.message).toMatch(/missing completed_at/i);
      }
      // The null guard must short-circuit before the escrow FOR UPDATE query.
      const sqls = mockDb.query.mock.calls.map((c) => c[0] as string);
      expect(sqls.some((s) => s.includes('FROM escrows'))).toBe(false);
    });
  });
});

// =============================================================================
// T62-1: DisputeService.resolve — RELEASE must accept REJECTED proofs
// =============================================================================
describe('T62-1: DisputeService.resolve RELEASE accepts REJECTED proof (concurrent deadlock fix)', () => {
  it('T62-1: resolve with RELEASE outcome updates proofs with state IN (SUBMITTED, REJECTED)', async () => {
    // Scenario: proof was REJECTED by ProofService.review() before a concurrent dispute.create()
    // locked the task into DISPUTED. Now admin resolves the dispute with RELEASE outcome.
    // The proof UPDATE must use state IN ('SUBMITTED', 'REJECTED') to succeed — otherwise
    // the proof stays REJECTED, the task cannot transition to COMPLETED (INV-3), and
    // the dispute is permanently unresolvable (deadlock).
    const { DisputeService } = await import('../../src/services/DisputeService');

    // canResolveDisputes check
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);

    const disputeRow = {
      id: 'd-t62',
      task_id: 'task-t62',
      escrow_id: 'escrow-t62',
      worker_id: 'worker-1',
      poster_id: 'poster-1',
      state: 'OPEN',
      version: 1,
    };
    const escrowRow = { id: 'escrow-t62', state: 'LOCKED_DISPUTE', amount: 10000, version: 1 };

    // Capture the SQL used to update proofs
    let proofUpdateSql = '';
    mockDb.transaction.mockImplementationOnce(async (fn: (q: typeof mockDb.query) => Promise<unknown>) => {
      const captureQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
        if (sql.includes('FROM disputes') && sql.includes('FOR UPDATE')) {
          return { rows: [disputeRow], rowCount: 1 };
        }
        if (sql.includes('FROM escrows') && sql.includes('FOR UPDATE')) {
          return { rows: [escrowRow], rowCount: 1 };
        }
        if (sql.includes('UPDATE disputes')) {
          return { rows: [{ ...disputeRow, state: 'RESOLVED', version: 2 }], rowCount: 1 };
        }
        if (sql.includes('UPDATE proofs') && sql.includes("'ACCEPTED'")) {
          proofUpdateSql = sql;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('UPDATE tasks') && sql.includes("'COMPLETED'")) {
          return { rows: [{ id: 'task-t62', state: 'COMPLETED' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO outbox') || sql.includes('outbox')) {
          return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      return fn(captureQuery);
    });

    const result = await DisputeService.resolve({
      disputeId: 'd-t62',
      resolvedBy: 'admin-1',
      resolution: 'Worker wins — proof was valid despite prior rejection',
      outcomeEscrowAction: 'RELEASE',
    });

    expect(result.success).toBe(true);

    // T62-1 CRITICAL: the proof UPDATE must include REJECTED in the state filter
    expect(proofUpdateSql).toMatch(/state\s+IN\s*\(\s*'SUBMITTED'\s*,\s*'REJECTED'\s*\)/i);
    // Must NOT be restricted to only SUBMITTED
    expect(proofUpdateSql).not.toMatch(/state\s*=\s*'SUBMITTED'/);
  });
});
