/**
 * money.ts — unified money-math tests (AUDIT FIX H3/M10/M11).
 *
 * The decisive property: every decomposition sums EXACTLY to gross for every
 * representable amount — no path-dependent cents, no floats escaping.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/config', () => ({
  config: { stripe: { platformFeePercent: 15 } },
}));

import {
  computePlatformFeeCents,
  computeFeeBreakdown,
  xpForPriceCents,
  clampFeePercent,
  INSURANCE_RATE,
  feeBasisPoints,
  resolvePlatformFeeCents,
} from '../../src/lib/money';

describe('money — unified financial math (audit H3/M10/M11)', () => {
  describe('computePlatformFeeCents', () => {
    it('uses Math.round (the unified convention)', () => {
      // 1050 × 15% = 157.5 → round → 158 (floor would give 157 — the old StripeService divergence)
      expect(computePlatformFeeCents(1050, 15)).toBe(158);
      expect(computePlatformFeeCents(5000, 15)).toBe(750);
      expect(computePlatformFeeCents(1, 15)).toBe(0);
    });

    it('clamps malicious/invalid percents to [0,100] (v2.9.3 security fix preserved)', () => {
      expect(computePlatformFeeCents(10000, -50)).toBe(0);
      expect(computePlatformFeeCents(10000, 250)).toBe(10000);
      expect(clampFeePercent(undefined)).toBe(15);
      expect(clampFeePercent(null)).toBe(15);
    });

    it('rejects non-integer and negative gross (INV-1/INV-5)', () => {
      expect(() => computePlatformFeeCents(10.5, 15)).toThrow(TypeError);
      expect(() => computePlatformFeeCents(NaN, 15)).toThrow(TypeError);
      expect(() => computePlatformFeeCents(Infinity, 15)).toThrow(TypeError);
      expect(() => computePlatformFeeCents(-100, 15)).toThrow(RangeError);
    });
  });

  describe('computeFeeBreakdown — exact-sum property', () => {
    it('fee + insurance + net === gross for EVERY cent value 1..20000 (exhaustive)', () => {
      for (let gross = 1; gross <= 20000; gross++) {
        const b = computeFeeBreakdown(gross, 15);
        expect(b.platformFeeCents + b.insuranceContributionCents + b.netPayoutCents).toBe(gross);
        expect(Number.isInteger(b.platformFeeCents)).toBe(true);
        expect(Number.isInteger(b.insuranceContributionCents)).toBe(true);
        expect(Number.isInteger(b.netPayoutCents)).toBe(true);
      }
    });

    it('holds across fee percents 0..100 on awkward amounts (property sample)', () => {
      const grosses = [1, 3, 99, 101, 1050, 33333, 99999, 100001, 999999, 99999900];
      for (let pct = 0; pct <= 100; pct++) {
        for (const gross of grosses) {
          const b = computeFeeBreakdown(gross, pct);
          expect(b.platformFeeCents + b.insuranceContributionCents + b.netPayoutCents).toBe(gross);
        }
      }
    });

    it('insurance is 2% of GROSS (F54-2 basis, both release paths unified)', () => {
      const b = computeFeeBreakdown(10000, 15);
      expect(b.insuranceContributionCents).toBe(Math.round(10000 * INSURANCE_RATE));
      expect(b.insuranceContributionCents).toBe(200);
      expect(b.platformFeeCents).toBe(1500);
      expect(b.netPayoutCents).toBe(8300);
      expect(b.netBeforeInsuranceCents).toBe(8500);
    });

    it('matches the live EscrowService release math exactly (no behavior change)', () => {
      // Mirrors EscrowService.release: fee=round(gross×15%), ins=round(gross×2%), net=complement
      const gross = 12345;
      const b = computeFeeBreakdown(gross, 15);
      expect(b.platformFeeCents).toBe(Math.round(gross * 0.15)); // 1852
      expect(b.insuranceContributionCents).toBe(Math.round(gross * 0.02)); // 247
      expect(b.netPayoutCents).toBe(gross - 1852 - 247); // 10246
    });

    it('honors the immutable Price Book fee instead of the global fallback', () => {
      const b = computeFeeBreakdown(18000, 15, 4500);
      expect(b.platformFeeCents).toBe(4500);
      expect(b.netBeforeInsuranceCents).toBe(13500);
      expect(b.insuranceContributionCents).toBe(360);
      expect(b.netPayoutCents).toBe(13140);
      expect(feeBasisPoints(18000, 4500)).toBe(2500);
    });

    it('fails closed on invalid canonical fee evidence', () => {
      expect(() => computeFeeBreakdown(18000, 15, -1)).toThrow(RangeError);
      expect(() => computeFeeBreakdown(18000, 15, 18000)).toThrow(RangeError);
      expect(() => computeFeeBreakdown(18000, 15, 1.5)).toThrow(TypeError);
    });

    it('treats a canonical zero-cent margin as valid evidence, not as a missing fallback', () => {
      expect(resolvePlatformFeeCents(18000, 15, 0)).toBe(0);
      expect(computeFeeBreakdown(18000, 15, 0).platformFeeCents).toBe(0);
    });

    it('rejects negative and full-gross canonical margins with the exact boundary contract', () => {
      expect(() => resolvePlatformFeeCents(18000, 15, -1))
        .toThrow('canonicalPlatformFeeCents must be >= 0 cents');
      expect(() => resolvePlatformFeeCents(18000, 15, 18000))
        .toThrow('canonicalPlatformFeeCents must be non-negative and less than grossCents');
    });

    it('computes fee basis at the zero boundary and rejects every invalid boundary independently', () => {
      expect(feeBasisPoints(18000, 0)).toBe(0);
      expect(feeBasisPoints(18000, 4500)).toBe(2500);
      expect(() => feeBasisPoints(0, 0)).toThrow('Fee basis requires positive gross and a fee below gross');
      expect(() => feeBasisPoints(-1, 0)).toThrow(RangeError);
      expect(() => feeBasisPoints(18000, -1)).toThrow('platformFeeCents must be >= 0 cents');
      expect(() => feeBasisPoints(18000, 18000)).toThrow('Fee basis requires positive gross and a fee below gross');
    });
  });

  describe('xpForPriceCents', () => {
    it('price/10 with Math.round — single home for the formula', () => {
      expect(xpForPriceCents(5000)).toBe(500);
      expect(xpForPriceCents(1505)).toBe(151); // 150.5 → 151 (JS half-up == SQL half-away for positives)
      expect(xpForPriceCents(0)).toBe(0);
    });

    it('rejects non-integer price (INV-5)', () => {
      expect(() => xpForPriceCents(10.01)).toThrow(TypeError);
      expect(() => xpForPriceCents(-10)).toThrow(RangeError);
    });
  });
});
