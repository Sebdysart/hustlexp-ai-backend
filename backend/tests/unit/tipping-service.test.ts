/**
 * TippingService Unit Tests
 *
 * Tests tip creation (validation, Stripe), tip confirmation,
 * getting tips for tasks, and total tips received.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted() runs before vi.mock() hoisting, so these refs are safe to use
// inside the MockStripe class initializer even though vi.mock is hoisted.
const { mockPaymentIntentsCreate, mockPaymentIntentsRetrieve, mockPaymentIntentsCancel } = vi.hoisted(() => ({
  mockPaymentIntentsCreate: vi.fn(),
  mockPaymentIntentsRetrieve: vi.fn(),
  mockPaymentIntentsCancel: vi.fn(),
}));

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      // Pass the same queryFn into the transaction callback so that
      // mockResolvedValueOnce sequences flow through seamlessly.
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
  };
});

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

vi.mock('stripe', () => {
  return {
    default: class MockStripe {
      paymentIntents = {
        create: mockPaymentIntentsCreate,
        retrieve: mockPaymentIntentsRetrieve,
        cancel: mockPaymentIntentsCancel,
      };
    },
  };
});

import { db } from '../../src/db';
import { TippingService } from '../../src/services/TippingService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.resetAllMocks();
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
        rows: [{ state: 'COMPLETED', poster_id: 'other-poster', worker_id: 'worker-1', price: 5000 }],
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

    it('returns NO_WORKER when task has no assigned worker', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ state: 'COMPLETED', poster_id: 'poster-1', worker_id: null, price: 5000 }],
        rowCount: 1,
      } as never);

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 500,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NO_WORKER');
    });

    it('returns INVALID_AMOUNT when tip below minimum ($1)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ state: 'COMPLETED', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
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
        rows: [{ state: 'COMPLETED', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
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
        // 1. Task validation (outside transaction)
        .mockResolvedValueOnce({
          rows: [{ state: 'COMPLETED', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
          rowCount: 1,
        } as never)
        // 2. Advisory lock (first call inside transaction — result is discarded)
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as never)
        // 3. SELECT ... FOR UPDATE inside transaction — existing tip found
        .mockResolvedValueOnce({ rows: [{ id: 'tip-existing' }], rowCount: 1 } as never);

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
        // 1. Task validation (outside transaction)
        .mockResolvedValueOnce({
          rows: [{ state: 'COMPLETED', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
          rowCount: 1,
        } as never)
        // 2. Advisory lock (first call inside transaction — result is discarded)
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as never)
        // 3. SELECT ... FOR UPDATE inside transaction — no existing tip
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // 4. Worker Stripe Connect account (inside transaction)
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_worker' }], rowCount: 1 } as never)
        // 5. INSERT tip — plain db.query() OUTSIDE the transaction (TT-06 fix)
        .mockResolvedValueOnce({
          rows: [{ id: 'tip-1', task_id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1', amount_cents: 500 }],
          rowCount: 1,
        } as never);

      mockPaymentIntentsCreate.mockResolvedValueOnce({
        id: 'pi_test_123',
        client_secret: 'pi_test_123_secret_xxx',
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

      // FFF-01: Verify idempotency key is passed to prevent orphaned PIs on retry
      expect(mockPaymentIntentsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 500, currency: 'usd' }),
        { idempotencyKey: 'tip_pi_task-1_poster-1' }
      );
    });

    it('cancels orphaned Stripe PI when tip INSERT fails (TT-06)', async () => {
      mockDb.query
        // 1. Task validation
        .mockResolvedValueOnce({
          rows: [{ state: 'COMPLETED', poster_id: 'poster-1', worker_id: 'worker-1', price: 5000 }],
          rowCount: 1,
        } as never)
        // 2. Advisory lock (first call inside transaction — result is discarded)
        .mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as never)
        // 3. SELECT ... FOR UPDATE — no duplicate
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        // 4. Worker Stripe Connect account
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: null }], rowCount: 1 } as never)
        // 5. INSERT tip — DB failure after PI created (outside transaction, TT-06 fix)
        .mockRejectedValueOnce(new Error('unique_violation') as never);

      mockPaymentIntentsCreate.mockResolvedValueOnce({
        id: 'pi_orphan_123',
        client_secret: 'pi_orphan_123_secret',
      });
      mockPaymentIntentsCancel.mockResolvedValueOnce({ id: 'pi_orphan_123', status: 'canceled' });

      const result = await TippingService.createTip({
        taskId: 'task-1',
        posterId: 'poster-1',
        amountCents: 500,
      });

      // The PI should have been cancelled to avoid orphaning
      expect(mockPaymentIntentsCancel).toHaveBeenCalledWith('pi_orphan_123');
      // The overall result should report failure
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('TIP_CREATION_FAILED');
    });
  });

  // --------------------------------------------------------------------------
  // confirmTip
  // --------------------------------------------------------------------------
  describe('confirmTip', () => {
    // Convenience: a PI object that passes all TT-02 checks
    const validPi = {
      status: 'succeeded',
      amount: 500,
      metadata: { type: 'tip', task_id: 'task-1' },
    };

    it('confirms tip when payment succeeded', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValueOnce(validPi);

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
        // TT-02 + Fix 4: SELECT amount_cents, task_id
        .mockResolvedValueOnce({ rows: [{ amount_cents: 500, task_id: 'task-1' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [tip], rowCount: 1 } as never) // UPDATE tip
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // INSERT notification

      const result = await TippingService.confirmTip('tip-1', 'pi_123');

      expect(result.success).toBe(true);
    });

    it('returns INVALID_PAYMENT_INTENT when PI metadata.type is not "tip" (TT-02)', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValueOnce({
        status: 'succeeded',
        amount: 500,
        metadata: { type: 'escrow', task_id: 'task-1' },
      });

      const result = await TippingService.confirmTip('tip-1', 'pi_123');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_PAYMENT_INTENT');
    });

    it('returns INVALID_PAYMENT_INTENT when PI metadata.type is missing (TT-02)', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValueOnce({
        status: 'succeeded',
        amount: 500,
        metadata: {},
      });

      const result = await TippingService.confirmTip('tip-1', 'pi_123');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_PAYMENT_INTENT');
    });

    it('returns INVALID_PAYMENT_INTENT when PI metadata.task_id does not match tip task_id (TT-02)', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValueOnce({
        status: 'succeeded',
        amount: 500,
        metadata: { type: 'tip', task_id: 'task-DIFFERENT' },
      });
      mockDb.query.mockResolvedValueOnce({
        rows: [{ amount_cents: 500, task_id: 'task-1' }],
        rowCount: 1,
      } as never);

      const result = await TippingService.confirmTip('tip-1', 'pi_123');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_PAYMENT_INTENT');
    });

    it('returns PAYMENT_AMOUNT_MISMATCH when PI amount does not match tip amount (Fix 4)', async () => {
      // payment.amount=1000 does NOT match tip amount_cents=500
      mockPaymentIntentsRetrieve.mockResolvedValueOnce({
        status: 'succeeded',
        amount: 1000,
        metadata: { type: 'tip', task_id: 'task-1' },
      });
      mockDb.query.mockResolvedValueOnce({
        rows: [{ amount_cents: 500, task_id: 'task-1' }],
        rowCount: 1,
      } as never);

      const result = await TippingService.confirmTip('tip-1', 'pi_123');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
    });

    it('returns error when payment not succeeded', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValueOnce({
        status: 'requires_payment_method',
        amount: 500,
        metadata: { type: 'tip', task_id: 'task-1' },
      });

      const result = await TippingService.confirmTip('tip-1', 'pi_123');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('PAYMENT_NOT_SUCCEEDED');
    });

    it('returns NOT_FOUND when tip record not found (amount/task_id check query returns empty)', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValueOnce(validPi);
      // SELECT amount_cents, task_id returns empty — tip not found
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
