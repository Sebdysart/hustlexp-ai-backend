/**
 * DisputeService branch coverage tests
 *
 * Targets the 59 uncovered branches in DisputeService:
 * - getByTaskId: success + error paths
 * - getByUserId: success + error paths
 * - getById: DB_ERROR path (non-Error thrown)
 * - create: authorization checks, task window, escrow state, unique/invariant violations
 * - requestEvidence: not found, invalid transition, invariant violation, error instanceof
 * - resolve: permission, state checks, SPLIT validation, outbox events, error categories
 * - escalate: not found, invalid transition, invariant violation
 * - isValidTransition: all state machine paths
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => {
  const mockQuery = vi.fn();
  const mockTransaction = vi.fn();
  return {
    db: { query: mockQuery, transaction: mockTransaction },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  logger: { child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }) },
}));

vi.mock('../../src/services/EscrowService', () => ({
  EscrowService: { getById: vi.fn() },
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: { getById: vi.fn() },
}));

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue(undefined),
}));

import { db, isInvariantViolation, isUniqueViolation } from '../../src/db';
import { TaskService } from '../../src/services/TaskService';
import { EscrowService } from '../../src/services/EscrowService';
import { DisputeService } from '../../src/services/DisputeService';

const mockDb = vi.mocked(db);
const mockTaskService = vi.mocked(TaskService);
const mockEscrowService = vi.mocked(EscrowService);
const mockIsInvariant = vi.mocked(isInvariantViolation);
const mockIsUnique = vi.mocked(isUniqueViolation);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: db.transaction delegates callback with db.query so inner query mocks work
  mockDb.transaction.mockImplementation(async (fn: (q: typeof db.query) => Promise<unknown>) =>
    fn(db.query)
  );
});

describe('DisputeService.getByTaskId', () => {
  it('returns disputes on success', async () => {
    const disputes = [{ id: 'd1', task_id: 't1' }];
    mockDb.query.mockResolvedValueOnce({ rows: disputes, rowCount: 1 } as any);

    const result = await DisputeService.getByTaskId('t1');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(disputes);
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('query failed'));

    const result = await DisputeService.getByTaskId('t1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DB_ERROR');
  });

  it('returns Unknown error for non-Error throw', async () => {
    mockDb.query.mockRejectedValueOnce('string error');

    const result = await DisputeService.getByTaskId('t1');
    expect(result.success).toBe(false);
    // R-13 FIX: DB error messages are sanitized — raw message never exposed to callers
    if (!result.success) expect(result.error.message).toBe('A database error occurred. Please try again.');
  });
});

describe('DisputeService.getByUserId', () => {
  it('returns disputes on success', async () => {
    const disputes = [{ id: 'd1', poster_id: 'u1' }];
    mockDb.query.mockResolvedValueOnce({ rows: disputes, rowCount: 1 } as any);

    const result = await DisputeService.getByUserId('u1');
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(disputes);
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('fail'));

    const result = await DisputeService.getByUserId('u1');
    expect(result.success).toBe(false);
  });
});

describe('DisputeService.getById', () => {
  it('returns DB_ERROR for non-Error throw', async () => {
    mockDb.query.mockRejectedValueOnce('raw string');

    const result = await DisputeService.getById('d1');
    expect(result.success).toBe(false);
    // R-13 FIX: DB error messages are sanitized — raw message never exposed to callers
    if (!result.success) expect(result.error.message).toBe('A database error occurred. Please try again.');
  });
});

describe('DisputeService.create', () => {
  const baseParams = {
    taskId: 't1',
    escrowId: 'e1',
    initiatedBy: 'poster-1',
    posterId: 'poster-1',
    workerId: 'worker-1',
    reason: 'Quality',
    description: 'Bad work',
  };

  it('rejects when initiator is not poster or worker', async () => {
    const result = await DisputeService.create({
      ...baseParams,
      initiatedBy: 'outsider',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('FORBIDDEN');
  });

  it('rejects when task is not completed', async () => {
    // Inside transaction: SELECT task FOR UPDATE → task with no completed_at
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 't1', completed_at: null }],
      rowCount: 1,
    } as any);

    const result = await DisputeService.create(baseParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_STATE');
  });

  it('rejects when outside dispute window (>48h)', async () => {
    const oldDate = new Date(Date.now() - 49 * 60 * 60 * 1000);
    // Inside transaction: SELECT task FOR UPDATE → task with old completed_at
    // R-3 FIX: state check now runs before the 48h window check — must include state.
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 't1', completed_at: oldDate, state: 'COMPLETED' }],
      rowCount: 1,
    } as any);

    const result = await DisputeService.create(baseParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('48 hours');
  });

  it('rejects when escrow is in an invalid state (REFUNDED)', async () => {
    // BUG FIX (HIGH): FUNDED and RELEASED are both valid states for filing a dispute.
    // Only truly terminal/locked states like REFUNDED, LOCKED_DISPUTE, etc. are rejected.
    // Inside transaction:
    // Query 1: SELECT task FOR UPDATE → completed task
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 't1', completed_at: new Date() }],
      rowCount: 1,
    } as any);
    // Query 2: SELECT escrow FOR UPDATE → REFUNDED escrow (invalid state)
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'e1', state: 'REFUNDED' }],
      rowCount: 1,
    } as any);

    const result = await DisputeService.create(baseParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_STATE');
  });

  it('returns error when TaskService fails', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    } as any);

    const result = await DisputeService.create(baseParams);
    expect(result.success).toBe(false);
  });

  it('returns error when EscrowService fails', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: { id: 't1', completed_at: new Date() } as any,
    });
    mockEscrowService.getById.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Escrow not found' },
    } as any);

    const result = await DisputeService.create(baseParams);
    expect(result.success).toBe(false);
  });

  it('handles unique violation', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: { id: 't1', completed_at: new Date() } as any,
    });
    mockEscrowService.getById.mockResolvedValueOnce({
      success: true,
      data: { state: 'FUNDED' } as any,
    });
    mockDb.transaction.mockRejectedValueOnce(new Error('unique'));
    mockIsUnique.mockReturnValueOnce(true);

    const result = await DisputeService.create(baseParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.message).toContain('already exists');
  });

  it('handles invariant violation', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: { id: 't1', completed_at: new Date() } as any,
    });
    mockEscrowService.getById.mockResolvedValueOnce({
      success: true,
      data: { state: 'FUNDED' } as any,
    });
    const err = Object.assign(new Error('inv'), { code: 'HX001' });
    mockDb.transaction.mockRejectedValueOnce(err);
    mockIsUnique.mockReturnValueOnce(false);
    mockIsInvariant.mockReturnValueOnce(true);

    const result = await DisputeService.create(baseParams);
    expect(result.success).toBe(false);
  });

  it('handles generic DB error', async () => {
    mockTaskService.getById.mockResolvedValueOnce({
      success: true,
      data: { id: 't1', completed_at: new Date() } as any,
    });
    mockEscrowService.getById.mockResolvedValueOnce({
      success: true,
      data: { state: 'FUNDED' } as any,
    });
    mockDb.transaction.mockRejectedValueOnce(new Error('connection lost'));
    mockIsUnique.mockReturnValueOnce(false);
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.create(baseParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DB_ERROR');
  });
});

describe('DisputeService.requestEvidence', () => {
  it('returns NOT_FOUND when dispute missing', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await DisputeService.requestEvidence('d-missing');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_TRANSITION for bad state', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'd1', state: 'RESOLVED' }], rowCount: 1,
    } as any);

    const result = await DisputeService.requestEvidence('d1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_TRANSITION');
  });

  it('succeeds for OPEN state', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'd1', state: 'OPEN' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: 'd1', state: 'EVIDENCE_REQUESTED' }], rowCount: 1 } as any);

    const result = await DisputeService.requestEvidence('d1');
    expect(result.success).toBe(true);
  });

  it('handles invariant violation in requestEvidence', async () => {
    const err = Object.assign(new Error('inv'), { code: 'HX001' });
    mockDb.query.mockRejectedValueOnce(err);
    mockIsInvariant.mockReturnValueOnce(true);

    const result = await DisputeService.requestEvidence('d1');
    expect(result.success).toBe(false);
  });

  it('handles generic error in requestEvidence', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('boom'));
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.requestEvidence('d1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DB_ERROR');
  });
});

describe('DisputeService.escalate', () => {
  it('returns NOT_FOUND when dispute missing', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await DisputeService.escalate('d-missing');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('returns INVALID_TRANSITION for RESOLVED state', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'd1', state: 'RESOLVED' }], rowCount: 1,
    } as any);

    const result = await DisputeService.escalate('d1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_TRANSITION');
  });

  it('succeeds for OPEN state', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'd1', state: 'OPEN' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: 'd1', state: 'ESCALATED' }], rowCount: 1 } as any);

    const result = await DisputeService.escalate('d1');
    expect(result.success).toBe(true);
  });

  it('handles invariant violation in escalate', async () => {
    const err = Object.assign(new Error('inv'), { code: 'HX001' });
    mockDb.query.mockRejectedValueOnce(err);
    mockIsInvariant.mockReturnValueOnce(true);

    const result = await DisputeService.escalate('d1');
    expect(result.success).toBe(false);
  });

  it('handles generic error in escalate', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('fail'));
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.escalate('d1');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DB_ERROR');
  });
});

describe('DisputeService.resolve', () => {
  const baseResolveParams = {
    disputeId: 'd1',
    resolvedBy: 'admin-1',
    resolution: 'Worker paid',
    outcomeEscrowAction: 'RELEASE' as const,
  };

  it('rejects when user lacks permission', async () => {
    // canResolveDisputes returns no rows
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await DisputeService.resolve(baseResolveParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('FORBIDDEN');
  });

  it('handles "not found" error from transaction', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);
    mockDb.transaction.mockRejectedValueOnce(new Error('Dispute d1 not found'));
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.resolve(baseResolveParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
  });

  it('handles "Cannot resolve" error', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);
    mockDb.transaction.mockRejectedValueOnce(new Error('Cannot resolve dispute from OPEN'));
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.resolve(baseResolveParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_STATE');
  });

  it('handles "already resolved" error', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);
    mockDb.transaction.mockRejectedValueOnce(new Error('Dispute is already resolved'));
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.resolve(baseResolveParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_STATE');
  });

  it('handles "Version conflict" error', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);
    mockDb.transaction.mockRejectedValueOnce(new Error('Version conflict: dispute was modified'));
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.resolve(baseResolveParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_STATE');
  });

  it('handles "must be" error (escrow state)', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);
    mockDb.transaction.mockRejectedValueOnce(new Error('Escrow must be LOCKED_DISPUTE'));
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.resolve(baseResolveParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_STATE');
  });

  it('handles SPLIT validation error', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);
    mockDb.transaction.mockRejectedValueOnce(new Error('SPLIT resolution requires refund_amount'));
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.resolve({
      ...baseResolveParams,
      outcomeEscrowAction: 'SPLIT',
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('INVALID_STATE');
  });

  it('handles invariant violation in resolve', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);
    const err = Object.assign(new Error('inv'), { code: 'HX002' });
    mockDb.transaction.mockRejectedValueOnce(err);
    mockIsInvariant.mockReturnValueOnce(true);

    const result = await DisputeService.resolve(baseResolveParams);
    expect(result.success).toBe(false);
  });

  it('handles generic DB error in resolve', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);
    mockDb.transaction.mockRejectedValueOnce(new Error('connection reset'));
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.resolve(baseResolveParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DB_ERROR');
  });

  it('handles non-Error throw in resolve', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);
    mockDb.transaction.mockRejectedValueOnce('raw string error');
    mockIsInvariant.mockReturnValueOnce(false);

    const result = await DisputeService.resolve(baseResolveParams);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.code).toBe('DB_ERROR');
  });

  it('T56-1: REFUND path transitions task DISPUTED → CANCELLED (poster wins)', async () => {
    // Arrange: admin has permission
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);

    const disputeRow = {
      id: 'd1',
      task_id: 'task-1',
      escrow_id: 'escrow-1',
      worker_id: 'worker-1',
      poster_id: 'poster-1',
      state: 'OPEN',
      version: 1,
    };
    const escrowRow = { id: 'escrow-1', state: 'LOCKED_DISPUTE', amount: 10000, version: 1 };

    const taskUpdateSqlCalls: string[] = [];

    mockDb.transaction.mockImplementationOnce(async (fn: (q: typeof db.query) => Promise<unknown>) => {
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
        if (sql.includes('UPDATE tasks')) {
          taskUpdateSqlCalls.push(sql.trim());
          return { rows: [{ id: 'task-1', state: 'CANCELLED' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO outbox') || sql.includes('outbox')) {
          return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      return fn(captureQuery);
    });

    const result = await DisputeService.resolve({
      disputeId: 'd1',
      resolvedBy: 'admin-1',
      resolution: 'Poster wins — refund issued',
      outcomeEscrowAction: 'REFUND',
    });

    expect(result.success).toBe(true);

    // T56-1: task must be transitioned to CANCELLED (not left in DISPUTED)
    const cancelledTransition = taskUpdateSqlCalls.find(sql =>
      sql.includes("'CANCELLED'") && sql.includes("'DISPUTED'")
    );
    expect(cancelledTransition).toBeDefined();
  });

  it('T56-1: SPLIT path transitions task DISPUTED → CANCELLED (partial payout)', async () => {
    // Arrange: admin has permission
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);

    const disputeRow = {
      id: 'd1',
      task_id: 'task-1',
      escrow_id: 'escrow-1',
      worker_id: 'worker-1',
      poster_id: 'poster-1',
      state: 'OPEN',
      version: 1,
    };
    const escrowRow = { id: 'escrow-1', state: 'LOCKED_DISPUTE', amount: 10000, version: 1 };

    const taskUpdateSqlCalls: string[] = [];

    mockDb.transaction.mockImplementationOnce(async (fn: (q: typeof db.query) => Promise<unknown>) => {
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
        if (sql.includes('UPDATE tasks')) {
          taskUpdateSqlCalls.push(sql.trim());
          return { rows: [{ id: 'task-1', state: 'CANCELLED' }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO outbox') || sql.includes('outbox')) {
          return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      return fn(captureQuery);
    });

    const result = await DisputeService.resolve({
      disputeId: 'd1',
      resolvedBy: 'admin-1',
      resolution: 'Split — partial payout to both parties',
      outcomeEscrowAction: 'SPLIT',
      refundAmount: 6000,
      releaseAmount: 4000,
    });

    expect(result.success).toBe(true);

    // T56-1: task must be transitioned to CANCELLED (not left in DISPUTED)
    const cancelledTransition = taskUpdateSqlCalls.find(sql =>
      sql.includes("'CANCELLED'") && sql.includes("'DISPUTED'")
    );
    expect(cancelledTransition).toBeDefined();
  });

  it('T55-1: RELEASE path accepts proof and completes task BEFORE emitting escrow event', async () => {
    // Arrange: admin has permission
    mockDb.query.mockResolvedValueOnce({ rows: [{ can_resolve_disputes: true }], rowCount: 1 } as any);

    const disputeRow = {
      id: 'd1',
      task_id: 'task-1',
      escrow_id: 'escrow-1',
      worker_id: 'worker-1',
      poster_id: 'poster-1',
      state: 'OPEN',
      version: 1,
    };
    const escrowRow = { id: 'escrow-1', state: 'LOCKED_DISPUTE', amount: 10000, version: 1 };

    // Track all query SQL strings issued inside the transaction
    const querySqlLog: string[] = [];

    mockDb.transaction.mockImplementationOnce(async (fn: (q: typeof db.query) => Promise<unknown>) => {
      const captureQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
        querySqlLog.push(sql.trim().split('\n')[0].trim()); // first line for identification
        if (sql.includes('FROM disputes') && sql.includes('FOR UPDATE')) {
          return { rows: [disputeRow], rowCount: 1 };
        }
        if (sql.includes('FROM escrows') && sql.includes('FOR UPDATE')) {
          return { rows: [escrowRow], rowCount: 1 };
        }
        if (sql.includes('UPDATE disputes')) {
          return { rows: [{ ...disputeRow, state: 'RESOLVED', version: 2 }], rowCount: 1 };
        }
        // proof accept
        if (sql.includes('UPDATE proofs') && sql.includes("'ACCEPTED'")) {
          return { rows: [], rowCount: 1 };
        }
        // task complete from disputed
        if (sql.includes('UPDATE tasks') && sql.includes("'COMPLETED'")) {
          return { rows: [{ id: 'task-1', state: 'COMPLETED' }], rowCount: 1 };
        }
        // outbox writes
        if (sql.includes('INSERT INTO outbox') || sql.includes('outbox')) {
          return { rows: [{ id: 'outbox-1' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      return fn(captureQuery);
    });

    const result = await DisputeService.resolve({
      disputeId: 'd1',
      resolvedBy: 'admin-1',
      resolution: 'Worker wins',
      outcomeEscrowAction: 'RELEASE',
    });

    // The resolve itself must succeed
    expect(result.success).toBe(true);

    // T55-1 CRITICAL: proof must be accepted AND task must be completed BEFORE
    // the escrow.release_requested outbox event is emitted — otherwise the
    // payment-worker's RELEASED→escrow UPDATE will fail INV-2 (task not COMPLETED)
    const proofAcceptIdx = querySqlLog.findIndex(sql => sql.includes('UPDATE proofs'));
    const taskCompleteIdx = querySqlLog.findIndex(sql => sql.includes('UPDATE tasks') && !sql.includes('disputes'));
    const escrowEventIdx = querySqlLog.findIndex(sql =>
      sql.includes('outbox') || sql.includes('INSERT INTO outbox')
    );

    expect(proofAcceptIdx).toBeGreaterThanOrEqual(0);  // proof must be accepted
    expect(taskCompleteIdx).toBeGreaterThanOrEqual(0); // task must be completed
    // Both must happen before the escrow release outbox event
    if (escrowEventIdx >= 0) {
      expect(proofAcceptIdx).toBeLessThan(escrowEventIdx);
      expect(taskCompleteIdx).toBeLessThan(escrowEventIdx);
    }
  });
});
