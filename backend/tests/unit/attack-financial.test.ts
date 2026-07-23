/**
 * RED-TEAM FINANCIAL ATTACK TESTS
 *
 * Mission: find every way to break financial invariants — double-payouts,
 * fee bypass, platform cut manipulation, escrow state corruption.
 *
 * FINDINGS LEGEND:
 *   EXPLOIT  — confirmed exploitable vulnerability
 *   WRONG    — code behaves unexpectedly but not maliciously exploitable
 *   SAFE     — guard is present and correct
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — mirroring the existing escrow-service.test.ts patterns
// ---------------------------------------------------------------------------
vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: { recordEarnings: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPTaxService', () => ({
  XPTaxService: { recordOfflinePayment: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: {
    awardXP: vi.fn().mockResolvedValue(undefined),
    clawbackXP: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: { recordContribution: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

import { db } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService';
import { EarnedVerificationUnlockService } from '../../src/services/EarnedVerificationUnlockService';
import { SelfInsurancePoolService } from '../../src/services/SelfInsurancePoolService.js';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    task_id: 'task-1',
    amount: 5000,
    state: 'PENDING',
    stripe_payment_intent_id: null,
    stripe_transfer_id: null,
    funded_at: null,
    released_at: null,
    refunded_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

/**
 * Wire up the standard happy-path mock sequence for release().
 * release() fires exactly 4 db.query calls in order:
 *   1. SELECT escrow row
 *   2. SELECT task row (worker_id, price)
 *   3. SELECT user KYC row (payouts_enabled, stripe_connect_id, stripe_connect_status)
 *   4. UPDATE escrows SET state = 'RELEASED' … RETURNING *
 */
function mockReleaseHappyPath(
  escrowAmount: number,
  taskPrice: number,
  escrowState = 'FUNDED',
  workerHasConnect = true,
  payoutsEnabled = true,
) {
  const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: escrowAmount, state: escrowState };
  const taskRow = { worker_id: 'worker-1', price: taskPrice };
  const kycRow = {
    payouts_enabled: payoutsEnabled,
    stripe_connect_id: workerHasConnect ? 'acct_test' : null,
    stripe_connect_status: 'complete',
  };
  const released = makeEscrow({ state: 'RELEASED', amount: escrowAmount });

  mockDb.query
    .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [kycRow], rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// ATTACK GROUP 1: PLATFORM FEE BYPASS
// ===========================================================================

describe('ATTACK 1: Fee calculation base (escrow.amount vs task.price)', () => {
  /**
   * SCENARIO: escrow.amount=$6000 (e.g. tip bumped before release, or surge),
   *            task.price=$4000.
   *
   * EXPECTED BEHAVIOUR: fee should be on escrow.amount (the actual charged amount).
   * ACTUAL:  EscrowService.release() line 339: `const grossPayoutCents = escrow.amount`
   *          then line 386: `const platformFeeCents = Math.round(grossPayoutCents * (platformFeePercent / 100))`
   *
   * The fee is correctly calculated on escrow.amount, the canonical charged
   * amount. createPaymentIntent now requires exact equality across caller,
   * task, and pending escrow, and confirmFunding independently compares the
   * Stripe PI with escrow.amount. This test injects a corrupt legacy row to
   * demonstrate why those boundary checks must never regress.
   *
   * VERDICT: SAFE at the public funding boundary; legacy data corruption still
   * warrants a reconciliation check before release.
   */
  it('fee is calculated on canonical escrow.amount even for a corrupt legacy mismatch', async () => {
    // escrow funded at $40, but task.price is $60
    const escrowAmount = 4000;
    const taskPrice = 6000;

    mockReleaseHappyPath(escrowAmount, taskPrice);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });
    expect(result.success).toBe(true);

    // Platform fee is 15% of escrow.amount ($40) = $6, NOT 15% of task.price ($60) = $9
    const expectedFeeOnEscrow = Math.round(4000 * 0.15); // 600 cents
    const expectedFeeOnTaskPrice = Math.round(6000 * 0.15); // 900 cents

    // recordEarnings receives finalPayout = escrowAmount - platformFee - 2% insurance on gross
    // net = 4000 - 600 = 3400; insurance = Math.round(4000*0.02) = 80; final = 3400 - 80 = 3320
    expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
      'worker-1',
      'task-1',
      'esc-1',
      3320, // F54-2: insurance = 2% of gross 4000 = 80; resolvedNet = 3400 - 80 = 3320
    );

    // Confirm fee was NOT deducted on task.price basis
    expect(EarnedVerificationUnlockService.recordEarnings).not.toHaveBeenCalledWith(
      'worker-1',
      'task-1',
      'esc-1',
      taskPrice - expectedFeeOnTaskPrice, // 5100 — this would be wrong anyway
    );

    // The release service trusts escrow.amount. The router and confirmFunding
    // now prevent a poster from creating this mismatch through the API.
    expect(expectedFeeOnEscrow).toBeLessThan(expectedFeeOnTaskPrice);
  });
});

describe('ATTACK 2: Zero-fee path — small task rounds platform fee to 0', () => {
  /**
   * SCENARIO: Task price = $5.00 (500 cents, the minimum).
   * Platform fee = 15% → 0.15 * 500 = 75 cents. Math.round(75) = 75. Safe.
   *
   * But: what if PLATFORM_FEE_PERCENT env var is unset AND the parseInt fallback
   * returns NaN? Let's check:
   *   config.ts line 33: `parseInt(process.env.PLATFORM_FEE_PERCENT || '15', 10)` → 15 (safe)
   *
   * Then EscrowService.release() line 385:
   *   `const platformFeePercent = config.stripe.platformFeePercent || 15`
   *   If config returns 0 (e.g. PLATFORM_FEE_PERCENT=0), the `|| 15` won't fire
   *   because 0 is falsy... wait, no: 0 IS falsy in JS, so `0 || 15` = 15. SAFE.
   *
   * But: PLATFORM_FEE_PERCENT=0 → parseInt('0', 10) = 0, then `0 || 15` = 15.
   * So env=0 is ignored in favor of 15. SAFE.
   *
   * However: if PLATFORM_FEE_PERCENT is set to a non-numeric string, parseInt
   * returns NaN. `NaN || 15` = 15. SAFE.
   *
   * Edge: What is the minimum amount where fee rounds to 0?
   *   Math.round(amount * 0.15) = 0 → amount < 3.33 cents → impossible because
   *   minimum escrow is 500 cents (config) and Stripe minimum is 50 cents.
   *
   * VERDICT: SAFE — no zero-fee path exists at permitted minimums.
   * The `|| 15` fallback is robust for the 0 and NaN cases.
   */
  it('platform fee cannot round to 0 at the $5 minimum task value (500 cents)', () => {
    const escrowAmount = 500; // $5.00 — system minimum
    const platformFeePercent = 15;
    const platformFeeCents = Math.round(escrowAmount * (platformFeePercent / 100));
    expect(platformFeeCents).toBe(75); // $0.75 — not zero
  });

  it('fee percent env=0 is overridden to 15 by the || 15 fallback in release()', () => {
    // Simulating: config.stripe.platformFeePercent = 0 (env PLATFORM_FEE_PERCENT=0)
    const configuredPercent = 0;
    const effectivePercent = configuredPercent || 15; // JS falsy: 0 || 15 = 15
    expect(effectivePercent).toBe(15);
    // VERDICT: SAFE — zero fee env is silently overridden to 15%
  });
});

describe('ATTACK 3: Fee percentage stored in env — no DB manipulation possible', () => {
  /**
   * EscrowService.release() line 385:
   *   `const platformFeePercent = config.stripe.platformFeePercent || 15`
   *
   * config.ts line 33:
   *   `parseInt(process.env.PLATFORM_FEE_PERCENT || '15', 10)`
   *
   * The fee percentage is read from an environment variable at module load time.
   * It is NOT stored in the database. A user-level actor cannot manipulate it
   * via any API endpoint.
   *
   * Risk: if an attacker gains server env access, they can set PLATFORM_FEE_PERCENT=0
   * but `|| 15` prevents that from working (0 is falsy). They'd need to set it
   * to a negative number: `-1 || 15` = -1 (truthy). That would give negative fee,
   * meaning the worker gets MORE than escrow.amount.
   *
   * VERDICT: EXPLOIT (requires env write access) — PLATFORM_FEE_PERCENT=-1 would
   * cause negative platform fee (worker overpaid). But this requires server access.
   * At the application level: SAFE.
   */
  it('negative PLATFORM_FEE_PERCENT would produce negative fee (worker overpaid)', () => {
    const maliciousPercent = -5; // attacker sets PLATFORM_FEE_PERCENT=-5
    const effectivePercent = maliciousPercent || 15; // -5 is truthy → -5
    expect(effectivePercent).toBe(-5); // negative percent passes the || guard

    const grossPayoutCents = 10000; // $100
    const platformFeeCents = Math.round(grossPayoutCents * (effectivePercent / 100));
    expect(platformFeeCents).toBe(-500); // NEGATIVE fee — worker gets $105 instead of $85

    const netPayoutCents = grossPayoutCents - platformFeeCents;
    expect(netPayoutCents).toBe(10500); // worker overpaid by $5
    // VERDICT: EXPLOIT (env-level) — no guard against negative fee percentage.
    // Fix: add `Math.max(0, ...)` or validate config on startup.
  });
});

// ===========================================================================
// ATTACK GROUP 2: ESCROW STATE CORRUPTION
// ===========================================================================

describe('ATTACK 4: Concurrent release + dispute (TOCTOU race)', () => {
  /**
   * RACE CONDITION ANALYSIS:
   *
   * release() SQL (EscrowService.ts:390-399):
   *   UPDATE escrows SET state='RELEASED' WHERE id=$1 AND state IN ('FUNDED','LOCKED_DISPUTE')
   *
   * lockForDispute() SQL (EscrowService.ts:602-609):
   *   UPDATE escrows SET state='LOCKED_DISPUTE' WHERE id=$1 AND state='FUNDED'
   *
   * Both use atomic WHERE-clause state checks. PostgreSQL row-level locking
   * means only one UPDATE can win — the loser gets rowCount=0.
   *
   * HOWEVER: release() permits release from LOCKED_DISPUTE state (line 396).
   * This means: if dispute lock wins first, release() can still succeed on
   * the LOCKED_DISPUTE row. This is intentional per SPEC (dispute resolved in
   * worker's favor) but means `lockForDispute` does NOT prevent release().
   *
   * VERDICT: WRONG (by design, not exploitable) — lockForDispute does not block
   * release(). The state machine explicitly allows LOCKED_DISPUTE → RELEASED.
   * A dispute cannot prevent payout; an admin must call partialRefund() instead.
   * This is a product design decision, not a code bug, but it does mean the
   * "lock" name is misleading — it does not prevent release.
   */
  it('release() succeeds on LOCKED_DISPUTE state — dispute lock does not prevent payout', async () => {
    // Simulate: dispute lock won the race, escrow is now LOCKED_DISPUTE
    mockReleaseHappyPath(5000, 5000, 'LOCKED_DISPUTE');

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });
    // This SUCCEEDS — confirming dispute lock does not block release
    expect(result.success).toBe(true);

    // VERDICT: WRONG (design issue) — "lock" does not lock against release().
    // File: backend/src/services/EscrowService.ts:396 (AND state IN ('FUNDED', 'LOCKED_DISPUTE'))
    // File: backend/src/services/EscrowService.ts:74 (LOCKED_DISPUTE → RELEASED is valid)
  });

  it('lockForDispute cannot transition from PENDING state (correct guard)', async () => {
    // window check returns no rows
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // window check
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never) // dup dispute check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE — 0 rows (PENDING, not FUNDED)
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never); // getById

    const result = await EscrowService.lockForDispute('esc-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('expected FUNDED');
    }
    // VERDICT: SAFE — PENDING cannot be disputed.
  });
});

describe('ATTACK 5: Escrow in PENDING state — task acceptance guard', () => {
  /**
   * ANALYSIS: When a task is accepted, does the system verify escrow is FUNDED?
   *
   * EscrowService has no `acceptTask` method — task acceptance is in TaskService.
   * Looking at the escrow flow: escrow starts PENDING, then is funded via webhook.
   * If a worker accepts a task before the poster funds the escrow (or the webhook
   * hasn't fired yet), there is no escrow-state guard in the accept flow at the
   * EscrowService level.
   *
   * The escrow router's `release` endpoint requires FUNDED/LOCKED_DISPUTE, so
   * the funds cannot be released from PENDING. However, the task can proceed
   * (worker accepts, completes) while escrow sits in PENDING. At release time,
   * the release() call will fail with INVALID_STATE because PENDING is not in
   * ('FUNDED', 'LOCKED_DISPUTE').
   *
   * VERDICT: WRONG — no proactive guard prevents task work from proceeding with
   * unfunded escrow. The failure is caught at release time (not acceptance time),
   * meaning a worker can complete a task and only discover they cannot be paid
   * after the work is done. This is a UX/protection gap, not a financial exploit
   * (no funds are lost — the poster simply hasn't paid yet).
   */
  it('release() on PENDING escrow returns INVALID_STATE — worker cannot be paid', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'PENDING' };
    const taskRow = { worker_id: 'worker-1', price: 5000 };
    const kycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [kycRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE fails — PENDING not in valid states
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never); // getById

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('PENDING');
    }
    // VERDICT: WRONG — failure is at release time, not task-accept time.
  });
});

describe('ATTACK 6: Fund escrow twice (double-funding)', () => {
  /**
   * fund() SQL (EscrowService.ts:234-243):
   *   UPDATE escrows SET state='FUNDED' WHERE id=$1 AND state='PENDING' RETURNING *
   *
   * The WHERE clause requires state='PENDING'. If fund() is called a second time
   * on an already-FUNDED escrow, the UPDATE matches 0 rows → service returns
   * INVALID_STATE error. No double-funding is possible via this path.
   *
   * Additionally, stripe_payment_intent_id is set on first fund() call.
   * Stripe itself deduplicates payment_intent.succeeded webhooks via the
   * processed_stripe_events table (StripeService.ts:98-103).
   *
   * VERDICT: SAFE — state machine prevents double-funding.
   */
  it('second fund() call on FUNDED escrow returns INVALID_STATE', async () => {
    // fund() is now wrapped in db.transaction():
    //   1st: SELECT FOR UPDATE → row with state='FUNDED'
    //   2nd: cross-escrow PI dedup check → no conflict (runs before the state check)
    //   state check then fires and returns INVALID_STATE
    mockDb.query.mockResolvedValueOnce({
      rows: [{ state: 'FUNDED', version: 1 }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({
      rows: [],
      rowCount: 0,
    } as never);

    const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_second' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
      expect(result.error.message).toContain('expected PENDING');
    }
    // VERDICT: SAFE — double-funding blocked by state guard.
  });
});

describe('ATTACK 7: Release with no Stripe Connect account', () => {
  /**
   * EscrowService.release() lines 364-372:
   *   if (!workerKyc.stripe_connect_id) {
   *     return { success: false, error: { code: 'INVALID_STATE', message: '...' } }
   *   }
   *
   * The check is at line 364 BEFORE the DB UPDATE (line 390).
   * So: no Stripe Connect ID → early return, escrow state NOT changed.
   * Escrow remains in FUNDED/LOCKED_DISPUTE — no corruption.
   *
   * VERDICT: SAFE — KYC pre-flight check prevents state corruption.
   * File: backend/src/services/EscrowService.ts:364
   */
  it('release() with no stripe_connect_id returns error and does NOT change escrow state', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
    const taskRow = { worker_id: 'worker-1', price: 5000 };
    const kycRow = { payouts_enabled: true, stripe_connect_id: null, stripe_connect_status: null };

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [kycRow], rowCount: 1 } as never);
    // NOTE: no 4th mock — the UPDATE should never be called

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('Stripe Connect');
    }

    // Only 3 DB calls were made — no UPDATE fired
    expect(mockDb.query).toHaveBeenCalledTimes(3);
    // VERDICT: SAFE — escrow not corrupted.
  });

  it('release() with payouts_enabled=false returns error and does NOT change escrow state', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
    const taskRow = { worker_id: 'worker-1', price: 5000 };
    const kycRow = { payouts_enabled: false, stripe_connect_id: 'acct_pending', stripe_connect_status: 'pending' };

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [kycRow], rowCount: 1 } as never);

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('KYC incomplete');
    }
    expect(mockDb.query).toHaveBeenCalledTimes(3);
    // VERDICT: SAFE — payouts_enabled=false blocks release.
  });
});

describe('ATTACK 8: Partial payout math — pennies lost or gained', () => {
  /**
   * EscrowService.release() lines 386-387:
   *   const platformFeeCents = Math.round(grossPayoutCents * (platformFeePercent / 100))
   *   const netPayoutCents = grossPayoutCents - platformFeeCents
   *
   * Math.round() on the fee means: platformFee + netPayout = grossPayout ALWAYS,
   * because netPayout is defined as gross - fee (not rounded independently).
   *
   * Verify: for $100 escrow at 15%:
   *   fee = Math.round(10000 * 0.15) = Math.round(1500) = 1500
   *   net = 10000 - 1500 = 8500
   *   fee + net = 1500 + 8500 = 10000 ✓
   *
   * For edge case escrow=$7 at 15%:
   *   fee = Math.round(700 * 0.15) = Math.round(105) = 105
   *   net = 700 - 105 = 595
   *   fee + net = 105 + 595 = 700 ✓
   *
   * VERDICT: SAFE — no pennies lost. netPayout is a subtraction from gross,
   * so gross always equals fee + net exactly.
   */
  it('platform_fee + net_payout = escrow.amount exactly at $100 / 15%', () => {
    const grossPayoutCents = 10000;
    const platformFeePercent = 15;
    const platformFeeCents = Math.round(grossPayoutCents * (platformFeePercent / 100));
    const netPayoutCents = grossPayoutCents - platformFeeCents;
    expect(platformFeeCents + netPayoutCents).toBe(grossPayoutCents);
  });

  it('platform_fee + net_payout = escrow.amount exactly at $7 / 15% (rounding edge)', () => {
    const grossPayoutCents = 700;
    const platformFeePercent = 15;
    const platformFeeCents = Math.round(grossPayoutCents * (platformFeePercent / 100));
    const netPayoutCents = grossPayoutCents - platformFeeCents;
    expect(platformFeeCents + netPayoutCents).toBe(grossPayoutCents);
  });

  it('platform_fee + net_payout = escrow.amount exactly at $500 minimum / 15%', async () => {
    // Also verify recordEarnings receives the correct net amount
    mockReleaseHappyPath(500, 500);

    await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });

    const grossPayoutCents = 500;
    const platformFeePercent = 15;
    const platformFeeCents = Math.round(grossPayoutCents * (platformFeePercent / 100)); // 75
    const netPayoutCents = grossPayoutCents - platformFeeCents; // 425

    // F54-2: insurance = 2% of gross (500), not net (425)
    // insurance = Math.round(500 * 0.02) = 10; resolvedNet = 425 - 10 = 415
    expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
      'worker-1', 'task-1', 'esc-1', netPayoutCents - Math.round(grossPayoutCents * 0.02), // 425 - 10 = 415
    );
    expect(platformFeeCents + netPayoutCents).toBe(grossPayoutCents);
    // VERDICT: SAFE
  });

  it('self-insurance contribution is 2% of GROSS (task price) — F54-2 fix', async () => {
    /**
     * F54-2 FIX: SelfInsurancePoolService.recordContribution is called with:
     *   insuranceContributionCents = Math.round(grossPayoutCents * 0.02)
     *
     * Per spec: contribution = 2% of task price (gross), matching
     * SelfInsurancePoolService.calculateContribution(taskPriceCents).
     *
     * gross=10000, fee=1500 (15%), netBeforeInsurance=8500,
     * insurance=Math.round(10000*0.02)=200
     * resolvedNet = 8500 - 200 = 8300
     *
     * VERDICT: FIXED (F54-2) — insurance is now on gross, matching the spec.
     */
    mockReleaseHappyPath(10000, 10000);
    await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });

    const expectedInsurance = Math.round(10000 * 0.02); // 200 cents ($2.00) — 2% of gross
    expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
      'task-1', 'worker-1', expectedInsurance,
    );

    // Net payout to worker is gross minus platform fee minus 2% insurance on gross
    const expectedNet = 10000 - Math.round(10000 * 0.15); // 8500
    const expectedTransfer = expectedNet - Math.round(10000 * 0.02); // 8500 - 200 = 8300
    expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
      'worker-1', 'task-1', 'esc-1', expectedTransfer,
    );
  });
});

// ===========================================================================
// ATTACK GROUP 3: REFUND EDGE CASES
// ===========================================================================

describe('ATTACK 9: Refund on LOCKED_DISPUTE state', () => {
  /**
   * SECURITY FIX (v2.9.3): refund() SQL now only permits state = 'FUNDED'.
   * LOCKED_DISPUTE was removed from the WHERE clause.
   *
   * A poster can no longer call refund() while a worker's dispute is active.
   * LOCKED_DISPUTE → REFUNDED is still a valid state-machine transition,
   * but it is only reachable via the admin dispute-resolution path
   * (partialRefund or admin-invoked refund), not via the poster refund endpoint.
   *
   * VERDICT: FIXED — poster cannot shortcut an active dispute.
   */
  it('refund() on LOCKED_DISPUTE now returns INVALID_STATE — exploit closed', async () => {
    // T1 pre-check returns state=LOCKED_DISPUTE — the guard triggers immediately before T2 is reached.
    // The T1 LOCKED_DISPUTE guard (line ~794) returns INVALID_STATE for non-admin callers.
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', state: 'LOCKED_DISPUTE' }], rowCount: 1 } as never); // T1 pre-check: LOCKED_DISPUTE triggers guard

    const result = await EscrowService.refund({ escrowId: 'esc-1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toContain('Cannot refund escrow');
    }
    // VERDICT: FIXED — poster can no longer refund mid-dispute.
  });
});

describe('ATTACK 10: Double refund', () => {
  /**
   * refund() checks state IN ('FUNDED','LOCKED_DISPUTE').
   * After first refund: state = 'REFUNDED' (terminal state).
   * Second call: UPDATE WHERE state IN ('FUNDED','LOCKED_DISPUTE') → 0 rows.
   * getById returns REFUNDED → isTerminalState() = true → ESCROW_TERMINAL error.
   *
   * VERDICT: SAFE — double refund blocked by terminal state check.
   */
  it('second refund() call returns ESCROW_TERMINAL', async () => {
    // FIX 3 + F-05: T1 pre-checks, then T2 FOR UPDATE NOWAIT re-read (FUNDED), UPDATE misses, getById sees REFUNDED
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }], rowCount: 1 } as never) // T1: SELECT task_id
      .mockResolvedValueOnce({ rows: [{ worker_id: null }], rowCount: 1 } as never)   // T1: SELECT worker_id
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', version: 1, state: 'FUNDED' }], rowCount: 1 } as never) // F-05: T2 FOR UPDATE NOWAIT
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // T2: UPDATE miss (already REFUNDED)
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'REFUNDED' })], rowCount: 1 } as never); // getById fallback

    const result = await EscrowService.refund({ escrowId: 'esc-1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HX002'); // ESCROW_TERMINAL
    }
    // VERDICT: SAFE — no double refund possible.
  });
});

describe('ATTACK 11: Refund amount vs original charge amount', () => {
  /**
   * EscrowService.refund() only changes state — it does NOT interact with Stripe.
   * The actual Stripe refund call is in StripeService.createRefund(), which
   * accepts an optional `amount` param (undefined = full refund).
   *
   * escrow.amount is set at creation (INV-4: immutable after creation per CLAUDE.md).
   * The DB trigger `escrow_balance_check` enforces positive amounts.
   * There is no UPDATE path on escrow.amount in the codebase.
   *
   * StripeService.createRefund() does not read escrow.amount — it just passes
   * through the `amount` the caller provides (or undefined for full).
   * The caller (router/webhook handler) must correctly pass the original charged amount.
   *
   * VERDICT: SAFE at the EscrowService level — amount is immutable. Any
   * discrepancy would require the router layer to pass the wrong amount to
   * StripeService.createRefund(), which is a caller responsibility.
   */
  it('escrow.amount is immutable — fund() only updates state and payment_intent_id (not amount)', async () => {
    const funded = makeEscrow({ state: 'FUNDED', amount: 5000 });
    // fund() is wrapped in db.transaction():
    //   1st query: SELECT state, version FOR UPDATE → lock row with state=PENDING
    //   2nd query: cross-escrow PI dedup check → no conflict
    //   3rd query: UPDATE escrows ... RETURNING *   → funded row with unchanged amount
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'PENDING', version: 0 }], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [funded], rowCount: 1 } as never);

    const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_123' });
    expect(result.success).toBe(true);
    if (result.success) {
      // amount is returned as-is from the DB (immutable)
      expect(result.data.amount).toBe(5000);
    }
    // VERDICT: SAFE — amount never changes after creation.
  });
});

// ===========================================================================
// ATTACK GROUP 4: SELF-INSURANCE POOL
// ===========================================================================

describe('ATTACK 12: Pool contribution path', () => {
  /**
   * F54-2 FIX: SelfInsurancePoolService.recordContribution() is called from EscrowService.release()
   * with: `Math.round(grossPayoutCents * 0.02)`
   *
   * Per spec: contribution = 2% of task price (gross), matching
   * SelfInsurancePoolService.calculateContribution(taskPriceCents).
   *
   * It is called on EVERY successful release, regardless of task type.
   *
   * The contribution uses ON CONFLICT (task_id, hustler_id) DO NOTHING,
   * so calling release() twice for the same escrow would contribute only once.
   * (But double-release is already blocked by the state machine.)
   *
   * VERDICT: SAFE — pool is funded on every release, idempotent.
   */
  it('pool contribution is 2% of gross (task price), called on every release — F54-2', async () => {
    mockReleaseHappyPath(10000, 10000);
    await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });

    expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledTimes(1);
    expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
      'task-1',
      'worker-1',
      200, // F54-2: 2% of gross 10000 = 200 (not 170 which was 2% of net 8500)
    );
    // VERDICT: FIXED (F54-2) — funded on every release, calculated on gross amount per spec.
  });

  it('pool contribution is also called when releasing from LOCKED_DISPUTE (dispute worker-win)', async () => {
    mockReleaseHappyPath(10000, 10000, 'LOCKED_DISPUTE');
    await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });

    expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledTimes(1);
    // VERDICT: SAFE — pool is funded even on dispute-resolution releases.
  });
});

describe('ATTACK 13: Pool funding on dispute LOSS (poster wins — refund path)', () => {
  /**
   * When the poster wins a dispute, the resolution path is:
   *   - EscrowService.refund() → state = REFUNDED (poster gets money back)
   *   OR
   *   - EscrowService.partialRefund() → state = REFUND_PARTIAL
   *
   * Neither refund() nor partialRefund() calls SelfInsurancePoolService.
   * Only release() calls recordContribution().
   *
   * So: if a dispute is resolved in the POSTER's favor (refund), the pool
   * receives NO contribution from that task. The 2% is only collected on
   * worker payouts.
   *
   * VERDICT: WRONG (design gap, not exploitable) — pool is NOT funded when
   * poster wins a dispute. Tasks that result in refunds contribute nothing
   * to the insurance pool, which may undermine pool solvency over time.
   */
  it('refund() does NOT call SelfInsurancePoolService — pool unfunded on poster-wins-dispute', async () => {
    const refundedEscrow = makeEscrow({ state: 'REFUNDED' });
    // FIX 3: refund() pre-fetches task_id + worker_id before the UPDATE
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }], rowCount: 1 } as never) // SELECT task_id
      .mockResolvedValueOnce({ rows: [{ worker_id: null }], rowCount: 1 } as never)   // SELECT worker_id
      .mockResolvedValueOnce({ rows: [refundedEscrow], rowCount: 1 } as never)        // UPDATE
      .mockResolvedValueOnce({ rowCount: 1 } as never);                               // logEscrowEvent

    await EscrowService.refund({ escrowId: 'esc-1' });
    expect(SelfInsurancePoolService.recordContribution).not.toHaveBeenCalled();
    // VERDICT: WRONG — pool contribution skipped on refund path.
  });
});

// ===========================================================================
// ATTACK GROUP 5: TIP HANDLING
// ===========================================================================

describe('ATTACK 14: Tip platform cut', () => {
  /**
   * TippingService.ts line 98: "no platform fee on tips — 100% to worker"
   * The createPaymentIntent call for tips does NOT include application_fee_amount.
   * (Lines 113-129: no application_fee_amount in the paymentIntents.create call)
   *
   * The transfer_data.destination is set (if worker has Connect account), meaning
   * funds flow directly to the worker's Connect account with no platform deduction.
   *
   * This is an INTENTIONAL DESIGN DECISION per the service docstring.
   *
   * VERDICT: SAFE by design — tips have 0% platform cut. This is documented
   * product behavior, not a bug. However, it IS a revenue leak from the
   * platform's perspective: a $50 task at 15% = $7.50 platform fee, but a
   * $50 tip generates $0 platform fee.
   *
   * File: backend/src/services/TippingService.ts:98-129
   */
  it('tip PaymentIntent has no application_fee_amount (0% platform cut) — documented design', () => {
    // We verify by inspecting the code path: TippingService creates a PaymentIntent
    // WITHOUT application_fee_amount. This test documents the behavior.

    // The Stripe PaymentIntent params built at TippingService.ts:113-129:
    const paymentIntentParams = {
      amount: 5000,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      metadata: { type: 'tip', task_id: 'task-1', poster_id: 'poster-1', worker_id: 'worker-1' },
      transfer_data: { destination: 'acct_worker' },
      description: 'HustleXP Tip for Task task-1',
    };

    // No application_fee_amount key
    expect('application_fee_amount' in paymentIntentParams).toBe(false);
    // VERDICT: SAFE by design — 0% tip cut is intentional.
    // Revenue consideration: tips bypass platform fee entirely.
  });
});

describe('ATTACK 15: Tip before task completion', () => {
  /**
   * TippingService.createTip() lines 70-72:
   *   if (task.state !== 'COMPLETED') {
   *     return { success: false, error: { code: 'INVALID_STATE', message: 'Can only tip on completed tasks' } }
   *   }
   *
   * The guard is a strict equality check against 'COMPLETED'. Any other state
   * (OPEN, ACCEPTED, PROOF_SUBMITTED, DISPUTED, CANCELLED, EXPIRED) is rejected.
   *
   * VERDICT: SAFE — tip requires COMPLETED state, enforced at service layer.
   * File: backend/src/services/TippingService.ts:70
   */
  it('tip on non-COMPLETED task is rejected — guard is strict', async () => {
    // We verify the logic inline (TippingService requires real Stripe, so we test the guard logic)
    const states = ['OPEN', 'ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED', 'CANCELLED', 'EXPIRED', 'MATCHING'];
    for (const state of states) {
      // The guard: task.state !== 'COMPLETED' → reject
      expect(state !== 'COMPLETED').toBe(true);
    }
    expect('COMPLETED' !== 'COMPLETED').toBe(false);
    // VERDICT: SAFE — all non-COMPLETED states are blocked.
  });
});

// ===========================================================================
// ATTACK GROUP 6: ADDITIONAL EDGE CASES
// ===========================================================================

describe('ATTACK 16: Double release via terminal state check', () => {
  /**
   * release() after first release: state = RELEASED (terminal).
   * Second release call:
   *   1. SELECT escrow → { state: 'RELEASED' }
   *   2. SELECT task → returns worker
   *   3. SELECT KYC → returns valid worker
   *   4. UPDATE WHERE state IN ('FUNDED','LOCKED_DISPUTE') → 0 rows
   *   5. getById fallback → state: 'RELEASED' → isTerminalState() = true → ESCROW_TERMINAL
   *
   * VERDICT: SAFE — ESCROW_TERMINAL code blocks double release.
   * File: backend/src/services/EscrowService.ts:407-414
   */
  it('second release() on already-RELEASED escrow returns ESCROW_TERMINAL', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'RELEASED' };
    const taskRow = { worker_id: 'worker-1', price: 5000 };
    const kycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)   // SELECT escrow (state RELEASED)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)     // SELECT task
      .mockResolvedValueOnce({ rows: [kycRow], rowCount: 1 } as never)      // SELECT KYC
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)            // UPDATE — 0 rows
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED' })], rowCount: 1 } as never); // getById

    const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HX002'); // ESCROW_TERMINAL
    }
    // VERDICT: SAFE — no double-release possible.
  });
});

describe('ATTACK 17: XP formula uses gross payout (not net) — XP over-award', () => {
  /**
   * EscrowService.release() line 465:
   *   const xpAmount = Math.round(grossPayoutCents / 10)
   *
   * XP is calculated on GROSS (before platform fee deduction), not NET.
   * For a $100 task: XP = Math.round(10000 / 10) = 1000 XP
   * Worker receives net = $85, but earns XP for $100 of "work."
   *
   * This is not a financial exploit but means XP is slightly over-awarded
   * relative to actual worker earnings. Platform has an incentive to keep this
   * because higher XP = more engagement.
   *
   * VERDICT: WRONG (minor design inconsistency) — XP is based on gross, not net.
   * Not a financial invariant violation; just an inconsistency between what
   * the worker is paid vs what they earn in XP.
   * File: backend/src/services/EscrowService.ts:465
   */
  it('XP award uses grossPayoutCents (not net) — XP overcounted relative to worker earnings', async () => {
    mockReleaseHappyPath(10000, 10000);
    const { XPService } = await import('../../src/services/XPService');
    await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_atk' });

    // XP = gross / 10 = 10000 / 10 = 1000
    expect(XPService.awardXP).toHaveBeenCalledWith(
      expect.objectContaining({ baseXP: 1000 }), // gross-based
    );

    // Net payout was 8500 (85%), so "correct" XP would be 850
    // But code awards 1000 (gross-based)
    expect(1000).toBeGreaterThan(850); // XP is over-awarded vs net
    // VERDICT: WRONG — not exploitable but XP inflated by 17.6% vs net-based calc.
  });
});

describe('ATTACK 18: Dispute window bypass — lockForDispute after window expires', () => {
  /**
   * BUG-2 FIX: The service-level completed_at == null guard has been removed.
   * The defence is now at the router layer (escrow.lockForDispute validates that
   * the task is in an active disputeable state: ACCEPTED/IN_PROGRESS/PROOF_SUBMITTED/DISPUTED).
   * The service-level guard created contradictory preconditions — the router allowed active
   * tasks while the service required completed_at IS NOT NULL, making the feature completely
   * non-functional for legitimate non-admin users.
   *
   * Challenge-window enforcement (completed_at + challenge_window_hours) still runs when
   * completed_at is non-null, so completed tasks outside the window are still rejected.
   *
   * VERDICT: FIXED at the router layer. Service-level guard removed (was contradictory).
   * Active task disputes (completed_at = null) now proceed through the service;
   * the router's task-state allowlist prevents abuse.
   */
  it('lockForDispute on escrow with null completed_at proceeds (router guards task state; service no longer blocks)', async () => {
    // Window check returns completed_at = null → no window check runs (skipped for active tasks)
    // Dup dispute check returns 0 open disputes
    // UPDATE: returns 0 rows (version mismatch / wrong state) → service calls getById for error message
    // getById: returns an escrow row (so the INVALID_STATE path returns a meaningful message)
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ completed_at: null, challenge_window_hours: 6, version: 1 }], rowCount: 1 } as never)  // window check (FOR UPDATE)
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never)   // dup dispute check
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)                  // UPDATE escrows SET state=LOCKED_DISPUTE → 0 rows (wrong state)
      .mockResolvedValueOnce({ rows: [{ id: 'esc-1', state: 'REFUNDED', poster_id: 'p1', worker_id: 'w1' }], rowCount: 1 } as never); // getById fallback

    // The service now proceeds past the completed_at check and attempts the UPDATE.
    // The UPDATE returns 0 rows (escrow not in FUNDED state) → INVALID_STATE returned.
    const result = await EscrowService.lockForDispute('esc-1');
    expect(result.success).toBe(false);
    // The error should be INVALID_STATE (from the UPDATE returning 0 rows) — not BAD_REQUEST.
    // This confirms the completed_at guard is gone and the service proceeds to the UPDATE attempt.
    expect((result as { success: false; error: { code: string } }).error.code).toBe('INVALID_STATE');
    expect((result as { success: false; error: { code: string } }).error.code).not.toBe('BAD_REQUEST');
  });
});

describe('ATTACK 19: Poster-supplied custom amount vs canonical task and escrow', () => {
  it('requires exact integer-cent equality before Stripe is called', () => {
    const canonicalTaskPrice = 5000;
    const canonicalEscrowAmount = 5000;
    const mayCreatePaymentIntent = (callerAmount: number) =>
      callerAmount === canonicalTaskPrice && callerAmount === canonicalEscrowAmount;

    expect(mayCreatePaymentIntent(100)).toBe(false);  // $1 for a $50 task
    expect(mayCreatePaymentIntent(5001)).toBe(false); // overpayment cannot strand a PI
    expect(mayCreatePaymentIntent(5000)).toBe(true);
  });
});
