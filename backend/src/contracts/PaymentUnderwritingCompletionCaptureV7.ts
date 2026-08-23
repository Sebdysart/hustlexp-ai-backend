export const PAYMENT_COMPLETION_CAPTURE_AUTHORITY_V7 = Object.freeze({
  googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
  driveRevision: '7',
  docsRevision:
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
  textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
  acceptedD5Commit: '9ba77a24ec23a5de8c9193655894d25b4e67a9c0',
  acceptedD5Tree: '80b67e44db9d159dfa96d4b6303448e98cb3cb4f',
  contractVersion: 7,
  operationallyEnabled: false,
} as const);

export type PaymentCompletionCaptureBlockerV7 =
  | 'lifecycle_not_completion_submitted'
  | 'task_not_proof_submitted'
  | 'completion_evidence_missing'
  | 'completion_work_order_mismatch'
  | 'poster_approval_missing'
  | 'customer_notice_missing'
  | 'amount_approval_missing'
  | 'amount_invalid'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'incident_clearance_missing'
  | 'financial_security_agreement_unresolved'
  | 'financial_security_expired'
  | 'capture_already_planned';

export interface PaymentCompletionCaptureInputV7 {
  readonly lifecycleStage: string;
  readonly taskState: string;
  readonly completionEvidencePresent: boolean;
  readonly completionWorkOrderId: string | null;
  readonly workOrderId: string;
  readonly posterApprovalState: string;
  readonly customerNoticeState: string;
  readonly amountApprovalState: string;
  readonly approvedAmountCents: number;
  readonly financialSecurityAmountCents: number;
  readonly approvedCurrency: string;
  readonly financialSecurityCurrency: string;
  readonly incidentClearanceState: string;
  readonly financialSecurityAgreementState: string;
  readonly financialSecurityExpiresAt: string;
  readonly captureAlreadyPlanned: boolean;
}

export function paymentCompletionCaptureBlockersV7(
  input: PaymentCompletionCaptureInputV7,
  now: string
): PaymentCompletionCaptureBlockerV7[] {
  const blockers: PaymentCompletionCaptureBlockerV7[] = [];
  if (input.lifecycleStage !== 'COMPLETION_SUBMITTED') {
    blockers.push('lifecycle_not_completion_submitted');
  }
  if (input.taskState !== 'PROOF_SUBMITTED') blockers.push('task_not_proof_submitted');
  if (!input.completionEvidencePresent) blockers.push('completion_evidence_missing');
  if (input.completionWorkOrderId !== input.workOrderId) {
    blockers.push('completion_work_order_mismatch');
  }
  if (input.posterApprovalState !== 'APPROVED') blockers.push('poster_approval_missing');
  if (!['ACKNOWLEDGED', 'DISCLOSED_TIMEOUT'].includes(input.customerNoticeState)) {
    blockers.push('customer_notice_missing');
  }
  if (input.amountApprovalState !== 'APPROVED') blockers.push('amount_approval_missing');
  if (!Number.isSafeInteger(input.approvedAmountCents) || input.approvedAmountCents <= 0) {
    blockers.push('amount_invalid');
  }
  if (input.approvedAmountCents !== input.financialSecurityAmountCents) {
    blockers.push('amount_mismatch');
  }
  if (input.approvedCurrency !== input.financialSecurityCurrency) {
    blockers.push('currency_mismatch');
  }
  if (input.incidentClearanceState !== 'CLEAR') blockers.push('incident_clearance_missing');
  if (input.financialSecurityAgreementState !== 'AGREED') {
    blockers.push('financial_security_agreement_unresolved');
  }
  const expiresAt = Date.parse(input.financialSecurityExpiresAt);
  const nowAt = Date.parse(now);
  if (!Number.isFinite(expiresAt) || !Number.isFinite(nowAt) || expiresAt <= nowAt) {
    blockers.push('financial_security_expired');
  }
  if (input.captureAlreadyPlanned) blockers.push('capture_already_planned');
  return blockers;
}
