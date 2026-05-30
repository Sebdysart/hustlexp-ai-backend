/**
 * ChargebackService Unit Tests
 *
 * Tests dispute lifecycle: creation (idempotent), update, close (won/lost),
 * ledger entries, payout freeze, trust downgrade, and dispute rate calculations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: {
    logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }),
  },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    submitDisputeEvidence: vi.fn().mockResolvedValue({ success: true, data: undefined }),
  },
}));

vi.mock('../../src/logger', () => ({
  stripeLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { db } from '../../src/db';
import { ChargebackService } from '../../src/services/ChargebackService';
import { RevenueService } from '../../src/services/RevenueService';
import { StripeService } from '../../src/services/StripeService';

const mockDb = vi.mocked(db);
const mockRevenueLog = vi.mocked(RevenueService.logEvent);
const mockSubmitEvidence = vi.mocked(StripeService.submitDisputeEvidence);

function makeDisputeParams(overrides: Record<string, unknown> = {}) {
  return {
    stripeDisputeId: 'dp_test_123',
    stripeChargeId: 'ch_test_123',
    stripePaymentIntentId: 'pi_test_123',
    stripeEventId: 'evt_test_123',
    amountCents: 5000,
    currency: 'usd',
    reason: 'fraudulent',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRevenueLog.mockResolvedValue({ success: true, data: { id: 'rev-1' } });
});

describe('ChargebackService', () => {
  // -------------------------------------------------------------------------
  // handleDisputeCreated
  // -------------------------------------------------------------------------
  describe('handleDisputeCreated', () => {
    it('creates dispute, logs negative ledger entry, freezes payouts', async () => {
      const params = makeDisputeParams();

      // 1. Find escrow by payment intent
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'esc-1', task_id: 'task-1', state: 'FUNDED' }], rowCount: 1,
      } as never);
      // 2. Find poster from task
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: 'user-1' }], rowCount: 1,
      } as never);
      // 3. INSERT payment_disputes (new)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pd-1' }], rowCount: 1,
      } as never);
      // 4. UPDATE payment_disputes with reversal ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 5. UPDATE users SET payouts_locked
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 6. UPDATE payment_disputes SET payouts_were_frozen
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 7. SELECT trust_tier, dispute_count
      mockDb.query.mockResolvedValueOnce({
        rows: [{ trust_tier: 3, dispute_count: 1 }], rowCount: 1,
      } as never);
      // 8. UPDATE escrows SET state = LOCKED_DISPUTE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeCreated(params);

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.paymentDisputeId).toBe('pd-1');

      // Verify negative ledger entry was logged
      expect(mockRevenueLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'chargeback',
          amountCents: -5000,
        })
      );
    });

    it('is idempotent on duplicate stripe_dispute_id', async () => {
      const params = makeDisputeParams();

      // Find escrow
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'esc-1', task_id: 'task-1', state: 'FUNDED' }], rowCount: 1,
      } as never);
      // Find poster
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: 'user-1' }], rowCount: 1,
      } as never);
      // INSERT returns 0 rows (ON CONFLICT DO NOTHING)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // SELECT existing
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pd-existing' }], rowCount: 1,
      } as never);

      const result = await ChargebackService.handleDisputeCreated(params);

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.paymentDisputeId).toBe('pd-existing');
      // Should NOT log another ledger entry (idempotent)
      expect(mockRevenueLog).not.toHaveBeenCalled();
    });

    it('downgrades trust tier on 2nd dispute', async () => {
      const params = makeDisputeParams();

      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', state: 'FUNDED' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-2' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // link reversal
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // freeze payouts
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // payouts_were_frozen
      // dispute_count = 2, trust_tier = 3 -> should drop to 2
      mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 3, dispute_count: 2 }], rowCount: 1 } as never);
      // UPDATE users SET trust_tier
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // INSERT trust_ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // UPDATE payment_disputes trust_was_downgraded
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // LOCK escrow
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeCreated(params);
      expect(result.success).toBe(true);

      // Verify trust downgrade query was called with tier 2
      const trustUpdateCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('UPDATE users SET trust_tier')
      );
      expect(trustUpdateCall).toBeDefined();
      expect(trustUpdateCall![1]).toContain(2); // new tier
    });

    it('drops to tier 1 on 3+ disputes', async () => {
      const params = makeDisputeParams();

      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', state: 'FUNDED' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-3' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // dispute_count = 3 -> drop to tier 1
      mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 4, dispute_count: 3 }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeCreated(params);
      expect(result.success).toBe(true);

      const trustUpdateCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('UPDATE users SET trust_tier')
      );
      expect(trustUpdateCall).toBeDefined();
      expect(trustUpdateCall![1]).toContain(1); // dropped to tier 1
    });
  });

  // -------------------------------------------------------------------------
  // handleDisputeUpdated
  // -------------------------------------------------------------------------
  describe('handleDisputeUpdated', () => {
    it('updates status of existing dispute', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeUpdated({
        stripeDisputeId: 'dp_test', stripeEventId: 'evt_1',
        status: 'under_review', reason: null,
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.updated).toBe(true);
    });

    it('returns updated=false when dispute not found or terminal', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await ChargebackService.handleDisputeUpdated({
        stripeDisputeId: 'dp_missing', stripeEventId: 'evt_1',
        status: 'under_review', reason: null,
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.updated).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // handleDisputeClosed
  // -------------------------------------------------------------------------
  describe('handleDisputeClosed', () => {
    it('logs positive reversal entry when dispute won', async () => {
      // Fetch dispute
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'pd-1', stripe_dispute_id: 'dp_1', stripe_charge_id: 'ch_1',
          user_id: 'user-1', escrow_id: 'esc-1', task_id: 'task-1',
          amount_cents: 5000, status: 'open',
        }],
        rowCount: 1,
      } as never);
      // Check other open disputes
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
      // Unlock payouts
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // Mark resolved
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_1', stripeEventId: 'evt_close',
        status: 'won', reason: null,
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.resolved).toBe(true);

      // Verify positive reversal logged
      expect(mockRevenueLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'chargeback_reversal',
          amountCents: 5000, // positive
        })
      );
    });

    it('restores trust tier when a downgraded dispute is won and no other disputes remain', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'pd-1', stripe_dispute_id: 'dp_1', stripe_charge_id: 'ch_1',
          user_id: 'user-1', escrow_id: 'esc-1', task_id: 'task-1',
          amount_cents: 5000, status: 'open',
          trust_was_downgraded: true, previous_trust_tier: 3,
        }],
        rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never); // other open disputes (payout unlock)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);               // unlock payouts
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never); // otherNonWon → 0
      mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 } as never); // current tier (still demoted)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);               // UPDATE users trust_tier
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);               // INSERT trust_ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);               // mark resolved

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_1', stripeEventId: 'evt_close', status: 'won', reason: null,
      });
      expect(result.success).toBe(true);

      const calls = mockDb.query.mock.calls;
      const restore = calls.find(c => typeof c[0] === 'string' && c[0].includes('UPDATE users SET trust_tier'));
      expect(restore).toBeTruthy();
      expect(restore?.[1]).toEqual(['user-1', 3]); // restored to previous tier
      const ledger = calls.find(c => typeof c[0] === 'string' && c[0].includes('INSERT INTO trust_ledger'));
      expect(ledger).toBeTruthy();
    });

    it('does NOT restore trust when other non-won disputes remain', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'pd-1', stripe_dispute_id: 'dp_1', stripe_charge_id: 'ch_1',
          user_id: 'user-1', escrow_id: null, task_id: null,
          amount_cents: 5000, status: 'open',
          trust_was_downgraded: true, previous_trust_tier: 3,
        }],
        rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never); // payout other-open
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);               // unlock
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 } as never); // otherNonWon → 2 → skip restore
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);               // mark resolved

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_1', stripeEventId: 'evt_close', status: 'won', reason: null,
      });
      expect(result.success).toBe(true);

      const restore = mockDb.query.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('UPDATE users SET trust_tier'));
      expect(restore).toBeFalsy();
    });

    it('increments dispute_lost_count when dispute lost', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'pd-1', stripe_dispute_id: 'dp_1', stripe_charge_id: 'ch_1',
          user_id: 'user-1', escrow_id: null, task_id: null,
          amount_cents: 3000, status: 'open',
        }],
        rowCount: 1,
      } as never);
      // increment dispute_lost_count
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // check other open disputes
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
      // unlock payouts
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // mark resolved
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_1', stripeEventId: 'evt_close',
        status: 'lost', reason: null,
      });

      expect(result.success).toBe(true);
      // No positive reversal for lost dispute
      expect(mockRevenueLog).not.toHaveBeenCalled();
    });

    it('is idempotent for already-resolved disputes', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'pd-1', stripe_dispute_id: 'dp_1', stripe_charge_id: 'ch_1',
          user_id: 'user-1', escrow_id: null, task_id: null,
          amount_cents: 3000, status: 'won', // already resolved
        }],
        rowCount: 1,
      } as never);

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_1', stripeEventId: 'evt_close2',
        status: 'won', reason: null,
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.resolved).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getDisputeRate
  // -------------------------------------------------------------------------
  describe('getDisputeRate', () => {
    it('calculates dispute rate and isAtRisk flag', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ count: '100' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 } as never);

      const result = await ChargebackService.getDisputeRate('user-1');
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totalCharges).toBe(100);
        expect(result.data.totalDisputes).toBe(1);
        expect(result.data.disputeRate).toBe(0.01);
        expect(result.data.isAtRisk).toBe(true); // 1% > 0.75%
      }
    });

    it('returns isAtRisk=false when rate is low', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ count: '1000' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 } as never);

      const result = await ChargebackService.getDisputeRate('user-1');
      if (result.success) {
        expect(result.data.disputeRate).toBe(0.001);
        expect(result.data.isAtRisk).toBe(false); // 0.1% < 0.75%
      }
    });
  });

  describe('submitDisputeEvidence', () => {
    it('auto-submits evidence when quality is strong (≥3 signals)', async () => {
      // task
      mockDb.query.mockResolvedValueOnce({ rows: [{ title: 'Move couch', description: 'Help me move', price: 5000, created_at: new Date(), completed_at: new Date(), poster_id: 'p1', worker_id: 'w1' }], rowCount: 1 } as never);
      // proofs with accepted proof + photos
      mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'ACCEPTED', submitted_at: new Date(), description: 'done', photo_count: 3 }], rowCount: 1 } as never);
      // geofence events
      mockDb.query.mockResolvedValueOnce({ rows: [{ event_type: 'checkin', distance_meters: 10, created_at: new Date() }], rowCount: 1 } as never);
      // messages
      mockDb.query.mockResolvedValueOnce({ rows: [{ content: 'On my way', sender_id: 'w1', created_at: new Date() }], rowCount: 1 } as never);
      // escrow
      mockDb.query.mockResolvedValueOnce({ rows: [{ amount: 5000, funded_at: new Date(), released_at: new Date(), stripe_payment_intent_id: 'pi_1' }], rowCount: 1 } as never);
      // UPDATE evidence_submitted_at
      mockDb.query.mockResolvedValueOnce({ rowCount: 1 } as never);

      await ChargebackService.submitDisputeEvidence('dp_1', 'pd_1', 'task-1', 'esc-1');

      expect(mockSubmitEvidence).toHaveBeenCalledWith('dp_1', expect.objectContaining({ product_description: expect.stringContaining('Move couch') }), true);
      const updateCall = mockDb.query.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('evidence_submitted_at'));
      expect(updateCall).toBeTruthy();
    });

    it('flags admin review when evidence is thin (< 3 signals)', async () => {
      // task only — 1 signal
      mockDb.query.mockResolvedValueOnce({ rows: [{ title: 'X', description: '', price: 100, created_at: new Date(), completed_at: null, poster_id: 'p1', worker_id: null }], rowCount: 1 } as never);
      // no proofs
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // no geofence
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // no messages
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // UPDATE evidence_needs_review
      mockDb.query.mockResolvedValueOnce({ rowCount: 1 } as never);

      await ChargebackService.submitDisputeEvidence('dp_2', 'pd_2', 'task-2', null);

      expect(mockSubmitEvidence).not.toHaveBeenCalled();
      const reviewCall = mockDb.query.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('evidence_needs_review'));
      expect(reviewCall).toBeTruthy();
    });

    it('flags submission failure when Stripe API errors (does not throw)', async () => {
      // strong evidence (3+ signals)
      mockDb.query.mockResolvedValueOnce({ rows: [{ title: 'T', description: 'D', price: 100, created_at: new Date(), completed_at: new Date(), poster_id: 'p', worker_id: 'w' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'ACCEPTED', submitted_at: new Date(), description: 'x', photo_count: 2 }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ event_type: 'checkin', distance_meters: 5, created_at: new Date() }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ content: 'hi', sender_id: 'w', created_at: new Date() }], rowCount: 1 } as never);
      // Stripe fails
      mockSubmitEvidence.mockResolvedValueOnce({ success: false, error: { code: 'ERR', message: 'network' } } as never);
      // UPDATE evidence_submission_failed
      mockDb.query.mockResolvedValueOnce({ rowCount: 1 } as never);

      await expect(ChargebackService.submitDisputeEvidence('dp_3', 'pd_3', 'task-3', null)).resolves.toBeUndefined();
      const failCall = mockDb.query.mock.calls.find(c => typeof c[0] === 'string' && c[0].includes('evidence_submission_failed'));
      expect(failCall).toBeTruthy();
    });

    it('skips gracefully when no task_id is available', async () => {
      await ChargebackService.submitDisputeEvidence('dp_4', 'pd_4', null, null);
      expect(mockSubmitEvidence).not.toHaveBeenCalled();
      expect(mockDb.query).not.toHaveBeenCalled();
    });
  });
});
