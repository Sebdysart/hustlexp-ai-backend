export const PAYMENT_UNDERWRITING_DECISION_IDS_V7 = [
  'SOLE_PROPRIETOR_PROVIDER_ELIGIBILITY',
  'PROVIDER_BANK_ACCOUNT_ELIGIBILITY',
  'MARKETPLACE_PROVIDER_OS_RELATIONSHIP',
  'MERCHANT_OF_RECORD_AND_SUPPORT_TOPOLOGY',
  'CONDITIONAL_PROVIDER_ACCEPTANCE_BEFORE_FSE',
  'CAPTURE_AND_DISBURSEMENT_MODEL',
  'TOKENIZATION_CONSENT_AND_PORTABILITY',
  'PLATFORM_ECONOMICS',
  'AMOUNT_CHANGE_AUTHORITY',
  'PROVIDER_REPLACEMENT_AUTHORITY',
  'LOSS_ALLOCATION_WATERFALL',
  'PROVIDER_PLATFORM_RISK_ISOLATION',
  'CATEGORY_AND_MCC_APPROVAL',
  'LIMITS_RESERVES_SETTLEMENT_AND_CAPACITY',
  'RESTRICTION_AND_TERMINATION_CONTINUITY',
  'RECURRING_OCCURRENCE_MODEL',
  'REGULATORY_ROLE_AND_LICENSING',
  'COMMERCIAL_TERMS',
  'TASK_OPPORTUNITY_ONBOARDING',
  'WRITTEN_ARCHITECTURE_SIGNOFF',
] as const;

export type PaymentUnderwritingDecisionIdV7 = (typeof PAYMENT_UNDERWRITING_DECISION_IDS_V7)[number];
export type PaymentUnderwritingDecisionStatusV7 = 'UNRESOLVED';

const decisions = Object.freeze(
  Object.fromEntries(
    PAYMENT_UNDERWRITING_DECISION_IDS_V7.map((decision) => [decision, 'UNRESOLVED'])
  ) as Readonly<Record<PaymentUnderwritingDecisionIdV7, PaymentUnderwritingDecisionStatusV7>>
);

export const PAYMENT_UNDERWRITING_AUTHORITY_V7 = Object.freeze({
  googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
  driveRevision: '7',
  docsRevision:
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
  textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
  textPlainUtf8Bytes: 71_231,
  currentMainBase: 'ab4a76cbc8ea32c663c36982eafe94b20d2dc879',
  productionDecision: 'NO_GO',
  processorSpecificMoneyCreation: 'DISABLED_PENDING_WRITTEN_APPROVAL',
  decisions,
  excludedPullRequests: Object.freeze({
    263: Object.freeze({
      head: 'ce0e622c8ff2069239768d4172a12be531a90061',
      disposition: 'SUPERSEDED',
    }),
    265: Object.freeze({
      head: '9cc7f6a7596dacd5f91112ddee61189bf60a1fc8',
      disposition: 'REJECTED_CONFLICTING',
    }),
  }),
} as const);

export const PAYMENT_UNDERWRITING_BLOCK_AUTHORITY_V7 = 'UNDERWRITING_DECISIONS_UNRESOLVED' as const;

export function unresolvedPaymentUnderwritingDecisionsV7(): readonly PaymentUnderwritingDecisionIdV7[] {
  return PAYMENT_UNDERWRITING_DECISION_IDS_V7.filter(
    (decision) => PAYMENT_UNDERWRITING_AUTHORITY_V7.decisions[decision] === 'UNRESOLVED'
  );
}
