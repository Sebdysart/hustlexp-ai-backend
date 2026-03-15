/**
 * stripe-event-worker unit tests
 *
 * Covers new event handlers added in the P1 revenue-leak fix:
 * - invoice.paid       → RevenueService.logEvent subscription renewal
 * - charge.dispute.created  → ChargebackService.handleDisputeCreated
 * - charge.dispute.updated  → ChargebackService.handleDisputeUpdated
 * - charge.dispute.closed   → ChargebackService.handleDisputeClosed
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  workerLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../src/services/StripeSubscriptionProcessor.js', () => ({
  processSubscriptionEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/StripeEntitlementProcessor.js', () => ({
  processEntitlementPurchase: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/RevenueService.js', () => ({
  RevenueService: {
    logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }),
  },
}));

vi.mock('../../src/services/ChargebackService.js', () => ({
  ChargebackService: {
    handleDisputeCreated: vi.fn().mockResolvedValue({ success: true, data: { paymentDisputeId: 'pd-1' } }),
    handleDisputeUpdated: vi.fn().mockResolvedValue({ success: true, data: { updated: true } }),
    handleDisputeClosed: vi.fn().mockResolvedValue({ success: true, data: { resolved: true } }),
  },
}));

import { db } from '../../src/db';
import { processStripeEventJob } from '../../src/jobs/stripe-event-worker';
import { RevenueService } from '../../src/services/RevenueService.js';
import { ChargebackService } from '../../src/services/ChargebackService.js';
import type { Job } from 'bullmq';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(type: string, eventObject: Record<string, unknown>): Job {
  return { data: { stripeEventId: 'evt_test_123', type } } as unknown as Job;
}

function setupClaim(type: string, eventObject: Record<string, unknown>) {
  // claim query (UPDATE ... WHERE claimed_at IS NULL) → returns the event
  mockDb.query.mockResolvedValueOnce({
    rows: [{ payload_json: { id: 'evt_test_123', data: { object: eventObject } }, type }],
    rowCount: 1,
  } as never);
  // success update (result = 'success')
  mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('processStripeEventJob', () => {
  // -------------------------------------------------------------------------
  // invoice.paid
  // -------------------------------------------------------------------------
  describe('invoice.paid', () => {
    it('logs subscription renewal revenue when amount_paid > 0', async () => {
      const invoice = { metadata: { user_id: 'user-abc' }, amount_paid: 999 };
      setupClaim('invoice.paid', invoice);

      await processStripeEventJob(makeJob('invoice.paid', invoice));

      expect(RevenueService.logEvent).toHaveBeenCalledWith({
        eventType: 'subscription',
        userId: 'user-abc',
        amountCents: 999,
        stripeEventId: 'evt_test_123',
      });
    });

    it('skips logEvent when amount_paid is 0', async () => {
      const invoice = { metadata: { user_id: 'user-abc' }, amount_paid: 0 };
      setupClaim('invoice.paid', invoice);

      await processStripeEventJob(makeJob('invoice.paid', invoice));

      expect(RevenueService.logEvent).not.toHaveBeenCalled();
    });

    it('skips logEvent when user_id metadata is missing', async () => {
      const invoice = { metadata: {}, amount_paid: 999 };
      setupClaim('invoice.paid', invoice);

      await processStripeEventJob(makeJob('invoice.paid', invoice));

      expect(RevenueService.logEvent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // charge.dispute.created
  // -------------------------------------------------------------------------
  describe('charge.dispute.created', () => {
    it('calls ChargebackService.handleDisputeCreated with correct params', async () => {
      const dispute = {
        id: 'dp_abc',
        charge: 'ch_abc',
        payment_intent: 'pi_abc',
        amount: 5000,
        currency: 'usd',
        reason: 'fraudulent',
        status: 'needs_response',
      };
      setupClaim('charge.dispute.created', dispute);

      await processStripeEventJob(makeJob('charge.dispute.created', dispute));

      expect(ChargebackService.handleDisputeCreated).toHaveBeenCalledWith({
        stripeDisputeId: 'dp_abc',
        stripeChargeId: 'ch_abc',
        stripePaymentIntentId: 'pi_abc',
        stripeEventId: 'evt_test_123',
        amountCents: 5000,
        currency: 'usd',
        reason: 'fraudulent',
      });
    });

    it('passes null payment_intent when missing', async () => {
      const dispute = {
        id: 'dp_abc',
        charge: 'ch_abc',
        payment_intent: null,
        amount: 5000,
        currency: 'usd',
        reason: null,
        status: 'needs_response',
      };
      setupClaim('charge.dispute.created', dispute);

      await processStripeEventJob(makeJob('charge.dispute.created', dispute));

      expect(ChargebackService.handleDisputeCreated).toHaveBeenCalledWith(
        expect.objectContaining({ stripePaymentIntentId: null, reason: null })
      );
    });
  });

  // -------------------------------------------------------------------------
  // charge.dispute.updated
  // -------------------------------------------------------------------------
  describe('charge.dispute.updated', () => {
    it('calls ChargebackService.handleDisputeUpdated', async () => {
      const dispute = {
        id: 'dp_abc',
        status: 'under_review',
        reason: 'fraudulent',
      };
      setupClaim('charge.dispute.updated', dispute);

      await processStripeEventJob(makeJob('charge.dispute.updated', dispute));

      expect(ChargebackService.handleDisputeUpdated).toHaveBeenCalledWith({
        stripeDisputeId: 'dp_abc',
        stripeEventId: 'evt_test_123',
        status: 'under_review',
        reason: 'fraudulent',
      });
    });
  });

  // -------------------------------------------------------------------------
  // charge.dispute.closed
  // -------------------------------------------------------------------------
  describe('charge.dispute.closed', () => {
    it('calls ChargebackService.handleDisputeClosed with status "won"', async () => {
      const dispute = {
        id: 'dp_abc',
        status: 'won',
        reason: 'fraudulent',
      };
      setupClaim('charge.dispute.closed', dispute);

      await processStripeEventJob(makeJob('charge.dispute.closed', dispute));

      expect(ChargebackService.handleDisputeClosed).toHaveBeenCalledWith({
        stripeDisputeId: 'dp_abc',
        stripeEventId: 'evt_test_123',
        status: 'won',
        reason: 'fraudulent',
      });
    });

    it('calls ChargebackService.handleDisputeClosed with status "lost" for non-won outcomes', async () => {
      const dispute = {
        id: 'dp_abc',
        status: 'lost',
        reason: null,
      };
      setupClaim('charge.dispute.closed', dispute);

      await processStripeEventJob(makeJob('charge.dispute.closed', dispute));

      expect(ChargebackService.handleDisputeClosed).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'lost' })
      );
    });
  });

  // -------------------------------------------------------------------------
  // Already processed — no-op
  // -------------------------------------------------------------------------
  it('returns early when event is already claimed', async () => {
    // claim query returns 0 rows → already processed
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await processStripeEventJob(makeJob('invoice.paid', {}));

    expect(RevenueService.logEvent).not.toHaveBeenCalled();
    expect(ChargebackService.handleDisputeCreated).not.toHaveBeenCalled();
  });
});
