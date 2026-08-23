export const PAYMENT_SETTLEMENT_CLOSE_AUTHORITY_V7 = Object.freeze({
  googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
  driveRevision: '7',
  docsRevision:
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
  textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
  acceptedD6Commit: '7e1fc60f9afa270b4a19f0aee9b1f36bd1e25674',
  acceptedD6Tree: '30d1df8705cbdbca5105fe594ce1b4ea53b3de40',
  contractVersion: 7,
  operationallyEnabled: false,
} as const);

export type PaymentSettlementCloseBlockerV7 =
  | 'lifecycle_not_captured'
  | 'capture_not_agreed'
  | 'economics_policy_missing'
  | 'economics_unbalanced'
  | 'settlement_not_terminal'
  | 'ledger_not_posted'
  | 'ledger_unbalanced'
  | 'reconciliation_not_completed'
  | 'reconciliation_exceptions_present'
  | 'processor_ledger_mismatch'
  | 'open_post_funding_exposure';

export interface PaymentSettlementCloseInputV7 {
  readonly lifecycleStage: string;
  readonly captureAgreementState: string;
  readonly economicsPolicyPresent: boolean;
  readonly customerAmountCents: number;
  readonly providerAmountCents: number;
  readonly platformAmountCents: number;
  readonly settlementState: string;
  readonly ledgerState: string;
  readonly ledgerDebitCents: number;
  readonly ledgerCreditCents: number;
  readonly reconciliationRunState: string;
  readonly reconciliationExceptionCount: number;
  readonly processorCustomerAmountCents: number;
  readonly ledgerCustomerAmountCents: number;
  readonly openPostFundingExposureCount: number;
}

const isNonnegativeSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

export function paymentSettlementCloseBlockersV7(
  input: PaymentSettlementCloseInputV7
): PaymentSettlementCloseBlockerV7[] {
  const blockers: PaymentSettlementCloseBlockerV7[] = [];
  if (input.lifecycleStage !== 'CAPTURED') blockers.push('lifecycle_not_captured');
  if (input.captureAgreementState !== 'AGREED') blockers.push('capture_not_agreed');
  if (!input.economicsPolicyPresent) blockers.push('economics_policy_missing');
  if (
    !isNonnegativeSafeInteger(input.customerAmountCents) ||
    input.customerAmountCents === 0 ||
    !isNonnegativeSafeInteger(input.providerAmountCents) ||
    !isNonnegativeSafeInteger(input.platformAmountCents) ||
    input.providerAmountCents + input.platformAmountCents !== input.customerAmountCents
  ) {
    blockers.push('economics_unbalanced');
  }
  if (!['FUNDED', 'PAID_OUT'].includes(input.settlementState)) {
    blockers.push('settlement_not_terminal');
  }
  if (input.ledgerState !== 'POSTED') blockers.push('ledger_not_posted');
  if (
    !isNonnegativeSafeInteger(input.ledgerDebitCents) ||
    input.ledgerDebitCents === 0 ||
    input.ledgerDebitCents !== input.ledgerCreditCents
  ) {
    blockers.push('ledger_unbalanced');
  }
  if (input.reconciliationRunState !== 'COMPLETED') {
    blockers.push('reconciliation_not_completed');
  }
  if (
    !isNonnegativeSafeInteger(input.reconciliationExceptionCount) ||
    input.reconciliationExceptionCount !== 0
  ) {
    blockers.push('reconciliation_exceptions_present');
  }
  if (
    !isNonnegativeSafeInteger(input.processorCustomerAmountCents) ||
    input.processorCustomerAmountCents !== input.ledgerCustomerAmountCents ||
    input.processorCustomerAmountCents !== input.customerAmountCents
  ) {
    blockers.push('processor_ledger_mismatch');
  }
  if (
    !isNonnegativeSafeInteger(input.openPostFundingExposureCount) ||
    input.openPostFundingExposureCount !== 0
  ) {
    blockers.push('open_post_funding_exposure');
  }
  return blockers;
}
