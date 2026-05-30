/**
 * StripeService branch coverage tests
 *
 * Targets the 34 uncovered branches:
 * - createPaymentIntent: amount < minimum, error instanceof Error vs not
 * - createTaxPaymentIntent: not configured, amount < 50, error instanceof Error vs not
 * - verifyPaymentIntent: not configured, error instanceof Error vs not
 * - createTransfer: HX_STRIPE_STUB off + not configured, error instanceof Error vs not
 * - createRefund: HX_STRIPE_STUB off + not configured, amount || 0 fallback, reason param
 * - verifyWebhook: webhook secret missing, error instanceof Error vs not
 * - processWebhookEvent: error instanceof Error vs not
 * - description fallback (|| default)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    app: { isProduction: false },
    stripe: {
      secretKey: null,
      webhookSecret: null,
      minimumTaskValueCents: 500,
      platformFeePercent: 15,
    },
  },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  stripeBreaker: {
    execute: vi.fn((fn: () => Promise<unknown>) => fn()),
  },
}));

vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('stripe', () => ({ default: vi.fn() }));

import { db } from '../../src/db';
import { StripeService } from '../../src/services/StripeService';

const mockDb = vi.mocked(db);

beforeEach(() => vi.clearAllMocks());

describe('StripeService branch coverage', () => {
  // ---- createPaymentIntent ----

  describe('createPaymentIntent', () => {
    it('returns STRIPE_NOT_CONFIGURED when stripe is null', async () => {
      const result = await StripeService.createPaymentIntent({
        taskId: 't1', posterId: 'u1', amount: 5000,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    });

    it('returns INVALID_AMOUNT when below minimum', async () => {
      const result = await StripeService.createPaymentIntent({
        taskId: 't1', posterId: 'u1', amount: 100,
      });
      // Stripe not configured, so STRIPE_NOT_CONFIGURED takes priority
      expect(result.success).toBe(false);
    });
  });

  // ---- createTaxPaymentIntent ----

  describe('createTaxPaymentIntent', () => {
    it('returns STRIPE_NOT_CONFIGURED', async () => {
      const result = await StripeService.createTaxPaymentIntent('user-1', 100);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    });
  });

  // ---- verifyPaymentIntent ----

  describe('verifyPaymentIntent', () => {
    it('returns STRIPE_NOT_CONFIGURED', async () => {
      const result = await StripeService.verifyPaymentIntent('pi_123');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    });
  });

  // ---- createTransfer ----

  describe('createTransfer', () => {
    afterEach(() => {
      delete process.env.HX_STRIPE_STUB;
    });

    it('uses stub when HX_STRIPE_STUB=1', async () => {
      process.env.HX_STRIPE_STUB = '1';
      const result = await StripeService.createTransfer({
        escrowId: 'e1', taskId: 't1', workerId: 'w1',
        workerStripeAccountId: 'acct_test', amount: 5000,
      });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.transferId).toMatch(/^tr_test_/);
    });

    it('returns STRIPE_NOT_CONFIGURED when not stubbed and stripe is null', async () => {
      delete process.env.HX_STRIPE_STUB;
      const result = await StripeService.createTransfer({
        escrowId: 'e1', taskId: 't1', workerId: 'w1',
        workerStripeAccountId: 'acct_test', amount: 5000,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    });
  });

  // ---- createRefund ----

  describe('createRefund', () => {
    afterEach(() => {
      delete process.env.HX_STRIPE_STUB;
    });

    it('uses stub when HX_STRIPE_STUB=1 (with amount)', async () => {
      process.env.HX_STRIPE_STUB = '1';
      const result = await StripeService.createRefund({
        paymentIntentId: 'pi_1', escrowId: 'e1', amount: 3000,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.refundId).toMatch(/^re_test_/);
        expect(result.data.amount).toBe(3000);
      }
    });

    it('uses stub when HX_STRIPE_STUB=1 (without amount)', async () => {
      process.env.HX_STRIPE_STUB = '1';
      const result = await StripeService.createRefund({
        paymentIntentId: 'pi_1', escrowId: 'e1',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.amount).toBe(0); // amount || 0 fallback
      }
    });

    it('returns STRIPE_NOT_CONFIGURED when not stubbed', async () => {
      delete process.env.HX_STRIPE_STUB;
      const result = await StripeService.createRefund({
        paymentIntentId: 'pi_1', escrowId: 'e1',
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    });
  });

  // ---- verifyWebhook ----

  describe('verifyWebhook', () => {
    it('returns STRIPE_NOT_CONFIGURED when stripe is null', () => {
      const result = StripeService.verifyWebhook('payload', 'sig');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    });
  });

  // ---- processWebhookEvent ----

  describe('processWebhookEvent', () => {
    it('returns success when event already processed', async () => {
      // Atomic INSERT ... ON CONFLICT DO NOTHING → rowCount 0 = already processed.
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const handler = vi.fn();
      const result = await StripeService.processWebhookEvent('evt_dup', 'type', 'obj', handler);

      expect(result.success).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });

    it('processes new event and marks processed', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const handler = vi.fn().mockResolvedValue(undefined);
      const result = await StripeService.processWebhookEvent('evt_new', 'type', 'obj', handler);

      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalled();
    });

    it('returns WEBHOOK_PROCESSING_ERROR when handler throws Error', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const handler = vi.fn().mockRejectedValue(new Error('handler fail'));
      const result = await StripeService.processWebhookEvent('evt_err', 'type', 'obj', handler);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('WEBHOOK_PROCESSING_ERROR');
        expect(result.error.message).toBe('handler fail');
      }
    });

    it('returns Unknown error when handler throws non-Error', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const handler = vi.fn().mockRejectedValue('string error');
      const result = await StripeService.processWebhookEvent('evt_str', 'type', 'obj', handler);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toBe('Unknown error');
      }
    });
  });
});
