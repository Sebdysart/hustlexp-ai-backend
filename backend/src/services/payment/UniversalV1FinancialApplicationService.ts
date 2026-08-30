import { createHash } from 'node:crypto';

import { buildIdentity, type BuildIdentity } from '../../buildIdentity.js';
import { db, type Database, type QueryFn } from '../../db.js';
import { readReleaseManifest, type ReleaseManifestEvidence } from '../../releaseManifest.js';
import {
  FakeFinancialProvider,
  PostgresFakeFinancialOperationRepository,
  type FakeFinancialScenario,
} from './FakeFinancialProvider.js';
import {
  canonicalFinancialProviderRequestSha256,
  JournaledFinancialProviderInvoker,
  PostgresFinancialProviderCommandJournal,
  type DurableFakeFinancialCommandEvidence,
  type FinancialProviderCommandActorEvidence,
  type ForegroundFinancialProviderCommandCoordinator,
  type FinancialProviderCommandJournal,
  type FinancialProviderCommandReleaseEvidence,
  type FinancialProviderCommandSafeEvidence,
  type JournaledFinancialProviderInvocation,
} from './FinancialProviderCommandJournal.js';
import {
  DurableFakeFinancialProviderCommandCoordinator,
  PostgresFinancialProviderCommandRecoveryRepository,
} from './FinancialProviderCommandRecovery.js';
import type {
  FinancialOperationKind,
  FinancialOperationResult,
  FinancialOperationState,
  FinancialProviderKind,
  FinancialProviderPorts,
  ProviderAccountStateResult,
} from './FinancialProviderPorts.js';
import {
  assertNonproductionFakeFinanceAuthorized,
  type NonproductionFinancialAuthorizationOptions,
} from './NonproductionFinancialAuthorization.js';
import {
  PreparedFinancialCommandAuthorityError,
  PostgresUniversalV1PreparedFinancialCommandAuthority,
  type PreparedUniversalV1FinancialCommandReceipt,
  type PrepareUniversalV1FinancialCommandInput,
  type UniversalV1PreparedFinancialCommandAuthority,
} from './PreparedFinancialCommandAuthority.js';

export type UniversalV1FinancialEventKind =
  | 'PAYMENT_METHOD_PREPARED'
  | 'AUTHORIZED'
  | 'SECURED'
  | 'VOIDED'
  | 'ADJUSTMENT_AUTHORIZED'
  | 'CAPTURED'
  | 'REFUNDED'
  | 'REVERSED'
  | 'SETTLEMENT_OBSERVED'
  | 'FUNDING_OBSERVED'
  | 'PROVIDER_RELEASED'
  | 'PAYOUT_OBSERVED'
  | 'BANK_SETTLEMENT_OBSERVED';

export type UniversalV1FinancialEventStatus =
  | 'REQUESTED'
  | 'SUCCEEDED'
  | 'DECLINED'
  | 'FAILED'
  | 'RETRYABLE_FAILURE';

type LifecycleFinancialOperationKind = Exclude<
  FinancialOperationKind,
  'ONBOARD_PROVIDER' | 'REFRESH_PROVIDER_ACCOUNT_STATE' | 'INGEST_WEBHOOK' | 'RECONCILE'
>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,128}$/u;

const EVENT_KIND_BY_OPERATION: Readonly<
  Record<LifecycleFinancialOperationKind, UniversalV1FinancialEventKind>
> = {
  PREPARE_PAYMENT_METHOD: 'PAYMENT_METHOD_PREPARED',
  AUTHORIZE: 'AUTHORIZED',
  SECURE: 'SECURED',
  VOID: 'VOIDED',
  ADJUST: 'ADJUSTMENT_AUTHORIZED',
  CAPTURE: 'CAPTURED',
  REFUND: 'REFUNDED',
  REVERSAL: 'REVERSED',
  SETTLE: 'SETTLEMENT_OBSERVED',
  FUND: 'FUNDING_OBSERVED',
  PROVIDER_RELEASE: 'PROVIDER_RELEASED',
  PAYOUT: 'PAYOUT_OBSERVED',
  OBSERVE_BANK_SETTLEMENT: 'BANK_SETTLEMENT_OBSERVED',
};

const AUTHORIZED_PREDECESSORS: Readonly<
  Record<UniversalV1FinancialEventKind, readonly UniversalV1FinancialEventKind[]>
> = {
  PAYMENT_METHOD_PREPARED: [],
  AUTHORIZED: ['PAYMENT_METHOD_PREPARED'],
  SECURED: ['AUTHORIZED', 'ADJUSTMENT_AUTHORIZED'],
  VOIDED: ['AUTHORIZED', 'SECURED', 'ADJUSTMENT_AUTHORIZED'],
  ADJUSTMENT_AUTHORIZED: ['SECURED', 'ADJUSTMENT_AUTHORIZED'],
  CAPTURED: ['SECURED', 'ADJUSTMENT_AUTHORIZED'],
  REFUNDED: [
    'CAPTURED',
    'REFUNDED',
    'SETTLEMENT_OBSERVED',
    'FUNDING_OBSERVED',
    'PROVIDER_RELEASED',
    'PAYOUT_OBSERVED',
    'BANK_SETTLEMENT_OBSERVED',
  ],
  REVERSED: ['AUTHORIZED', 'SECURED', 'ADJUSTMENT_AUTHORIZED', 'CAPTURED'],
  SETTLEMENT_OBSERVED: ['CAPTURED'],
  FUNDING_OBSERVED: ['SETTLEMENT_OBSERVED'],
  PROVIDER_RELEASED: ['FUNDING_OBSERVED'],
  PAYOUT_OBSERVED: ['PROVIDER_RELEASED'],
  BANK_SETTLEMENT_OBSERVED: ['PAYOUT_OBSERVED'],
};

interface ApplicationOperationBase {
  readonly providerKind: FinancialProviderKind;
  readonly operationId: string;
  readonly idempotencyKey: string;
  /** Version of this provider operation, independent of the lifecycle chain. */
  readonly providerExpectedVersion: number;
  /** Version of the Task Draft financial-event chain. */
  readonly lifecycleExpectedVersion: number;
  readonly taskDraftId: string;
  readonly scenario?: FakeFinancialScenario;
  readonly recordedBy: string;
  readonly occurredAt: string;
}

interface PreparedPaymentMethodOperation extends ApplicationOperationBase {
  readonly operationKind: 'PREPARE_PAYMENT_METHOD';
  readonly customerId: string;
  readonly taskId?: string;
  readonly eligibilityDecisionId?: string;
  readonly scopeVersionId?: string;
}

interface BoundFinancialEffectOperation extends ApplicationOperationBase {
  readonly operationKind: Exclude<LifecycleFinancialOperationKind, 'PREPARE_PAYMENT_METHOD'>;
  readonly taskId: string;
  readonly eligibilityDecisionId: string;
  readonly scopeVersionId: string;
  readonly predecessorEventId: string;
  readonly relatedOperationId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly paymentMethodReference?: string;
  readonly authorizationOperationId?: string;
  readonly changeOrderId?: string;
  readonly completionFactId?: string;
  readonly originalAmountCents?: number;
  readonly providerAccountReference?: string;
}

export type ExecuteUniversalV1FinancialEventCommand =
  | PreparedPaymentMethodOperation
  | BoundFinancialEffectOperation;

export interface RecordedUniversalV1FinancialEvent {
  readonly id: string;
  readonly operationId: string;
  readonly eventKind: UniversalV1FinancialEventKind;
  readonly status: UniversalV1FinancialEventStatus;
  readonly providerKind: FinancialProviderKind;
  readonly externalReference: string;
  readonly providerOperationVersion: number;
  readonly lifecycleExpectedVersion: number;
  readonly idempotencyReplayed: boolean;
  readonly taskDraftId: string;
  readonly taskId: string | null;
  readonly eligibilityDecisionId: string | null;
  readonly scopeVersionId: string | null;
  readonly changeOrderId: string | null;
  readonly predecessorEventId: string | null;
  readonly completionFactId: string | null;
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly providerState: FinancialOperationState;
  readonly recordedBy: string;
  readonly occurredAt: string;
}

interface RecordFinancialEventCommand {
  readonly operationId: string;
  readonly eventKind: UniversalV1FinancialEventKind;
  readonly status: UniversalV1FinancialEventStatus;
  readonly providerKind: FinancialProviderKind;
  readonly externalReference: string;
  readonly providerOperationVersion: number;
  readonly lifecycleExpectedVersion: number;
  readonly idempotencyKey: string;
  readonly taskDraftId: string;
  readonly taskId: string | null;
  readonly eligibilityDecisionId: string | null;
  readonly scopeVersionId: string | null;
  readonly changeOrderId: string | null;
  readonly predecessorEventId: string | null;
  readonly completionFactId: string | null;
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly providerState: FinancialOperationState;
  readonly providerIdempotencyReplayed: boolean;
  readonly durableFakeEvidence?: DurableFakeFinancialCommandEvidence;
  readonly recordedBy: string;
}

export interface UniversalV1ReconciliationSnapshot {
  readonly workOrderId: string;
  readonly reconciliationVersion: number;
  readonly supersedesFactId?: string;
  readonly voidEventId?: string;
  readonly captureEventId?: string;
  readonly refundEventId?: string;
  readonly reversalEventId?: string;
  readonly settlementEventId?: string;
  readonly fundingEventId?: string;
  readonly providerReleaseEventId?: string;
  readonly payoutEventId?: string;
  readonly bankSettlementEventId?: string;
  readonly voidState: 'NOT_APPLICABLE' | 'PENDING' | 'VOIDED' | 'FAILED' | 'MISMATCH';
  readonly captureState: 'NOT_APPLICABLE' | 'PENDING' | 'CAPTURED' | 'MISMATCH';
  readonly refundState: 'NOT_APPLICABLE' | 'PENDING' | 'REFUNDED' | 'FAILED' | 'MISMATCH';
  readonly reversalState: 'NOT_APPLICABLE' | 'PENDING' | 'REVERSED' | 'FAILED' | 'MISMATCH';
  readonly settlementState: 'NOT_APPLICABLE' | 'PENDING' | 'SETTLED' | 'FAILED' | 'MISMATCH';
  readonly fundingState: 'NOT_APPLICABLE' | 'PENDING' | 'FUNDED' | 'FAILED' | 'MISMATCH';
  readonly providerReleaseState: 'NOT_APPLICABLE' | 'PENDING' | 'RELEASED' | 'FAILED' | 'MISMATCH';
  readonly payoutState: 'NOT_APPLICABLE' | 'PENDING' | 'PAID' | 'FAILED' | 'MISMATCH';
  readonly bankSettlementState: 'NOT_APPLICABLE' | 'PENDING' | 'SETTLED' | 'FAILED' | 'MISMATCH';
  readonly ledgerState: 'PENDING' | 'MATCHED' | 'MISMATCH';
  readonly reconciliationState: 'OPEN' | 'MATCHED' | 'MISMATCH' | 'CLOSED';
  readonly mismatchCodes: readonly string[];
  readonly customerLedgerAmountCents: number;
  readonly providerLedgerAmountCents: number;
  readonly currency: string;
  readonly expectedVersion: number;
  readonly recordedBy: string;
}

export interface ExecuteUniversalV1ReconciliationCommand {
  readonly providerKind: FinancialProviderKind;
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly providerExpectedVersion: number;
  readonly relatedOperationId: string;
  readonly scenario?: FakeFinancialScenario;
  readonly snapshot: UniversalV1ReconciliationSnapshot;
}

export interface RecordedUniversalV1Reconciliation {
  readonly id: string;
  readonly operationId: string;
  readonly providerState: 'MATCHED' | 'MISMATCH';
  readonly providerOperationVersion: number;
  readonly reconciliationVersion: number;
  readonly idempotencyReplayed: boolean;
  readonly workOrderId: string;
  readonly reconciliationState: UniversalV1ReconciliationSnapshot['reconciliationState'];
  readonly mismatchCodes: readonly string[];
}

interface RecordReconciliationCommand {
  readonly operationId: string;
  readonly idempotencyKey: string;
  readonly providerState: 'MATCHED' | 'MISMATCH';
  readonly providerOperationVersion: number;
  readonly providerIdempotencyReplayed: boolean;
  readonly externalReference: string;
  readonly snapshot: UniversalV1ReconciliationSnapshot;
}

export interface UniversalV1FinancialLifecycleRepository {
  recordFinancialEvent(
    command: RecordFinancialEventCommand
  ): Promise<RecordedUniversalV1FinancialEvent>;
  recordReconciliation(
    command: RecordReconciliationCommand
  ): Promise<RecordedUniversalV1Reconciliation>;
}

export interface FinancialExecutionGate {
  assertAuthorized(): void;
}

/** Backward-compatible name for the nonproduction fake factory and callers. */
export type FakeFinancialExecutionGate = FinancialExecutionGate;

/**
 * Explicit authority evidence required before the generic application layer
 * may enter an approved-provider adapter. The command journal independently
 * validates both values and requires a verified release.
 */
const APPROVED_PROVIDER_RUNTIME_AUTHORITY_SEAL = Symbol('approved-provider-runtime-authority');

interface ApprovedFinancialProviderCommandAuthority {
  readonly runtimeSeal: typeof APPROVED_PROVIDER_RUNTIME_AUTHORITY_SEAL;
  readonly actor: FinancialProviderCommandActorEvidence;
  readonly release: FinancialProviderCommandReleaseEvidence;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function deterministicUuid(value: unknown): string {
  const digest = sha256(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function assertUuid(value: string | undefined, code: string): asserts value is string {
  if (!value || !UUID.test(value)) throw new Error(code);
}

function assertIdempotencyKey(value: string): void {
  if (!IDEMPOTENCY_KEY.test(value)) {
    throw new Error('UNIVERSAL_FINANCE_IDEMPOTENCY_KEY_INVALID');
  }
}

function assertVersion(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(code);
}

function assertProviderSelection(
  providerKind: FinancialProviderKind,
  configuredProviderKind: FinancialProviderKind
): void {
  if (providerKind === configuredProviderKind) return;
  if (configuredProviderKind === 'FAKE') {
    throw new Error('UNIVERSAL_FINANCE_REAL_PROVIDER_REFUSED');
  }
  throw new Error('UNIVERSAL_FINANCE_PROVIDER_SELECTION_MISMATCH');
}

function canonicalCurrency(currency: string): string {
  if (!/^[a-z]{3}$/u.test(currency)) {
    throw new Error('UNIVERSAL_FINANCE_PROVIDER_CURRENCY_INVALID');
  }
  return currency.toUpperCase();
}

function lifecycleStatus(state: FinancialOperationState): UniversalV1FinancialEventStatus {
  switch (state) {
    case 'PENDING':
      return 'REQUESTED';
    case 'DECLINED':
      return 'DECLINED';
    case 'FAILED':
    case 'REJECTED':
    case 'MISMATCH':
      return 'FAILED';
    case 'RETRYABLE_FAILURE':
      return 'RETRYABLE_FAILURE';
    case 'SUCCEEDED':
    case 'VOIDED':
    case 'REFUNDED':
    case 'PARTIALLY_REFUNDED':
    case 'REVERSED':
    case 'ACCEPTED':
    case 'MATCHED':
      return 'SUCCEEDED';
    default:
      throw new Error('UNIVERSAL_FINANCE_PROVIDER_RESULT_STATE_INVALID');
  }
}

const FINANCIAL_OPERATION_STATES = new Set<FinancialOperationState>([
  'PENDING',
  'SUCCEEDED',
  'DECLINED',
  'FAILED',
  'RETRYABLE_FAILURE',
  'VOIDED',
  'REFUNDED',
  'PARTIALLY_REFUNDED',
  'REVERSED',
  'ACCEPTED',
  'REJECTED',
  'MATCHED',
  'MISMATCH',
]);

const MONEY_OPERATION_KINDS = new Set<FinancialOperationKind>([
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
]);

const FAILURE_PROVIDER_STATES = [
  'PENDING',
  'DECLINED',
  'FAILED',
  'RETRYABLE_FAILURE',
] as const satisfies readonly FinancialOperationState[];

const PROVIDER_STATES_BY_OPERATION: Readonly<
  Record<FinancialOperationKind, ReadonlySet<FinancialOperationState>>
> = {
  PREPARE_PAYMENT_METHOD: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  AUTHORIZE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  SECURE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  VOID: new Set(['VOIDED', ...FAILURE_PROVIDER_STATES]),
  ADJUST: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  CAPTURE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  REFUND: new Set(['REFUNDED', 'PARTIALLY_REFUNDED', ...FAILURE_PROVIDER_STATES]),
  REVERSAL: new Set(['REVERSED', ...FAILURE_PROVIDER_STATES]),
  ONBOARD_PROVIDER: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  REFRESH_PROVIDER_ACCOUNT_STATE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  SETTLE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  FUND: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  PROVIDER_RELEASE: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  PAYOUT: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  OBSERVE_BANK_SETTLEMENT: new Set(['SUCCEEDED', ...FAILURE_PROVIDER_STATES]),
  INGEST_WEBHOOK: new Set(['ACCEPTED', 'REJECTED', 'PENDING', 'RETRYABLE_FAILURE']),
  RECONCILE: new Set(['MATCHED', 'MISMATCH']),
};

function assertProviderResult(
  result: FinancialOperationResult,
  command: Pick<ApplicationOperationBase, 'operationId' | 'providerExpectedVersion'>
    & Partial<Pick<BoundFinancialEffectOperation, 'amountCents' | 'currency'>>,
  operationKind: FinancialOperationKind,
  configuredProviderKind: FinancialProviderKind
): void {
  if (
    !result
    || typeof result !== 'object'
    || result.providerKind !== configuredProviderKind ||
    result.operationId !== command.operationId ||
    result.operationKind !== operationKind ||
    !Number.isSafeInteger(result.version)
    || result.version !== command.providerExpectedVersion + 1
  ) {
    throw new Error('UNIVERSAL_FINANCE_PROVIDER_RESULT_IDENTITY_MISMATCH');
  }
  if (
    !FINANCIAL_OPERATION_STATES.has(result.state)
    || !PROVIDER_STATES_BY_OPERATION[operationKind].has(result.state)
    || typeof result.idempotencyReplayed !== 'boolean'
    || typeof result.retryable !== 'boolean'
    || (result.retryable && !['PENDING', 'RETRYABLE_FAILURE'].includes(result.state))
    || (result.state === 'RETRYABLE_FAILURE' && !result.retryable)
    || typeof result.externalReference !== 'string'
    || result.externalReference.length < 1
    || result.externalReference.length > 512
    || result.externalReference.trim() !== result.externalReference
    || containsControlCharacter(result.externalReference)
  ) {
    throw new Error('UNIVERSAL_FINANCE_PROVIDER_RESULT_SHAPE_INVALID');
  }
  if (MONEY_OPERATION_KINDS.has(operationKind)) {
    if (
      !Number.isSafeInteger(command.amountCents)
      || result.amountCents !== command.amountCents
      || typeof result.currency !== 'string'
      || result.currency.toUpperCase() !== canonicalCurrency(command.currency ?? '')
    ) {
      throw new Error('UNIVERSAL_FINANCE_PROVIDER_RESULT_AMOUNT_MISMATCH');
    }
  } else if (result.amountCents !== null || result.currency !== null) {
    throw new Error('UNIVERSAL_FINANCE_PROVIDER_RESULT_AMOUNT_MISMATCH');
  }
}

function assertProviderAccountResult(
  result: ProviderAccountStateResult,
  providerId: string,
): void {
  if (
    result.providerId !== providerId
    || !['PENDING', 'ENABLED', 'RESTRICTED', 'FAILED'].includes(result.accountState)
    || typeof result.chargesEnabled !== 'boolean'
    || typeof result.payoutsEnabled !== 'boolean'
    || !Array.isArray(result.requirementsDue)
    || result.requirementsDue.some((requirement) => (
      typeof requirement !== 'string'
      || requirement.length < 1
      || requirement.length > 255
      || requirement.trim() !== requirement
      || containsControlCharacter(requirement)
    ))
  ) {
    throw new Error('UNIVERSAL_FINANCE_PROVIDER_ACCOUNT_RESULT_INVALID');
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

function assertEventCommand(
  command: ExecuteUniversalV1FinancialEventCommand,
  configuredProviderKind: FinancialProviderKind
): void {
  assertProviderSelection(command.providerKind, configuredProviderKind);
  assertUuid(command.operationId, 'UNIVERSAL_FINANCE_OPERATION_ID_INVALID');
  assertUuid(command.taskDraftId, 'UNIVERSAL_FINANCE_TASK_DRAFT_ID_INVALID');
  assertUuid(command.recordedBy, 'UNIVERSAL_FINANCE_RECORDED_BY_INVALID');
  assertIdempotencyKey(command.idempotencyKey);
  assertVersion(command.providerExpectedVersion, 'UNIVERSAL_FINANCE_PROVIDER_VERSION_INVALID');
  assertVersion(command.lifecycleExpectedVersion, 'UNIVERSAL_FINANCE_LIFECYCLE_VERSION_INVALID');
  if (!Number.isFinite(Date.parse(command.occurredAt))) {
    throw new Error('UNIVERSAL_FINANCE_OCCURRED_AT_INVALID');
  }

  if (command.operationKind === 'PREPARE_PAYMENT_METHOD') {
    if (command.lifecycleExpectedVersion !== 0) {
      throw new Error('UNIVERSAL_FINANCE_PREPARATION_VERSION_INVALID');
    }
    if (!command.customerId.trim()) throw new Error('UNIVERSAL_FINANCE_CUSTOMER_ID_INVALID');
    const optionalBindings = [
      command.taskId,
      command.eligibilityDecisionId,
      command.scopeVersionId,
    ];
    if (optionalBindings.some(Boolean) && !optionalBindings.every(Boolean)) {
      throw new Error('UNIVERSAL_FINANCE_PREPARATION_BINDING_INCOMPLETE');
    }
    for (const [value, code] of [
      [command.taskId, 'UNIVERSAL_FINANCE_TASK_ID_INVALID'],
      [command.eligibilityDecisionId, 'UNIVERSAL_FINANCE_ELIGIBILITY_ID_INVALID'],
      [command.scopeVersionId, 'UNIVERSAL_FINANCE_SCOPE_ID_INVALID'],
    ] as const) {
      if (value !== undefined) assertUuid(value, code);
    }
    return;
  }

  assertUuid(command.taskId, 'UNIVERSAL_FINANCE_TASK_ID_INVALID');
  assertUuid(command.eligibilityDecisionId, 'UNIVERSAL_FINANCE_ELIGIBILITY_ID_INVALID');
  assertUuid(command.scopeVersionId, 'UNIVERSAL_FINANCE_SCOPE_ID_INVALID');
  assertUuid(command.predecessorEventId, 'UNIVERSAL_FINANCE_PREDECESSOR_ID_INVALID');
  assertUuid(command.relatedOperationId, 'UNIVERSAL_FINANCE_RELATED_OPERATION_ID_INVALID');
  if (!Number.isSafeInteger(command.amountCents) || command.amountCents <= 0) {
    throw new Error('UNIVERSAL_FINANCE_AMOUNT_INVALID');
  }
  canonicalCurrency(command.currency);
  if (command.operationKind === 'ADJUST') {
    assertUuid(command.changeOrderId, 'UNIVERSAL_FINANCE_CHANGE_ORDER_ID_REQUIRED');
  } else if (command.changeOrderId !== undefined) {
    throw new Error('UNIVERSAL_FINANCE_CHANGE_ORDER_NOT_ALLOWED');
  }
  if (command.operationKind === 'CAPTURE') {
    assertUuid(command.completionFactId, 'UNIVERSAL_FINANCE_COMPLETION_FACT_ID_REQUIRED');
  } else if (command.completionFactId !== undefined) {
    throw new Error('UNIVERSAL_FINANCE_COMPLETION_FACT_NOT_ALLOWED');
  }
  if (command.operationKind === 'AUTHORIZE' && !command.paymentMethodReference?.trim()) {
    throw new Error('UNIVERSAL_FINANCE_PAYMENT_METHOD_REFERENCE_REQUIRED');
  }
  if (command.operationKind === 'SECURE' && !command.authorizationOperationId?.trim()) {
    throw new Error('UNIVERSAL_FINANCE_AUTHORIZATION_OPERATION_REQUIRED');
  }
  if (
    command.operationKind === 'REFUND' &&
    (!Number.isSafeInteger(command.originalAmountCents) || command.originalAmountCents! <= 0)
  ) {
    throw new Error('UNIVERSAL_FINANCE_ORIGINAL_AMOUNT_REQUIRED');
  }
  if (command.operationKind === 'PAYOUT' && !command.providerAccountReference?.trim()) {
    throw new Error('UNIVERSAL_FINANCE_PROVIDER_ACCOUNT_REFERENCE_REQUIRED');
  }
}

function preparedAuthorityInput(
  command: ExecuteUniversalV1FinancialEventCommand,
  providerRequestSha256: string
): PrepareUniversalV1FinancialCommandInput {
  const paymentMethodPreparation = command.operationKind === 'PREPARE_PAYMENT_METHOD';
  return {
    operationKind: command.operationKind,
    operationId: command.operationId,
    providerKind: command.providerKind,
    idempotencyKey: command.idempotencyKey,
    providerExpectedVersion: command.providerExpectedVersion,
    lifecycleExpectedVersion: command.lifecycleExpectedVersion,
    providerRequestSha256,
    taskDraftId: command.taskDraftId,
    taskId: command.taskId ?? null,
    eligibilityDecisionId: command.eligibilityDecisionId ?? null,
    scopeVersionId: command.scopeVersionId ?? null,
    changeOrderId: paymentMethodPreparation ? null : (command.changeOrderId ?? null),
    predecessorEventId: paymentMethodPreparation ? null : command.predecessorEventId,
    completionFactId: paymentMethodPreparation ? null : (command.completionFactId ?? null),
    relatedOperationId: paymentMethodPreparation ? null : command.relatedOperationId,
    amountCents: paymentMethodPreparation ? null : command.amountCents,
    currency: paymentMethodPreparation ? null : canonicalCurrency(command.currency),
    recordedBy: command.recordedBy,
  };
}

function exactFinancialProviderRequest(
  command: ExecuteUniversalV1FinancialEventCommand
): Record<string, unknown> {
  const base = {
    operationId: command.operationId,
    idempotencyKey: command.idempotencyKey,
    expectedVersion: command.providerExpectedVersion,
    ...(command.scenario === undefined ? {} : { scenario: command.scenario }),
  };
  if (command.operationKind === 'PREPARE_PAYMENT_METHOD') {
    return { ...base, customerId: command.customerId };
  }
  const money = {
    ...base,
    amountCents: command.amountCents,
    currency: canonicalCurrency(command.currency).toLowerCase(),
    relatedOperationId: command.relatedOperationId,
  };
  switch (command.operationKind) {
    case 'AUTHORIZE':
      return { ...money, paymentMethodReference: command.paymentMethodReference! };
    case 'SECURE':
      return { ...money, authorizationOperationId: command.authorizationOperationId! };
    case 'ADJUST':
      return {
        ...money,
        scopeVersionId: command.scopeVersionId,
        changeOrderId: command.changeOrderId!,
      };
    case 'REFUND':
      return { ...money, originalAmountCents: command.originalAmountCents! };
    case 'PAYOUT':
      return { ...money, providerAccountReference: command.providerAccountReference! };
    default:
      return money;
  }
}

function assertReconciliationSnapshot(snapshot: UniversalV1ReconciliationSnapshot): void {
  assertUuid(snapshot.workOrderId, 'UNIVERSAL_FINANCE_WORK_ORDER_ID_INVALID');
  assertUuid(snapshot.recordedBy, 'UNIVERSAL_FINANCE_RECORDED_BY_INVALID');
  if (
    !Number.isSafeInteger(snapshot.reconciliationVersion) ||
    snapshot.reconciliationVersion <= 0
  ) {
    throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_VERSION_INVALID');
  }
  assertVersion(
    snapshot.expectedVersion,
    'UNIVERSAL_FINANCE_RECONCILIATION_EXPECTED_VERSION_INVALID'
  );
  if (snapshot.reconciliationVersion === 1) {
    if (snapshot.supersedesFactId !== undefined) {
      throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_PREDECESSOR_INVALID');
    }
  } else {
    assertUuid(snapshot.supersedesFactId, 'UNIVERSAL_FINANCE_RECONCILIATION_PREDECESSOR_INVALID');
  }
  for (const [value, code] of [
    [snapshot.voidEventId, 'UNIVERSAL_FINANCE_VOID_EVENT_ID_INVALID'],
    [snapshot.captureEventId, 'UNIVERSAL_FINANCE_CAPTURE_EVENT_ID_INVALID'],
    [snapshot.refundEventId, 'UNIVERSAL_FINANCE_REFUND_EVENT_ID_INVALID'],
    [snapshot.reversalEventId, 'UNIVERSAL_FINANCE_REVERSAL_EVENT_ID_INVALID'],
    [snapshot.settlementEventId, 'UNIVERSAL_FINANCE_SETTLEMENT_EVENT_ID_INVALID'],
    [snapshot.fundingEventId, 'UNIVERSAL_FINANCE_FUNDING_EVENT_ID_INVALID'],
    [snapshot.providerReleaseEventId, 'UNIVERSAL_FINANCE_PROVIDER_RELEASE_EVENT_ID_INVALID'],
    [snapshot.payoutEventId, 'UNIVERSAL_FINANCE_PAYOUT_EVENT_ID_INVALID'],
    [snapshot.bankSettlementEventId, 'UNIVERSAL_FINANCE_BANK_SETTLEMENT_EVENT_ID_INVALID'],
  ] as const) {
    if (value !== undefined) assertUuid(value, code);
  }
  if (
    !Number.isSafeInteger(snapshot.customerLedgerAmountCents) ||
    snapshot.customerLedgerAmountCents < 0 ||
    !Number.isSafeInteger(snapshot.providerLedgerAmountCents) ||
    snapshot.providerLedgerAmountCents < 0
  ) {
    throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_LEDGER_AMOUNT_INVALID');
  }
  if (!/^[A-Z]{3}$/u.test(snapshot.currency)) {
    throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_CURRENCY_INVALID');
  }
  if (snapshot.mismatchCodes.some((code) => !/^[A-Z0-9:_-]{3,128}$/u.test(code))) {
    throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_MISMATCH_CODE_INVALID');
  }
  const hasMismatchState = [
    snapshot.voidState,
    snapshot.captureState,
    snapshot.refundState,
    snapshot.reversalState,
    snapshot.settlementState,
    snapshot.fundingState,
    snapshot.providerReleaseState,
    snapshot.payoutState,
    snapshot.bankSettlementState,
    snapshot.ledgerState,
    snapshot.reconciliationState,
  ].includes('MISMATCH');
  if (snapshot.mismatchCodes.length > 0 !== hasMismatchState) {
    throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_MISMATCH_EVIDENCE_INVALID');
  }
}

function commandHash(command: object): string {
  return sha256(command);
}

function sameRecordedEvent(
  existing: RecordedUniversalV1FinancialEvent,
  command: RecordFinancialEventCommand
): boolean {
  return (
    commandHash({
      operationId: existing.operationId,
      eventKind: existing.eventKind,
      status: existing.status,
      providerKind: existing.providerKind,
      externalReference: existing.externalReference,
      providerOperationVersion: existing.providerOperationVersion,
      lifecycleExpectedVersion: existing.lifecycleExpectedVersion,
      taskDraftId: existing.taskDraftId,
      taskId: existing.taskId,
      eligibilityDecisionId: existing.eligibilityDecisionId,
      scopeVersionId: existing.scopeVersionId,
      changeOrderId: existing.changeOrderId,
      predecessorEventId: existing.predecessorEventId,
      completionFactId: existing.completionFactId,
      amountCents: existing.amountCents,
      currency: existing.currency,
      providerState: existing.providerState,
      recordedBy: existing.recordedBy,
    }) ===
    commandHash({
      operationId: command.operationId,
      eventKind: command.eventKind,
      status: command.status,
      providerKind: command.providerKind,
      externalReference: command.externalReference,
      providerOperationVersion: command.providerOperationVersion,
      lifecycleExpectedVersion: command.lifecycleExpectedVersion,
      taskDraftId: command.taskDraftId,
      taskId: command.taskId,
      eligibilityDecisionId: command.eligibilityDecisionId,
      scopeVersionId: command.scopeVersionId,
      changeOrderId: command.changeOrderId,
      predecessorEventId: command.predecessorEventId,
      completionFactId: command.completionFactId,
      amountCents: command.amountCents,
      currency: command.currency,
      providerState: command.providerState,
      recordedBy: command.recordedBy,
    })
  );
}

function reconciliationCommandHash(command: RecordReconciliationCommand): string {
  return commandHash({
    operationId: command.operationId,
    idempotencyKey: command.idempotencyKey,
    providerState: command.providerState,
    providerOperationVersion: command.providerOperationVersion,
    externalReference: command.externalReference,
    snapshot: command.snapshot,
  });
}

function assertInMemoryPredecessor(
  predecessor: RecordedUniversalV1FinancialEvent,
  command: RecordFinancialEventCommand
): void {
  if (
    predecessor.taskDraftId !== command.taskDraftId ||
    predecessor.providerKind !== command.providerKind ||
    command.lifecycleExpectedVersion !== predecessor.lifecycleExpectedVersion + 1
  ) {
    throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_PREDECESSOR_CONFLICT');
  }
  if (predecessor.status === 'REQUESTED' || predecessor.status === 'RETRYABLE_FAILURE') {
    if (
      command.operationId !== predecessor.operationId ||
      command.eventKind !== predecessor.eventKind ||
      command.externalReference !== predecessor.externalReference ||
      command.taskId !== predecessor.taskId ||
      command.eligibilityDecisionId !== predecessor.eligibilityDecisionId ||
      command.scopeVersionId !== predecessor.scopeVersionId ||
      command.changeOrderId !== predecessor.changeOrderId ||
      command.completionFactId !== predecessor.completionFactId ||
      command.amountCents !== predecessor.amountCents ||
      command.currency !== predecessor.currency
    ) {
      throw new Error('UNIVERSAL_FINANCE_RETRY_IDENTITY_CONFLICT');
    }
    return;
  }
  if (
    predecessor.status !== 'SUCCEEDED' ||
    command.operationId === predecessor.operationId ||
    !AUTHORIZED_PREDECESSORS[command.eventKind].includes(predecessor.eventKind)
  ) {
    throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_TRANSITION_REFUSED');
  }
}

export class InMemoryUniversalV1FinancialLifecycleRepository implements UniversalV1FinancialLifecycleRepository {
  private readonly eventsById = new Map<string, RecordedUniversalV1FinancialEvent>();
  private readonly eventsByIdempotency = new Map<string, RecordedUniversalV1FinancialEvent>();
  private readonly eventsByDraftVersion = new Map<string, RecordedUniversalV1FinancialEvent>();
  private readonly reconciliationsByIdempotency = new Map<
    string,
    RecordedUniversalV1Reconciliation
  >();
  private readonly reconciliationHashes = new Map<string, string>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async recordFinancialEvent(
    command: RecordFinancialEventCommand
  ): Promise<RecordedUniversalV1FinancialEvent> {
    const replay = this.eventsByIdempotency.get(command.idempotencyKey);
    if (replay) {
      if (!sameRecordedEvent(replay, command)) {
        throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_IDEMPOTENCY_CONFLICT');
      }
      return { ...replay, idempotencyReplayed: true };
    }

    if (command.eventKind === 'PAYMENT_METHOD_PREPARED') {
      if (command.predecessorEventId !== null || command.lifecycleExpectedVersion !== 0) {
        throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_PREDECESSOR_CONFLICT');
      }
    } else {
      const predecessor = command.predecessorEventId
        ? this.eventsById.get(command.predecessorEventId)
        : undefined;
      if (!predecessor) {
        throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_PREDECESSOR_CONFLICT');
      }
      assertInMemoryPredecessor(predecessor, command);
    }

    const draftVersionKey = `${command.taskDraftId}:${command.lifecycleExpectedVersion}`;
    if (this.eventsByDraftVersion.has(draftVersionKey)) {
      throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_VERSION_CONFLICT');
    }

    const event: RecordedUniversalV1FinancialEvent = {
      id: deterministicUuid({ type: 'financial-event', idempotencyKey: command.idempotencyKey }),
      operationId: command.operationId,
      eventKind: command.eventKind,
      status: command.status,
      providerKind: command.providerKind,
      externalReference: command.externalReference,
      providerOperationVersion: command.providerOperationVersion,
      lifecycleExpectedVersion: command.lifecycleExpectedVersion,
      idempotencyReplayed: false,
      taskDraftId: command.taskDraftId,
      taskId: command.taskId,
      eligibilityDecisionId: command.eligibilityDecisionId,
      scopeVersionId: command.scopeVersionId,
      changeOrderId: command.changeOrderId,
      predecessorEventId: command.predecessorEventId,
      completionFactId: command.completionFactId,
      amountCents: command.amountCents,
      currency: command.currency,
      providerState: command.providerState,
      recordedBy: command.recordedBy,
      occurredAt: this.now().toISOString(),
    };
    this.eventsById.set(event.id, event);
    this.eventsByIdempotency.set(command.idempotencyKey, event);
    this.eventsByDraftVersion.set(draftVersionKey, event);
    return event;
  }

  async recordReconciliation(
    command: RecordReconciliationCommand
  ): Promise<RecordedUniversalV1Reconciliation> {
    const requestHash = reconciliationCommandHash(command);
    const replay = this.reconciliationsByIdempotency.get(command.idempotencyKey);
    if (replay) {
      if (this.reconciliationHashes.get(command.idempotencyKey) !== requestHash) {
        throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_IDEMPOTENCY_CONFLICT');
      }
      return { ...replay, idempotencyReplayed: true };
    }

    const reconciliation: RecordedUniversalV1Reconciliation = {
      id: deterministicUuid({ type: 'reconciliation', idempotencyKey: command.idempotencyKey }),
      operationId: command.operationId,
      providerState: command.providerState,
      providerOperationVersion: command.providerOperationVersion,
      reconciliationVersion: command.snapshot.reconciliationVersion,
      idempotencyReplayed: false,
      workOrderId: command.snapshot.workOrderId,
      reconciliationState: command.snapshot.reconciliationState,
      mismatchCodes: [...command.snapshot.mismatchCodes],
    };
    this.reconciliationsByIdempotency.set(command.idempotencyKey, reconciliation);
    this.reconciliationHashes.set(command.idempotencyKey, requestHash);
    return reconciliation;
  }
}

interface FinancialEventRow {
  id: string;
  operation_id: string;
  event_kind: UniversalV1FinancialEventKind;
  status: UniversalV1FinancialEventStatus;
  provider_kind: FinancialProviderKind;
  external_reference: string;
  expected_version: number;
  idempotency_key: string;
  task_draft_id: string;
  task_id: string | null;
  eligibility_decision_id: string | null;
  scope_version_id: string | null;
  change_order_id: string | null;
  predecessor_event_id: string | null;
  completion_fact_id: string | null;
  amount_cents: string | number | null;
  currency: string | null;
  evidence: Record<string, unknown>;
  recorded_by: string;
  occurred_at: Date | string;
}

interface FinancialLifecycleBridgeRow {
  bridge_id: string;
  prepared_command_id: string;
  command_id: string;
  dispatch_attempt_id: string;
  outcome_fact_id: string;
  fake_operation_event_id: string;
  task_financial_security_event_id: string;
  authority_chain_sha256: string;
}

function mapFinancialEventRow(
  row: FinancialEventRow,
  replayed: boolean
): RecordedUniversalV1FinancialEvent {
  return {
    id: row.id,
    operationId: row.operation_id,
    eventKind: row.event_kind,
    status: row.status,
    providerKind: row.provider_kind,
    externalReference: row.external_reference,
    providerOperationVersion: Number(row.evidence.providerOperationVersion),
    lifecycleExpectedVersion: row.expected_version,
    idempotencyReplayed: replayed,
    taskDraftId: row.task_draft_id,
    taskId: row.task_id,
    eligibilityDecisionId: row.eligibility_decision_id,
    scopeVersionId: row.scope_version_id,
    changeOrderId: row.change_order_id,
    predecessorEventId: row.predecessor_event_id,
    completionFactId: row.completion_fact_id,
    amountCents: row.amount_cents == null ? null : Number(row.amount_cents),
    currency: row.currency,
    providerState: row.evidence.providerState as FinancialOperationState,
    recordedBy: row.recorded_by,
    occurredAt: new Date(row.occurred_at).toISOString(),
  };
}

const FINANCIAL_EVENT_SELECT = `
  id, operation_id, event_kind, status, provider_kind, external_reference,
  expected_version, idempotency_key, task_draft_id, task_id,
  eligibility_decision_id, scope_version_id, change_order_id,
  predecessor_event_id, completion_fact_id, amount_cents, currency,
  evidence, recorded_by, occurred_at`;

function exactBridgeEvidence(
  row: FinancialLifecycleBridgeRow,
  evidence: DurableFakeFinancialCommandEvidence,
  financialEventId: string
): boolean {
  return (
    row.prepared_command_id === evidence.preparedCommandId &&
    row.command_id === evidence.commandId &&
    row.dispatch_attempt_id === evidence.dispatchAttemptId &&
    row.outcome_fact_id === evidence.outcomeFactId &&
    row.fake_operation_event_id === evidence.fakeOperationEventId &&
    row.task_financial_security_event_id === financialEventId &&
    /^[0-9a-f]{64}$/u.test(row.authority_chain_sha256)
  );
}

export class PostgresUniversalV1FinancialLifecycleRepository implements UniversalV1FinancialLifecycleRepository {
  constructor(private readonly database: Database = db) {}

  async recordFinancialEvent(
    command: RecordFinancialEventCommand
  ): Promise<RecordedUniversalV1FinancialEvent> {
    return this.database.serializableTransaction(async (query) => {
      await query(
        `SELECT pg_advisory_xact_lock(hashtext('universal-v1-financial-event'), hashtext($1))`,
        [command.idempotencyKey]
      );
      const replay = await query<FinancialEventRow>(
        `SELECT ${FINANCIAL_EVENT_SELECT}
         FROM task_financial_security_events
         WHERE idempotency_key = $1`,
        [command.idempotencyKey]
      );
      if (replay.rows[0]) {
        const mapped = mapFinancialEventRow(replay.rows[0], false);
        if (!sameRecordedEvent(mapped, command)) {
          throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_IDEMPOTENCY_CONFLICT');
        }
        if (command.providerKind === 'FAKE') {
          if (!command.durableFakeEvidence) {
            throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_BRIDGE_EVIDENCE_REQUIRED');
          }
          const bridge = await query<FinancialLifecycleBridgeRow>(
            `SELECT bridge_id, prepared_command_id, command_id,
                    dispatch_attempt_id, outcome_fact_id,
                    fake_operation_event_id, task_financial_security_event_id,
                    authority_chain_sha256
               FROM public.universal_v1_fake_financial_lifecycle_bridges
              WHERE task_financial_security_event_id=$1`,
            [mapped.id]
          );
          if (
            !bridge.rows[0] ||
            !exactBridgeEvidence(bridge.rows[0], command.durableFakeEvidence, mapped.id)
          ) {
            throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_BRIDGE_IDENTITY_MISMATCH');
          }
        }
        return { ...mapped, idempotencyReplayed: true };
      }

      if (command.providerKind === 'FAKE' && !command.durableFakeEvidence) {
        throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_BRIDGE_EVIDENCE_REQUIRED');
      }

      const inserted = await query<FinancialEventRow>(
        `INSERT INTO task_financial_security_events (
           task_draft_id, task_id, eligibility_decision_id, scope_version_id,
           change_order_id, predecessor_event_id, event_kind, status,
           operation_id, idempotency_key, expected_version, provider_kind,
           external_reference, amount_cents, currency, evidence, recorded_by,
           occurred_at, completion_fact_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13, $14, $15, $16::jsonb, $17, clock_timestamp(), $18
         )
         RETURNING ${FINANCIAL_EVENT_SELECT}`,
        [
          command.taskDraftId,
          command.taskId,
          command.eligibilityDecisionId,
          command.scopeVersionId,
          command.changeOrderId,
          command.predecessorEventId,
          command.eventKind,
          command.status,
          command.operationId,
          command.idempotencyKey,
          command.lifecycleExpectedVersion,
          command.providerKind,
          command.externalReference,
          command.amountCents,
          command.currency,
          JSON.stringify({
            providerState: command.providerState,
            providerOperationVersion: command.providerOperationVersion,
            providerIdempotencyReplayed: command.providerIdempotencyReplayed,
          }),
          command.recordedBy,
          command.completionFactId,
        ]
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('UNIVERSAL_FINANCE_EVENT_INSERT_MISSING');
      if (command.providerKind === 'FAKE') {
        const evidence = command.durableFakeEvidence!;
        const bridge = await query<FinancialLifecycleBridgeRow>(
          `INSERT INTO public.universal_v1_fake_financial_lifecycle_bridges (
             prepared_command_id, command_id, dispatch_attempt_id,
             outcome_fact_id, fake_operation_event_id,
             task_financial_security_event_id
           ) VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING bridge_id, prepared_command_id, command_id,
                     dispatch_attempt_id, outcome_fact_id,
                     fake_operation_event_id, task_financial_security_event_id,
                     authority_chain_sha256`,
          [
            evidence.preparedCommandId,
            evidence.commandId,
            evidence.dispatchAttemptId,
            evidence.outcomeFactId,
            evidence.fakeOperationEventId,
            row.id,
          ]
        );
        if (
          !bridge.rows[0] ||
          !exactBridgeEvidence(bridge.rows[0], evidence, row.id)
        ) {
          throw new Error('UNIVERSAL_FINANCE_LIFECYCLE_BRIDGE_INSERT_MISSING');
        }
      }
      return mapFinancialEventRow(row, false);
    });
  }

  async recordReconciliation(
    command: RecordReconciliationCommand
  ): Promise<RecordedUniversalV1Reconciliation> {
    return this.database.serializableTransaction(async (query) => {
      await query(
        `SELECT pg_advisory_xact_lock(hashtext('universal-v1-reconciliation'), hashtext($1))`,
        [command.idempotencyKey]
      );
      const replay = await query<{
        id: string;
        work_order_id: string;
        reconciliation_version: number;
        reconciliation_state: UniversalV1ReconciliationSnapshot['reconciliationState'];
        mismatch_codes: string[];
        evidence: Record<string, unknown>;
      }>(
        `SELECT id, work_order_id, reconciliation_version, reconciliation_state,
                mismatch_codes, evidence
         FROM task_reconciliation_facts
         WHERE idempotency_key = $1`,
        [command.idempotencyKey]
      );
      if (replay.rows[0]) {
        const row = replay.rows[0];
        if (row.evidence.applicationRequestSha256 !== reconciliationCommandHash(command)) {
          throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_IDEMPOTENCY_CONFLICT');
        }
        return {
          id: row.id,
          operationId: String(row.evidence.operationId),
          providerState: row.evidence.providerState as 'MATCHED' | 'MISMATCH',
          providerOperationVersion: Number(row.evidence.providerOperationVersion),
          reconciliationVersion: row.reconciliation_version,
          idempotencyReplayed: true,
          workOrderId: row.work_order_id,
          reconciliationState: row.reconciliation_state,
          mismatchCodes: row.mismatch_codes,
        };
      }
      return this.insertReconciliation(query, command);
    });
  }

  private async insertReconciliation(
    query: QueryFn,
    command: RecordReconciliationCommand
  ): Promise<RecordedUniversalV1Reconciliation> {
    const snapshot = command.snapshot;
    const inserted = await query<{
      id: string;
      work_order_id: string;
      reconciliation_version: number;
      reconciliation_state: UniversalV1ReconciliationSnapshot['reconciliationState'];
      mismatch_codes: string[];
    }>(
      `INSERT INTO task_reconciliation_facts (
         work_order_id, reconciliation_version, supersedes_fact_id,
         void_event_id, capture_event_id, refund_event_id, reversal_event_id,
         settlement_event_id, funding_event_id, provider_release_event_id,
         payout_event_id, bank_settlement_event_id, void_state, capture_state,
         refund_state, reversal_state, settlement_state, funding_state,
         provider_release_state, payout_state, bank_settlement_state,
         ledger_state, reconciliation_state, mismatch_codes,
         customer_ledger_amount_cents, provider_ledger_amount_cents, currency,
         expected_version, evidence, recorded_by, idempotency_key
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24,
         $25, $26, $27, $28, $29::jsonb, $30, $31
       )
       RETURNING id, work_order_id, reconciliation_version,
                 reconciliation_state, mismatch_codes`,
      [
        snapshot.workOrderId,
        snapshot.reconciliationVersion,
        snapshot.supersedesFactId ?? null,
        snapshot.voidEventId ?? null,
        snapshot.captureEventId ?? null,
        snapshot.refundEventId ?? null,
        snapshot.reversalEventId ?? null,
        snapshot.settlementEventId ?? null,
        snapshot.fundingEventId ?? null,
        snapshot.providerReleaseEventId ?? null,
        snapshot.payoutEventId ?? null,
        snapshot.bankSettlementEventId ?? null,
        snapshot.voidState,
        snapshot.captureState,
        snapshot.refundState,
        snapshot.reversalState,
        snapshot.settlementState,
        snapshot.fundingState,
        snapshot.providerReleaseState,
        snapshot.payoutState,
        snapshot.bankSettlementState,
        snapshot.ledgerState,
        snapshot.reconciliationState,
        [...snapshot.mismatchCodes],
        snapshot.customerLedgerAmountCents,
        snapshot.providerLedgerAmountCents,
        snapshot.currency,
        snapshot.expectedVersion,
        JSON.stringify({
          operationId: command.operationId,
          providerState: command.providerState,
          providerOperationVersion: command.providerOperationVersion,
          providerExternalReference: command.externalReference,
          providerIdempotencyReplayed: command.providerIdempotencyReplayed,
          applicationRequestSha256: reconciliationCommandHash(command),
        }),
        snapshot.recordedBy,
        command.idempotencyKey,
      ]
    );
    const row = inserted.rows[0];
    if (!row) throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_INSERT_MISSING');
    return {
      id: row.id,
      operationId: command.operationId,
      providerState: command.providerState,
      providerOperationVersion: command.providerOperationVersion,
      reconciliationVersion: row.reconciliation_version,
      idempotencyReplayed: false,
      workOrderId: row.work_order_id,
      reconciliationState: row.reconciliation_state,
      mismatchCodes: row.mismatch_codes,
    };
  }
}

export class UniversalV1FinancialApplicationService {
  private readonly providerInvoker: JournaledFinancialProviderInvoker;

  constructor(
    private readonly provider: FinancialProviderPorts,
    private readonly lifecycle: UniversalV1FinancialLifecycleRepository,
    private readonly executionGate: FinancialExecutionGate,
    private readonly configuredProviderKind: FinancialProviderKind,
    commandJournal: FinancialProviderCommandJournal,
    private readonly preparedAuthority: UniversalV1PreparedFinancialCommandAuthority,
    private readonly approvedProviderAuthority?: ApprovedFinancialProviderCommandAuthority,
    foregroundCoordinator?: ForegroundFinancialProviderCommandCoordinator
  ) {
    if (
      configuredProviderKind === 'APPROVED_PROVIDER'
      && approvedProviderAuthority?.runtimeSeal !== APPROVED_PROVIDER_RUNTIME_AUTHORITY_SEAL
    ) {
      throw new Error('UNIVERSAL_FINANCE_APPROVED_PROVIDER_RUNTIME_AUTHORITY_UNAVAILABLE');
    }
    if (foregroundCoordinator && configuredProviderKind !== 'FAKE') {
      throw new Error('UNIVERSAL_FINANCE_APPROVED_PROVIDER_FOREGROUND_COORDINATOR_REFUSED');
    }
    this.providerInvoker = new JournaledFinancialProviderInvoker(
      commandJournal,
      foregroundCoordinator
    );
  }

  private commandActor(recordedBy?: string): FinancialProviderCommandActorEvidence | undefined {
    if (this.configuredProviderKind === 'APPROVED_PROVIDER' && !this.approvedProviderAuthority) {
      return undefined;
    }
    const approvedActor = this.approvedProviderAuthority?.actor;
    if (!recordedBy) return approvedActor;
    if (approvedActor && approvedActor.actorId.toLowerCase() !== recordedBy.toLowerCase()) {
      throw new Error('UNIVERSAL_FINANCE_RECORDED_ACTOR_MISMATCH');
    }
    // A Universal V1 participant is neither a named operator nor a service
    // principal. Migration 20260918 adds the exact PARTICIPANT journal kind.
    return approvedActor
      ? { ...approvedActor, actorId: recordedBy }
      : { actorId: recordedBy, actorKind: 'PARTICIPANT' };
  }

  private async invokeProviderAfterCommittedCommand<TRequest, TResult>(
    operationKind: FinancialOperationKind,
    identity: {
      readonly operationId: string;
      readonly idempotencyKey: string;
      readonly providerExpectedVersion: number;
    },
    exactRequest: TRequest,
    evidence: FinancialProviderCommandSafeEvidence | undefined,
    recordedBy: string | undefined,
    invokeAdapter: (request: TRequest) => Promise<TResult>
  ): Promise<JournaledFinancialProviderInvocation<TResult>> {
    return this.providerInvoker.invokeAfterCommit(
      {
        operationKind,
        operationId: identity.operationId,
        providerKind: this.configuredProviderKind,
        idempotencyKey: identity.idempotencyKey,
        providerExpectedVersion: identity.providerExpectedVersion,
        exactRequest,
        evidence,
        actor: this.commandActor(recordedBy),
        release: this.approvedProviderAuthority?.release,
      },
      invokeAdapter
    );
  }

  async executeFinancialEvent(
    command: ExecuteUniversalV1FinancialEventCommand
  ): Promise<RecordedUniversalV1FinancialEvent> {
    this.executionGate.assertAuthorized();
    assertEventCommand(command, this.configuredProviderKind);

    const providerRequestSha256 = canonicalFinancialProviderRequestSha256(
      exactFinancialProviderRequest(command)
    );
    const prepared = await this.preparedAuthority.prepare(
      preparedAuthorityInput(command, providerRequestSha256)
    );
    if (prepared.idempotencyReplayed && !this.providerInvoker.hasForegroundCoordinator()) {
      throw new PreparedFinancialCommandAuthorityError(
        'REPLAY_FOREGROUND_COORDINATOR_REQUIRED'
      );
    }
    const execution = await this.executeProviderOperation(command, prepared);
    const result = execution.result;
    assertProviderResult(
      result,
      command,
      command.operationKind,
      this.configuredProviderKind
    );
    const eventKind = EVENT_KIND_BY_OPERATION[command.operationKind];
    const taskId = command.taskId ?? null;
    const eligibilityDecisionId = command.eligibilityDecisionId ?? null;
    const scopeVersionId = command.scopeVersionId ?? null;
    const amountCents =
      command.operationKind === 'PREPARE_PAYMENT_METHOD' ? null : command.amountCents;
    const currency =
      command.operationKind === 'PREPARE_PAYMENT_METHOD'
        ? null
        : canonicalCurrency(command.currency);

    return this.lifecycle.recordFinancialEvent({
      operationId: command.operationId,
      eventKind,
      status: lifecycleStatus(result.state),
      providerKind: result.providerKind,
      externalReference: result.externalReference,
      providerOperationVersion: result.version,
      lifecycleExpectedVersion: command.lifecycleExpectedVersion,
      idempotencyKey: command.idempotencyKey,
      taskDraftId: command.taskDraftId,
      taskId,
      eligibilityDecisionId,
      scopeVersionId,
      changeOrderId: command.operationKind === 'ADJUST' ? (command.changeOrderId ?? null) : null,
      predecessorEventId:
        command.operationKind === 'PREPARE_PAYMENT_METHOD' ? null : command.predecessorEventId,
      completionFactId:
        command.operationKind === 'CAPTURE' ? (command.completionFactId ?? null) : null,
      amountCents,
      currency,
      providerState: result.state,
      providerIdempotencyReplayed: result.idempotencyReplayed,
      ...(execution.evidence === undefined
        ? {}
        : { durableFakeEvidence: execution.evidence }),
      recordedBy: command.recordedBy,
    });
  }

  async onboardProvider(input: {
    readonly providerKind: FinancialProviderKind;
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly providerExpectedVersion: number;
    readonly providerId: string;
    readonly scenario?: FakeFinancialScenario;
    readonly recordedBy?: string;
  }): Promise<FinancialOperationResult> {
    this.executionGate.assertAuthorized();
    assertProviderSelection(input.providerKind, this.configuredProviderKind);
    const command = {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: input.providerExpectedVersion,
      ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
      providerId: input.providerId,
    };
    const { result } = await this.invokeProviderAfterCommittedCommand(
      'ONBOARD_PROVIDER',
      input,
      command,
      undefined,
      input.recordedBy,
      (exactRequest) => this.provider.onboardProvider(exactRequest)
    );
    assertProviderResult(
      result,
      {
        operationId: input.operationId,
        providerExpectedVersion: input.providerExpectedVersion,
      },
      'ONBOARD_PROVIDER',
      this.configuredProviderKind
    );
    return result;
  }

  async refreshProviderAccountState(input: {
    readonly providerKind: FinancialProviderKind;
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly providerExpectedVersion: number;
    readonly providerId: string;
    readonly providerAccountReference: string;
    readonly scenario?: FakeFinancialScenario;
    readonly recordedBy?: string;
  }): Promise<ProviderAccountStateResult> {
    this.executionGate.assertAuthorized();
    assertProviderSelection(input.providerKind, this.configuredProviderKind);
    const command = {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: input.providerExpectedVersion,
      ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
      providerId: input.providerId,
      providerAccountReference: input.providerAccountReference,
    };
    const { result } = await this.invokeProviderAfterCommittedCommand(
      'REFRESH_PROVIDER_ACCOUNT_STATE',
      input,
      command,
      undefined,
      input.recordedBy,
      (exactRequest) => this.provider.refreshProviderAccountState(exactRequest)
    );
    assertProviderResult(
      result,
      {
        operationId: input.operationId,
        providerExpectedVersion: input.providerExpectedVersion,
      },
      'REFRESH_PROVIDER_ACCOUNT_STATE',
      this.configuredProviderKind
    );
    assertProviderAccountResult(result, input.providerId);
    return result;
  }

  async ingestWebhook(input: {
    readonly providerKind: FinancialProviderKind;
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly providerExpectedVersion: number;
    readonly providerEventReference: string;
    readonly authenticated: boolean;
    readonly scenario?: FakeFinancialScenario;
    readonly recordedBy?: string;
  }): Promise<FinancialOperationResult> {
    this.executionGate.assertAuthorized();
    assertProviderSelection(input.providerKind, this.configuredProviderKind);
    const command = {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: input.providerExpectedVersion,
      ...(input.scenario === undefined ? {} : { scenario: input.scenario }),
      providerEventReference: input.providerEventReference,
      authenticated: input.authenticated,
    };
    const { result } = await this.invokeProviderAfterCommittedCommand(
      'INGEST_WEBHOOK',
      input,
      command,
      undefined,
      input.recordedBy,
      (exactRequest) => this.provider.ingestWebhook(exactRequest)
    );
    assertProviderResult(
      result,
      {
        operationId: input.operationId,
        providerExpectedVersion: input.providerExpectedVersion,
      },
      'INGEST_WEBHOOK',
      this.configuredProviderKind
    );
    return result;
  }

  async reconcile(
    command: ExecuteUniversalV1ReconciliationCommand
  ): Promise<RecordedUniversalV1Reconciliation> {
    this.executionGate.assertAuthorized();
    assertProviderSelection(command.providerKind, this.configuredProviderKind);
    assertUuid(command.operationId, 'UNIVERSAL_FINANCE_OPERATION_ID_INVALID');
    assertUuid(command.relatedOperationId, 'UNIVERSAL_FINANCE_RELATED_OPERATION_ID_INVALID');
    assertIdempotencyKey(command.idempotencyKey);
    assertVersion(command.providerExpectedVersion, 'UNIVERSAL_FINANCE_PROVIDER_VERSION_INVALID');
    assertReconciliationSnapshot(command.snapshot);

    const providerCommand = {
      operationId: command.operationId,
      idempotencyKey: command.idempotencyKey,
      expectedVersion: command.providerExpectedVersion,
      relatedOperationId: command.relatedOperationId,
      ...(command.scenario === undefined ? {} : { scenario: command.scenario }),
    };
    const { result } = await this.invokeProviderAfterCommittedCommand(
      'RECONCILE',
      command,
      providerCommand,
      {
        workOrderId: command.snapshot.workOrderId,
        relatedOperationId: command.relatedOperationId,
      },
      command.snapshot.recordedBy,
      (exactRequest) => this.provider.reconcile(exactRequest)
    );
    assertProviderResult(result, command, 'RECONCILE', this.configuredProviderKind);
    if (result.state !== 'MATCHED' && result.state !== 'MISMATCH') {
      throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_RESULT_INVALID');
    }
    const stateMatches =
      (result.state === 'MATCHED' &&
        ['MATCHED', 'CLOSED'].includes(command.snapshot.reconciliationState) &&
        command.snapshot.ledgerState === 'MATCHED' &&
        command.snapshot.mismatchCodes.length === 0) ||
      (result.state === 'MISMATCH' &&
        command.snapshot.reconciliationState === 'MISMATCH' &&
        command.snapshot.mismatchCodes.length > 0);
    if (!stateMatches) {
      throw new Error('UNIVERSAL_FINANCE_RECONCILIATION_SNAPSHOT_MISMATCH');
    }

    return this.lifecycle.recordReconciliation({
      operationId: command.operationId,
      idempotencyKey: command.idempotencyKey,
      providerState: result.state,
      providerOperationVersion: result.version,
      providerIdempotencyReplayed: result.idempotencyReplayed,
      externalReference: result.externalReference,
      snapshot: command.snapshot,
    });
  }

  private executeProviderOperation(
    command: ExecuteUniversalV1FinancialEventCommand,
    prepared: PreparedUniversalV1FinancialCommandReceipt
  ): Promise<JournaledFinancialProviderInvocation<FinancialOperationResult>> {
    const base = {
      operationId: command.operationId,
      idempotencyKey: command.idempotencyKey,
      expectedVersion: command.providerExpectedVersion,
      ...(command.scenario === undefined ? {} : { scenario: command.scenario }),
    };
    const evidence: FinancialProviderCommandSafeEvidence =
      command.operationKind === 'PREPARE_PAYMENT_METHOD'
        ? {
            preparedFinancialCommandId: prepared.preparedCommandId,
            preparedAuthoritySha256: prepared.authorityContextSha256,
            taskDraftId: command.taskDraftId,
            taskId: command.taskId,
            workOrderId: prepared.workOrderId ?? undefined,
          }
        : {
            preparedFinancialCommandId: prepared.preparedCommandId,
            preparedAuthoritySha256: prepared.authorityContextSha256,
            taskDraftId: command.taskDraftId,
            taskId: command.taskId,
            workOrderId: prepared.workOrderId ?? undefined,
            relatedOperationId: command.relatedOperationId,
            amountCents: command.amountCents,
            currency: canonicalCurrency(command.currency),
          };
    const invoke = <TRequest>(
      exactRequest: TRequest,
      invokeAdapter: (request: TRequest) => Promise<FinancialOperationResult>
    ) =>
      this.invokeProviderAfterCommittedCommand(
        command.operationKind,
        command,
        exactRequest,
        evidence,
        command.recordedBy,
        invokeAdapter
      );
    if (command.operationKind === 'PREPARE_PAYMENT_METHOD') {
      return invoke(
        { ...base, customerId: command.customerId },
        (exactRequest) => this.provider.preparePaymentMethod(exactRequest)
      );
    }
    const money = {
      ...base,
      amountCents: command.amountCents,
      currency: canonicalCurrency(command.currency).toLowerCase(),
      relatedOperationId: command.relatedOperationId,
    };
    switch (command.operationKind) {
      case 'AUTHORIZE':
        return invoke(
          {
            ...money,
            paymentMethodReference: command.paymentMethodReference!,
          },
          (exactRequest) => this.provider.authorize(exactRequest)
        );
      case 'SECURE':
        return invoke(
          {
            ...money,
            authorizationOperationId: command.authorizationOperationId!,
          },
          (exactRequest) => this.provider.secure(exactRequest)
        );
      case 'VOID':
        return invoke(money, (exactRequest) => this.provider.void(exactRequest));
      case 'ADJUST':
        return invoke(
          {
            ...money,
            scopeVersionId: command.scopeVersionId,
            changeOrderId: command.changeOrderId!,
          },
          (exactRequest) => this.provider.adjust(exactRequest)
        );
      case 'CAPTURE':
        return invoke(money, (exactRequest) => this.provider.capture(exactRequest));
      case 'REFUND':
        return invoke(
          {
            ...money,
            originalAmountCents: command.originalAmountCents!,
          },
          (exactRequest) => this.provider.refund(exactRequest)
        );
      case 'REVERSAL':
        return invoke(money, (exactRequest) => this.provider.reverse(exactRequest));
      case 'SETTLE':
        return invoke(money, (exactRequest) => this.provider.settle(exactRequest));
      case 'FUND':
        return invoke(money, (exactRequest) => this.provider.fund(exactRequest));
      case 'PROVIDER_RELEASE':
        return invoke(money, (exactRequest) => this.provider.releaseProvider(exactRequest));
      case 'PAYOUT':
        return invoke(
          {
            ...money,
            providerAccountReference: command.providerAccountReference!,
          },
          (exactRequest) => this.provider.payout(exactRequest)
        );
      case 'OBSERVE_BANK_SETTLEMENT':
        return invoke(money, (exactRequest) =>
          this.provider.observeBankSettlement(exactRequest)
        );
    }
  }
}

/**
 * The only runtime-selectable application service today. It fixes the generic
 * application layer to the deterministic fake adapter and the nonproduction
 * authorization gate; an approved-provider adapter still requires a separate
 * reviewed factory, capability policy, and certification.
 */
export class UniversalV1FakeFinancialApplicationService extends UniversalV1FinancialApplicationService {
  constructor(
    provider: FinancialProviderPorts,
    lifecycle: UniversalV1FinancialLifecycleRepository,
    executionGate: FinancialExecutionGate,
    commandJournal: FinancialProviderCommandJournal,
    preparedAuthority: UniversalV1PreparedFinancialCommandAuthority,
    foregroundCoordinator?: DurableFakeFinancialProviderCommandCoordinator
  ) {
    super(
      provider,
      lifecycle,
      executionGate,
      'FAKE',
      commandJournal,
      preparedAuthority,
      undefined,
      foregroundCoordinator
    );
  }
}

class RuntimeFakeFinancialExecutionGate implements FakeFinancialExecutionGate {
  constructor(private readonly options: NonproductionFinancialAuthorizationOptions) {}

  assertAuthorized(): void {
    assertNonproductionFakeFinanceAuthorized(this.options);
  }
}

export function createUniversalV1FakeFinancialApplicationService(
  database: Database = db,
  environment: NodeJS.ProcessEnv = process.env,
  release: ReleaseManifestEvidence = readReleaseManifest(),
  identity: BuildIdentity = buildIdentity
): UniversalV1FakeFinancialApplicationService {
  const component =
    environment.SERVICE_ROLE?.trim().toLowerCase() === 'worker' ? 'worker' : 'backend';
  const authorization = { env: environment, release, identity, component } as const;
  const gate = new RuntimeFakeFinancialExecutionGate(authorization);
  gate.assertAuthorized();
  const fakeEvents = new PostgresFakeFinancialOperationRepository(database);
  const commandRecovery = new PostgresFinancialProviderCommandRecoveryRepository(database);
  const foregroundCoordinator = new DurableFakeFinancialProviderCommandCoordinator(
    commandRecovery,
    fakeEvents,
    {
      leaseOwnerId: deterministicUuid({
        type: 'fake-foreground-financial-command-coordinator',
        component,
        revision: identity.revision,
        artifactDigest: identity.artifact_digest,
        releaseDigest: release.digest,
      }),
    }
  );
  return new UniversalV1FakeFinancialApplicationService(
    new FakeFinancialProvider(fakeEvents),
    new PostgresUniversalV1FinancialLifecycleRepository(database),
    gate,
    new PostgresFinancialProviderCommandJournal(database),
    new PostgresUniversalV1PreparedFinancialCommandAuthority(database),
    foregroundCoordinator
  );
}

/**
 * Compatibility boundary for the former caller-owned transaction factory.
 *
 * PREPARED and REQUESTED must commit before provider I/O. A service bound to an
 * outer transaction cannot prove that ordering, cannot see independently
 * committed predecessor facts it just wrote, and can deadlock when its outer
 * transaction already owns canonical lifecycle row locks. The affected Work
 * Order, change-order, and fulfillment orchestrators therefore fail closed
 * here until their required three-phase flow is implemented. The independent
 * `createUniversalV1FakeFinancialApplicationService` factory remains the only
 * executable financial application factory.
 */
export function authorizeUniversalV1FakeFinancialTransaction(
  _environment?: NodeJS.ProcessEnv,
  _release?: ReleaseManifestEvidence,
  _identity?: BuildIdentity,
  _committedCommandDatabase?: Database
): (database: Database) => UniversalV1FakeFinancialApplicationService {
  throw new Error('UNIVERSAL_FINANCE_CALLER_OWNED_TRANSACTION_PREPARED_AUTHORITY_REFUSED');
}
