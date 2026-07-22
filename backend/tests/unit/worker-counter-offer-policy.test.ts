import { describe, expect, it } from 'vitest';
import {
  buildWorkerCounterCorridor,
  evaluateWorkerCounter,
  WORKER_COUNTER_LIMITS,
  WORKER_COUNTER_POLICY_VERSION,
} from '../../src/services/WorkerCounterOfferPolicy.js';
import { taskEligibilityPredicates } from '../../src/services/TaskEligibilityPolicy.js';

describe('deterministic worker counter corridor', () => {
  const economics = { customerTotalCents: 5_000, payoutCents: 4_000, platformMarginCents: 1_000 };

  it('defines a bounded corridor with a customer maximum and margin floor', () => {
    expect(buildWorkerCounterCorridor(economics)).toEqual({
      policyVersion: WORKER_COUNTER_POLICY_VERSION,
      eligible: true,
      blockingReasons: [],
      currentCustomerTotalCents: 5_000,
      currentPayoutCents: 4_000,
      platformMarginCents: 1_000,
      minimumCounterPayoutCents: 4_100,
      maximumCounterPayoutCents: 4_800,
      customerMaximumCents: 6_250,
      marginFloorBps: 1_000,
    });
  });

  it('accepts both exact boundaries and rejects one cent outside', () => {
    expect(evaluateWorkerCounter({ ...economics, proposedPayoutCents: 4_100 })).toMatchObject({
      accepted: true, proposedCustomerTotalCents: 5_100,
    });
    expect(evaluateWorkerCounter({ ...economics, proposedPayoutCents: 4_800 })).toMatchObject({
      accepted: true, proposedCustomerTotalCents: 5_800,
    });
    expect(evaluateWorkerCounter({ ...economics, proposedPayoutCents: 4_099 }).accepted).toBe(false);
    expect(evaluateWorkerCounter({ ...economics, proposedPayoutCents: 4_801 }).accepted).toBe(false);
  });

  it('rejects unreconciled, below-margin, and no-room source economics', () => {
    expect(buildWorkerCounterCorridor({ ...economics, customerTotalCents: 5_001 }).blockingReasons)
      .toContain('economics_do_not_reconcile');
    expect(buildWorkerCounterCorridor({ customerTotalCents: 5_000, payoutCents: 4_600, platformMarginCents: 400 }).blockingReasons)
      .toContain('current_margin_below_floor');
    expect(buildWorkerCounterCorridor({ customerTotalCents: 1_000, payoutCents: 900, platformMarginCents: 100 }).blockingReasons)
      .toContain('no_bounded_counter_room');
  });

  it('keeps all hard limits explicit and model-independent', () => {
    expect(WORKER_COUNTER_LIMITS).toEqual({
      marginFloorBps: 1_000,
      maximumPayoutIncreaseBps: 2_000,
      maximumCustomerIncreaseBps: 2_500,
      maximumAbsolutePayoutIncreaseCents: 5_000,
      minimumPayoutIncreaseCents: 100,
      expiresMinutes: 30,
    });
  });

  it('blocks stale acceptance for the countering worker and every approved reauthorization', () => {
    const sql = taskEligibilityPredicates();
    expect(sql).toContain("COALESCE(t.clarification_state, 'READY') = 'READY'");
    expect(sql).toContain("counter_offer.status = 'APPROVED_REAUTH_REQUIRED'");
    expect(sql).toContain("counter_offer.worker_id = feed_worker.id AND counter_offer.status = 'PENDING_POSTER'");
  });
});
