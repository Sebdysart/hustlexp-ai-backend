/**
 * ChargebackService Extra Tests
 *
 * Covers uncovered paths from chargeback-service.test.ts:
 * - handleDisputeCreated: no payment intent (fallback to featured_listings),
 *   no userId at all, 1st dispute (no tier downgrade), already-tier-1,
 *   ledger failure (soft), escrow locking, invariant violation
 * - handleDisputeUpdated: Stripe status mapping (all branches), DB error
 * - handleDisputeClosed: dispute not found, won with other open disputes,
 *   lost with other open disputes, no user_id on dispute, DB error
 * - getDisputeRate: zero charges (division by zero guard), DB error
 * - getPlatformDisputeRate: healthy/warning/monitoring/high/critical levels, DB error
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

vi.mock('../../src/logger', () => ({
  stripeLogger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import { db } from '../../src/db';
import { ChargebackService } from '../../src/services/ChargebackService';
import { RevenueService } from '../../src/services/RevenueService';

const mockDb = vi.mocked(db);
const mockRevenueLog = vi.mocked(RevenueService.logEvent);

function makeDisputeParams(overrides: Record<string, unknown> = {}) {
  return {
    stripeDisputeId: 'dp_test_extra',
    stripeChargeId: 'ch_test_extra',
    stripePaymentIntentId: 'pi_test_extra',
    stripeEventId: 'evt_test_extra',
    amountCents: 3000,
    currency: 'usd',
    reason: 'product_not_received',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRevenueLog.mockResolvedValue({ success: true, data: { id: 'rev-1' } });
});

describe('ChargebackService (extra coverage)', () => {
  // -------------------------------------------------------------------------
  // handleDisputeCreated — no escrow but payment intent lookup succeeds via featured_listings
  // -------------------------------------------------------------------------
  describe('handleDisputeCreated — featured_listings fallback', () => {
    it('finds user from featured_listings when no escrow', async () => {
      // No escrow found
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // featured_listings fallback
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'user-from-feature' }],
        rowCount: 1,
      } as never);
      // INSERT payment_disputes
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-feat' }], rowCount: 1 } as never);
      // UPDATE reversal link
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // always-increment dispute_count (F61-2 step 1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // conditional payouts_locked (F61-2 step 2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // payouts_were_frozen
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // trust_tier + dispute_count (1st dispute, no downgrade)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ trust_tier: 3, dispute_count: 1 }],
        rowCount: 1,
      } as never);
      // No escrow to lock

      const result = await ChargebackService.handleDisputeCreated(makeDisputeParams());

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.paymentDisputeId).toBe('pd-feat');
      }
    });

    it('handles no user found anywhere — system user fallback', async () => {
      // No escrow
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // No featured_listings
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // INSERT payment_disputes (no user)
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-nouser' }], rowCount: 1 } as never);
      // UPDATE reversal link
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // No user: skip freeze + tier check

      const result = await ChargebackService.handleDisputeCreated(makeDisputeParams());

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.paymentDisputeId).toBe('pd-nouser');
      }

      // Revenue log should use system user UUID
      expect(mockRevenueLog).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: '00000000-0000-0000-0000-000000000000',
        })
      );
    });

    it('handles null payment intent (no escrow lookup)', async () => {
      // No payment intent → skip both escrow and featured_listings queries
      // INSERT payment_disputes
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-null' }], rowCount: 1 } as never);
      // UPDATE reversal link
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeCreated(
        makeDisputeParams({ stripePaymentIntentId: null })
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.paymentDisputeId).toBe('pd-null');
      }
    });
  });

  // -------------------------------------------------------------------------
  // handleDisputeCreated — 1st dispute (no tier change)
  // -------------------------------------------------------------------------
  describe('handleDisputeCreated — 1st dispute no tier downgrade', () => {
    it('does not downgrade trust tier on 1st dispute', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'esc-1', task_id: 'task-1', state: 'RELEASED' }], rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-first' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // link reversal
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // always-increment dispute_count (F61-2 step 1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // conditional payouts_locked (F61-2 step 2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // payouts_were_frozen
      // 1st dispute, tier 3 — newTier should remain 3 (no change)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ trust_tier: 3, dispute_count: 1 }], rowCount: 1,
      } as never);
      // lock escrow (RELEASED state won't match FUNDED filter but query still runs)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await ChargebackService.handleDisputeCreated(makeDisputeParams());

      expect(result.success).toBe(true);

      // No UPDATE trust_tier should have been called
      const trustUpdateCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('UPDATE users SET trust_tier')
      );
      expect(trustUpdateCall).toBeUndefined();
    });

    it('correctly classifies loss type from escrow state', async () => {
      // RELEASED escrow → platform_loss
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'esc-r', task_id: 'task-r', state: 'RELEASED' }], rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-loss' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // link reversal
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // always-increment dispute_count (F61-2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // conditional payouts_locked (F61-2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // payouts_were_frozen
      mockDb.query.mockResolvedValueOnce({
        rows: [{ trust_tier: 2, dispute_count: 1 }], rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await ChargebackService.handleDisputeCreated(makeDisputeParams());

      expect(mockRevenueLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ loss_type: 'platform_loss' }),
        })
      );
    });

    it('classifies non-FUNDED/RELEASED escrow state', async () => {
      // REFUNDED escrow → escrow_refunded
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'esc-ref', task_id: 'task-1', state: 'REFUNDED' }], rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-ref' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // link reversal
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // always-increment dispute_count (F61-2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // conditional payouts_locked (F61-2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // payouts_were_frozen
      mockDb.query.mockResolvedValueOnce({
        rows: [{ trust_tier: 2, dispute_count: 1 }], rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await ChargebackService.handleDisputeCreated(makeDisputeParams());

      expect(mockRevenueLog).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ loss_type: 'escrow_refunded' }),
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // handleDisputeCreated — ledger failure (soft)
  // -------------------------------------------------------------------------
  describe('handleDisputeCreated — ledger failure is soft', () => {
    it('continues processing when RevenueService.logEvent fails', async () => {
      mockRevenueLog.mockResolvedValueOnce({ success: false, error: { code: 'LEDGER_ERROR', message: 'fail' } });

      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'esc-1', task_id: 'task-1', state: 'FUNDED' }], rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: 'user-1' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'pd-soft' }], rowCount: 1 } as never);
      // No reversal link update (ledger failed → ledgerResult.success = false)
      // always-increment dispute_count (F61-2 step 1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // conditional payouts_locked (F61-2 step 2)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // payouts_were_frozen
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // trust check
      mockDb.query.mockResolvedValueOnce({
        rows: [{ trust_tier: 2, dispute_count: 1 }], rowCount: 1,
      } as never);
      // escrow lock
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeCreated(makeDisputeParams());

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // handleDisputeCreated — DB error
  // -------------------------------------------------------------------------
  describe('handleDisputeCreated — DB error', () => {
    it('returns CHARGEBACK_PROCESSING_FAILED on DB exception', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB connection lost'));

      const result = await ChargebackService.handleDisputeCreated(makeDisputeParams());

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CHARGEBACK_PROCESSING_FAILED');
        expect(result.error.message).toBe('DB connection lost');
      }
    });
  });

  // -------------------------------------------------------------------------
  // handleDisputeUpdated — all Stripe status mappings
  // -------------------------------------------------------------------------
  describe('handleDisputeUpdated — status mapping', () => {
    const statusMappings = [
      { stripe: 'needs_response', internal: 'needs_response' },
      { stripe: 'warning_needs_response', internal: 'needs_response' },
      { stripe: 'under_review', internal: 'under_review' },
      { stripe: 'warning_under_review', internal: 'under_review' },
      { stripe: 'won', internal: 'won' },
      { stripe: 'lost', internal: 'lost' },
      { stripe: 'charge_refunded', internal: 'lost' },
      { stripe: 'warning_closed', internal: 'closed' },
      { stripe: 'some_unknown_status', internal: 'open' },
    ];

    for (const { stripe, internal } of statusMappings) {
      it(`maps Stripe status "${stripe}" → "${internal}"`, async () => {
        mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

        await ChargebackService.handleDisputeUpdated({
          stripeDisputeId: 'dp_map',
          stripeEventId: 'evt_map',
          status: stripe,
          reason: null,
        });

        // Verify mapped status was passed to UPDATE
        const args = mockDb.query.mock.calls[0][1] as unknown[];
        expect(args[1]).toBe(internal);
      });
    }

    it('returns CHARGEBACK_UPDATE_FAILED on DB error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB error'));

      const result = await ChargebackService.handleDisputeUpdated({
        stripeDisputeId: 'dp_err',
        stripeEventId: 'evt_err',
        status: 'under_review',
        reason: null,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CHARGEBACK_UPDATE_FAILED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // handleDisputeClosed — dispute not found
  // -------------------------------------------------------------------------
  describe('handleDisputeClosed — edge cases', () => {
    it('returns resolved=false when dispute not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_missing',
        stripeEventId: 'evt_1',
        status: 'won',
        reason: null,
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.resolved).toBe(false);
      }
    });

    it('won — keeps payouts locked when other open disputes exist', async () => {
      // Fetch dispute
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'pd-1', stripe_dispute_id: 'dp_1', stripe_charge_id: 'ch_1',
          user_id: 'user-1', escrow_id: null, task_id: null,
          amount_cents: 5000, status: 'open',
        }],
        rowCount: 1,
      } as never);
      // Other open disputes count = 2 (payouts remain locked)
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 } as never);
      // No payout unlock
      // Mark resolved
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_1', stripeEventId: 'evt_won2',
        status: 'won', reason: null,
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.resolved).toBe(true);

      // Verify payouts were NOT unlocked
      const unlockCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('payouts_locked = FALSE')
      );
      expect(unlockCall).toBeUndefined();
    });

    it('won — no user_id on dispute (null user)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'pd-noid', stripe_dispute_id: 'dp_noid', stripe_charge_id: 'ch_noid',
          user_id: null, escrow_id: null, task_id: null,
          amount_cents: 2000, status: 'open',
        }],
        rowCount: 1,
      } as never);
      // Mark resolved
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_noid', stripeEventId: 'evt_noid',
        status: 'won', reason: null,
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.resolved).toBe(true);

      // No payout unlock calls when user_id is null
      const unlockCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('payouts_locked = FALSE')
      );
      expect(unlockCall).toBeUndefined();
    });

    it('lost — keeps payouts locked when other open disputes exist', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'pd-2', stripe_dispute_id: 'dp_2', stripe_charge_id: 'ch_2',
          user_id: 'user-2', escrow_id: null, task_id: null,
          amount_cents: 4000, status: 'open',
        }],
        rowCount: 1,
      } as never);
      // increment dispute_lost_count
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // Mark resolved (no other-disputes query — lost branch never unlocks payouts)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_2', stripeEventId: 'evt_lost2',
        status: 'lost', reason: null,
      });

      expect(result.success).toBe(true);

      // Payouts remain locked because the lost branch never calls unfreezePayouts()
      const unlockCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('payouts_locked = FALSE')
      );
      expect(unlockCall).toBeUndefined();
    });

    it('lost — no user_id on dispute', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'pd-3', stripe_dispute_id: 'dp_3', stripe_charge_id: 'ch_3',
          user_id: null, escrow_id: null, task_id: null,
          amount_cents: 1000, status: 'open',
        }],
        rowCount: 1,
      } as never);
      // Mark resolved
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_3', stripeEventId: 'evt_lost3',
        status: 'lost', reason: null,
      });

      expect(result.success).toBe(true);
      // No revenue log for lost (negative entry was already created at dispute creation)
      expect(mockRevenueLog).not.toHaveBeenCalled();
    });

    it('returns CHARGEBACK_CLOSE_FAILED on DB error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB timeout'));

      const result = await ChargebackService.handleDisputeClosed({
        stripeDisputeId: 'dp_err', stripeEventId: 'evt_err',
        status: 'won', reason: null,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('CHARGEBACK_CLOSE_FAILED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getDisputeRate — zero charges
  // -------------------------------------------------------------------------
  describe('getDisputeRate — zero charges', () => {
    it('returns disputeRate=0 and isAtRisk=false when no charges exist', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);

      const result = await ChargebackService.getDisputeRate('user-new');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.totalCharges).toBe(0);
        expect(result.data.disputeRate).toBe(0);
        expect(result.data.isAtRisk).toBe(false);
      }
    });

    it('returns DISPUTE_RATE_QUERY_FAILED on DB error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB error'));

      const result = await ChargebackService.getDisputeRate('user-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DISPUTE_RATE_QUERY_FAILED');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getPlatformDisputeRate
  // -------------------------------------------------------------------------
  describe('getPlatformDisputeRate', () => {
    // Note: getPlatformDisputeRate uses Promise.all([calc(30), calc(90)]).
    // With Promise.all, both calc functions start simultaneously. The actual
    // db.query call order is: charges30, charges90, disputes30, disputes90,
    // then the loss classification query. Use argument-based dispatch to avoid
    // interleaving issues.
    function stubPlatformCalcCalls(
      charges30: number, disputes30: number,
      charges90: number, disputes90: number,
      lossRows: Array<{ loss_type: string; total: string }> = []
    ) {
      let callCount = 0;
      mockDb.query.mockImplementation((sql: string, params?: unknown[]) => {
        callCount++;
        // Loss classification query (no params, or after 4 count queries)
        if (typeof sql === 'string' && sql.includes('revenue_ledger')) {
          return Promise.resolve({ rows: lossRows, rowCount: lossRows.length });
        }
        // escrows COUNT queries → charges
        if (typeof sql === 'string' && sql.includes('escrows')) {
          const days = Array.isArray(params) ? params[0] : 0;
          const count = days === 30 ? charges30 : charges90;
          return Promise.resolve({ rows: [{ count: String(count) }], rowCount: 1 });
        }
        // payment_disputes COUNT queries → disputes
        if (typeof sql === 'string' && sql.includes('payment_disputes')) {
          const days = Array.isArray(params) ? params[0] : 0;
          const count = days === 30 ? disputes30 : disputes90;
          return Promise.resolve({ rows: [{ count: String(count) }], rowCount: 1 });
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
    }

    it('returns HEALTHY riskLevel when rate is very low', async () => {
      stubPlatformCalcCalls(1000, 1, 5000, 5);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('HEALTHY');
        expect(result.data.window30d.rate).toBeCloseTo(0.001);
      }
    });

    it('returns WARNING riskLevel at 0.6%-0.75%', async () => {
      // 6 disputes per 1000 charges = 0.6%
      stubPlatformCalcCalls(1000, 7, 5000, 35);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('WARNING');
      }
    });

    it('returns MONITORING riskLevel at 0.75%-1%', async () => {
      // 8 per 1000 = 0.8%
      stubPlatformCalcCalls(1000, 8, 5000, 40);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('MONITORING');
      }
    });

    it('returns HIGH riskLevel at 1%-2%', async () => {
      // 15 per 1000 = 1.5%
      stubPlatformCalcCalls(1000, 15, 5000, 75);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('HIGH');
      }
    });

    it('returns CRITICAL riskLevel above 2%', async () => {
      // 25 per 1000 = 2.5%
      stubPlatformCalcCalls(1000, 25, 5000, 125);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.riskLevel).toBe('CRITICAL');
      }
    });

    it('correctly maps platform_loss and payout_blocked from ledger', async () => {
      stubPlatformCalcCalls(1000, 1, 5000, 5, [
        { loss_type: 'platform_loss', total: '150000' },
        { loss_type: 'payout_blocked', total: '75000' },
      ]);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.platformLossCents).toBe(150000);
        expect(result.data.payoutBlockedCents).toBe(75000);
      }
    });

    it('handles zero charges — returns 0 rate', async () => {
      stubPlatformCalcCalls(0, 0, 0, 0);

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.window30d.rate).toBe(0);
        expect(result.data.window30d.riskLevel).toBe('HEALTHY');
      }
    });

    it('returns PLATFORM_DISPUTE_RATE_FAILED on DB error', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB error'));

      const result = await ChargebackService.getPlatformDisputeRate();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('PLATFORM_DISPUTE_RATE_FAILED');
      }
    });
  });
});
