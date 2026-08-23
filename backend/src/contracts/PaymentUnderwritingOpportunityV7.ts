export const PAYMENT_OPPORTUNITY_SAFE_PREVIEW_FIELDS_V7 = Object.freeze([
  'categoryCode',
  'generalAreaCode',
  'scheduleWindowStart',
  'scheduleWindowEnd',
  'scopeSummarySha256',
  'requirementsSha256',
  'pricingLane',
  'grossEarningsMinCents',
  'grossEarningsMaxCents',
  'currency',
] as const);

export const PAYMENT_PROVIDER_ELIGIBILITY_REQUIRED_FLAGS_V7 = Object.freeze([
  'paymentEligible',
  'merchantContextApproved',
  'categoryEligible',
  'credentialsEligible',
  'trustEligible',
  'availabilityEligible',
] as const);

export const PAYMENT_CONDITIONAL_HOLD_MAX_TTL_SECONDS_V7 = 15 * 60;

export const PAYMENT_OPPORTUNITY_AUTHORITY_V7 = Object.freeze({
  googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
  driveRevision: '7',
  docsRevision:
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
  textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
  acceptedD2Commit: '2abbddf7ababcbfe1c8f3ba96147f562421be2e5',
  contractVersion: 7,
  operationallyEnabled: false,
} as const);

export type PaymentOpportunityPreviewBlockerV7 =
  | `unsafe_field:${string}`
  | 'invalid_category_code'
  | 'invalid_general_area_code'
  | 'invalid_schedule_window'
  | 'invalid_scope_summary_sha256'
  | 'invalid_requirements_sha256'
  | 'invalid_pricing_lane'
  | 'invalid_earnings_range'
  | 'invalid_currency';

export type PaymentProviderEligibilityBlockerV7 =
  | 'provider_account_not_eligible'
  | 'funding_not_ready'
  | 'provider_evidence_expired'
  | 'provider_evidence_stale'
  | 'provider_evidence_future'
  | 'bank_reference_missing'
  | 'blocking_restrictions'
  | 'payment_eligibility_missing'
  | 'merchant_context_unapproved'
  | 'category_ineligible'
  | 'credentials_ineligible'
  | 'trust_ineligible'
  | 'availability_ineligible';

export interface PaymentProviderEligibilityInputV7 {
  readonly eligibilityState: string;
  readonly fundingState: string;
  readonly observedAt: string;
  readonly expiresAt: string;
  readonly bankReferencePresent: boolean;
  readonly hasBlockingRestrictions: boolean;
  readonly paymentEligible: boolean;
  readonly merchantContextApproved: boolean;
  readonly categoryEligible: boolean;
  readonly credentialsEligible: boolean;
  readonly trustEligible: boolean;
  readonly availabilityEligible: boolean;
}

const SHA256 = /^[0-9a-f]{64}$/;
const CATEGORY_CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const GENERAL_AREA_CODE = /^[A-Z0-9][A-Z0-9_-]{1,63}$/;
const CURRENCY = /^[a-z]{3}$/;
const PROVIDER_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;
const PROVIDER_EVIDENCE_MAX_FUTURE_SKEW_MS = 5 * 1000;

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export function paymentOpportunityPreviewBlockersV7(
  input: Readonly<Record<string, unknown>>
): PaymentOpportunityPreviewBlockerV7[] {
  const allowed = new Set<string>(PAYMENT_OPPORTUNITY_SAFE_PREVIEW_FIELDS_V7);
  const unsafe = Object.keys(input)
    .filter((field) => !allowed.has(field))
    .sort()
    .map((field) => `unsafe_field:${field}` as const);
  if (unsafe.length > 0) return unsafe;

  const blockers: PaymentOpportunityPreviewBlockerV7[] = [];
  if (typeof input.categoryCode !== 'string' || !CATEGORY_CODE.test(input.categoryCode)) {
    blockers.push('invalid_category_code');
  }
  if (typeof input.generalAreaCode !== 'string' || !GENERAL_AREA_CODE.test(input.generalAreaCode)) {
    blockers.push('invalid_general_area_code');
  }
  const scheduleStart = timestamp(input.scheduleWindowStart);
  const scheduleEnd = timestamp(input.scheduleWindowEnd);
  if (scheduleStart === null || scheduleEnd === null || scheduleEnd <= scheduleStart) {
    blockers.push('invalid_schedule_window');
  }
  if (typeof input.scopeSummarySha256 !== 'string' || !SHA256.test(input.scopeSummarySha256)) {
    blockers.push('invalid_scope_summary_sha256');
  }
  if (typeof input.requirementsSha256 !== 'string' || !SHA256.test(input.requirementsSha256)) {
    blockers.push('invalid_requirements_sha256');
  }
  if (!['PLATFORM_PRICED', 'PROVIDER_ESTIMATE'].includes(String(input.pricingLane))) {
    blockers.push('invalid_pricing_lane');
  }
  if (
    !positiveInteger(input.grossEarningsMinCents) ||
    !positiveInteger(input.grossEarningsMaxCents) ||
    input.grossEarningsMaxCents < input.grossEarningsMinCents
  ) {
    blockers.push('invalid_earnings_range');
  }
  if (typeof input.currency !== 'string' || !CURRENCY.test(input.currency)) {
    blockers.push('invalid_currency');
  }
  return blockers;
}

export function paymentProviderEligibilityBlockersV7(
  input: PaymentProviderEligibilityInputV7,
  now: string
): PaymentProviderEligibilityBlockerV7[] {
  const blockers: PaymentProviderEligibilityBlockerV7[] = [];
  if (input.eligibilityState !== 'ELIGIBLE') blockers.push('provider_account_not_eligible');
  if (input.fundingState !== 'READY') blockers.push('funding_not_ready');
  const observedAt = timestamp(input.observedAt);
  const expiresAt = timestamp(input.expiresAt);
  const nowAt = timestamp(now);
  if (
    observedAt === null ||
    expiresAt === null ||
    nowAt === null ||
    expiresAt <= observedAt ||
    expiresAt <= nowAt
  ) {
    blockers.push('provider_evidence_expired');
  }
  if (observedAt !== null && nowAt !== null && observedAt < nowAt - PROVIDER_EVIDENCE_MAX_AGE_MS) {
    blockers.push('provider_evidence_stale');
  }
  if (
    observedAt !== null &&
    nowAt !== null &&
    observedAt > nowAt + PROVIDER_EVIDENCE_MAX_FUTURE_SKEW_MS
  ) {
    blockers.push('provider_evidence_future');
  }
  if (!input.bankReferencePresent) blockers.push('bank_reference_missing');
  if (input.hasBlockingRestrictions) blockers.push('blocking_restrictions');
  if (!input.paymentEligible) blockers.push('payment_eligibility_missing');
  if (!input.merchantContextApproved) blockers.push('merchant_context_unapproved');
  if (!input.categoryEligible) blockers.push('category_ineligible');
  if (!input.credentialsEligible) blockers.push('credentials_ineligible');
  if (!input.trustEligible) blockers.push('trust_ineligible');
  if (!input.availabilityEligible) blockers.push('availability_ineligible');
  return blockers;
}
