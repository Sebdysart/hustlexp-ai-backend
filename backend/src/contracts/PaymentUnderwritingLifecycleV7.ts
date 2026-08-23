export const PAYMENT_UNDERWRITING_LIFECYCLE_STAGES_V7 = Object.freeze([
  'TASK_DRAFT',
  'SCOPE_READY',
  'QUOTED',
  'ESTIMATE_REQUIRED',
  'QUOTE_APPROVED',
  'PAYMENT_METHOD_READY',
  'PROVIDER_SOURCING',
  'PAYMENT_ELIGIBLE',
  'PROVIDER_SOFT_RESERVED',
  'FINANCIAL_SECURITY_PENDING',
  'FINANCIALLY_SECURED',
  'WORK_ORDER_MATERIALIZED',
  'ASSIGNED',
  'IN_PROGRESS',
  'COMPLETION_SUBMITTED',
  'CAPTURE_PENDING',
  'CAPTURED',
  'SETTLING',
  'PAYOUT_PENDING',
  'FUNDED',
  'PAID_OUT',
  'RECONCILED',
  'CLOSED',
] as const);

export type PaymentUnderwritingLifecycleStageV7 =
  (typeof PAYMENT_UNDERWRITING_LIFECYCLE_STAGES_V7)[number];

export const PAYMENT_UNDERWRITING_STAGE_TRANSITIONS_V7 = Object.freeze({
  TASK_DRAFT: Object.freeze(['SCOPE_READY']),
  SCOPE_READY: Object.freeze(['QUOTED', 'ESTIMATE_REQUIRED']),
  QUOTED: Object.freeze(['QUOTE_APPROVED']),
  ESTIMATE_REQUIRED: Object.freeze(['QUOTE_APPROVED']),
  QUOTE_APPROVED: Object.freeze(['PAYMENT_METHOD_READY']),
  PAYMENT_METHOD_READY: Object.freeze(['PROVIDER_SOURCING']),
  PROVIDER_SOURCING: Object.freeze(['PAYMENT_ELIGIBLE']),
  PAYMENT_ELIGIBLE: Object.freeze(['PROVIDER_SOFT_RESERVED']),
  PROVIDER_SOFT_RESERVED: Object.freeze(['FINANCIAL_SECURITY_PENDING']),
  FINANCIAL_SECURITY_PENDING: Object.freeze(['FINANCIALLY_SECURED']),
  FINANCIALLY_SECURED: Object.freeze(['WORK_ORDER_MATERIALIZED']),
  WORK_ORDER_MATERIALIZED: Object.freeze(['ASSIGNED']),
  ASSIGNED: Object.freeze(['IN_PROGRESS']),
  IN_PROGRESS: Object.freeze(['COMPLETION_SUBMITTED']),
  COMPLETION_SUBMITTED: Object.freeze(['CAPTURE_PENDING']),
  CAPTURE_PENDING: Object.freeze(['CAPTURED']),
  CAPTURED: Object.freeze(['SETTLING', 'PAYOUT_PENDING']),
  SETTLING: Object.freeze(['FUNDED']),
  PAYOUT_PENDING: Object.freeze(['PAID_OUT']),
  FUNDED: Object.freeze(['RECONCILED']),
  PAID_OUT: Object.freeze(['RECONCILED']),
  RECONCILED: Object.freeze(['CLOSED']),
  CLOSED: Object.freeze([]),
} satisfies Readonly<
  Record<PaymentUnderwritingLifecycleStageV7, readonly PaymentUnderwritingLifecycleStageV7[]>
>);

export const PAYMENT_UNDERWRITING_CANONICAL_OBJECTS_V7 = Object.freeze([
  'TaskDraftLifecycle',
  'TaskOpportunity',
  'ProviderAccountRef',
  'ConditionalProviderHold',
  'PaymentMethodRef',
  'FinancialSecurityEvent',
  'CanonicalWorkOrder',
  'PaymentCapture',
  'LedgerTransaction',
  'LedgerEntry',
  'SettlementRecord',
  'WebhookInbox',
  'ReconciliationRun',
  'LegacyPaymentClassification',
] as const);

export type PaymentUnderwritingCanonicalObjectV7 =
  (typeof PAYMENT_UNDERWRITING_CANONICAL_OBJECTS_V7)[number];

export type PaymentUnderwritingPricingLaneV7 = 'PLATFORM_PRICED' | 'PROVIDER_ESTIMATE';

export type PaymentUnderwritingLifecycleActorV7 =
  | Readonly<{
      actorType: 'POSTER' | 'PROVIDER' | 'ADMIN';
      actorUserId: string;
    }>
  | Readonly<{
      actorType: 'SYSTEM' | 'WEBHOOK' | 'RECONCILER';
      actorUserId: null;
    }>;

export interface PaymentUnderwritingLifecycleV7 {
  readonly lifecycleId: string;
  readonly taskDraftId: string;
  readonly requestId: string;
  readonly pricingLane: PaymentUnderwritingPricingLaneV7;
  readonly contractVersion: 7;
}

export interface PaymentUnderwritingLifecycleEventV7 {
  readonly eventId: string;
  readonly lifecycleId: string;
  readonly sequenceNumber: number;
  readonly priorEventId: string | null;
  readonly commandId: string;
  readonly stage: PaymentUnderwritingLifecycleStageV7;
  readonly actor: PaymentUnderwritingLifecycleActorV7;
  readonly evidenceSha256: string;
  readonly eventSha256: string;
}

export interface PlannedPaymentOperationV7 {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly state: 'PLANNED';
}

export const PAYMENT_UNDERWRITING_SCHEMA_AUTHORITY_V7 = Object.freeze({
  googleDocId: '1PYpWdbnlhRBoovc6GfTyxMuu1IzMIdDQpV6hHHraXaQ',
  driveRevision: '7',
  docsRevision:
    'AIroW37g_sqKNU_dvvRNUndw-qUeooFwAYIHqN60aHvPSR178sKjMMu5rMzGTzODqgDKERue3ZbAT8UesInsUZvT6p1Z0bUvPByrgwaPDA',
  textPlainSha256: 'ba8dc04bfc43feb24bd78698c6e5b820ecdf22177f915fb04856a55d8076bd26',
  contractVersion: 7,
  operationallyEnabled: false,
} as const);

export function isPaymentUnderwritingTransitionV7(
  pricingLane: PaymentUnderwritingPricingLaneV7,
  from: PaymentUnderwritingLifecycleStageV7,
  to: PaymentUnderwritingLifecycleStageV7
): boolean {
  if (from === 'SCOPE_READY') {
    return to === (pricingLane === 'PLATFORM_PRICED' ? 'QUOTED' : 'ESTIMATE_REQUIRED');
  }
  return PAYMENT_UNDERWRITING_STAGE_TRANSITIONS_V7[from].includes(to as never);
}
