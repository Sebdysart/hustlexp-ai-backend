/**
 * ChargebackService Unit Tests
 *
 * Tests dispute lifecycle: creation (idempotent), update, close (won/lost),
 * ledger entries, payout freeze, trust downgrade, and dispute rate calculations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// AUDIT H1/H2: ChargebackService now wraps all mutations in db.transaction.
// The tx executor DELEGATES to the same `query` spy so the existing
// mockResolvedValueOnce sequences keep driving both paths, while `txQuery`
// separately records which statements ran INSIDE the transaction (assertable).
// The transaction mock propagates rejections (real rollback-then-rethrow shape).
const dbMocks = vi.hoisted(() => {
  const query = vi.fn();
  const txQuery = vi.fn((sql: string, params?: unknown[]) => query(sql, params));
  const transaction = vi.fn(async (fn: (q: typeof txQuery) => Promise<unknown>) => fn(txQuery));
  return { query, txQuery, transaction };
});

vi.mock('../../src/db', () => ({
  db: { query: dbMocks.query, transaction: dbMocks.transaction },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: {
    logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }),
  },
}));

vi.mock('../../src/logger', () => ({
  stripeLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../src/auth-cache', () => ({
  invalidateAuthCacheForUser: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../../src/db';
import { ChargebackService } from '../../src/services/ChargebackService';
import { RevenueService } from '../../src/services/RevenueService';
import { invalidateAuthCacheForUser } from '../../src/auth-cache';

const mockDb = vi.mocked(db);
const mockRevenueLog = vi.mocked(RevenueService.logEvent);

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
  // clearAllMocks does NOT flush mockResolvedValueOnce queues — reset fully so
  // under-consumed queues can never bleed across tests (audit H1/H2 hardening).
  dbMocks.query.mockReset();
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
      // 5. UPDATE users SET dispute_count (F61-2: always-increment, step 1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 6. UPDATE users SET payouts_locked = TRUE WHERE payouts_locked = FALSE (step 2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 7. UPDATE payment_disputes SET payouts_were_frozen
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 8. SELECT trust_tier, dispute_count
      mockDb.query.mockResolvedValueOnce({
        rows: [{ trust_tier: 3, dispute_count: 1 }], rowCount: 1,
      } as never);
      // 9. UPDATE escrows SET state = LOCKED_DISPUTE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeCreated(params);

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.paymentDisputeId).toBe('pd-1');

      // Verify negative ledger entry was logged
      expect(mockRevenueLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'chargeback',
          amountCents: -5000,
        }),
        expect.anything() // tx executor (audit H1)
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
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // always-increment dispute_count (F61-2 step 1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // conditional payouts_locked (F61-2 step 2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // payouts_were_frozen
      // dispute_count = 2, trust_tier = 3 -> should drop to 2
      mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 3, dispute_count: 2 }], rowCount: 1 } as never);
      // UPDATE users SET trust_tier
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // SELECT firebase_uid (A60-4)
      mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'fb-user-1' }], rowCount: 1 } as never);
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
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // link reversal
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // always-increment dispute_count (F61-2 step 1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // conditional payouts_locked (F61-2 step 2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // payouts_were_frozen
      // dispute_count = 3 -> drop to tier 1
      mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 4, dispute_count: 3 }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE users SET trust_tier = 1
      mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'fb-u1' }], rowCount: 1 } as never); // SELECT firebase_uid
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // INSERT trust_ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE payment_disputes trust_was_downgraded
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // LOCK escrow

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
        }),
        expect.anything() // tx executor (audit H2)
      );
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
      // Bug 4 fix: LOST path no longer checks other open disputes or unlocks payouts.
      // Payouts remain frozen and require admin manual review.
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

  // -------------------------------------------------------------------------
  // A60-4: invalidateAuthCacheForUser after trust_tier downgrade
  // -------------------------------------------------------------------------
  describe('A60-4: auth cache invalidation after trust_tier downgrade', () => {
    it('calls invalidateAuthCacheForUser with userId after trust_tier downgrade', async () => {
      const mockInvalidate = vi.mocked(invalidateAuthCacheForUser);
      mockInvalidate.mockClear();

      const params = makeDisputeParams();

      // Find escrow
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', state: 'FUNDED' }], rowCount: 1 } as never);
      // Find poster
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never);
      // INSERT payment_disputes
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-2' }], rowCount: 1 } as never);
      // link reversal ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // always-increment dispute_count (F61-2 step 1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // conditional payouts_locked (F61-2 step 2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // payouts_were_frozen
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // trust_tier=3, dispute_count=2 → downgrade to tier 2
      mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 3, dispute_count: 2 }], rowCount: 1 } as never);
      // UPDATE users SET trust_tier
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // SELECT firebase_uid (for cache invalidation)
      mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'fb-user-1' }], rowCount: 1 } as never);
      // INSERT trust_ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // UPDATE payment_disputes trust_was_downgraded
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // LOCK escrow
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeCreated(params);
      expect(result.success).toBe(true);

      expect(mockInvalidate).toHaveBeenCalledWith('user-1', 'fb-user-1', false);
    });
  });

  // -------------------------------------------------------------------------
  // F61-2: dispute_count incremented even when payouts_locked=TRUE
  // -------------------------------------------------------------------------
  describe('F61-2: dispute_count always incremented regardless of payouts_locked state', () => {
    it('F61-2: increments dispute_count even when payouts_locked is already TRUE (repeat fraudster)', async () => {
      // Simulates a user who already has payouts_locked=TRUE from a prior chargeback.
      // The original bug: a single UPDATE with AND payouts_locked = FALSE would match
      // 0 rows and skip the dispute_count increment entirely.
      // Fix: two separate UPDATEs — first always increments dispute_count,
      // second conditionally sets payouts_locked (matches 0 rows when already locked, harmless).
      const params = makeDisputeParams({ stripeDisputeId: 'dp_repeat_fraud' });

      // 1. Find escrow by payment intent
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'esc-1', task_id: 'task-1', state: 'RELEASED' }], rowCount: 1,
      } as never);
      // 2. Find poster from task
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: 'user-1' }], rowCount: 1,
      } as never);
      // 3. INSERT payment_disputes (new)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'pd-repeat' }], rowCount: 1,
      } as never);
      // 4. UPDATE payment_disputes with reversal ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 5. UPDATE users SET dispute_count = COALESCE(dispute_count,0)+1 (always — F61-2 fix, step 1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 6. UPDATE users SET payouts_locked = TRUE WHERE payouts_locked = FALSE
      //    (matches 0 rows because already locked — this is fine)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // 7. UPDATE payment_disputes SET payouts_were_frozen = TRUE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 8. SELECT trust_tier, dispute_count (now reflects incremented count = 3 → drop to tier 1)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ trust_tier: 2, dispute_count: 3 }], rowCount: 1,
      } as never);
      // 9. UPDATE users SET trust_tier = 1
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 10. SELECT firebase_uid
      mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'fb-user-1' }], rowCount: 1 } as never);
      // 11. INSERT trust_ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 12. UPDATE payment_disputes trust_was_downgraded
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // 13. UPDATE escrows SET state = LOCKED_DISPUTE (escrow was RELEASED → no match, harmless)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await ChargebackService.handleDisputeCreated(params);
      expect(result.success).toBe(true);

      // Verify: the dispute_count increment UPDATE was issued (no payouts_locked guard)
      const allSqls = mockDb.query.mock.calls.map(c => c[0] as string);
      const disputeCountUpdate = allSqls.find(
        (sql) => sql.includes('dispute_count') && sql.includes('UPDATE users') && !sql.includes('payouts_locked = FALSE')
      );
      expect(disputeCountUpdate).toBeDefined();

      // Verify: a separate conditional payouts_locked update exists
      const payoutsLockUpdate = allSqls.find(
        (sql) => sql.includes('payouts_locked = TRUE') && sql.includes('payouts_locked = FALSE')
      );
      expect(payoutsLockUpdate).toBeDefined();
    });

    it('F61-2: trust tier downgrade fires on 3rd chargeback even when payouts were already locked', async () => {
      // User has payouts_locked=TRUE. Receives 3rd chargeback. Because dispute_count is
      // always incremented (F61-2), the SELECT after the update returns dispute_count=3
      // and the tier-downgrade logic fires correctly.
      const params = makeDisputeParams({ stripeDisputeId: 'dp_3rd_chargeback' });

      // Escrow lookup
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', state: 'FUNDED' }], rowCount: 1 } as never);
      // Poster lookup
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never);
      // INSERT payment_disputes
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-3rd' }], rowCount: 1 } as never);
      // Link reversal ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // Always-increment dispute_count (F61-2 step 1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // Conditional payouts_locked (already locked → 0 rows matched)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // UPDATE payouts_were_frozen
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // SELECT trust_tier=3, dispute_count=3 → must drop to tier 1
      mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: 3, dispute_count: 3 }], rowCount: 1 } as never);
      // UPDATE users SET trust_tier = 1
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // SELECT firebase_uid
      mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'fb-u1' }], rowCount: 1 } as never);
      // INSERT trust_ledger
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // UPDATE payment_disputes trust_was_downgraded
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // UPDATE escrows (FUNDED → LOCKED_DISPUTE)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeCreated(params);
      expect(result.success).toBe(true);

      // Tier-downgrade query must have been called with tier=1
      const trustUpdateCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && (call[0] as string).includes('UPDATE users SET trust_tier')
      );
      expect(trustUpdateCall).toBeDefined();
      expect(trustUpdateCall![1]).toContain(1); // downgraded to tier 1
    });
  });
});

// --------------------------------------------------------------------------
// F64-3: payouts_were_frozen should only be TRUE when this dispute actually froze account
// --------------------------------------------------------------------------
describe('F64-3: payouts_were_frozen set correctly based on actual lock result', () => {
  it('F64-3: sets payouts_were_frozen=FALSE when account was already locked (rowCount=0 on Step 2)', async () => {
    const params = makeDisputeParams({ stripeDisputeId: 'dp_already_locked' });

    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', state: 'RELEASED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'pd-f64' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // reversal ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // step 1: dispute_count increment
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // step 2: payouts_locked (0 = already locked)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // payouts_were_frozen UPDATE
      .mockResolvedValueOnce({ rows: [{ trust_tier: 2, dispute_count: 2 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // trust_tier UPDATE
      .mockResolvedValueOnce({ rows: [{ firebase_uid: 'fb-u1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // trust_ledger INSERT
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // payment_disputes trust_was_downgraded
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // escrow LOCKED_DISPUTE

    const result = await ChargebackService.handleDisputeCreated(params);
    expect(result.success).toBe(true);

    // Find the payouts_were_frozen UPDATE call
    const frozenCall = mockDb.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('payouts_were_frozen')
    );
    expect(frozenCall).toBeDefined();
    // F64-3 fix: rowCount was 0 (already locked) → should pass FALSE as $2
    expect(frozenCall![1][1]).toBe(false);
  });

  it('F64-3: sets payouts_were_frozen=TRUE when this dispute freshly locked the account (rowCount=1 on Step 2)', async () => {
    const params = makeDisputeParams({ stripeDisputeId: 'dp_fresh_lock' });

    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'esc-2', task_id: 'task-2', state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ poster_id: 'user-2' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'pd-f64b' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // reversal ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // step 1: dispute_count increment
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // step 2: payouts_locked (1 = freshly locked)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // payouts_were_frozen UPDATE
      .mockResolvedValueOnce({ rows: [{ trust_tier: 3, dispute_count: 1 }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // escrow LOCKED_DISPUTE

    const result = await ChargebackService.handleDisputeCreated(params);
    expect(result.success).toBe(true);

    const frozenCall = mockDb.query.mock.calls.find(
      (call) => typeof call[0] === 'string' && (call[0] as string).includes('payouts_were_frozen')
    );
    expect(frozenCall).toBeDefined();
    // F64-3 fix: rowCount was 1 (freshly locked) → should pass TRUE as $2
    expect(frozenCall![1][1]).toBe(true);
  });
});

// =============================================================================
// AUDIT FIXES H1/H2 (2026-06-11): chargeback handlers must be ATOMIC.
// H1: handleDisputeCreated — all mutations in ONE db.transaction; a ledger-write
//     failure aborts everything (no partially-applied chargeback that the
//     idempotent early-return would then permanently skip on retry).
// H2: handleDisputeClosed — dispute row locked FOR UPDATE; reversal ledger entry
//     and terminal status written in the SAME transaction (no duplicate
//     chargeback_reversal on Stripe webhook redelivery).
// =============================================================================
describe('ChargebackService — H1/H2 atomicity (audit fixes)', () => {
  const txSql = () => dbMocks.txQuery.mock.calls.map((c) => String(c[0]));

  function seedCreatedHappyPath() {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', state: 'FUNDED' }], rowCount: 1 } as never) // escrow lookup (read, outside tx)
      .mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never) // poster lookup (read, outside tx)
      .mockResolvedValueOnce({ rows: [{ id: 'pd-1' }], rowCount: 1 } as never) // INSERT payment_disputes
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // link reversal ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // dispute_count++
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // conditional payouts lock
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // payouts_were_frozen
      .mockResolvedValueOnce({ rows: [{ trust_tier: 3, dispute_count: 1 }], rowCount: 1 } as never) // tier check (no downgrade)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // escrow → LOCKED_DISPUTE
  }

  it('H1: runs every chargeback mutation inside exactly one transaction', async () => {
    seedCreatedHappyPath();

    const result = await ChargebackService.handleDisputeCreated(makeDisputeParams());

    expect(result.success).toBe(true);
    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);

    // Mutations all went through the tx executor…
    const inTx = txSql();
    expect(inTx.some((s) => s.includes('INSERT INTO payment_disputes'))).toBe(true);
    expect(inTx.some((s) => s.includes('dispute_count'))).toBe(true);
    expect(inTx.some((s) => s.includes('payouts_locked = TRUE'))).toBe(true);
    expect(inTx.some((s) => s.includes("LOCKED_DISPUTE"))).toBe(true);

    // …and the ledger write joined the SAME transaction (received the tx executor).
    expect(mockRevenueLog).toHaveBeenCalledTimes(1);
    expect(mockRevenueLog.mock.calls[0][1]).toBe(dbMocks.txQuery);

    // Only the two Stripe-ID lookups ran outside the transaction.
    expect(mockDb.query.mock.calls.length - dbMocks.txQuery.mock.calls.length).toBe(2);
  });

  it('H1: ledger write failure aborts the whole transaction — no partial chargeback', async () => {
    seedCreatedHappyPath();
    mockRevenueLog.mockResolvedValueOnce({
      success: false,
      error: { code: 'REVENUE_LOG_FAILED', message: 'boom' },
    } as never);

    const result = await ChargebackService.handleDisputeCreated(makeDisputeParams());

    expect(result.success).toBe(false);
    // Nothing after the ledger failure may execute: no reversal link, no freeze, no escrow lock.
    const inTx = txSql();
    expect(inTx.some((s) => s.includes('reversal_ledger_id'))).toBe(false);
    expect(inTx.some((s) => s.includes('payouts_locked = TRUE'))).toBe(false);
    expect(inTx.some((s) => s.includes('LOCKED_DISPUTE'))).toBe(false);
  });

  it('H1: duplicate dispute (idempotent re-entry) exits inside the tx without writing anything else', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', task_id: 'task-1', state: 'FUNDED' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // INSERT ON CONFLICT DO NOTHING → no row
      .mockResolvedValueOnce({ rows: [{ id: 'pd-existing' }], rowCount: 1 } as never); // SELECT existing

    const result = await ChargebackService.handleDisputeCreated(makeDisputeParams());

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.paymentDisputeId).toBe('pd-existing');
    expect(mockRevenueLog).not.toHaveBeenCalled();
    expect(txSql().some((s) => s.includes('payouts_locked'))).toBe(false);
  });

  it('H2: close locks the dispute row FOR UPDATE and writes reversal + terminal status in one tx', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ id: 'pd-1', user_id: 'user-1', escrow_id: 'esc-1', task_id: 'task-1', amount_cents: 5000, status: 'open', stripe_charge_id: 'ch_1' }],
        rowCount: 1,
      } as never) // SELECT … FOR UPDATE
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never) // other open disputes
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // unlock payouts
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // terminal status UPDATE

    const result = await ChargebackService.handleDisputeClosed({
      stripeDisputeId: 'dp_test_123', stripeEventId: 'evt_close_1', status: 'won',
    });

    expect(result.success).toBe(true);
    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);

    const inTx = txSql();
    expect(inTx[0]).toContain('FOR UPDATE');
    expect(mockRevenueLog).toHaveBeenCalledTimes(1);
    expect(mockRevenueLog.mock.calls[0][1]).toBe(dbMocks.txQuery);
    expect(inTx.some((s) => s.includes('resolved_at'))).toBe(true);
  });

  it('H2: redelivery after terminal status writes NO second reversal entry', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'pd-1', user_id: 'user-1', escrow_id: null, task_id: null, amount_cents: 5000, status: 'won', stripe_charge_id: 'ch_1' }],
      rowCount: 1,
    } as never);

    const result = await ChargebackService.handleDisputeClosed({
      stripeDisputeId: 'dp_test_123', stripeEventId: 'evt_close_redelivery', status: 'won',
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.resolved).toBe(false);
    expect(mockRevenueLog).not.toHaveBeenCalled();
    expect(txSql().some((s) => s.includes('resolved_at'))).toBe(false);
  });

  it('H2: reversal ledger failure on won aborts — terminal status NOT written, retry stays possible', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'pd-1', user_id: 'user-1', escrow_id: null, task_id: null, amount_cents: 5000, status: 'open', stripe_charge_id: 'ch_1' }],
      rowCount: 1,
    } as never);
    mockRevenueLog.mockResolvedValueOnce({
      success: false,
      error: { code: 'REVENUE_LOG_FAILED', message: 'ledger down' },
    } as never);

    const result = await ChargebackService.handleDisputeClosed({
      stripeDisputeId: 'dp_test_123', stripeEventId: 'evt_close_2', status: 'won',
    });

    expect(result.success).toBe(false);
    expect(txSql().some((s) => s.includes('resolved_at'))).toBe(false);
  });
});
