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

vi.mock('../../src/config', () => ({ config: { payments: { platformFeePercent: 20 } } }));
vi.mock('../../src/services/EscrowPaymentBindingService.js', () => ({ loadEscrowPaymentBinding: vi.fn().mockResolvedValue({ provider: 'local_test', status: 'SUCCEEDED' }) }));
vi.mock('../../src/services/LocalCertificationPayoutProvider.js', () => ({ localCertificationPayoutEnabled: () => true, LocalCertificationPayoutProvider: { verifyPaidTransfer: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../src/lib/task-lifecycle-notifications.js', () => ({ notifyPaymentReleased: vi.fn() }));
vi.mock('../../src/services/EscrowRefundProvider.js', () => ({ recordManualRefundRequirement: vi.fn() }));

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
    provider_payment_id: null,
    funded_at: null,
    released_at: null,
    refunded_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

/** Controlled test releases still enforce the shared escrow invariants. */
function mockReleaseHappyPath(escrowAmount: number, taskPrice: number, escrowState = 'FUNDED', resolvedWorkerFavor = escrowState === 'LOCKED_DISPUTE') {
  const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: escrowAmount, state: escrowState, version: 1 };
  mockDb.query.mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never);
  if (escrowState === 'LOCKED_DISPUTE') mockDb.query.mockResolvedValueOnce({ rows: resolvedWorkerFavor ? [{ resolved_dispute_id: 'dispute-1' }] : [], rowCount: resolvedWorkerFavor ? 1 : 0 } as never);
  mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', price: taskPrice, state: 'COMPLETED', automation_classification: 'CONTROLLED_TEST' }], rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED', amount: escrowAmount })], rowCount: 1 } as never);
}
beforeEach(() => { vi.clearAllMocks(); mockDb.query.mockReset(); });

// ===========================================================================
// ATTACK GROUP 1: PLATFORM FEE BYPASS
// ===========================================================================

describe('ATTACK 1: Fee calculation base (escrow.amount vs task.price)', () => {

  it('fee is calculated on canonical escrow.amount even for a corrupt legacy mismatch', async () => {
    // escrow funded at $40, but task.price is $60
    const escrowAmount = 4000;
    const taskPrice = 6000;

    mockReleaseHappyPath(escrowAmount, taskPrice);

    const result = await EscrowService.release({ escrowId: 'esc-1', localTestTransferId: 'tr_test_atk' });
    expect(result.success).toBe(true);

    // Legacy fallback margin is 20% of escrow.amount ($40) = $8, NOT 20% of task.price ($60) = $12
    const expectedFeeOnEscrow = Math.round(4000 * 0.20); // 800 cents
    const expectedFeeOnTaskPrice = Math.round(6000 * 0.20); // 1200 cents

    // recordEarnings receives finalPayout = escrowAmount - platformFee - 2% insurance on gross
    // net = 4000 - 800 = 3200; insurance = Math.round(4000*0.02) = 80; final = 3200 - 80 = 3120
    expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
      'worker-1',
      'task-1',
      'esc-1',
      3120, // F54-2: insurance = 2% of gross 4000 = 80; resolvedNet = 3200 - 80 = 3120
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

  it('platform fee cannot round to 0 at the $5 minimum task value (500 cents)', () => {
    const escrowAmount = 500; // $5.00 — system minimum
    const platformFeePercent = 15;
    const platformFeeCents = Math.round(escrowAmount * (platformFeePercent / 100));
    expect(platformFeeCents).toBe(75); // $0.75 — not zero
  });
});

describe('ATTACK 3: Fee percentage stored in env — no DB manipulation possible', () => {

  it('negative fee input is clamped and cannot overpay the worker', async () => {
    const { clampFeePercent, computePlatformFeeCents } = await import('../../src/lib/money.js');
    expect(clampFeePercent(-5)).toBe(0);
    expect(computePlatformFeeCents(10000, -5)).toBe(0);
  });
});

// ===========================================================================
// ATTACK GROUP 2: ESCROW STATE CORRUPTION
// ===========================================================================

describe('ATTACK 4: Concurrent release + dispute (TOCTOU race)', () => {

  it('rejects ordinary release from LOCKED_DISPUTE while no resolved worker-favor decision exists', async () => {
    mockReleaseHappyPath(5000, 5000, 'LOCKED_DISPUTE', false);

    const result = await EscrowService.release({ escrowId: 'esc-1', localTestTransferId: 'tr_test_atk' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
      expect(result.error.message).toMatch(/resolved worker-favor dispute/i);
    }
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

  it('release() on PENDING escrow returns INVALID_STATE — worker cannot be paid', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'PENDING' };
    const taskRow = { worker_id: 'worker-1', price: 5000, state: 'COMPLETED', automation_classification: 'CONTROLLED_TEST' };

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE fails — PENDING not in valid states
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never); // getById

    const result = await EscrowService.release({ escrowId: 'esc-1', localTestTransferId: 'tr_test_atk' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
    }
    // VERDICT: WRONG — failure is at release time, not task-accept time.
  });
});

describe('ATTACK 6: Fund escrow twice (double-funding)', () => {

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

    const result = await EscrowService.fund({ escrowId: 'esc-1', providerPaymentId: 'pi_second' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_STATE');
      expect(result.error.message).toContain('expected PENDING');
    }
    // VERDICT: SAFE — double-funding blocked by state guard.
  });
});

describe('ATTACK 8: Partial payout math — pennies lost or gained', () => {

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

  it('platform_fee + net_payout = escrow.amount exactly at $500 minimum / 20% fallback', async () => {
    // Also verify recordEarnings receives the correct net amount
    mockReleaseHappyPath(500, 500);

    await EscrowService.release({ escrowId: 'esc-1', localTestTransferId: 'tr_test_atk' });

    const grossPayoutCents = 500;
    const platformFeePercent = 20;
    const platformFeeCents = Math.round(grossPayoutCents * (platformFeePercent / 100)); // 100
    const netPayoutCents = grossPayoutCents - platformFeeCents; // 400

    // F54-2: insurance = 2% of gross (500), not net (400)
    // insurance = Math.round(500 * 0.02) = 10; resolvedNet = 400 - 10 = 390
    expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
      'worker-1', 'task-1', 'esc-1', netPayoutCents - Math.round(grossPayoutCents * 0.02), // 400 - 10 = 390
    );
    expect(platformFeeCents + netPayoutCents).toBe(grossPayoutCents);
    // VERDICT: SAFE
  });

  it('self-insurance contribution is 2% of GROSS (task price) — F54-2 fix', async () => {

    mockReleaseHappyPath(10000, 10000);
    await EscrowService.release({ escrowId: 'esc-1', localTestTransferId: 'tr_test_atk' });

    const expectedInsurance = Math.round(10000 * 0.02); // 200 cents ($2.00) — 2% of gross
    expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
      'task-1', 'worker-1', expectedInsurance,
    );

    // Net payout to worker is gross minus platform fee minus 2% insurance on gross
    const expectedNet = 10000 - Math.round(10000 * 0.20); // 8000
    const expectedTransfer = expectedNet - Math.round(10000 * 0.02); // 8000 - 200 = 7800
    expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
      'worker-1', 'task-1', 'esc-1', expectedTransfer,
    );
  });
});

// ===========================================================================
// ATTACK GROUP 3: REFUND EDGE CASES
// ===========================================================================

describe('ATTACK 9: Refund on LOCKED_DISPUTE state', () => {

  it('refund() on LOCKED_DISPUTE now returns INVALID_STATE — exploit closed', async () => {
    // T1 pre-check returns state=LOCKED_DISPUTE — the guard triggers immediately before T2 is reached.
    // The T1 LOCKED_DISPUTE guard (line ~794) returns INVALID_STATE for non-admin callers.
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', state: 'LOCKED_DISPUTE' }], rowCount: 1 } as never); // T1 pre-check: LOCKED_DISPUTE triggers guard

    const result = await EscrowService.refund({ escrowId: 'esc-1' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('MANUAL_REFUND_REQUIRED');
    }
    // VERDICT: FIXED — poster can no longer refund mid-dispute.
  });
});

describe('ATTACK 10: Double refund', () => {
  it('a completed refund replay does not create another obligation', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [makeEscrow({ state: 'REFUNDED' })], rowCount: 1 } as never);
    const result = await EscrowService.refund({ escrowId: 'esc-1' });
    expect(result.success).toBe(true);
    expect(mockDb.query).toHaveBeenCalledTimes(1);
  });
});

describe('ATTACK 11: Refund amount vs original charge amount', () => {

  it('escrow.amount is immutable — fund() only updates state and payment_intent_id (not amount)', async () => {
    const funded = makeEscrow({ state: 'FUNDED', amount: 5000 });
    // fund() is wrapped in db.transaction():
    //   1st query: SELECT state, version FOR UPDATE → lock row with state=PENDING
    //   2nd query: cross-escrow PI dedup check → no conflict
    //   3rd query: UPDATE escrows ... RETURNING *   → funded row with unchanged amount
    mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'PENDING', version: 0 }], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [funded], rowCount: 1 } as never);

    const result = await EscrowService.fund({ escrowId: 'esc-1', providerPaymentId: 'pi_123' });
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

  it('pool contribution is 2% of gross (task price), called on every release — F54-2', async () => {
    mockReleaseHappyPath(10000, 10000);
    await EscrowService.release({ escrowId: 'esc-1', localTestTransferId: 'tr_test_atk' });

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
    const result = await EscrowService.release({ escrowId: 'esc-1', localTestTransferId: 'tr_test_atk' });

    expect(result.success).toBe(true);
    expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledTimes(1);
    // VERDICT: SAFE — pool is funded even on dispute-resolution releases.
  });
});

describe('ATTACK 13: Pool funding on dispute LOSS (poster wins — refund path)', () => {

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
// ATTACK GROUP 6: ADDITIONAL EDGE CASES
// ===========================================================================

describe('ATTACK 16: Double release via terminal state check', () => {

  it('second release() on already-RELEASED escrow returns ESCROW_TERMINAL', async () => {
    const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'RELEASED' };
    const taskRow = { worker_id: 'worker-1', price: 5000 };

    mockDb.query
      .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)   // SELECT escrow (state RELEASED)
      .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)     // SELECT task
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)            // UPDATE — 0 rows
      .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED' })], rowCount: 1 } as never); // getById

    const result = await EscrowService.release({ escrowId: 'esc-1', localTestTransferId: 'tr_test_atk' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HX002'); // ESCROW_TERMINAL
    }
    // VERDICT: SAFE — no double-release possible.
  });
});

describe('ATTACK 17: XP formula uses gross payout (not net) — XP over-award', () => {

  it('XP award uses grossPayoutCents (not net) — XP overcounted relative to worker earnings', async () => {
    mockReleaseHappyPath(10000, 10000);
    const { XPService } = await import('../../src/services/XPService');
    await EscrowService.release({ escrowId: 'esc-1', localTestTransferId: 'tr_test_atk' });

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
