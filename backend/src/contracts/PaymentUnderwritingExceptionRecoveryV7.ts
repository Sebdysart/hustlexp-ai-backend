export const PAYMENT_EXCEPTION_RECOVERY_AUTHORITY_V7 = Object.freeze({
  googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
  driveRevision: '7',
  docsRevision:
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
  textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
  acceptedD7Commit: '44db114aa548189413ec62cee380d2a9fb86c6ab',
  acceptedD7Tree: 'c7a2abb06038b332cdc08cba1fbc402841800170',
  contractVersion: 7,
  operationallyEnabled: false,
  refundAutomationEnabled: false,
  disputeAutomationEnabled: false,
  replacementAutomationEnabled: false,
  recurringPaymentsEnabled: false,
} as const);

export type PaymentExceptionRecoveryBlockerV7 =
  | 'refund_policy_unapproved'
  | 'dispute_policy_unapproved'
  | 'replacement_policy_unapproved'
  | 'recurring_policy_unapproved'
  | 'open_exception_cases'
  | 'unreconciled_exception_cases'
  | 'conflicting_refund_dispute'
  | 'loss_allocation_unresolved'
  | 'prior_provider_security_not_reversed'
  | 'replacement_customer_authorization_missing'
  | 'recurring_occurrence_not_independent'
  | 'long_term_prepayment_prohibited';

export interface PaymentExceptionRecoveryInputV7 {
  readonly refundPolicyApproved: boolean;
  readonly disputePolicyApproved: boolean;
  readonly replacementPolicyApproved: boolean;
  readonly recurringPolicyApproved: boolean;
  readonly openExceptionCaseCount: number;
  readonly unreconciledExceptionCaseCount: number;
  readonly conflictingRefundDisputeCount: number;
  readonly unresolvedLossAllocationCount: number;
  readonly replacementPriorSecurityReversed: boolean;
  readonly replacementCustomerAuthorizationPresent: boolean;
  readonly recurringOccurrenceIndependent: boolean;
  readonly longTermPrepaymentRequested: boolean;
}

const isNonnegativeSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

const isNonzeroOrInvalid = (value: number): boolean =>
  !isNonnegativeSafeInteger(value) || value !== 0;

export function paymentExceptionRecoveryBlockersV7(
  input: PaymentExceptionRecoveryInputV7
): PaymentExceptionRecoveryBlockerV7[] {
  const blockers: PaymentExceptionRecoveryBlockerV7[] = [];
  if (!input.refundPolicyApproved) blockers.push('refund_policy_unapproved');
  if (!input.disputePolicyApproved) blockers.push('dispute_policy_unapproved');
  if (!input.replacementPolicyApproved) blockers.push('replacement_policy_unapproved');
  if (!input.recurringPolicyApproved) blockers.push('recurring_policy_unapproved');
  if (isNonzeroOrInvalid(input.openExceptionCaseCount)) {
    blockers.push('open_exception_cases');
  }
  if (isNonzeroOrInvalid(input.unreconciledExceptionCaseCount)) {
    blockers.push('unreconciled_exception_cases');
  }
  if (isNonzeroOrInvalid(input.conflictingRefundDisputeCount)) {
    blockers.push('conflicting_refund_dispute');
  }
  if (isNonzeroOrInvalid(input.unresolvedLossAllocationCount)) {
    blockers.push('loss_allocation_unresolved');
  }
  if (!input.replacementPriorSecurityReversed) {
    blockers.push('prior_provider_security_not_reversed');
  }
  if (!input.replacementCustomerAuthorizationPresent) {
    blockers.push('replacement_customer_authorization_missing');
  }
  if (!input.recurringOccurrenceIndependent) {
    blockers.push('recurring_occurrence_not_independent');
  }
  if (input.longTermPrepaymentRequested) {
    blockers.push('long_term_prepayment_prohibited');
  }
  return blockers;
}
