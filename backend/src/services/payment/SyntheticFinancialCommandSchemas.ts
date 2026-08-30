import { z, type RefinementCtx } from 'zod';

import type { FinancialOperationKind } from './FinancialProviderPorts.js';
import {
  FAKE_FINANCIAL_SCENARIO_VALUES,
  fakeFinancialScenarioSupportsOperation,
  type FakeFinancialScenario,
} from './FakeFinancialScenarioPolicy.js';

const idempotencyKey = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9:_-]+$/u);
const scenario = z.enum(FAKE_FINANCIAL_SCENARIO_VALUES);

function enforceScenarioOperation(
  selectedScenario: FakeFinancialScenario | undefined,
  operationKind: FinancialOperationKind,
  context: RefinementCtx
): void {
  if (
    selectedScenario !== undefined &&
    !fakeFinancialScenarioSupportsOperation(selectedScenario, operationKind)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['scenario'],
      message: 'FAKE_FINANCIAL_SCENARIO_OPERATION_INVALID',
    });
  }
}

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
  .strict()
  .superRefine((value, context) => {
    enforceScenarioOperation(value.scenario, 'PREPARE_PAYMENT_METHOD', context);
  });

// Public and generic queued callers may only advance the pre-WorkOrder lane.
// Terminal operations are intentionally available only to the fulfillment
// application after it commits and pins the terminal lifecycle intent.
const boundFinancialEffect = z
  .object({
    ...commandBase,
    operationKind: z.enum(['AUTHORIZE', 'SECURE']),
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
  .strict()
  .superRefine((value, context) => {
    enforceScenarioOperation(value.scenario, value.operationKind, context);
  });

export const syntheticFinancialEventCommandSchema = z.union([
  paymentMethodPreparation,
  boundFinancialEffect,
]);

export const PUBLIC_SYNTHETIC_RECONCILIATION_REFUSAL =
  'UNIVERSAL_FINANCE_PUBLIC_RECONCILIATION_REFUSED';

// Reconciliation is materialized only by the terminal fulfillment coordinator,
// which owns the exact intent, terminal event, and snapshot-digest bindings.
export function refusePublicSyntheticReconciliation(): never {
  throw new Error(PUBLIC_SYNTHETIC_RECONCILIATION_REFUSAL);
}

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
  .strict()
  .superRefine((value, context) => {
    enforceScenarioOperation(value.scenario, 'RECONCILE', context);
  });

const providerCommandBase = {
  providerKind: z.literal('FAKE'),
  operationId: z.string().uuid(),
  idempotencyKey,
  providerExpectedVersion: z.number().int().nonnegative(),
  scenario: scenario.optional(),
} as const;

export const syntheticProviderOnboardingCommandSchema = z
  .object({
    ...providerCommandBase,
  })
  .strict()
  .superRefine((value, context) => {
    enforceScenarioOperation(value.scenario, 'ONBOARD_PROVIDER', context);
  });

export const syntheticProviderAccountStateCommandSchema = z
  .object({
    ...providerCommandBase,
    providerAccountReference: z.string().trim().min(3).max(256),
  })
  .strict()
  .superRefine((value, context) => {
    enforceScenarioOperation(value.scenario, 'REFRESH_PROVIDER_ACCOUNT_STATE', context);
  });

export const syntheticProviderAccountEstablishmentCommandSchema = z
  .object({
    providerKind: z.literal('FAKE'),
    providerOrganizationId: z.string().uuid().optional(),
    onboardOperationId: z.string().uuid(),
    onboardIdempotencyKey: idempotencyKey,
    refreshOperationId: z.string().uuid(),
    refreshIdempotencyKey: idempotencyKey,
    providerExpectedVersion: z.number().int().nonnegative(),
    onboardScenario: scenario.optional(),
    refreshScenario: scenario.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    enforceScenarioOperation(value.onboardScenario, 'ONBOARD_PROVIDER', context);
    enforceScenarioOperation(value.refreshScenario, 'REFRESH_PROVIDER_ACCOUNT_STATE', context);
    if (value.onboardOperationId === value.refreshOperationId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refreshOperationId'],
        message: 'Provider onboarding and refresh require distinct operation IDs.',
      });
    }
    if (value.onboardIdempotencyKey === value.refreshIdempotencyKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refreshIdempotencyKey'],
        message: 'Provider onboarding and refresh require distinct idempotency keys.',
      });
    }
  });

export const syntheticWebhookCommandSchema = z
  .object({
    providerKind: z.literal('FAKE'),
    operationId: z.string().uuid(),
    idempotencyKey,
    providerExpectedVersion: z.number().int().nonnegative(),
    providerEventReference: z.string().trim().min(3).max(255),
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

// A signed job authenticates bytes; it does not grant terminal authority.
// Reconciliation and terminal events therefore have no generic worker envelope.
export const syntheticFinancialJobEnvelopeSchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('FINANCIAL_EVENT'),
    actorId: z.string().uuid(),
    command: syntheticFinancialEventCommandSchema,
  })
  .strict();

export type SyntheticFinancialEventRouteCommand = z.infer<
  typeof syntheticFinancialEventCommandSchema
>;
export type SyntheticReconciliationRouteCommand = z.infer<
  typeof syntheticReconciliationCommandSchema
>;
export type SyntheticWebhookIngressCommand = z.infer<typeof syntheticWebhookIngressCommandSchema>;
export type SyntheticFinancialJobEnvelope = z.infer<typeof syntheticFinancialJobEnvelopeSchema>;
