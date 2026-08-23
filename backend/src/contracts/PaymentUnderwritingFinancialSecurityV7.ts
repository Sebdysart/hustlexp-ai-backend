export const PAYMENT_FINANCIAL_SECURITY_IDEMPOTENCY_PREFIX_V7 = 'hx-fse-v7:' as const;

export const PAYMENT_FINANCIAL_SECURITY_OBSERVATION_SOURCES_V7 = Object.freeze([
  'API_RESPONSE',
  'WEBHOOK',
] as const);

export const PAYMENT_FINANCIAL_SECURITY_PROVIDER_STATES_V7 = Object.freeze([
  'PENDING',
  'ACTION_REQUIRED',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
  'UNKNOWN',
] as const);

export type PaymentFinancialSecurityObservationSourceV7 =
  (typeof PAYMENT_FINANCIAL_SECURITY_OBSERVATION_SOURCES_V7)[number];

export type PaymentFinancialSecurityProviderStateV7 =
  (typeof PAYMENT_FINANCIAL_SECURITY_PROVIDER_STATES_V7)[number];

export const PAYMENT_FINANCIAL_SECURITY_AUTHORITY_V7 = Object.freeze({
  googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
  driveRevision: '7',
  docsRevision:
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
  textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
  acceptedD3Commit: 'f4c2acef976ce8e1bdf2d97c208fe5a2d47e7245',
  acceptedD3Tree: '182c2f81a1f1d02c575e559af4ab308cf1ac42f1',
  contractVersion: 7,
  operationallyEnabled: false,
} as const);

export interface PaymentFinancialSecurityObservationV7 {
  readonly source: PaymentFinancialSecurityObservationSourceV7;
  readonly financialSecurityEventId: string;
  readonly operationId: string;
  readonly processorCode: string;
  readonly providerOperationReferenceSha256: string;
  readonly providerState: PaymentFinancialSecurityProviderStateV7;
  readonly amountCents: number;
  readonly currency: string;
  readonly merchantContextSha256: string;
  readonly expiresAt: string;
  readonly observedAt: string;
  readonly authenticated: boolean;
}

export type PaymentFinancialSecurityAgreementBlockerV7 =
  | 'api_source_invalid'
  | 'webhook_source_invalid'
  | 'webhook_not_authenticated'
  | 'financial_security_event_mismatch'
  | 'operation_mismatch'
  | 'processor_mismatch'
  | 'provider_operation_mismatch'
  | 'provider_state_not_succeeded'
  | 'amount_mismatch'
  | 'currency_mismatch'
  | 'merchant_context_mismatch'
  | 'expiry_mismatch'
  | 'observation_time_invalid'
  | 'financial_security_expired';

export function paymentFinancialSecurityIdempotencyKeyV7(operationId: string): string {
  return `${PAYMENT_FINANCIAL_SECURITY_IDEMPOTENCY_PREFIX_V7}${operationId}`;
}

export function paymentFinancialSecurityAgreementBlockersV7(
  api: PaymentFinancialSecurityObservationV7,
  webhook: PaymentFinancialSecurityObservationV7,
  now: string
): PaymentFinancialSecurityAgreementBlockerV7[] {
  const blockers: PaymentFinancialSecurityAgreementBlockerV7[] = [];
  if (api.source !== 'API_RESPONSE') blockers.push('api_source_invalid');
  if (webhook.source !== 'WEBHOOK') blockers.push('webhook_source_invalid');
  if (!webhook.authenticated) blockers.push('webhook_not_authenticated');
  if (api.financialSecurityEventId !== webhook.financialSecurityEventId) {
    blockers.push('financial_security_event_mismatch');
  }
  if (api.operationId !== webhook.operationId) blockers.push('operation_mismatch');
  if (api.processorCode !== webhook.processorCode) blockers.push('processor_mismatch');
  if (api.providerOperationReferenceSha256 !== webhook.providerOperationReferenceSha256) {
    blockers.push('provider_operation_mismatch');
  }
  if (api.providerState !== 'SUCCEEDED' || webhook.providerState !== 'SUCCEEDED') {
    blockers.push('provider_state_not_succeeded');
  }
  if (api.amountCents !== webhook.amountCents) blockers.push('amount_mismatch');
  if (api.currency !== webhook.currency) blockers.push('currency_mismatch');
  if (api.merchantContextSha256 !== webhook.merchantContextSha256) {
    blockers.push('merchant_context_mismatch');
  }
  if (api.expiresAt !== webhook.expiresAt) blockers.push('expiry_mismatch');

  const nowAt = Date.parse(now);
  const apiObservedAt = Date.parse(api.observedAt);
  const webhookObservedAt = Date.parse(webhook.observedAt);
  const expiresAt = Date.parse(api.expiresAt);
  if (![nowAt, apiObservedAt, webhookObservedAt, expiresAt].every(Number.isFinite)) {
    blockers.push('observation_time_invalid');
  } else if (expiresAt <= nowAt) {
    blockers.push('financial_security_expired');
  }
  return blockers;
}
