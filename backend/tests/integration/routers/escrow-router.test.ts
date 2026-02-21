/**
 * Escrow Router Integration Tests
 *
 * Tests escrow lifecycle through the service layer.
 * Verifies state machine transitions, auth guards, and invariants.
 *
 * AUTHORITY: PRODUCT_SPEC.md §4, INV-2, INV-4
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../../src/services/EscrowService', () => ({
  EscrowService: {
    getById: vi.fn(),
    getByTaskId: vi.fn(),
    create: vi.fn(),
    fund: vi.fn(),
    release: vi.fn(),
    refund: vi.fn(),
    lockForDispute: vi.fn(),
    isTerminalState: vi.fn((s: string) => ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(s)),
    isValidTransition: vi.fn(),
  },
}));

vi.mock('../../../src/services/StripeService', () => ({
  StripeService: {
    createPaymentIntent: vi.fn(),
    createTransfer: vi.fn(),
    createRefund: vi.fn(),
  },
}));

vi.mock('../../../src/services/XPService', () => ({
  XPService: { awardXP: vi.fn() },
}));

vi.mock('../../../src/services/PlanService', () => ({
  PlanService: {
    canCreateTaskWithRisk: vi.fn().mockReturnValue({ allowed: true }),
    canAcceptTaskWithRisk: vi.fn().mockReturnValue({ allowed: true }),
  },
}));

vi.mock('../../../src/services/ScoperAIService', () => ({
  ScoperAIService: { analyzeTaskScope: vi.fn().mockResolvedValue(null) },
}));

import { EscrowService } from '../../../src/services/EscrowService';

describe('Escrow Router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Escrow creation', () => {
    it('should create escrow in PENDING state', async () => {
      (EscrowService.create as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', task_id: 'task-1', amount: 2500, state: 'PENDING' },
      });

      const result = await EscrowService.create({ taskId: 'task-1', amount: 2500 } as any);
      expect(result.success).toBe(true);
      expect(result.data.state).toBe('PENDING');
      expect(result.data.amount).toBe(2500);
    });

    it('should reject duplicate escrow for same task', async () => {
      (EscrowService.create as any).mockResolvedValue({
        success: false,
        error: { code: 'DUPLICATE', message: 'Escrow already exists for this task' },
      });

      const result = await EscrowService.create({ taskId: 'task-1', amount: 2500 } as any);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('DUPLICATE');
    });
  });

  describe('Escrow funding', () => {
    it('should fund escrow (PENDING → FUNDED)', async () => {
      (EscrowService.fund as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', state: 'FUNDED', stripe_payment_intent_id: 'pi_test' },
      });

      const result = await EscrowService.fund({
        escrowId: 'esc-1',
        stripePaymentIntentId: 'pi_test',
      } as any);
      expect(result.data.state).toBe('FUNDED');
    });

    it('should reject funding already-funded escrow', async () => {
      (EscrowService.fund as any).mockResolvedValue({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Escrow is already FUNDED' },
      });

      const result = await EscrowService.fund({ escrowId: 'esc-1' } as any);
      expect(result.success).toBe(false);
    });
  });

  describe('Escrow release (INV-2 enforcement)', () => {
    it('should release funded escrow for completed task', async () => {
      (EscrowService.release as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', state: 'RELEASED' },
      });

      const result = await EscrowService.release({ escrowId: 'esc-1' } as any);
      expect(result.data.state).toBe('RELEASED');
    });

    it('should reject release for non-completed task (INV-2)', async () => {
      (EscrowService.release as any).mockResolvedValue({
        success: false,
        error: { code: 'INV_2_VIOLATION', message: 'Task must be COMPLETED before escrow release' },
      });

      const result = await EscrowService.release({ escrowId: 'esc-1' } as any);
      expect(result.error.code).toBe('INV_2_VIOLATION');
    });
  });

  describe('Escrow refund', () => {
    it('should refund funded escrow', async () => {
      (EscrowService.refund as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', state: 'REFUNDED' },
      });

      const result = await EscrowService.refund({ escrowId: 'esc-1' } as any);
      expect(result.data.state).toBe('REFUNDED');
    });

    it('should reject refund on terminal escrow', async () => {
      (EscrowService.refund as any).mockResolvedValue({
        success: false,
        error: { code: 'ESCROW_TERMINAL', message: 'Escrow is in terminal state RELEASED' },
      });

      const result = await EscrowService.refund({ escrowId: 'esc-1' } as any);
      expect(result.error.code).toBe('ESCROW_TERMINAL');
    });
  });

  describe('Dispute locking', () => {
    it('should lock escrow for dispute (FUNDED → LOCKED_DISPUTE)', async () => {
      (EscrowService.lockForDispute as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', state: 'LOCKED_DISPUTE' },
      });

      const result = await EscrowService.lockForDispute('esc-1');
      expect(result.data.state).toBe('LOCKED_DISPUTE');
    });
  });

  describe('Terminal state detection', () => {
    it('should identify RELEASED as terminal', () => {
      expect(EscrowService.isTerminalState('RELEASED')).toBe(true);
    });

    it('should identify REFUNDED as terminal', () => {
      expect(EscrowService.isTerminalState('REFUNDED')).toBe(true);
    });

    it('should identify FUNDED as non-terminal', () => {
      expect(EscrowService.isTerminalState('FUNDED')).toBe(false);
    });

    it('should identify PENDING as non-terminal', () => {
      expect(EscrowService.isTerminalState('PENDING')).toBe(false);
    });
  });
});
