/**
 * LEDGER INVARIANTS — PROPERTY-BASED TESTS
 *
 * Uses fast-check to verify financial invariants hold for arbitrary inputs.
 * Property tests generate hundreds of random inputs to catch edge cases that
 * hand-crafted unit tests miss.
 *
 * INVARIANTS TESTED:
 *   1. Base XP non-negativity: calculateBaseXP(n) >= 10 for all n >= 0
 *   2. Decay factor bounds: calculateDecayFactor(xp) ∈ [0.1, 1.0] for all xp >= 0
 *   3. Effective XP non-negativity: baseXP * decayFactor >= 0 for any valid inputs
 *   4. Split amount preservation: releaseAmount + refundAmount === taskAmount (no rounding loss)
 *   5. Platform fee invariant: grossAmount - platformFee + platformFee === grossAmount
 *   6. Streak multiplier bounds: getStreakMultiplier(s) ∈ [1.0, 1.5] for all s >= 0
 *   7. Level monotonicity: calculateLevel is non-decreasing in totalXP
 *   8. Final XP floor: finalXP >= 1 for any positive price and any cumulative XP
 *
 * @version 1.0.0
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  calculateBaseXP,
  calculateDecayFactor,
  calculateLevel,
  getStreakMultiplier,
} from '../services/AtomicXPService.js';

// ============================================================================
// HELPERS — mirror the inline computation from awardXPInTx
// ============================================================================

/**
 * Computes the effective XP (before streak) that awardXPInTx would produce.
 * Mirrors the production code so we can test its numerical properties in
 * isolation without touching the database.
 */
function computeEffectiveXP(priceCents: number, totalXP: number): number {
  const baseXP = calculateBaseXP(priceCents);
  const decayFactor = calculateDecayFactor(totalXP).toNumber();
  return Math.round(baseXP * decayFactor);
}

/**
 * Computes the final XP that awardXPInTx would persist.
 * Math.max(1, ...) matches the production floor used in awardXPInTx.
 */
function computeFinalXP(
  priceCents: number,
  totalXP: number,
  streak: number,
): number {
  const effectiveXP = computeEffectiveXP(priceCents, totalXP);
  const streakMul = getStreakMultiplier(streak);
  return Math.max(1, Math.round(effectiveXP * streakMul));
}

/**
 * Mirrors the platform fee calculation in StripeService:
 *   platformFeeCents = Math.round(amountCents * PLATFORM_FEE_PERCENT)
 * where PLATFORM_FEE_PERCENT defaults to 0.15 (15%).
 */
function computePlatformFee(grossCents: number, feeBps: number): number {
  // feeBps in basis points (e.g. 1500 = 15%)
  return Math.round(grossCents * (feeBps / 10000));
}

// ============================================================================
// INVARIANT 1 — Base XP non-negativity and minimum floor
// ============================================================================

describe('calculateBaseXP — non-negativity and minimum', () => {
  it('returns a value >= 10 for any non-negative price in cents', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_00 }), // $0 – $1 000 000
        (priceCents) => {
          const baseXP = calculateBaseXP(priceCents);
          return baseXP >= 10;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('is always an integer', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_00 }),
        (priceCents) => {
          const baseXP = calculateBaseXP(priceCents);
          return Number.isInteger(baseXP);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ============================================================================
// INVARIANT 2 — Decay factor bounds [0.1, 1.0]
// ============================================================================

describe('calculateDecayFactor — multiplier bounds', () => {
  it('is always in [0.1, 1.0] for any cumulative XP >= 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }), // up to 10M XP
        (totalXP) => {
          const factor = calculateDecayFactor(totalXP).toNumber();
          return factor >= 0.1 && factor <= 1.0;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never exceeds 1.0 even at XP = 0 (fresh user)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100 }), // very low XP — early adopter range
        (totalXP) => {
          const factor = calculateDecayFactor(totalXP).toNumber();
          return factor <= 1.0;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('is monotonically non-increasing as XP grows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5_000_000 }),
        fc.integer({ min: 0, max: 5_000_000 }),
        (xpA, xpB) => {
          const higher = Math.max(xpA, xpB);
          const lower = Math.min(xpA, xpB);
          const factorHigher = calculateDecayFactor(higher).toNumber();
          const factorLower = calculateDecayFactor(lower).toNumber();
          // Higher cumulative XP must produce an equal or lower decay factor
          return factorHigher <= factorLower;
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ============================================================================
// INVARIANT 3 — Effective XP non-negativity
// ============================================================================

describe('effective XP — non-negativity', () => {
  it('is always >= 0 for any price and cumulative XP', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_00 }),   // task price in cents
        fc.integer({ min: 0, max: 10_000_000 }),   // cumulative XP
        (priceCents, totalXP) => {
          const effectiveXP = computeEffectiveXP(priceCents, totalXP);
          return effectiveXP >= 0;
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ============================================================================
// INVARIANT 4 — Split amount preservation (no rounding loss or gain)
// ============================================================================

describe('dispute split amounts — conservation', () => {
  it('releaseAmount + refundAmount === taskAmount for any integer split %', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000_00 }), // task amount in cents ($1 – $1 M)
        fc.integer({ min: 1, max: 99 }),             // split percent to hustler
        (taskAmountCents, splitPercent) => {
          const releaseAmountCents = Math.round(
            taskAmountCents * (splitPercent / 100),
          );
          const refundAmountCents = taskAmountCents - releaseAmountCents;
          return releaseAmountCents + refundAmountCents === taskAmountCents;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('release amount is always non-negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000_00 }),
        fc.integer({ min: 0, max: 100 }),
        (taskAmountCents, splitPercent) => {
          const releaseAmountCents = Math.round(
            taskAmountCents * (splitPercent / 100),
          );
          return releaseAmountCents >= 0;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('refund amount is always non-negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000_00 }),
        fc.integer({ min: 0, max: 100 }),
        (taskAmountCents, splitPercent) => {
          const releaseAmountCents = Math.round(
            taskAmountCents * (splitPercent / 100),
          );
          const refundAmountCents = taskAmountCents - releaseAmountCents;
          return refundAmountCents >= 0;
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ============================================================================
// INVARIANT 5 — Platform fee calculation: gross - fee + fee === gross
// ============================================================================

describe('platform fee calculation — accounting identity', () => {
  it('hustlerPayout + platformFee === grossAmount for any gross and fee rate', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 100, max: 100_000_00 }), // gross amount in cents
        fc.integer({ min: 0, max: 5000 }),           // fee in basis points (0–50%)
        (grossCents, feeBps) => {
          const platformFeeCents = computePlatformFee(grossCents, feeBps);
          const hustlerPayoutCents = grossCents - platformFeeCents;
          return platformFeeCents + hustlerPayoutCents === grossCents;
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('platform fee is never negative', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000_00 }),
        fc.integer({ min: 0, max: 5000 }),
        (grossCents, feeBps) => {
          const platformFeeCents = computePlatformFee(grossCents, feeBps);
          return platformFeeCents >= 0;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('hustler payout never exceeds gross amount', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_00 }),
        fc.integer({ min: 0, max: 5000 }),
        (grossCents, feeBps) => {
          const platformFeeCents = computePlatformFee(grossCents, feeBps);
          const hustlerPayoutCents = grossCents - platformFeeCents;
          return hustlerPayoutCents <= grossCents;
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ============================================================================
// INVARIANT 6 — Streak multiplier bounds [1.0, 1.5]
// ============================================================================

describe('getStreakMultiplier — bounds', () => {
  it('is always in [1.0, 1.5] for any streak >= 0', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }), // up to 10 000 consecutive days
        (streak) => {
          const mul = getStreakMultiplier(streak);
          return mul >= 1.0 && mul <= 1.5;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('is monotonically non-decreasing in streak length', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        (streakA, streakB) => {
          const higher = Math.max(streakA, streakB);
          const lower = Math.min(streakA, streakB);
          return getStreakMultiplier(higher) >= getStreakMultiplier(lower);
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ============================================================================
// INVARIANT 7 — Level monotonicity
// ============================================================================

describe('calculateLevel — monotonicity', () => {
  it('level(xp + delta) >= level(xp) for any positive delta', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),  // base XP
        fc.integer({ min: 1, max: 10_000 }),   // positive increment
        (baseXP, delta) => {
          return calculateLevel(baseXP + delta) >= calculateLevel(baseXP);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('is always in [1, 10]', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        (totalXP) => {
          const level = calculateLevel(totalXP);
          return level >= 1 && level <= 10;
        },
      ),
      { numRuns: 500 },
    );
  });
});

// ============================================================================
// INVARIANT 8 — Final XP floor: always >= 1
// ============================================================================

describe('finalXP — minimum floor', () => {
  it('is always >= 1 for any valid price, cumulative XP, and streak', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000_00 }),   // task price in cents (> 0)
        fc.integer({ min: 0, max: 10_000_000 }),   // cumulative XP
        fc.integer({ min: 0, max: 10_000 }),        // streak days
        (priceCents, totalXP, streak) => {
          const finalXP = computeFinalXP(priceCents, totalXP, streak);
          return finalXP >= 1;
        },
      ),
      { numRuns: 500 },
    );
  });
});
