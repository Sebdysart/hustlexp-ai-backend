import { createHash, randomUUID } from 'node:crypto';

import type {
  FinancialOperationResult,
  FinancialOperationKind,
  FinancialOperationState,
} from '../services/payment/FinancialProviderPorts.js';
import {
  assertNonproductionFakeFinanceAuthorized,
  type NonproductionFinancialAuthorizationOptions,
} from '../services/payment/NonproductionFinancialAuthorization.js';
import {
  resultFromExactStoredFakeFinancialOperation,
  type FakeFinancialOperationRepository,
  type StoredFakeFinancialOperation,
} from '../services/payment/FakeFinancialProvider.js';
import { canonicalFinancialProviderRequestSha256 } from '../services/payment/FinancialProviderCommandJournal.js';
import type {
  FinancialProviderCommandDispatchAttempt,
  FinancialProviderCommandRecoveryClaim,
  FinancialProviderCommandRecoveryRepository,
  RecordFinancialProviderCommandOutcomeInput,
} from '../services/payment/FinancialProviderCommandRecovery.js';

const NONPRODUCTION_ENVIRONMENTS = new Set(['local', 'preview', 'staging']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,128}$/u;
const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{7,127}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_.:-]{2,63}$/u;
const NONTERMINAL_STATES = new Set<FinancialOperationState>(['PENDING', 'RETRYABLE_FAILURE']);
const NO_EFFECT_STATES = new Set<FinancialOperationState>([
  'DECLINED',
  'FAILED',
  'REJECTED',
  'MATCHED',
  'MISMATCH',
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

export type FakeFinancialCommandRecoveryExecutionResult =
  | {
      readonly kind: 'OUTCOME_OBSERVED';
      readonly providerResult: FinancialOperationResult;
    }
  | {
      readonly kind: 'OUTCOME_UNKNOWN';
      readonly failureCode: string;
      readonly recoveryDelaySeconds: number;
    }
  | {
      readonly kind: 'FAILED';
      readonly failureCode: string;
      readonly retryable: false;
      /** A FAILED fact is legal only when provider effect is definitively absent. */
      readonly confirmedNoEffect: true;
    }
  | {
      readonly kind: 'FAILED';
      readonly failureCode: string;
      readonly retryable: true;
      readonly recoveryDelaySeconds: number;
      /** A retry is legal only when provider effect is definitively absent. */
      readonly confirmedNoEffect: true;
    };

/**
 * Deliberately fake-only. No approved-provider executor, resolver, or factory is
 * exposed by this worker foundation.
 */
export interface FakeFinancialCommandRecoveryExecutor {
  readonly providerKind: 'FAKE';
  /** Executor guarantees transport cancellation and promise settlement on abort. */
  readonly abortContract: 'ABORT_SIGNAL_SETTLES';
  reconcile(
    claim: FinancialProviderCommandRecoveryClaim,
    attempt: FinancialProviderCommandDispatchAttempt,
    signal: AbortSignal
  ): Promise<FakeFinancialCommandRecoveryExecutionResult>;
}

export interface NonproductionFakeFinancialCommandRecoveryWorkerOptions {
  readonly environment: 'local' | 'preview' | 'staging';
  readonly leaseOwnerId: string;
  readonly batchLimit?: number;
  readonly leaseDurationSeconds?: number;
  readonly thrownOutcomeRecoveryDelaySeconds?: number;
  readonly nonterminalObservationRecoveryDelaySeconds?: number;
  readonly reconciliationDeadlineMs?: number;
}

export interface FinancialProviderCommandRecoveryRunResult {
  readonly claimed: number;
  readonly reconciled: number;
  readonly outcomeObserved: number;
  readonly outcomeUnknown: number;
  readonly failed: number;
  readonly persistenceErrors: number;
}

export interface LegacyFakeFinancialExpiryCompensationPort {
  runOnce(limit?: number): Promise<unknown>;
}

export interface ForegroundFinancialProviderCommandDispatchPort {
  /**
   * Must establish fresh lifecycle reservation/authorization and bind the
   * exact request identity before recording DISPATCH_ATTEMPTED and entering a
   * provider. A PREPARED fact alone grants no dispatch authority. Not
   * implemented here.
   */
  dispatchPreparedCommand(commandId: string): Promise<FinancialProviderCommandDispatchAttempt>;
}

export interface FinancialProviderCommandOutcomeMaterializationPort {
  /**
   * Must separately authorize and apply durable evidence to the authoritative
   * lifecycle. Neither PREPARED nor an outcome fact grants that write
   * authority. Not implemented here.
   */
  materializeCommandOutcome(commandId: string, outcomeFactId: string): Promise<void>;
}

export const FINANCIAL_PROVIDER_COMMAND_RECOVERY_INTEGRATION_BLOCKERS = Object.freeze({
  foregroundPreparedCommandDispatch: 'WIRED_FAKE_NONPRODUCTION',
  lifecycleOutcomeMaterialization: 'BLOCKED_ACTOR_AUTHORITY_REQUIRED',
  abortableProviderReconciliation: 'WIRED_FAKE_EVENT_READ_ONLY',
} as const);

type FakeFinanceAuthorizer = (options: NonproductionFinancialAuthorizationOptions) => unknown;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validDate(value: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_TIMESTAMP_INVALID');
  }
  return milliseconds;
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_IDENTIFIER_INVALID');
  }
}

function assertSha256(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value) || /^0{64}$/u.test(value)) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_IDENTITY_INVALID');
  }
}

function assertReference(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 512 ||
    value.trim() !== value ||
    containsControlCharacter(value)
  ) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_EVENT_METADATA_INVALID');
  }
}

function exactOperationFields(
  operationKind: FinancialOperationKind,
  event: StoredFakeFinancialOperation
): Readonly<Record<string, unknown>> {
  const metadata = event.metadata;
  switch (operationKind) {
    case 'PREPARE_PAYMENT_METHOD':
      assertReference(metadata.customerId);
      return { customerId: metadata.customerId };
    case 'AUTHORIZE':
      assertReference(metadata.paymentMethodReference);
      return { paymentMethodReference: metadata.paymentMethodReference };
    case 'SECURE':
      assertReference(metadata.authorizationOperationId);
      return { authorizationOperationId: metadata.authorizationOperationId };
    case 'ADJUST':
      assertReference(metadata.scopeVersionId);
      assertReference(metadata.changeOrderId);
      return {
        scopeVersionId: metadata.scopeVersionId,
        changeOrderId: metadata.changeOrderId,
      };
    case 'REFUND':
      if (
        !Number.isSafeInteger(metadata.originalAmountCents) ||
        Number(metadata.originalAmountCents) <= 0 ||
        event.amountCents === null ||
        Number(metadata.originalAmountCents) < event.amountCents
      ) {
        throw new Error('FAKE_FINANCIAL_RECOVERY_EVENT_METADATA_INVALID');
      }
      return { originalAmountCents: metadata.originalAmountCents };
    case 'ONBOARD_PROVIDER':
      assertReference(metadata.providerId);
      return { providerId: metadata.providerId };
    case 'REFRESH_PROVIDER_ACCOUNT_STATE':
      assertReference(metadata.providerId);
      assertReference(metadata.providerAccountReference);
      return {
        providerId: metadata.providerId,
        providerAccountReference: metadata.providerAccountReference,
      };
    case 'PAYOUT':
      assertReference(metadata.providerAccountReference);
      return { providerAccountReference: metadata.providerAccountReference };
    case 'INGEST_WEBHOOK':
      assertReference(metadata.providerEventReference);
      if (typeof metadata.authenticated !== 'boolean') {
        throw new Error('FAKE_FINANCIAL_RECOVERY_EVENT_METADATA_INVALID');
      }
      return {
        providerEventReference: metadata.providerEventReference,
        authenticated: metadata.authenticated,
      };
    case 'RECONCILE':
      assertSha256(metadata.reconciliationSnapshotSha256);
      return { reconciliationSnapshotSha256: metadata.reconciliationSnapshotSha256 };
    default:
      return {};
  }
}

function assertCommandIdentity(command: FinancialProviderCommandRecoveryClaim['command']): void {
  const evidenceIds = [
    command.preparedFinancialCommandId,
    command.taskDraftId,
    command.taskId,
    command.workOrderId,
    command.relatedOperationId,
  ];
  if (evidenceIds.some((identifier) => identifier !== null && !UUID.test(identifier))) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_COMMAND_IDENTITY_INVALID');
  }
  if (
    (command.preparedFinancialCommandId === null) !== (command.preparedAuthoritySha256 === null) ||
    (command.preparedAuthoritySha256 !== null && !SHA256.test(command.preparedAuthoritySha256)) ||
    (command.amountCents === null) !== (command.currency === null) ||
    (command.amountCents !== null &&
      (!Number.isSafeInteger(command.amountCents) || command.amountCents < 0)) ||
    (command.currency !== null && !/^[A-Z]{3}$/u.test(command.currency))
  ) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_COMMAND_IDENTITY_INVALID');
  }

  const actorAbsent = command.recordedActorId === null && command.recordedActorKind === null;
  const actor = actorAbsent
    ? null
    : {
        actorId: command.recordedActorId,
        actorKind: command.recordedActorKind,
      };
  if (
    !actorAbsent &&
    (!actor ||
      typeof actor.actorId !== 'string' ||
      !UUID.test(actor.actorId) ||
      !['NAMED_OPERATOR', 'SERVICE_PRINCIPAL', 'PARTICIPANT'].includes(actor.actorKind ?? ''))
  ) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_COMMAND_IDENTITY_INVALID');
  }

  const releaseValues = [
    command.releaseManifestDigest,
    command.releaseId,
    command.releaseRevision,
    command.releaseEnvironment,
    command.releaseAuthenticationStatus,
  ];
  const releaseAbsent = releaseValues.every((value) => value === null);
  const releaseComplete = releaseValues.every((value) => value !== null);
  const release = releaseAbsent
    ? null
    : {
        manifestDigest: command.releaseManifestDigest,
        releaseId: command.releaseId,
        revision: command.releaseRevision,
        environment: command.releaseEnvironment,
        authenticationStatus: command.releaseAuthenticationStatus,
      };
  if (
    (!releaseAbsent && !releaseComplete) ||
    (release !== null &&
      (typeof release.manifestDigest !== 'string' ||
        !RELEASE_DIGEST.test(release.manifestDigest) ||
        release.manifestDigest === `sha256:${'0'.repeat(64)}` ||
        typeof release.releaseId !== 'string' ||
        !RELEASE_ID.test(release.releaseId) ||
        typeof release.revision !== 'string' ||
        !REVISION.test(release.revision) ||
        /^0{40}$/u.test(release.revision) ||
        !['local', 'preview', 'staging', 'production'].includes(release.environment ?? '') ||
        !['VERIFIED', 'MISSING', 'INVALID', 'UNTRUSTED_KEY'].includes(
          release.authenticationStatus ?? ''
        )))
  ) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_COMMAND_IDENTITY_INVALID');
  }

  const identity = {
    schemaVersion: 1,
    operationKind: command.operationKind,
    operationId: command.operationId.toLowerCase(),
    providerKind: command.providerKind,
    idempotencyKey: command.idempotencyKey,
    providerExpectedVersion: command.providerExpectedVersion,
    requestSha256: command.requestSha256,
    evidence: {
      preparedFinancialCommandId: command.preparedFinancialCommandId,
      preparedAuthoritySha256: command.preparedAuthoritySha256,
      taskDraftId: command.taskDraftId,
      taskId: command.taskId,
      workOrderId: command.workOrderId,
      relatedOperationId: command.relatedOperationId,
      amountCents: command.amountCents,
      currency: command.currency,
    },
    actor:
      actor === null
        ? null
        : { actorId: actor.actorId!.toLowerCase(), actorKind: actor.actorKind! },
    release,
  };
  if (sha256(JSON.stringify(identity)) !== command.commandIdentitySha256) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_COMMAND_IDENTITY_INVALID');
  }
}

function assertClaimAndAttemptIdentity(
  claim: FinancialProviderCommandRecoveryClaim,
  attempt: FinancialProviderCommandDispatchAttempt
): void {
  const { command, lease } = claim;
  assertUuid(command.commandId);
  assertUuid(command.operationId);
  assertSha256(command.requestSha256);
  assertSha256(command.commandIdentitySha256);
  if (!IDEMPOTENCY_KEY.test(command.idempotencyKey) || command.providerKind !== 'FAKE') {
    throw new Error('FAKE_FINANCIAL_RECOVERY_COMMAND_IDENTITY_INVALID');
  }
  boundedInteger(
    command.providerExpectedVersion,
    0,
    Number.MAX_SAFE_INTEGER,
    'FAKE_FINANCIAL_RECOVERY_COMMAND_IDENTITY_INVALID'
  );
  assertCommandIdentity(command);
  const requestedAt = validDate(command.requestedAt);

  assertUuid(lease.recoveryLeaseId);
  assertUuid(lease.commandId);
  assertUuid(lease.leaseOwnerId);
  assertSha256(lease.leaseIdentitySha256);
  const leaseDurationSeconds = boundedInteger(
    lease.leaseDurationSeconds,
    1,
    900,
    'FAKE_FINANCIAL_RECOVERY_LEASE_IDENTITY_INVALID'
  );
  const acquiredAt = validDate(lease.acquiredAt);
  const expiresAt = validDate(lease.expiresAt);
  const expectedLeaseIdentity = sha256(
    [
      lease.commandId.toLowerCase(),
      lease.recoveryLeaseId.toLowerCase(),
      lease.recoveryAction,
      lease.leaseOwnerId.toLowerCase(),
      String(leaseDurationSeconds),
    ].join(':')
  );
  if (
    lease.commandId.toLowerCase() !== command.commandId.toLowerCase() ||
    lease.recoveryAction !== 'RECONCILE' ||
    expiresAt - acquiredAt !== leaseDurationSeconds * 1_000 ||
    lease.leaseIdentitySha256 !== expectedLeaseIdentity
  ) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_LEASE_IDENTITY_INVALID');
  }

  assertUuid(attempt.dispatchAttemptId);
  assertUuid(attempt.commandId);
  assertUuid(attempt.recoveryLeaseId);
  assertSha256(attempt.requestSha256);
  assertSha256(attempt.attemptIdentitySha256);
  const attemptNumber = boundedInteger(
    attempt.attemptNumber,
    1,
    Number.MAX_SAFE_INTEGER,
    'FAKE_FINANCIAL_RECOVERY_ATTEMPT_IDENTITY_INVALID'
  );
  const outcomeTimeoutSeconds = boundedInteger(
    attempt.outcomeTimeoutSeconds,
    0,
    900,
    'FAKE_FINANCIAL_RECOVERY_ATTEMPT_IDENTITY_INVALID'
  );
  const attemptedAt = validDate(attempt.attemptedAt);
  const outcomeDeadlineAt = validDate(attempt.outcomeDeadlineAt);
  const claimedAttempt = claim.lastDispatchAttempt;
  const expectedAttemptIdentity = sha256(
    [
      attempt.commandId.toLowerCase(),
      attempt.dispatchAttemptId.toLowerCase(),
      attempt.recoveryLeaseId.toLowerCase(),
      String(attemptNumber),
      attempt.requestSha256,
      String(outcomeTimeoutSeconds),
    ].join(':')
  );
  if (
    attempt.commandId.toLowerCase() !== command.commandId.toLowerCase() ||
    attempt.requestSha256 !== command.requestSha256 ||
    claimedAttempt === null ||
    claimedAttempt.dispatchAttemptId.toLowerCase() !== attempt.dispatchAttemptId.toLowerCase() ||
    claimedAttempt.attemptIdentitySha256 !== attempt.attemptIdentitySha256 ||
    attempt.recoveryLeaseId.toLowerCase() === lease.recoveryLeaseId.toLowerCase() ||
    outcomeDeadlineAt - attemptedAt !== outcomeTimeoutSeconds * 1_000 ||
    attemptedAt < requestedAt ||
    acquiredAt < attemptedAt ||
    attempt.attemptIdentitySha256 !== expectedAttemptIdentity
  ) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_ATTEMPT_IDENTITY_INVALID');
  }
}

function reconstructExactRequest(
  claim: FinancialProviderCommandRecoveryClaim,
  event: StoredFakeFinancialOperation
): Readonly<Record<string, unknown>> {
  const { command } = claim;
  assertUuid(event.eventId);
  assertSha256(event.identitySha256);
  assertSha256(event.requestSha256);
  assertSha256(event.providerRequestSha256);
  assertSha256(event.responseSha256);
  const eventRecordedAt = validDate(event.recordedAt);
  const attempt = claim.lastDispatchAttempt;
  if (!attempt || eventRecordedAt < validDate(attempt.attemptedAt)) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_EVENT_PRECEDES_ATTEMPT');
  }
  const commandCurrency = event.currency?.toUpperCase() ?? null;
  if (
    event.providerKind !== 'FAKE' ||
    event.operationId.toLowerCase() !== command.operationId.toLowerCase() ||
    event.operationKind !== command.operationKind ||
    event.idempotencyKey !== command.idempotencyKey ||
    event.version !== command.providerExpectedVersion + 1 ||
    event.providerRequestSha256 !== command.requestSha256 ||
    event.relatedOperationId?.toLowerCase() !== command.relatedOperationId?.toLowerCase() ||
    event.amountCents !== command.amountCents ||
    commandCurrency !== command.currency ||
    (event.amountCents === null) !== (event.currency === null) ||
    (event.amountCents !== null &&
      (!Number.isSafeInteger(event.amountCents) || event.amountCents <= 0)) ||
    (event.currency !== null && !/^[a-z]{3}$/u.test(event.currency))
  ) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_EVENT_BINDING_MISMATCH');
  }

  const operationFields = exactOperationFields(command.operationKind, event);
  const base = {
    operationId: command.operationId.toLowerCase(),
    idempotencyKey: command.idempotencyKey,
    expectedVersion: command.providerExpectedVersion,
    ...(event.amountCents === null
      ? {}
      : { amountCents: event.amountCents, currency: event.currency }),
    ...(event.relatedOperationId === null
      ? {}
      : { relatedOperationId: event.relatedOperationId.toLowerCase() }),
    ...operationFields,
  } as const;
  const candidates: readonly Readonly<Record<string, unknown>>[] = [
    base,
    { ...base, scenario: event.scenario },
  ];
  const matches = candidates.filter(
    (candidate) => canonicalFinancialProviderRequestSha256(candidate) === command.requestSha256
  );
  if (matches.length !== 1) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_EXACT_REQUEST_UNAVAILABLE');
  }
  return matches[0]!;
}

function lookupWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

/**
 * Exact, read-only fake-event reconciliation. It can only observe the immutable
 * event written after DISPATCH_ATTEMPTED; no provider adapter or `execute`
 * method is reachable from this boundary.
 */
export class ExactFakeFinancialCommandRecoveryExecutor implements FakeFinancialCommandRecoveryExecutor {
  readonly providerKind = 'FAKE' as const;
  readonly abortContract = 'ABORT_SIGNAL_SETTLES' as const;
  private readonly recoveryDelaySeconds: number;

  constructor(
    private readonly fakeEvents: Pick<FakeFinancialOperationRepository, 'findByIdempotencyKey'>,
    recoveryDelaySeconds: number = 30,
    private readonly authorize: FakeFinanceAuthorizer = assertNonproductionFakeFinanceAuthorized
  ) {
    this.recoveryDelaySeconds = boundedInteger(
      recoveryDelaySeconds,
      1,
      86_400,
      'FAKE_FINANCIAL_RECOVERY_DELAY_INVALID'
    );
    authorize({ component: 'worker' });
  }

  async reconcile(
    claim: FinancialProviderCommandRecoveryClaim,
    attempt: FinancialProviderCommandDispatchAttempt,
    signal: AbortSignal
  ): Promise<FakeFinancialCommandRecoveryExecutionResult> {
    this.authorize({ component: 'worker' });
    if (signal.aborted) throw signal.reason;
    try {
      assertClaimAndAttemptIdentity(claim, attempt);
    } catch {
      return {
        kind: 'OUTCOME_UNKNOWN',
        failureCode: 'FAKE_IDENTITY_MISMATCH',
        recoveryDelaySeconds: this.recoveryDelaySeconds,
      };
    }

    let event: StoredFakeFinancialOperation | null;
    try {
      event = await lookupWithAbort(
        this.fakeEvents.findByIdempotencyKey(claim.command.idempotencyKey),
        signal
      );
    } catch (error) {
      if (signal.aborted) throw error;
      return {
        kind: 'OUTCOME_UNKNOWN',
        failureCode: 'FAKE_EVENT_LOOKUP_FAILED',
        recoveryDelaySeconds: this.recoveryDelaySeconds,
      };
    }
    if (!event) {
      return {
        kind: 'OUTCOME_UNKNOWN',
        failureCode: 'FAKE_EVENT_NOT_FOUND',
        recoveryDelaySeconds: this.recoveryDelaySeconds,
      };
    }

    try {
      const exactRequest = reconstructExactRequest(claim, event);
      const providerResult = resultFromExactStoredFakeFinancialOperation(
        event,
        claim.command.operationKind,
        exactRequest,
        claim.command.requestSha256,
        true
      );
      return { kind: 'OUTCOME_OBSERVED', providerResult };
    } catch {
      return {
        kind: 'OUTCOME_UNKNOWN',
        failureCode: 'FAKE_EVENT_IDENTITY_MISMATCH',
        recoveryDelaySeconds: this.recoveryDelaySeconds,
      };
    }
  }
}

export function financialProviderOutcomeProjectionSha256(result: FinancialOperationResult): string {
  const canonical = [
    result.operationId,
    result.operationKind,
    result.providerKind,
    result.state,
    String(result.version),
    result.amountCents === null ? '' : String(result.amountCents),
    result.currency ?? '',
    sha256(result.externalReference),
    String(result.retryable),
  ].join(':');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function boundedInteger(value: unknown, minimum: number, maximum: number, error: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(error);
  }
  return Number(value);
}

function assertFailureCode(value: string): void {
  if (!FAILURE_CODE.test(value)) throw new Error('FAKE_FINANCIAL_RECOVERY_FAILURE_CODE_INVALID');
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function assertFinalProviderResult(
  claim: FinancialProviderCommandRecoveryClaim,
  result: FinancialOperationResult
): void {
  if (
    result.providerKind !== 'FAKE' ||
    result.operationId !== claim.command.operationId ||
    result.operationKind !== claim.command.operationKind ||
    result.version !== claim.command.providerExpectedVersion + 1 ||
    !PROVIDER_STATES_BY_OPERATION[claim.command.operationKind].has(result.state) ||
    (NONTERMINAL_STATES.has(result.state)
      ? result.retryable !== true
      : result.retryable !== false) ||
    typeof result.externalReference !== 'string' ||
    result.externalReference.length < 1 ||
    result.externalReference.length > 512 ||
    result.externalReference.trim() !== result.externalReference ||
    containsControlCharacter(result.externalReference) ||
    typeof result.idempotencyReplayed !== 'boolean' ||
    (MONEY_OPERATION_KINDS.has(claim.command.operationKind)
      ? !Number.isSafeInteger(claim.command.amountCents) ||
        result.amountCents !== claim.command.amountCents ||
        typeof claim.command.currency !== 'string' ||
        !/^[A-Z]{3}$/u.test(claim.command.currency) ||
        result.currency !== claim.command.currency
      : result.amountCents !== null || result.currency !== null)
  ) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_RESULT_INVALID');
  }
}

function outcomeIdempotencyKey(recoveryLeaseId: string): string {
  return `finance-recovery:${recoveryLeaseId}`;
}

function outcomeInput(
  claim: FinancialProviderCommandRecoveryClaim,
  attempt: FinancialProviderCommandDispatchAttempt,
  execution: FakeFinancialCommandRecoveryExecutionResult,
  nonterminalObservationRecoveryDelaySeconds: number
): RecordFinancialProviderCommandOutcomeInput {
  const common = {
    commandId: claim.command.commandId,
    dispatchAttemptId: attempt.dispatchAttemptId,
    recoveryLeaseId: claim.lease.recoveryLeaseId,
    observationIdempotencyKey: outcomeIdempotencyKey(claim.lease.recoveryLeaseId),
  } as const;
  if (execution.kind === 'OUTCOME_OBSERVED') {
    assertFinalProviderResult(claim, execution.providerResult);
    const nonterminal = NONTERMINAL_STATES.has(execution.providerResult.state);
    return {
      kind: execution.kind,
      ...common,
      providerResultSha256: financialProviderOutcomeProjectionSha256(execution.providerResult),
      providerState: execution.providerResult.state,
      providerResultVersion: execution.providerResult.version,
      amountCents: execution.providerResult.amountCents,
      currency: execution.providerResult.currency,
      externalReferenceSha256: sha256(execution.providerResult.externalReference),
      effectCertainty: nonterminal
        ? 'UNKNOWN'
        : NO_EFFECT_STATES.has(execution.providerResult.state)
          ? 'CONFIRMED_NO_EFFECT'
          : 'CONFIRMED_EFFECT',
      retryable: nonterminal,
      recoveryDelaySeconds: nonterminal ? nonterminalObservationRecoveryDelaySeconds : null,
    };
  }

  assertFailureCode(execution.failureCode);
  if (execution.kind === 'OUTCOME_UNKNOWN') {
    return {
      kind: execution.kind,
      ...common,
      failureCode: execution.failureCode,
      recoveryDelaySeconds: boundedInteger(
        execution.recoveryDelaySeconds,
        1,
        86_400,
        'FAKE_FINANCIAL_RECOVERY_DELAY_INVALID'
      ),
    };
  }
  if (execution.confirmedNoEffect !== true) {
    throw new Error('FAKE_FINANCIAL_RECOVERY_NO_EFFECT_UNCONFIRMED');
  }
  if (execution.retryable) {
    return {
      kind: execution.kind,
      ...common,
      failureCode: execution.failureCode,
      retryable: true,
      recoveryDelaySeconds: boundedInteger(
        execution.recoveryDelaySeconds,
        1,
        86_400,
        'FAKE_FINANCIAL_RECOVERY_DELAY_INVALID'
      ),
    };
  }
  return {
    kind: execution.kind,
    ...common,
    failureCode: execution.failureCode,
    retryable: false,
  };
}

/**
 * One-shot nonproduction batch engine. The explicit poller below is its only
 * scheduler; it remains outside BullMQ and production construction fails
 * closed. Callers must still supply a fake-only reconciliation executor.
 */
export class NonproductionFakeFinancialCommandRecoveryWorker {
  private readonly batchLimit: number;
  private readonly leaseDurationSeconds: number;
  private readonly thrownOutcomeRecoveryDelaySeconds: number;
  private readonly nonterminalObservationRecoveryDelaySeconds: number;
  private readonly reconciliationDeadlineMs: number;

  constructor(
    private readonly repository: FinancialProviderCommandRecoveryRepository,
    private readonly executor: FakeFinancialCommandRecoveryExecutor,
    private readonly options: NonproductionFakeFinancialCommandRecoveryWorkerOptions,
    private readonly authorize: FakeFinanceAuthorizer = assertNonproductionFakeFinanceAuthorized,
    private readonly legacyExpiryCompensation?: LegacyFakeFinancialExpiryCompensationPort
  ) {
    if (
      !NONPRODUCTION_ENVIRONMENTS.has(options.environment) ||
      executor.providerKind !== 'FAKE' ||
      executor.abortContract !== 'ABORT_SIGNAL_SETTLES'
    ) {
      throw new Error('FAKE_FINANCIAL_RECOVERY_NONPRODUCTION_ONLY');
    }
    authorize({ component: 'worker' });
    this.batchLimit = boundedInteger(
      options.batchLimit ?? 20,
      1,
      50,
      'FAKE_FINANCIAL_RECOVERY_BATCH_INVALID'
    );
    this.leaseDurationSeconds = boundedInteger(
      options.leaseDurationSeconds ?? 60,
      2,
      900,
      'FAKE_FINANCIAL_RECOVERY_LEASE_INVALID'
    );
    this.thrownOutcomeRecoveryDelaySeconds = boundedInteger(
      options.thrownOutcomeRecoveryDelaySeconds ?? 30,
      1,
      86_400,
      'FAKE_FINANCIAL_RECOVERY_DELAY_INVALID'
    );
    this.nonterminalObservationRecoveryDelaySeconds = boundedInteger(
      options.nonterminalObservationRecoveryDelaySeconds ?? 30,
      1,
      86_400,
      'FAKE_FINANCIAL_RECOVERY_DELAY_INVALID'
    );
    this.reconciliationDeadlineMs = boundedInteger(
      options.reconciliationDeadlineMs ?? 30_000,
      1,
      this.leaseDurationSeconds * 1_000 - 1_000,
      'FAKE_FINANCIAL_RECOVERY_DEADLINE_INVALID'
    );
  }

  async runOnce(): Promise<FinancialProviderCommandRecoveryRunResult> {
    const mutable = {
      claimed: 0,
      reconciled: 0,
      outcomeObserved: 0,
      outcomeUnknown: 0,
      failed: 0,
      persistenceErrors: 0,
    };
    const processedCommandIds = new Set<string>();

    // Migration v9 can expose raw-only pre-expiry successes. Contain those
    // through their sealed PREPARED -> DISPATCH_ATTEMPTED -> OUTCOME_OBSERVED
    // fake-only rail before any source command is allowed to become terminal.
    if (this.legacyExpiryCompensation) {
      try {
        this.authorize({ component: 'worker' });
        await this.legacyExpiryCompensation.runOnce(this.batchLimit);
      } catch {
        mutable.persistenceErrors += 1;
        return mutable;
      }
    }

    for (let index = 0; index < this.batchLimit; index += 1) {
      let claims: readonly FinancialProviderCommandRecoveryClaim[];
      try {
        claims = await this.repository.claimRecoverable({
          leaseOwnerId: this.options.leaseOwnerId,
          leaseDurationSeconds: this.leaseDurationSeconds,
          excludeCommandIds: [...processedCommandIds],
        });
      } catch {
        mutable.persistenceErrors += 1;
        break;
      }
      if (claims.length === 0) break;
      if (claims.length !== 1) {
        mutable.persistenceErrors += 1;
        break;
      }
      const claim = claims[0]!;
      if (processedCommandIds.has(claim.command.commandId)) {
        mutable.persistenceErrors += 1;
        break;
      }
      processedCommandIds.add(claim.command.commandId);
      mutable.claimed += 1;
      if (
        claim.command.providerKind !== 'FAKE' ||
        claim.lease.recoveryAction !== 'RECONCILE' ||
        claim.lastDispatchAttempt === null
      ) {
        mutable.persistenceErrors += 1;
        continue;
      }
      let execution: FakeFinancialCommandRecoveryExecutionResult;
      const abortController = new AbortController();
      const abortTimer = setTimeout(() => {
        abortController.abort(new Error('FAKE_FINANCIAL_RECOVERY_DEADLINE_EXCEEDED'));
      }, this.reconciliationDeadlineMs);
      try {
        this.authorize({ component: 'worker' });
      } catch {
        clearTimeout(abortTimer);
        mutable.persistenceErrors += 1;
        continue;
      }
      mutable.reconciled += 1;
      try {
        execution = await this.executor.reconcile(
          claim,
          claim.lastDispatchAttempt,
          abortController.signal
        );
        if (abortController.signal.aborted) {
          throw new Error('FAKE_FINANCIAL_RECOVERY_DEADLINE_EXCEEDED');
        }
      } catch {
        execution = {
          kind: 'OUTCOME_UNKNOWN',
          failureCode: 'FAKE_EXECUTOR_THROWN',
          recoveryDelaySeconds: this.thrownOutcomeRecoveryDelaySeconds,
        };
      } finally {
        clearTimeout(abortTimer);
      }

      let durableOutcome: RecordFinancialProviderCommandOutcomeInput;
      try {
        durableOutcome = outcomeInput(
          claim,
          claim.lastDispatchAttempt,
          execution,
          this.nonterminalObservationRecoveryDelaySeconds
        );
      } catch {
        durableOutcome = outcomeInput(
          claim,
          claim.lastDispatchAttempt,
          {
            kind: 'OUTCOME_UNKNOWN',
            failureCode: 'FAKE_EXECUTOR_RESULT_INVALID',
            recoveryDelaySeconds: this.thrownOutcomeRecoveryDelaySeconds,
          },
          this.nonterminalObservationRecoveryDelaySeconds
        );
      }

      try {
        const outcome = await this.repository.recordOutcome(durableOutcome);
        if (outcome.outcomeKind === 'OUTCOME_OBSERVED') mutable.outcomeObserved += 1;
        else if (outcome.outcomeKind === 'OUTCOME_UNKNOWN') mutable.outcomeUnknown += 1;
        else mutable.failed += 1;
      } catch {
        mutable.persistenceErrors += 1;
      }
    }

    return mutable;
  }
}

export interface FakeFinancialCommandRecoveryPollerDependencies {
  readonly worker: Pick<NonproductionFakeFinancialCommandRecoveryWorker, 'runOnce'>;
  readonly assertAuthorized: () => void;
}

export interface FakeFinancialCommandRecoveryWorkerHealth {
  readonly status: 'healthy' | 'degraded' | 'stopped';
  readonly inFlight: boolean;
  readonly consecutiveFailures: number;
  readonly lastFailureCode: string | null;
}

export interface FakeFinancialCommandRecoveryWorkerHandle {
  readonly workerId: string;
  readonly interval: NodeJS.Timeout;
  health(): FakeFinancialCommandRecoveryWorkerHealth;
  stop(): Promise<void>;
}

export interface StartFakeFinancialCommandRecoveryPollerOptions {
  readonly workerId?: string;
}

function recoveryPollerInterval(value: number): number {
  return boundedInteger(value, 500, 60_000, 'FAKE_FINANCIAL_RECOVERY_INTERVAL_INVALID');
}

/**
 * Capability-gated nonproduction scheduler. Stopping it first clears the
 * timer, then drains the exact in-flight reconciliation batch before settling.
 */
export function startNonproductionFakeFinancialCommandRecoveryPoller(
  intervalMs: number = 5_000,
  dependencies: FakeFinancialCommandRecoveryPollerDependencies,
  options: StartFakeFinancialCommandRecoveryPollerOptions = {}
): FakeFinancialCommandRecoveryWorkerHandle {
  recoveryPollerInterval(intervalMs);
  dependencies.assertAuthorized();
  const workerId = options.workerId ?? `fake-financial-recovery:${randomUUID()}`;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let hasSuccessfulTick = false;
  let consecutiveFailures = 0;
  let lastFailureCode: string | null = 'STARTUP_PENDING';

  const tick = (): Promise<void> => {
    if (stopped || inFlight) return inFlight ?? Promise.resolve();
    inFlight = Promise.resolve()
      .then(() => {
        try {
          dependencies.assertAuthorized();
        } catch {
          throw new Error('FAKE_FINANCIAL_RECOVERY_CAPABILITY_GATE_DENIED');
        }
        return dependencies.worker.runOnce();
      })
      .then((result) => {
        if (result.persistenceErrors > 0) {
          throw new Error('FAKE_FINANCIAL_RECOVERY_PERSISTENCE_ERRORS');
        }
        hasSuccessfulTick = true;
        consecutiveFailures = 0;
        lastFailureCode = null;
      })
      .catch((error: unknown) => {
        consecutiveFailures += 1;
        lastFailureCode =
          error instanceof Error &&
          error.message === 'FAKE_FINANCIAL_RECOVERY_CAPABILITY_GATE_DENIED'
            ? 'CAPABILITY_GATE_DENIED'
            : error instanceof Error &&
                error.message === 'FAKE_FINANCIAL_RECOVERY_PERSISTENCE_ERRORS'
              ? 'PERSISTENCE_ERRORS'
              : 'BATCH_FAILED';
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  void tick();
  const interval = setInterval(() => {
    void tick();
  }, intervalMs);

  return {
    workerId,
    interval,
    health: () => ({
      status: stopped
        ? 'stopped'
        : !hasSuccessfulTick || consecutiveFailures > 0
          ? 'degraded'
          : 'healthy',
      inFlight: inFlight !== null,
      consecutiveFailures,
      lastFailureCode,
    }),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(interval);
      await inFlight;
    },
  };
}
