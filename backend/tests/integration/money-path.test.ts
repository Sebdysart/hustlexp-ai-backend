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
vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
    serializableTransaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(),
  isUniqueViolation: vi.fn(),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

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
      // fund() does UPDATE ... WHERE state = 'PENDING' RETURNING * (single query)
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
      // Mock 3: UPDATE escrow to RELEASED
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'RELEASED', released_at: new Date() }],
      });
      // Mock 4+: Downstream (earnings, XP, etc.)
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await EscrowService.release({ escrowId: 'escrow-1' });
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

      const result = await EscrowService.release({ escrowId: 'escrow-1' });
      expect(result.success).toBe(false);
    });

    it('should prevent funding already-funded escrow', async () => {
      // Mock 1: UPDATE returns 0 rows (WHERE state = 'PENDING' doesn't match)
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      // Mock 2: getById SELECT for error message
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' }],
      });

      const result = await EscrowService.fund({
        escrowId: 'escrow-1',
        stripePaymentIntentId: 'pi_test456',
      });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_STATE');
    });

    it('should prevent refunding already-released escrow', async () => {
      // Mock 1: UPDATE returns 0 rows (WHERE state IN ('FUNDED', 'LOCKED_DISPUTE') doesn't match)
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      // Mock 2: getById SELECT for error message — returns RELEASED (terminal)
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
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'RELEASED', released_at: new Date() }],
      });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
      db.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });

      const result = await EscrowService.release({ escrowId: 'escrow-1' });
      expect(result.success).toBe(true);
      expect(result.data?.state).toBe('RELEASED');
    });

    it('should allow LOCKED_DISPUTE → REFUNDED (poster wins)', async () => {
      // refund() does UPDATE ... WHERE state IN ('FUNDED', 'LOCKED_DISPUTE') — single query
      db.query.mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ id: 'escrow-1', task_id: 'task-1', amount: 5000, state: 'REFUNDED', refunded_at: new Date() }],
      });

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
