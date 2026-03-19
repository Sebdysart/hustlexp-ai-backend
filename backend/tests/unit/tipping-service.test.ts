/**
 * TippingService Unit Tests
 *
 * Tests tip creation (validation, Stripe), tip confirmation,
 * getting tips for tasks, and total tips received.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: { secretKey: 'sk_test_fake123' },
  },
}));

const mockCreatePaymentIntent = vi.fn();
const mockVerifyPaymentIntent = vi.fn();
const mockIsConfigured = vi.fn().mockReturnValue(true);

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    isConfigured: (...args: unknown[]) => mockIsConfigured(...args),
    createPaymentIntent: (...args: unknown[]) => mockCreatePaymentIntent(...args),
    verifyPaymentIntent: (...args: unknown[]) => mockVerifyPaymentIntent(...args),
  },
}));

import { db } from '../../src/db';
import { TippingService } from '../../src/services/TippingService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
  mockCreatePaymentIntent.mockReset();
  mockVerifyPaymentIntent.mockReset();
  mockIsConfigured.mockReturnValue(true);
});

describe('TippingService', () => {
  // --------------------------------------------------------------------------
  // createTip
  // --------------------------------------------------------------------------
  describe('createTip', () => {
    it('returns NOT_FOUND when task does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 500,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns INVALID_STATE when task not completed', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ state: 'in_progress', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
        rowCount: 1,
      } as never);

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 500,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_STATE');
    });

    it('returns UNAUTHORIZED when poster does not own task', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ state: 'completed', poster_id: 'other-poster', worker_id: 'worker-1', price: 5000 }],
        rowCount: 1,
      } as never);

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 500,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('UNAUTHORIZED');
    });

    it('returns INVALID_AMOUNT when tip below minimum ($1)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ state: 'completed', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
        rowCount: 1,
      } as never);

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 50, // Below $1 minimum
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_AMOUNT');
    });

    it('returns INVALID_AMOUNT when tip exceeds 50% of task price', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ state: 'completed', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
        rowCount: 1,
      } as never);

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 3000, // 60% of 5000
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_AMOUNT');
    });

    it('returns DUPLICATE when tip already exists', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ state: 'completed', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'tip-existing' }], rowCount: 1 } as never); // Existing tip

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 500,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DUPLICATE');
    });

    it('creates tip with Stripe payment intent', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ state: 'completed', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
          rowCount: 1,
        } as never) // Task check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // No existing tip (FOR UPDATE)
        .mockResolvedValueOnce({
          rows: [{ id: 'tip-1', task_id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', amount_cents: 500 }],
          rowCount: 1,
        } as never); // Tip insert

      mockCreatePaymentIntent.mockResolvedValueOnce({
        success: true,
        data: {
          paymentIntentId: 'pi_test_123',
          clientSecret: 'pi_test_123_secret_xxx',
          amount: 500,
        },
      });

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 500,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.clientSecret).toBe('pi_test_123_secret_xxx');
        expect(result.data.tipId).toBe('tip-1');
      }
    });

    it('allows tipping when task.price is null (H2: cap becomes Infinity)', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [{ state: 'completed', poster_id: 'poster-1', worker_id: 'worker-1', price: null }],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({
          rows: [{ id: 'tip-2', task_id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', amount_cents: 2000 }],
          rowCount: 1,
        } as never);

      mockCreatePaymentIntent.mockResolvedValueOnce({
        success: true,
        data: { paymentIntentId: 'pi_null', clientSecret: 'cs_null', amount: 2000 },
      });

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 2000,
      });

      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // confirmTip
  // --------------------------------------------------------------------------
  describe('confirmTip', () => {
    it('confirms tip when payment succeeded', async () => {
      mockVerifyPaymentIntent.mockResolvedValueOnce({
        success: true,
        data: { status: 'succeeded', amountCents: 500, metadata: {} },
      });

      const tip = {
        id: 'tip-1',
        task_id: 'task-1',
        poster_id: 'poster-1',
        worker_id: 'worker-1',
        amount_cents: 500,
        stripe_payment_intent_id: 'pi_123',
        status: 'completed',
        completed_at: new Date(),
        created_at: new Date(),
      };

      mockDb.query
        .mockResolvedValueOnce({ rows: [tip], rowCount: 1 } as never) // UPDATE tip
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // INSERT notification

      const result = await TippingService.confirmTip('tip-1', 'pi_123');

      expect(result.success).toBe(true);
    });

    it('returns error when payment not succeeded', async () => {
      mockVerifyPaymentIntent.mockResolvedValueOnce({
        success: true,
        data: { status: 'requires_payment_method', amountCents: 500, metadata: {} },
      });

      const result = await TippingService.confirmTip('tip-1', 'pi_123');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('PAYMENT_NOT_SUCCEEDED');
    });

    it('returns NOT_FOUND when tip record not found', async () => {
      mockVerifyPaymentIntent.mockResolvedValueOnce({
        success: true,
        data: { status: 'succeeded', amountCents: 500, metadata: {} },
      });
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await TippingService.confirmTip('tip-1', 'pi_123');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // --------------------------------------------------------------------------
  // getTipsForTask
  // --------------------------------------------------------------------------
  describe('getTipsForTask', () => {
    it('returns tips for a task', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'tip-1', amount_cents: 500 }],
        rowCount: 1,
      } as never);

      const result = await TippingService.getTipsForTask('task-1');

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toHaveLength(1);
    });

    it('returns empty array when no tips', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await TippingService.getTipsForTask('task-1');

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // getTotalTipsReceived
  // --------------------------------------------------------------------------
  describe('getTotalTipsReceived', () => {
    it('returns total tips and count', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total: '1500', count: '3' }],
        rowCount: 1,
      } as never);

      const result = await TippingService.getTotalTipsReceived('worker-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totalCents).toBe(1500);
        expect(result.data.count).toBe(3);
      }
    });

    it('returns zero when no tips received', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total: '0', count: '0' }],
        rowCount: 1,
      } as never);

      const result = await TippingService.getTotalTipsReceived('worker-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totalCents).toBe(0);
        expect(result.data.count).toBe(0);
      }
    });

    it('returns error on DB failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('timeout'));

      const result = await TippingService.getTotalTipsReceived('worker-1');

      expect(result.success).toBe(false);
    });
  });
});
