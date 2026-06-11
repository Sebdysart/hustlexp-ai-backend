/**
 * money.ts — the single source of truth for platform money math.
 *
 * AUDIT FIX H3/M10/M11 (2026-06-11): the platform fee was computed
 * independently in 7+ places with INCONSISTENT rounding — Math.floor in
 * StripeService vs Math.round in EscrowService and both payment workers —
 * so the same gross amount produced fees differing by 1¢ depending on code
 * path, breaking revenue-ledger reconciliation. The XP formula (price/10)
 * was likewise duplicated across TaskService/XPTaxService/ScoperAIService.
 *
 * CONVENTION (decided with explicit sign-off, 2026-06-11): **Math.round**,
 * matching the live escrow-release path. All derived parts are computed as
 * complements of the gross so decompositions ALWAYS sum exactly:
 *   platformFee + insurance + netPayout === gross   (no dropped/created cents)
 *
 * INV-1/INV-5: every input and output is a positive (or zero) INTEGER in
 * cents. Non-integer inputs throw — money floats must never propagate.
 *
 * NOTE on SQL parity: Postgres ROUND(numeric) rounds half AWAY FROM ZERO;
 * JS Math.round rounds half UP (toward +∞). For the POSITIVE amounts these
 * helpers accept, the two are identical — the SQL XP aggregation in
 * XPTaxService (ROUND(gross_payout_cents / 10.0)) matches xpForPriceCents.
 */

import { config } from '../config.js';

/** 2% self-insurance contribution — matches SelfInsurancePoolService.calculateContribution. */
export const INSURANCE_RATE = 0.02;

function assertIntegerCents(value: number, label: string): void {
  if (!Number.isInteger(value) || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be an integer number of cents, got: ${value}`);
  }
  if (value < 0) {
    throw new RangeError(`${label} must be >= 0 cents, got: ${value}`);
  }
}

/**
 * Clamp a fee percent to [0, 100]. SECURITY (v2.9.3): a negative env var must
 * never produce a negative fee (which would overpay the worker).
 */
export function clampFeePercent(feePercent: number | undefined | null): number {
  return Math.min(100, Math.max(0, feePercent ?? 15));
}

/**
 * Platform fee in cents for a gross amount (PRODUCT_SPEC §9: 15% default).
 * Math.round per the unified convention.
 */
export function computePlatformFeeCents(
  grossCents: number,
  feePercent: number = config.stripe.platformFeePercent
): number {
  assertIntegerCents(grossCents, 'grossCents');
  const pct = clampFeePercent(feePercent);
  return Math.round(grossCents * (pct / 100));
}

export interface FeeBreakdown {
  /** Platform fee (Math.round of gross × percent). */
  platformFeeCents: number;
  /** Self-insurance contribution: Math.round of gross × 2% (F54-2: GROSS basis). */
  insuranceContributionCents: number;
  /** What the worker actually receives: gross − fee − insurance (exact complement). */
  netPayoutCents: number;
  /** Gross minus platform fee only (pre-insurance net, used for ledger decomposition). */
  netBeforeInsuranceCents: number;
}

/**
 * Full release decomposition for an escrow payout.
 * Guarantee: platformFeeCents + insuranceContributionCents + netPayoutCents === grossCents.
 *
 * Insurance basis is GROSS (task price), per F54-2 and
 * SelfInsurancePoolService.calculateContribution(taskPriceCents). The
 * dispute-release worker previously used a NET basis — unified here so both
 * release paths withhold identical amounts for identical escrows.
 */
export function computeFeeBreakdown(
  grossCents: number,
  feePercent: number = config.stripe.platformFeePercent
): FeeBreakdown {
  const platformFeeCents = computePlatformFeeCents(grossCents, feePercent);
  const insuranceContributionCents = Math.round(grossCents * INSURANCE_RATE);
  const netBeforeInsuranceCents = grossCents - platformFeeCents;
  const netPayoutCents = netBeforeInsuranceCents - insuranceContributionCents;
  return { platformFeeCents, insuranceContributionCents, netPayoutCents, netBeforeInsuranceCents };
}

/**
 * XP for a task price: price/10 (100 XP per $1), Math.round.
 * Single home for the formula previously duplicated in TaskService,
 * XPTaxService and ScoperAIService.
 */
export function xpForPriceCents(priceCents: number): number {
  assertIntegerCents(priceCents, 'priceCents');
  return Math.round(priceCents / 10);
}

/**
 * Self-insurance pool contribution for a worker's GROSS share (task price, or
 * the worker's portion of it on a split). 2% of gross, Math.round.
 *
 * REVIEW FIX (PR242 follow-up): single home so all three payout paths withhold
 * an IDENTICAL amount for the same worker share — previously the full-release
 * path used round(gross×2%) (F54-2), the worker-queue split used the NET basis
 * round((gross−fee)×2%), and EscrowService.partialRefund withheld NOTHING. The
 * service path and the worker queue now both call this on the worker's gross
 * share, matching the full-release convention.
 */
export function computeInsuranceContributionCents(grossShareCents: number): number {
  assertIntegerCents(grossShareCents, 'grossShareCents');
  return Math.round(grossShareCents * INSURANCE_RATE);
}
