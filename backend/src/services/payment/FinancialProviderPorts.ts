/**
 * Provider-neutral financial ports for the HustleXP lifecycle.
 *
 * These contracts deliberately use HustleXP operation identifiers and states.
 * Processor-specific identifiers may only appear as opaque external references.
 */
/**
 * Canonical provider vocabulary shared with the database lifecycle contract.
 *
 * `APPROVED_PROVIDER` is deliberately an authority state rather than a vendor
 * name. No approved-provider adapter is currently registered; the type exists
 * so adding one does not require rewriting the domain application layer.
 */
export type FinancialProviderKind = 'FAKE' | 'APPROVED_PROVIDER';

export type FinancialOperationKind =
  | 'PREPARE_PAYMENT_METHOD'
  | 'AUTHORIZE'
  | 'SECURE'
  | 'VOID'
  | 'ADJUST'
  | 'CAPTURE'
  | 'REFUND'
  | 'REVERSAL'
  | 'ONBOARD_PROVIDER'
  | 'REFRESH_PROVIDER_ACCOUNT_STATE'
  | 'SETTLE'
  | 'FUND'
  | 'PROVIDER_RELEASE'
  | 'PAYOUT'
  | 'OBSERVE_BANK_SETTLEMENT'
  | 'INGEST_WEBHOOK'
  | 'RECONCILE';

export type FinancialOperationState =
  | 'PENDING'
  | 'SUCCEEDED'
  | 'DECLINED'
  | 'FAILED'
  | 'RETRYABLE_FAILURE'
  | 'VOIDED'
  | 'REFUNDED'
  | 'PARTIALLY_REFUNDED'
  | 'REVERSED'
  | 'ACCEPTED'
  | 'REJECTED'
  | 'MATCHED'
  | 'MISMATCH';

export interface FinancialOperationCommand {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly expectedVersion: number;
  readonly amountCents?: number;
  readonly currency?: string;
  readonly relatedOperationId?: string;
}

export interface FinancialOperationResult {
  readonly operationId: string;
  readonly operationKind: FinancialOperationKind;
  readonly providerKind: FinancialProviderKind;
  readonly state: FinancialOperationState;
  readonly version: number;
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly externalReference: string;
  readonly idempotencyReplayed: boolean;
  readonly retryable: boolean;
}

export interface PreparePaymentMethodCommand extends FinancialOperationCommand {
  readonly customerId: string;
}

export interface AuthorizeFinancialSecurityCommand extends FinancialOperationCommand {
  readonly paymentMethodReference: string;
}

export interface SecureFinancialSecurityCommand extends FinancialOperationCommand {
  readonly authorizationOperationId: string;
}

export interface AdjustmentAuthorizationCommand extends FinancialOperationCommand {
  readonly scopeVersionId: string;
  readonly changeOrderId: string;
}

export interface RefundCommand extends FinancialOperationCommand {
  readonly originalAmountCents: number;
}

export interface ProviderOnboardingCommand extends FinancialOperationCommand {
  readonly providerId: string;
}

export type ProviderAccountState = 'PENDING' | 'ENABLED' | 'RESTRICTED' | 'FAILED';

export interface ProviderAccountStateCommand extends FinancialOperationCommand {
  readonly providerId: string;
  readonly providerAccountReference: string;
}

export interface ProviderAccountStateResult extends FinancialOperationResult {
  readonly providerId: string;
  readonly accountState: ProviderAccountState;
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
  readonly requirementsDue: readonly string[];
}

export interface PayoutCommand extends FinancialOperationCommand {
  readonly providerAccountReference: string;
}

export interface WebhookIngestionCommand extends FinancialOperationCommand {
  readonly providerEventReference: string;
  readonly authenticated: boolean;
}

/**
 * Provider-neutral reconciliation request. The digest binds the exact
 * canonical HustleXP ledger snapshot presented to the provider adapter; it is
 * not a processor object identifier or processor-specific state.
 */
export interface ReconciliationCommand extends FinancialOperationCommand {
  readonly reconciliationSnapshotSha256: string;
}

export interface CustomerPaymentMethodPort {
  preparePaymentMethod(input: PreparePaymentMethodCommand): Promise<FinancialOperationResult>;
}

export interface FinancialSecurityEventPort {
  authorize(input: AuthorizeFinancialSecurityCommand): Promise<FinancialOperationResult>;
  secure(input: SecureFinancialSecurityCommand): Promise<FinancialOperationResult>;
  void(input: FinancialOperationCommand): Promise<FinancialOperationResult>;
}

export interface AdjustmentAuthorizationPort {
  adjust(input: AdjustmentAuthorizationCommand): Promise<FinancialOperationResult>;
}

export interface CapturePort {
  capture(input: FinancialOperationCommand): Promise<FinancialOperationResult>;
}

export interface RefundReversalPort {
  refund(input: RefundCommand): Promise<FinancialOperationResult>;
  reverse(input: FinancialOperationCommand): Promise<FinancialOperationResult>;
}

export interface ProviderAccountPort {
  onboardProvider(input: ProviderOnboardingCommand): Promise<FinancialOperationResult>;
  refreshProviderAccountState(
    input: ProviderAccountStateCommand
  ): Promise<ProviderAccountStateResult>;
}

export interface SettlementFundingReleasePayoutPort {
  settle(input: FinancialOperationCommand): Promise<FinancialOperationResult>;
  fund(input: FinancialOperationCommand): Promise<FinancialOperationResult>;
  releaseProvider(input: FinancialOperationCommand): Promise<FinancialOperationResult>;
  payout(input: PayoutCommand): Promise<FinancialOperationResult>;
  observeBankSettlement(input: FinancialOperationCommand): Promise<FinancialOperationResult>;
}

export interface WebhookIngestionPort {
  ingestWebhook(input: WebhookIngestionCommand): Promise<FinancialOperationResult>;
}

export interface LedgerReconciliationPort {
  reconcile(input: ReconciliationCommand): Promise<FinancialOperationResult>;
}

export interface FinancialProviderPorts
  extends
    CustomerPaymentMethodPort,
    FinancialSecurityEventPort,
    AdjustmentAuthorizationPort,
    CapturePort,
    RefundReversalPort,
    ProviderAccountPort,
    SettlementFundingReleasePayoutPort,
    WebhookIngestionPort,
    LedgerReconciliationPort {}
