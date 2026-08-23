export const PAYMENT_PRIVATE_FULFILLMENT_SCOPE_V7 = 'EXACT_FULFILLMENT_LOCATION' as const;

export const PAYMENT_WORK_ORDER_AUTHORITY_V7 = Object.freeze({
  googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
  driveRevision: '7',
  docsRevision:
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
  textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
  acceptedD4Commit: 'b5bf643def5365312a8e08d845f42afc6e79252d',
  acceptedD4Tree: 'b4ff045172abe0160d080cdf3eac7618335489a2',
  contractVersion: 7,
  operationallyEnabled: false,
} as const);

export type PaymentWorkOrderMaterializationBlockerV7 =
  | 'lifecycle_not_financially_secured'
  | 'financial_security_agreement_unresolved'
  | 'financial_security_provider_not_succeeded'
  | 'financial_security_expired'
  | 'hold_not_soft_reserved'
  | 'hold_expired'
  | 'task_not_bound_to_draft'
  | 'customer_mismatch'
  | 'provider_mismatch'
  | 'assignment_missing'
  | 'sealed_location_missing';

export interface PaymentWorkOrderMaterializationInputV7 {
  readonly lifecycleStage: string;
  readonly agreementState: string;
  readonly providerState: string;
  readonly financialSecurityExpiresAt: string;
  readonly holdState: string;
  readonly holdExpiresAt: string;
  readonly taskDraftTaskId: string | null;
  readonly taskId: string;
  readonly customerUserId: string;
  readonly taskPosterUserId: string;
  readonly providerUserId: string;
  readonly assignedProviderUserId: string | null;
  readonly assignmentPresent: boolean;
  readonly sealedLocationPresent: boolean;
}

function validFutureTimestamp(value: string, now: string): boolean {
  const parsed = Date.parse(value);
  const nowAt = Date.parse(now);
  return Number.isFinite(parsed) && Number.isFinite(nowAt) && parsed > nowAt;
}

export function paymentWorkOrderMaterializationBlockersV7(
  input: PaymentWorkOrderMaterializationInputV7,
  now: string
): PaymentWorkOrderMaterializationBlockerV7[] {
  const blockers: PaymentWorkOrderMaterializationBlockerV7[] = [];
  if (input.lifecycleStage !== 'FINANCIALLY_SECURED') {
    blockers.push('lifecycle_not_financially_secured');
  }
  if (input.agreementState !== 'AGREED') {
    blockers.push('financial_security_agreement_unresolved');
  }
  if (input.providerState !== 'SUCCEEDED') {
    blockers.push('financial_security_provider_not_succeeded');
  }
  if (!validFutureTimestamp(input.financialSecurityExpiresAt, now)) {
    blockers.push('financial_security_expired');
  }
  if (input.holdState !== 'SOFT_RESERVED') blockers.push('hold_not_soft_reserved');
  if (!validFutureTimestamp(input.holdExpiresAt, now)) blockers.push('hold_expired');
  if (input.taskDraftTaskId !== input.taskId) blockers.push('task_not_bound_to_draft');
  if (input.customerUserId !== input.taskPosterUserId) blockers.push('customer_mismatch');
  if (input.providerUserId !== input.assignedProviderUserId) blockers.push('provider_mismatch');
  if (!input.assignmentPresent) blockers.push('assignment_missing');
  if (!input.sealedLocationPresent) blockers.push('sealed_location_missing');
  return blockers;
}
