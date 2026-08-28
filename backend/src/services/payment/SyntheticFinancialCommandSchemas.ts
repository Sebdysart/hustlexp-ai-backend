import { z } from 'zod';

const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/u);
const scenario = z.enum([
  'SUCCESS',
  'DECLINE',
  'TIMEOUT',
  'DUPLICATE_WEBHOOK',
  'RETRY',
  'REVERSAL',
  'PARTIAL_REFUND',
  'DELAYED_SETTLEMENT',
  'RECONCILIATION_MISMATCH',
  'PROVIDER_ACCOUNT_FAILURE',
]);

const commandBase = {
  providerKind: z.literal('FAKE'),
  operationId: z.string().uuid(),
  idempotencyKey,
  providerExpectedVersion: z.number().int().nonnegative(),
  lifecycleExpectedVersion: z.number().int().nonnegative(),
  taskDraftId: z.string().uuid(),
  taskId: z.string().uuid(),
  eligibilityDecisionId: z.string().uuid(),
  scopeVersionId: z.string().uuid(),
  scenario: scenario.optional(),
  occurredAt: z.string().datetime(),
} as const;

const paymentMethodPreparation = z
  .object({
    ...commandBase,
    operationKind: z.literal('PREPARE_PAYMENT_METHOD'),
    customerId: z.string().trim().min(3).max(160),
  })
  .strict();

const boundFinancialEffect = z
  .object({
    ...commandBase,
    operationKind: z.enum([
      'AUTHORIZE',
      'SECURE',
      'VOID',
      'ADJUST',
      'CAPTURE',
      'REFUND',
      'REVERSAL',
      'SETTLE',
      'FUND',
      'PROVIDER_RELEASE',
      'PAYOUT',
      'OBSERVE_BANK_SETTLEMENT',
    ]),
    predecessorEventId: z.string().uuid(),
    relatedOperationId: z.string().uuid(),
    amountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[a-z]{3}$/u),
    paymentMethodReference: z.string().trim().min(3).max(256).optional(),
    authorizationOperationId: z.string().uuid().optional(),
    changeOrderId: z.string().uuid().optional(),
    completionFactId: z.string().uuid().optional(),
    originalAmountCents: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    providerAccountReference: z.string().trim().min(3).max(256).optional(),
  })
  .strict();

export const syntheticFinancialEventCommandSchema = z.union([
  paymentMethodPreparation,
  boundFinancialEffect,
]);

const reconciliationState = {
  voidState: z.enum(['NOT_APPLICABLE', 'PENDING', 'VOIDED', 'FAILED', 'MISMATCH']),
  captureState: z.enum(['NOT_APPLICABLE', 'PENDING', 'CAPTURED', 'MISMATCH']),
  refundState: z.enum(['NOT_APPLICABLE', 'PENDING', 'REFUNDED', 'FAILED', 'MISMATCH']),
  reversalState: z.enum(['NOT_APPLICABLE', 'PENDING', 'REVERSED', 'FAILED', 'MISMATCH']),
  settlementState: z.enum(['NOT_APPLICABLE', 'PENDING', 'SETTLED', 'FAILED', 'MISMATCH']),
  fundingState: z.enum(['NOT_APPLICABLE', 'PENDING', 'FUNDED', 'FAILED', 'MISMATCH']),
  providerReleaseState: z.enum(['NOT_APPLICABLE', 'PENDING', 'RELEASED', 'FAILED', 'MISMATCH']),
  payoutState: z.enum(['NOT_APPLICABLE', 'PENDING', 'PAID', 'FAILED', 'MISMATCH']),
  bankSettlementState: z.enum(['NOT_APPLICABLE', 'PENDING', 'SETTLED', 'FAILED', 'MISMATCH']),
  ledgerState: z.enum(['PENDING', 'MATCHED', 'MISMATCH']),
  reconciliationState: z.enum(['OPEN', 'MATCHED', 'MISMATCH', 'CLOSED']),
} as const;

export const syntheticReconciliationCommandSchema = z
  .object({
    providerKind: z.literal('FAKE'),
    operationId: z.string().uuid(),
    idempotencyKey,
    providerExpectedVersion: z.number().int().nonnegative(),
    relatedOperationId: z.string().uuid(),
    scenario: scenario.optional(),
    snapshot: z
      .object({
        workOrderId: z.string().uuid(),
        reconciliationVersion: z.number().int().positive(),
        supersedesFactId: z.string().uuid().optional(),
        voidEventId: z.string().uuid().optional(),
        captureEventId: z.string().uuid().optional(),
        refundEventId: z.string().uuid().optional(),
        reversalEventId: z.string().uuid().optional(),
        settlementEventId: z.string().uuid().optional(),
        fundingEventId: z.string().uuid().optional(),
        providerReleaseEventId: z.string().uuid().optional(),
        payoutEventId: z.string().uuid().optional(),
        bankSettlementEventId: z.string().uuid().optional(),
        ...reconciliationState,
        mismatchCodes: z.array(z.string().regex(/^[A-Z0-9:_-]{3,128}$/u)).max(32),
        customerLedgerAmountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        providerLedgerAmountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        currency: z.string().regex(/^[A-Z]{3}$/u),
        expectedVersion: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const syntheticProviderOnboardingCommandSchema = z
  .object({
    providerKind: z.literal('FAKE'),
    operationId: z.string().uuid(),
    idempotencyKey,
    providerExpectedVersion: z.number().int().nonnegative(),
    scenario: scenario.optional(),
  })
  .strict();

export const syntheticProviderAccountStateCommandSchema = syntheticProviderOnboardingCommandSchema
  .extend({
    providerAccountReference: z.string().trim().min(3).max(256),
  })
  .strict();

export const syntheticWebhookCommandSchema = z
  .object({
    providerKind: z.literal('FAKE'),
    operationId: z.string().uuid(),
    idempotencyKey,
    providerExpectedVersion: z.number().int().nonnegative(),
    providerEventReference: z.string().trim().min(3).max(256),
    scenario: z.enum(['SUCCESS', 'DUPLICATE_WEBHOOK']).optional(),
  })
  .strict();

export const syntheticWebhookIngressCommandSchema = syntheticWebhookCommandSchema
  .extend({
    taskDraftId: z.string().uuid(),
    taskId: z.string().uuid(),
  })
  .strict();

export const signedSyntheticWebhookIngressSchema = z
  .object({
    rawBody: z
      .string()
      .min(2)
      .max(16 * 1024),
    signature: z.string().regex(/^[0-9a-fA-F]{64}$/u),
  })
  .strict();

export const syntheticFinancialJobEnvelopeSchema = z.discriminatedUnion('kind', [
  z
    .object({
      version: z.literal(1),
      kind: z.literal('FINANCIAL_EVENT'),
      actorId: z.string().uuid(),
      command: syntheticFinancialEventCommandSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(1),
      kind: z.literal('RECONCILIATION'),
      actorId: z.string().uuid(),
      command: syntheticReconciliationCommandSchema,
    })
    .strict(),
]);

export type SyntheticFinancialEventRouteCommand = z.infer<
  typeof syntheticFinancialEventCommandSchema
>;
export type SyntheticReconciliationRouteCommand = z.infer<
  typeof syntheticReconciliationCommandSchema
>;
export type SyntheticWebhookIngressCommand = z.infer<typeof syntheticWebhookIngressCommandSchema>;
export type SyntheticFinancialJobEnvelope = z.infer<typeof syntheticFinancialJobEnvelopeSchema>;
