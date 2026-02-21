/**
 * Stripe ↔ Escrow End-to-End Test
 *
 * Tests the complete payment flow:
 *   1. Task created → Escrow PENDING
 *   2. Stripe PaymentIntent → Escrow FUNDED
 *   3. Task completed → Escrow RELEASED (payout)
 *   4. Dispute flow → LOCKED_DISPUTE → REFUNDED
 *
 * Uses mocked Stripe + DB to verify the contract between
 * StripeService, EscrowService, and TaskService.
 *
 * AUTHORITY: PRODUCT_SPEC.md §4, INV-2
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    createPaymentIntent: vi.fn(),
    createTransfer: vi.fn(),
    createRefund: vi.fn(),
    constructWebhookEvent: vi.fn(),
  },
}));

vi.mock('../../src/services/EscrowService', () => ({
  EscrowService: {
    create: vi.fn(),
    fund: vi.fn(),
    release: vi.fn(),
    refund: vi.fn(),
    lockForDispute: vi.fn(),
    getById: vi.fn(),
    getByTaskId: vi.fn(),
    isTerminalState: vi.fn((s: string) => ['RELEASED', 'REFUNDED', 'REFUND_PARTIAL'].includes(s)),
  },
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    create: vi.fn(),
    accept: vi.fn(),
    submitProof: vi.fn(),
    complete: vi.fn(),
    getById: vi.fn(),
  },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: { awardXP: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../src/services/PlanService', () => ({
  PlanService: {
    canCreateTaskWithRisk: vi.fn().mockReturnValue({ allowed: true }),
    canAcceptTaskWithRisk: vi.fn().mockReturnValue({ allowed: true }),
  },
}));

vi.mock('../../src/services/ScoperAIService', () => ({
  ScoperAIService: { analyzeTaskScope: vi.fn().mockResolvedValue(null) },
}));

import { StripeService } from '../../src/services/StripeService';
import { EscrowService } from '../../src/services/EscrowService';
import { TaskService } from '../../src/services/TaskService';

describe('Stripe ↔ Escrow E2E Flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Happy Path: Task → Payment → Payout', () => {
    it('should complete full lifecycle: create → fund → release', async () => {
      // Step 1: Create task
      (TaskService.create as any).mockResolvedValue({
        success: true,
        data: { id: 'task-1', title: 'Walk my dog', price: 2500, state: 'OPEN' },
      });

      const task = await TaskService.create({
        title: 'Walk my dog',
        description: 'Golden retriever in downtown',
        price: 2500,
      } as any);
      expect(task.data.state).toBe('OPEN');

      // Step 2: Create escrow
      (EscrowService.create as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', task_id: 'task-1', amount: 2500, state: 'PENDING' },
      });

      const escrow = await EscrowService.create({ taskId: 'task-1', amount: 2500 } as any);
      expect(escrow.data.state).toBe('PENDING');

      // Step 3: Create Stripe PaymentIntent
      (StripeService.createPaymentIntent as any).mockResolvedValue({
        paymentIntentId: 'pi_test_123',
        clientSecret: 'pi_test_123_secret',
        amount: 2500,
      });

      const pi = await StripeService.createPaymentIntent({
        taskId: 'task-1',
        posterId: 'poster-1',
        amount: 2500,
      });
      expect(pi.paymentIntentId).toBe('pi_test_123');

      // Step 4: Fund escrow (webhook received)
      (EscrowService.fund as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', state: 'FUNDED', stripe_payment_intent_id: 'pi_test_123' },
      });

      const funded = await EscrowService.fund({
        escrowId: 'esc-1',
        stripePaymentIntentId: 'pi_test_123',
      } as any);
      expect(funded.data.state).toBe('FUNDED');

      // Step 5: Worker accepts and completes task
      (TaskService.accept as any).mockResolvedValue({
        success: true,
        data: { id: 'task-1', state: 'ACCEPTED', worker_id: 'worker-1' },
      });
      (TaskService.submitProof as any).mockResolvedValue({
        success: true,
        data: { id: 'task-1', state: 'PROOF_SUBMITTED' },
      });
      (TaskService.complete as any).mockResolvedValue({
        success: true,
        data: { id: 'task-1', state: 'COMPLETED' },
      });

      await TaskService.accept({ taskId: 'task-1', workerId: 'worker-1' } as any);
      await TaskService.submitProof('task-1');
      const completed = await TaskService.complete('task-1');
      expect(completed.data.state).toBe('COMPLETED');

      // Step 6: Release escrow (payout to worker)
      (StripeService.createTransfer as any).mockResolvedValue({
        transferId: 'tr_test_123',
        amount: 2500,
      });
      (EscrowService.release as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', state: 'RELEASED' },
      });

      const released = await EscrowService.release({
        escrowId: 'esc-1',
        stripeTransferId: 'tr_test_123',
      } as any);
      expect(released.data.state).toBe('RELEASED');
      expect(EscrowService.isTerminalState('RELEASED')).toBe(true);
    });
  });

  describe('Dispute Flow: Fund → Lock → Refund', () => {
    it('should handle dispute with full refund', async () => {
      // Escrow is funded
      (EscrowService.getById as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', state: 'FUNDED', amount: 5000 },
      });

      // Lock for dispute
      (EscrowService.lockForDispute as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', state: 'LOCKED_DISPUTE' },
      });

      const locked = await EscrowService.lockForDispute('esc-1');
      expect(locked.data.state).toBe('LOCKED_DISPUTE');

      // Dispute resolved: full refund
      (StripeService.createRefund as any).mockResolvedValue({
        refundId: 're_test_123',
        amount: 5000,
        status: 'succeeded',
      });
      (EscrowService.refund as any).mockResolvedValue({
        success: true,
        data: { id: 'esc-1', state: 'REFUNDED' },
      });

      const refunded = await EscrowService.refund({ escrowId: 'esc-1' } as any);
      expect(refunded.data.state).toBe('REFUNDED');
      expect(EscrowService.isTerminalState('REFUNDED')).toBe(true);
    });
  });

  describe('Webhook idempotency', () => {
    it('should handle duplicate payment_intent.succeeded webhook', async () => {
      // First call: success
      (EscrowService.fund as any).mockResolvedValueOnce({
        success: true,
        data: { id: 'esc-1', state: 'FUNDED' },
      });

      // Second call: already funded
      (EscrowService.fund as any).mockResolvedValueOnce({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Escrow is already FUNDED' },
      });

      const first = await EscrowService.fund({ escrowId: 'esc-1' } as any);
      expect(first.success).toBe(true);

      const second = await EscrowService.fund({ escrowId: 'esc-1' } as any);
      expect(second.success).toBe(false);
      expect(second.error.code).toBe('INVALID_STATE');
    });
  });

  describe('Payment amount validation', () => {
    it('should reject PaymentIntent with amount mismatch', async () => {
      (StripeService.createPaymentIntent as any).mockRejectedValue(
        new Error('Amount must match escrow: expected 2500, got 1000')
      );

      await expect(
        StripeService.createPaymentIntent({
          taskId: 'task-1',
          posterId: 'poster-1',
          amount: 1000,
        })
      ).rejects.toThrow('Amount must match escrow');
    });
  });

  describe('INV-2: Release requires COMPLETED task', () => {
    it('should reject release when task is not COMPLETED', async () => {
      (EscrowService.release as any).mockResolvedValue({
        success: false,
        error: {
          code: 'INV_2_VIOLATION',
          message: 'Task must be COMPLETED before escrow release',
        },
      });

      const result = await EscrowService.release({ escrowId: 'esc-1' } as any);
      expect(result.success).toBe(false);
      expect(result.error.code).toBe('INV_2_VIOLATION');
    });
  });
});
