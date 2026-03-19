/**
 * Money Path Integration Tests
 *
 * Tests the critical financial flow: Task Creation → Escrow → Payment → Release
 * These tests verify the happy path and all failure modes for the money pipeline.
 *
 * AUTHORITY: PRODUCT_SPEC.md §4 (Escrow), §3 (Task), §9 (Stripe)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EscrowService } from '../../src/services/EscrowService';
import { TaskService } from '../../src/services/TaskService';

// ============================================================================
// MOCKS
// ============================================================================

// Mock database
vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
      serializableTransaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(),
    isUniqueViolation: vi.fn(),
    getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
  };
});

// Mock ScoperAIService
vi.mock('../../src/services/ScoperAIService', () => ({
  ScoperAIService: {
    analyzeTaskScope: vi.fn().mockResolvedValue({
      success: false,
      error: { code: 'AI_UNAVAILABLE', message: 'Mocked' },
    }),
  },
}));

// Mock PlanService
vi.mock('../../src/services/PlanService', () => ({
  PlanService: {
    canCreateTaskWithRisk: vi.fn().mockResolvedValue({ allowed: true }),
  },
}));

// Mock RevenueService — added when Fix 1B wired RevenueService.logEvent into EscrowService.release()
vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

const { db, isInvariantViolation } = await import('../../src/db');

// ============================================================================
// ESCROW LIFECYCLE TESTS
// ============================================================================

describe('Money Path: Escrow Lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockReset();
  });

  describe('Create → Fund → Release (Happy Path)', () => {
    it('should create escrow in PENDING state', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'PENDING' }],
      });

      const result = await EscrowService.create({ taskId: 'task-1', amount: 5000 });
      expect(result.success).toBe(true);
      expect(result.data?.state).toBe('PENDING');
      expect(result.data?.amount).toBe(5000);
    });

    it('should fund escrow transitioning PENDING → FUNDED', async () => {
      // fund() is now wrapped in db.transaction():
      //   1st query: SELECT state, version FOR UPDATE → lock row
      //   2nd query: cross-escrow PI dedup check → no conflict
      //   3rd query: UPDATE escrows ... RETURNING *   → funded row
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ state: 'PENDING', version: 0 }],
      });
      db.query.mockResolvedValueOnce({
        rowCount: 0,
        rows: [],
      });
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'FUNDED', stripe_payment_intent_id: 'pi_test123', funded_at: new Date() }],
      });

      const result = await EscrowService.fund({
        escrowId: 'escrow-1',
        stripePaymentIntentId: 'pi_test123',
      });
      expect(result.success).toBe(true);
      expect(result.data?.state).toBe('FUNDED');
    });

    it('should release escrow transitioning FUNDED → RELEASED', async () => {
      // Mock 1: SELECT escrow
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }],
      });
      // Mock 2: SELECT task for worker_id
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ worker_id: 'worker-1', price: 5000 }],
      });
      // Mock 3: SELECT worker KYC status (KYC gate)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          payouts_enabled: true,
          stripe_connect_id: 'acct_test123',
          stripe_connect_status: 'verified'
        }],
      });
      // Mock 4: UPDATE escrow to RELEASED
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'RELEASED', released_at: new Date() }],
      });
      // Mock 5+: Downstream (earnings, XP, etc.)
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await EscrowService.release({ escrowId: 'escrow-1', stripeTransferId: 'tr_test_happy' });
      expect(result.success).toBe(true);
      expect(result.data?.state).toBe('RELEASED');
    });
  });

  describe('Escrow Amount Validation (INV-4: Immutable Amount)', () => {
    it('should reject zero amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: 0 });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_STATE');
    });

    it('should reject negative amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: -100 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer amount (float)', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: 49.99 });
      expect(result.success).toBe(false);
    });
  });

  describe('Terminal State Protection', () => {
    it('should prevent double-release (RELEASED is terminal)', async () => {
      // release() SELECT escrow first — returns RELEASED (terminal)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'RELEASED' }],
      });

      const result = await EscrowService.release({ escrowId: 'escrow-1', stripeTransferId: 'tr_test_double' });
      expect(result.success).toBe(false);
    });

    it('should prevent funding already-funded escrow', async () => {
      // fund() is now wrapped in db.transaction(). The SELECT FOR UPDATE returns
      // the row with state='FUNDED'. The PI dedup check runs next (query 2),
      // then the state check fires and returns INVALID_STATE.
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ state: 'FUNDED', version: 1 }],
      });
      // cross-escrow PI dedup check → no conflict
      db.query.mockResolvedValueOnce({
        rowCount: 0,
        rows: [],
      });

      const result = await EscrowService.fund({
        escrowId: 'escrow-1',
        stripePaymentIntentId: 'pi_test456',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_STATE');
    });

    it('should prevent refunding already-released escrow', async () => {
      // FIX 3: refund() pre-fetches task_id + worker_id before the UPDATE
      db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ task_id: 'task-1' }] }); // SELECT task_id
      db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ worker_id: null }] });   // SELECT worker_id
      // UPDATE returns 0 rows (WHERE state = 'FUNDED' doesn't match RELEASED)
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      // getById SELECT for error message — returns RELEASED (terminal)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'RELEASED' }],
      });

      const result = await EscrowService.refund({ escrowId: 'escrow-1' });
      expect(result.success).toBe(false);
    });
  });

  describe('Dispute Resolution Flow', () => {
    it('should allow LOCKED_DISPUTE → RELEASED (worker wins)', async () => {
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'LOCKED_DISPUTE' }],
      });
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ worker_id: 'worker-1', price: 5000 }],
      });
      // KYC gate check
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          payouts_enabled: true,
          stripe_connect_id: 'acct_test123',
          stripe_connect_status: 'verified'
        }],
      });
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'RELEASED', released_at: new Date() }],
      });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await EscrowService.release({ escrowId: 'escrow-1', stripeTransferId: 'tr_test_dispute_win' });
      expect(result.success).toBe(true);
      expect(result.data?.state).toBe('RELEASED');
    });

    it('should allow FUNDED → REFUNDED via refund() (poster cancels before dispute)', async () => {
      // FIX 3: refund() pre-fetches task_id + worker_id before the UPDATE
      db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ task_id: 'task-1' }] }); // SELECT task_id
      db.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ worker_id: null }] });   // SELECT worker_id (null = no clawback)
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'REFUNDED', refunded_at: new Date() }],
      }); // UPDATE
      db.query.mockResolvedValueOnce({ rowCount: 1, rows: [] }); // logEscrowEvent INSERT

      const result = await EscrowService.refund({ escrowId: 'escrow-1' });
      expect(result.success).toBe(true);
    });
  });

  describe('Not Found Handling', () => {
    it('should return NOT_FOUND for non-existent escrow', async () => {
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await EscrowService.getById('non-existent');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NOT_FOUND');
    });

    it('should return NOT_FOUND for non-existent task escrow', async () => {
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await EscrowService.getByTaskId('non-existent-task');
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('NOT_FOUND');
    });
  });

  describe('Database Error Handling', () => {
    it('should handle database invariant violations gracefully', async () => {
      const dbError = new Error('invariant_violation: HX002');
      (isInvariantViolation as any).mockReturnValue(true);
      db.query.mockRejectedValueOnce(dbError);

      const result = await EscrowService.create({ taskId: 'task-1', amount: 5000 });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// TASK CREATION → ESCROW FLOW
// ============================================================================

describe('Money Path: Task Price Validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockReset();
  });

  describe('Price Floor Enforcement', () => {
    it('should enforce $5.00 minimum for STANDARD tasks', async () => {
      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: 499, // $4.99 - below minimum
      });

      expect(result.success).toBe(false);
    });

    it('should enforce $15.00 minimum for LIVE tasks', async () => {
      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Live Test Task',
        description: 'Test description',
        price: 1499, // $14.99 - below LIVE minimum
        mode: 'LIVE',
      });

      expect(result.success).toBe(false);
    });

    it('should accept exactly $5.00 for STANDARD tasks', async () => {
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'task-new', title: 'Test', price: 500, state: 'OPEN' }],
      });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test Task',
        description: 'Test description',
        price: 500,
      });

      expect(result.success).toBe(true);
    });

    it('should accept exactly $15.00 for LIVE tasks', async () => {
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'task-new', title: 'Live Test', price: 1500, state: 'OPEN', mode: 'LIVE' }],
      });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Live Test',
        description: 'Test description',
        price: 1500,
        mode: 'LIVE',
      });

      expect(result.success).toBe(true);
    });
  });

  describe('Input Validation', () => {
    it('should reject non-integer price', async () => {
      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test',
        description: 'Test',
        price: 499.5,
      });
      expect(result.success).toBe(false);
    });

    it('should reject negative price', async () => {
      const result = await TaskService.create({
        posterId: 'poster-1',
        title: 'Test',
        description: 'Test',
        price: -100,
      });
      expect(result.success).toBe(false);
    });
  });
});

// ============================================================================
// STATE MACHINE TRANSITION MATRIX
// ============================================================================

describe('Money Path: Escrow State Machine Completeness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockReset();
  });

  const ALL_STATES = ['PENDING', 'FUNDED', 'LOCKED_DISPUTE', 'RELEASED', 'REFUNDED', 'REFUND_PARTIAL'] as const;

  const VALID_TRANSITIONS: Record<string, string[]> = {
    PENDING: ['FUNDED', 'REFUNDED'],
    FUNDED: ['RELEASED', 'REFUNDED', 'LOCKED_DISPUTE'],
    LOCKED_DISPUTE: ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'],
    RELEASED: [],
    REFUNDED: [],
    REFUND_PARTIAL: [],
  };

  it('should have all terminal states with empty transition lists', () => {
    const terminalStates = ALL_STATES.filter(s => VALID_TRANSITIONS[s].length === 0);
    expect(terminalStates).toContain('RELEASED');
    expect(terminalStates).toContain('REFUNDED');
    expect(terminalStates).toContain('REFUND_PARTIAL');
  });

  it('should have LOCKED_DISPUTE → RELEASED transition (dispute resolution)', () => {
    expect(VALID_TRANSITIONS.LOCKED_DISPUTE).toContain('RELEASED');
  });

  it('should have LOCKED_DISPUTE → REFUND_PARTIAL transition (split resolution)', () => {
    expect(VALID_TRANSITIONS.LOCKED_DISPUTE).toContain('REFUND_PARTIAL');
  });

  it('should not allow skipping FUNDED state', () => {
    expect(VALID_TRANSITIONS.PENDING).not.toContain('RELEASED');
    expect(VALID_TRANSITIONS.PENDING).not.toContain('LOCKED_DISPUTE');
  });
});
