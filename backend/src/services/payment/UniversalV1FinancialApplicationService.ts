import { createHash } from 'node:crypto';

import { buildIdentity, type BuildIdentity } from '../../buildIdentity.js';
import { db, type Database, type QueryFn } from '../../db.js';
import { readReleaseManifest, type ReleaseManifestEvidence } from '../../releaseManifest.js';
import type { FakeFinancialScenario } from './FakeFinancialProvider.js';
import { resolveFinancialProvider } from './FinancialProviderResolver.js';
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
  readonly providerKind: 'FAKE';
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
  readonly recordedBy: string;
  readonly occurredAt: string;
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

export interface FakeFinancialExecutionGate {
  assertAuthorized(): void;
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

function assertFakeProvider(providerKind: FinancialProviderKind): void {
  if (providerKind !== 'FAKE') {
    throw new Error('UNIVERSAL_FINANCE_REAL_PROVIDER_REFUSED');
  }
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
    default:
      return 'SUCCEEDED';
  }
}

function assertFakeResult(
  result: FinancialOperationResult,
  command: Pick<ApplicationOperationBase, 'operationId' | 'providerExpectedVersion'>,
  operationKind: FinancialOperationKind
): void {
  if (
    result.providerKind !== 'FAKE' ||
    result.operationId !== command.operationId ||
    result.operationKind !== operationKind ||
    result.version !== command.providerExpectedVersion + 1
  ) {
    throw new Error('UNIVERSAL_FINANCE_PROVIDER_RESULT_IDENTITY_MISMATCH');
  }
}

function assertEventCommand(command: ExecuteUniversalV1FinancialEventCommand): void {
  assertFakeProvider(command.providerKind);
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
      occurredAt: existing.occurredAt,
    }) ===
    commandHash({
      operationId: command.operationId,
      eventKind: command.eventKind,
      status: command.status,
      providerKind: 'FAKE',
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
      occurredAt: new Date(command.occurredAt).toISOString(),
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
    predecessor.providerKind !== 'FAKE' ||
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
      providerKind: 'FAKE',
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
      occurredAt: new Date(command.occurredAt).toISOString(),
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
  provider_kind: 'FAKE';
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
        return { ...mapped, idempotencyReplayed: true };
      }

      const inserted = await query<FinancialEventRow>(
        `INSERT INTO task_financial_security_events (
           task_draft_id, task_id, eligibility_decision_id, scope_version_id,
           change_order_id, predecessor_event_id, event_kind, status,
           operation_id, idempotency_key, expected_version, provider_kind,
           external_reference, amount_cents, currency, evidence, recorded_by,
           occurred_at, completion_fact_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'FAKE',
           $12, $13, $14, $15::jsonb, $16, $17::timestamptz, $18
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
          command.externalReference,
          command.amountCents,
          command.currency,
          JSON.stringify({
            providerState: command.providerState,
            providerOperationVersion: command.providerOperationVersion,
            providerIdempotencyReplayed: command.providerIdempotencyReplayed,
          }),
          command.recordedBy,
          command.occurredAt,
          command.completionFactId,
        ]
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('UNIVERSAL_FINANCE_EVENT_INSERT_MISSING');
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

export class UniversalV1FakeFinancialApplicationService {
  constructor(
    private readonly provider: FinancialProviderPorts,
    private readonly lifecycle: UniversalV1FinancialLifecycleRepository,
    private readonly executionGate: FakeFinancialExecutionGate
  ) {}

  async executeFinancialEvent(
    command: ExecuteUniversalV1FinancialEventCommand
  ): Promise<RecordedUniversalV1FinancialEvent> {
    this.executionGate.assertAuthorized();
    assertEventCommand(command);

    const result = await this.executeProviderOperation(command);
    assertFakeResult(result, command, command.operationKind);
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
      recordedBy: command.recordedBy,
      occurredAt: command.occurredAt,
    });
  }

  async onboardProvider(input: {
    readonly providerKind: FinancialProviderKind;
    readonly operationId: string;
    readonly idempotencyKey: string;
    readonly providerExpectedVersion: number;
    readonly providerId: string;
    readonly scenario?: FakeFinancialScenario;
  }): Promise<FinancialOperationResult> {
    this.executionGate.assertAuthorized();
    assertFakeProvider(input.providerKind);
    const command = {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: input.providerExpectedVersion,
      scenario: input.scenario,
      providerId: input.providerId,
    };
    const result = await this.provider.onboardProvider(command);
    assertFakeResult(
      result,
      {
        operationId: input.operationId,
        providerExpectedVersion: input.providerExpectedVersion,
      },
      'ONBOARD_PROVIDER'
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
  }): Promise<ProviderAccountStateResult> {
    this.executionGate.assertAuthorized();
    assertFakeProvider(input.providerKind);
    const command = {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: input.providerExpectedVersion,
      scenario: input.scenario,
      providerId: input.providerId,
      providerAccountReference: input.providerAccountReference,
    };
    const result = await this.provider.refreshProviderAccountState(command);
    assertFakeResult(
      result,
      {
        operationId: input.operationId,
        providerExpectedVersion: input.providerExpectedVersion,
      },
      'REFRESH_PROVIDER_ACCOUNT_STATE'
    );
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
  }): Promise<FinancialOperationResult> {
    this.executionGate.assertAuthorized();
    assertFakeProvider(input.providerKind);
    const command = {
      operationId: input.operationId,
      idempotencyKey: input.idempotencyKey,
      expectedVersion: input.providerExpectedVersion,
      scenario: input.scenario,
      providerEventReference: input.providerEventReference,
      authenticated: input.authenticated,
    };
    const result = await this.provider.ingestWebhook(command);
    assertFakeResult(
      result,
      {
        operationId: input.operationId,
        providerExpectedVersion: input.providerExpectedVersion,
      },
      'INGEST_WEBHOOK'
    );
    return result;
  }

  async reconcile(
    command: ExecuteUniversalV1ReconciliationCommand
  ): Promise<RecordedUniversalV1Reconciliation> {
    this.executionGate.assertAuthorized();
    assertFakeProvider(command.providerKind);
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
      scenario: command.scenario,
    };
    const result = await this.provider.reconcile(providerCommand);
    assertFakeResult(result, command, 'RECONCILE');
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
    command: ExecuteUniversalV1FinancialEventCommand
  ): Promise<FinancialOperationResult> {
    const base = {
      operationId: command.operationId,
      idempotencyKey: command.idempotencyKey,
      expectedVersion: command.providerExpectedVersion,
      scenario: command.scenario,
    };
    if (command.operationKind === 'PREPARE_PAYMENT_METHOD') {
      return this.provider.preparePaymentMethod({ ...base, customerId: command.customerId });
    }
    const money = {
      ...base,
      amountCents: command.amountCents,
      currency: command.currency,
      relatedOperationId: command.relatedOperationId,
    };
    switch (command.operationKind) {
      case 'AUTHORIZE':
        if (!command.paymentMethodReference?.trim()) {
          throw new Error('UNIVERSAL_FINANCE_PAYMENT_METHOD_REFERENCE_REQUIRED');
        }
        return this.provider.authorize({
          ...money,
          paymentMethodReference: command.paymentMethodReference,
        });
      case 'SECURE':
        if (!command.authorizationOperationId?.trim()) {
          throw new Error('UNIVERSAL_FINANCE_AUTHORIZATION_OPERATION_REQUIRED');
        }
        return this.provider.secure({
          ...money,
          authorizationOperationId: command.authorizationOperationId,
        });
      case 'VOID':
        return this.provider.void(money);
      case 'ADJUST':
        return this.provider.adjust({
          ...money,
          scopeVersionId: command.scopeVersionId,
          changeOrderId: command.changeOrderId!,
        });
      case 'CAPTURE':
        return this.provider.capture(money);
      case 'REFUND':
        if (!Number.isSafeInteger(command.originalAmountCents)) {
          throw new Error('UNIVERSAL_FINANCE_ORIGINAL_AMOUNT_REQUIRED');
        }
        return this.provider.refund({
          ...money,
          originalAmountCents: command.originalAmountCents!,
        });
      case 'REVERSAL':
        return this.provider.reverse(money);
      case 'SETTLE':
        return this.provider.settle(money);
      case 'FUND':
        return this.provider.fund(money);
      case 'PROVIDER_RELEASE':
        return this.provider.releaseProvider(money);
      case 'PAYOUT':
        if (!command.providerAccountReference?.trim()) {
          throw new Error('UNIVERSAL_FINANCE_PROVIDER_ACCOUNT_REFERENCE_REQUIRED');
        }
        return this.provider.payout({
          ...money,
          providerAccountReference: command.providerAccountReference,
        });
      case 'OBSERVE_BANK_SETTLEMENT':
        return this.provider.observeBankSettlement(money);
    }
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
  return new UniversalV1FakeFinancialApplicationService(
    resolveFinancialProvider('fake', database, environment, release, identity),
    new PostgresUniversalV1FinancialLifecycleRepository(database),
    gate
  );
}

/**
 * Perform the nonproduction capability check before a caller opens its outer
 * transaction, then return a constructor that binds every fake-provider and
 * lifecycle write to that caller-owned Database adapter.
 */
export function authorizeUniversalV1FakeFinancialTransaction(
  environment: NodeJS.ProcessEnv = process.env,
  release: ReleaseManifestEvidence = readReleaseManifest(),
  identity: BuildIdentity = buildIdentity
): (database: Database) => UniversalV1FakeFinancialApplicationService {
  const component =
    environment.SERVICE_ROLE?.trim().toLowerCase() === 'worker' ? 'worker' : 'backend';
  const authorization = { env: environment, release, identity, component } as const;
  const gate = new RuntimeFakeFinancialExecutionGate(authorization);
  gate.assertAuthorized();
  return (database: Database) =>
    new UniversalV1FakeFinancialApplicationService(
      resolveFinancialProvider('fake', database, environment, release, identity),
      new PostgresUniversalV1FinancialLifecycleRepository(database),
      gate
    );
}
