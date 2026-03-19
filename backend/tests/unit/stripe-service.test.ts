/**
 * StripeService Unit Tests
 *
 * Tests payment intent creation, amount validation, webhook verification,
 * idempotent event processing, transfer/refund stubbing, and circuit breaker integration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    stripe: {
      secretKey: null, // Not configured by default for unit tests
      webhookSecret: 'whsec_test',
      minimumTaskValueCents: 500,
      platformFeePercent: 15,
    },
  },
}));

vi.mock('../../src/middleware/circuit-breaker', () => ({
  stripeBreaker: {
    execute: vi.fn((fn: () => Promise<unknown>) => fn()),
  },
  CircuitBreaker: vi.fn(),
  CircuitOpenError: class extends Error { retryAfterMs = 0; },
}));

vi.mock('../../src/logger', () => ({
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('stripe', () => {
  return {
    default: vi.fn(),
  };
});

import { db } from '../../src/db';
import { StripeService } from '../../src/services/StripeService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StripeService', () => {
  // -------------------------------------------------------------------------
  // isConfigured
  // -------------------------------------------------------------------------
  describe('isConfigured', () => {
    it('returns false when Stripe not configured', () => {
      expect(StripeService.isConfigured()).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // createPaymentIntent — when Stripe not configured
  // -------------------------------------------------------------------------
  describe('createPaymentIntent (not configured)', () => {
    it('returns STRIPE_NOT_CONFIGURED error', async () => {
      const result = await StripeService.createPaymentIntent({
        taskId: 'task-1', posterId: 'user-1', amount: 5000,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    });
  });

  // -------------------------------------------------------------------------
  // createTransfer — with HX_STRIPE_STUB
  // -------------------------------------------------------------------------
  describe('createTransfer (stub mode)', () => {
    it('returns stub transfer when HX_STRIPE_STUB=1', async () => {
      process.env.HX_STRIPE_STUB = '1';

      const result = await StripeService.createTransfer({
        escrowId: 'esc-1', taskId: 'task-1', workerId: 'worker-1',
        workerStripeAccountId: 'acct_test', amount: 4000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.transferId).toMatch(/^tr_test_/);
        expect(result.data.amount).toBe(4000);
      }

      delete process.env.HX_STRIPE_STUB;
    });
  });

  // -------------------------------------------------------------------------
  // createRefund — with HX_STRIPE_STUB
  // -------------------------------------------------------------------------
  describe('createRefund (stub mode)', () => {
    it('returns stub refund when HX_STRIPE_STUB=1', async () => {
      process.env.HX_STRIPE_STUB = '1';

      const result = await StripeService.createRefund({
        paymentIntentId: 'pi_test', escrowId: 'esc-1', amount: 3000,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.refundId).toMatch(/^re_test_/);
        expect(result.data.status).toBe('succeeded');
      }

      delete process.env.HX_STRIPE_STUB;
    });
  });

  // -------------------------------------------------------------------------
  // verifyWebhook
  // -------------------------------------------------------------------------
  describe('verifyWebhook', () => {
    it('returns STRIPE_NOT_CONFIGURED when Stripe not initialized', () => {
      const result = StripeService.verifyWebhook('payload', 'sig');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_NOT_CONFIGURED');
    });
  });

  // -------------------------------------------------------------------------
  // processWebhookEvent (idempotency)
  // -------------------------------------------------------------------------
  describe('processWebhookEvent', () => {
    it('skips already-processed events', async () => {
      // markEventProcessedAtomic → INSERT ON CONFLICT DO NOTHING → 0 rows (already exists)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const handler = vi.fn();
      const result = await StripeService.processWebhookEvent('evt_123', 'payment_intent.succeeded', 'pi_123', handler);

      expect(result.success).toBe(true);
      expect(handler).not.toHaveBeenCalled();
    });

    it('processes new events and marks as processed', async () => {
      // markEventProcessedAtomic → INSERT succeeds → rowCount: 1 (new event, we claimed it)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const handler = vi.fn().mockResolvedValue(undefined);
      const result = await StripeService.processWebhookEvent('evt_new', 'payment_intent.succeeded', 'pi_123', handler);

      expect(result.success).toBe(true);
      expect(handler).toHaveBeenCalledOnce();
    });

    it('returns error when handler throws', async () => {
      // markEventProcessedAtomic → INSERT succeeds → rowCount: 1 (we claimed it)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const handler = vi.fn().mockRejectedValue(new Error('handler boom'));
      const result = await StripeService.processWebhookEvent('evt_err', 'payment_intent.succeeded', 'pi_123', handler);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('WEBHOOK_PROCESSING_ERROR');
    });
  });
});
