import { createHash } from 'node:crypto';

import { db, type Database, type QueryFn } from '../../db.js';
import {
  resultFromExactStoredFakeFinancialOperation,
  type FakeFinancialOperationRepository,
} from './FakeFinancialProvider.js';
import type {
  DurableFakeFinancialCommandEvidence,
  ForegroundFinancialProviderCommandContext,
  ForegroundFinancialProviderCommandCoordinator,
  ForegroundFinancialProviderCommandResult,
} from './FinancialProviderCommandJournal.js';
import type {
  FinancialOperationKind,
  FinancialOperationResult,
  FinancialOperationState,
} from './FinancialProviderPorts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,128}$/u;
const FAILURE_CODE = /^[A-Z][A-Z0-9_.:-]{2,63}$/u;
const MAX_SAFE_DATABASE_INTEGER = Number.MAX_SAFE_INTEGER;

export type FinancialProviderCommandRecoveryAction = 'DISPATCH' | 'RECONCILE';
export type FinancialProviderCommandOutcomeKind = 'OUTCOME_OBSERVED' | 'OUTCOME_UNKNOWN' | 'FAILED';
export type FinancialProviderCommandEffectCertainty =
  | 'CONFIRMED_EFFECT'
  | 'CONFIRMED_NO_EFFECT'
  | 'UNKNOWN';

export interface FinancialProviderCommandRecoveryCommand {
  readonly commandId: string;
  readonly operationKind: FinancialOperationKind;
  readonly operationId: string;
  readonly providerKind: 'FAKE';
  readonly idempotencyKey: string;
  readonly providerExpectedVersion: number;
  readonly requestSha256: string;
  readonly commandIdentitySha256: string;
  readonly preparedFinancialCommandId: string | null;
  readonly preparedAuthoritySha256: string | null;
  readonly taskDraftId: string | null;
  readonly taskId: string | null;
  readonly workOrderId: string | null;
  readonly relatedOperationId: string | null;
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly requestedAt: string;
}

export interface FinancialProviderCommandRecoveryLease {
  readonly recoveryLeaseId: string;
  readonly commandId: string;
  readonly recoveryAction: FinancialProviderCommandRecoveryAction;
  readonly leaseOwnerId: string;
  readonly leaseDurationSeconds: number;
  readonly acquiredAt: string;
  readonly expiresAt: string;
  readonly leaseIdentitySha256: string;
}

export interface FinancialProviderCommandDispatchAttempt {
  readonly dispatchAttemptId: string;
  readonly commandId: string;
  readonly recoveryLeaseId: string;
  readonly attemptNumber: number;
  readonly requestSha256: string;
  readonly outcomeTimeoutSeconds: number;
  readonly attemptedAt: string;
  readonly outcomeDeadlineAt: string;
  readonly attemptIdentitySha256: string;
  readonly idempotencyReplayed: boolean;
}

export interface FinancialProviderCommandOutcomeFact {
  readonly outcomeFactId: string;
  readonly commandId: string;
  readonly dispatchAttemptId: string;
  readonly recoveryLeaseId: string;
  readonly outcomeKind: FinancialProviderCommandOutcomeKind;
  readonly observationIdempotencyKey: string;
  readonly providerResultSha256: string | null;
  readonly providerState: FinancialOperationState | null;
  readonly providerResultVersion: number | null;
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly externalReferenceSha256: string | null;
  readonly effectCertainty: FinancialProviderCommandEffectCertainty;
  readonly retryable: boolean;
  readonly failureCode: string | null;
  readonly recoveryDelaySeconds: number | null;
  readonly recoveryNotBefore: string | null;
  readonly recordedAt: string;
  readonly outcomeIdentitySha256: string;
  readonly idempotencyReplayed: boolean;
}

export interface FinancialProviderCommandRecoveryClaim {
  readonly command: FinancialProviderCommandRecoveryCommand;
  readonly lease: FinancialProviderCommandRecoveryLease;
  readonly lastDispatchAttempt: FinancialProviderCommandDispatchAttempt | null;
}

export interface ClaimRecoverableFinancialProviderCommandsInput {
  readonly leaseOwnerId: string;
  /** Optional exact-command bound for a manual recovery or reconciliation run. */
  readonly commandId?: string;
  /** Commands already handled by this run; prevents zero-delay hot loops. */
  readonly excludeCommandIds?: readonly string[];
  readonly leaseDurationSeconds?: number;
}

export interface AcquireFinancialProviderCommandRecoveryLeaseInput {
  readonly commandId: string;
  readonly recoveryAction: FinancialProviderCommandRecoveryAction;
  readonly leaseOwnerId: string;
  readonly leaseDurationSeconds?: number;
}

export interface RecordFinancialProviderCommandDispatchAttemptInput {
  readonly commandId: string;
  readonly recoveryLeaseId: string;
  readonly outcomeTimeoutSeconds?: number;
}

export interface RecordFinancialProviderCommandObservedOutcomeInput {
  readonly kind: 'OUTCOME_OBSERVED';
  readonly commandId: string;
  readonly dispatchAttemptId: string;
  readonly recoveryLeaseId: string;
  readonly observationIdempotencyKey: string;
  readonly providerResultSha256: string;
  readonly providerState: FinancialOperationState;
  readonly providerResultVersion: number;
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly externalReferenceSha256: string;
  readonly effectCertainty: FinancialProviderCommandEffectCertainty;
  readonly retryable: boolean;
  readonly recoveryDelaySeconds: number | null;
}

export interface RecordFinancialProviderCommandUnknownOutcomeInput {
  readonly kind: 'OUTCOME_UNKNOWN';
  readonly commandId: string;
  readonly dispatchAttemptId: string;
  readonly recoveryLeaseId: string;
  readonly observationIdempotencyKey: string;
  readonly failureCode: string;
  readonly recoveryDelaySeconds: number;
}

export type RecordFinancialProviderCommandFailedOutcomeInput =
  | {
      readonly kind: 'FAILED';
      readonly commandId: string;
      readonly dispatchAttemptId: string;
      readonly recoveryLeaseId: string;
      readonly observationIdempotencyKey: string;
      readonly failureCode: string;
      readonly retryable: false;
    }
  | {
      readonly kind: 'FAILED';
      readonly commandId: string;
      readonly dispatchAttemptId: string;
      readonly recoveryLeaseId: string;
      readonly observationIdempotencyKey: string;
      readonly failureCode: string;
      readonly retryable: true;
      readonly recoveryDelaySeconds: number;
    };

export type RecordFinancialProviderCommandOutcomeInput =
  | RecordFinancialProviderCommandObservedOutcomeInput
  | RecordFinancialProviderCommandUnknownOutcomeInput
  | RecordFinancialProviderCommandFailedOutcomeInput;

export type FinancialProviderCommandRecoveryErrorReason =
  | 'IDENTIFIER_INVALID'
  | 'RECOVERY_ACTION_INVALID'
  | 'LEASE_DURATION_INVALID'
  | 'OUTCOME_TIMEOUT_INVALID'
  | 'OUTCOME_INVALID'
  | 'APPROVED_PROVIDER_UNAVAILABLE'
  | 'COMMAND_NOT_FOUND'
  | 'LEASE_NOT_FOUND'
  | 'LEASE_CONFLICT'
  | 'DISPATCH_ATTEMPT_CONFLICT'
  | 'OUTCOME_IDEMPOTENCY_CONFLICT'
  | 'TERMINAL_OUTCOME_CONFLICT'
  | 'PERSISTENCE_INCOMPLETE';

export class FinancialProviderCommandRecoveryError extends Error {
  constructor(readonly reason: FinancialProviderCommandRecoveryErrorReason) {
    super(`FINANCIAL_PROVIDER_COMMAND_RECOVERY_${reason}`);
    this.name = 'FinancialProviderCommandRecoveryError';
  }
}

export interface FinancialProviderCommandRecoveryRepository {
  claimRecoverable(
    input: ClaimRecoverableFinancialProviderCommandsInput
  ): Promise<readonly FinancialProviderCommandRecoveryClaim[]>;
  acquireLease(
    input: AcquireFinancialProviderCommandRecoveryLeaseInput
  ): Promise<FinancialProviderCommandRecoveryLease | null>;
  recordDispatchAttempted(
    input: RecordFinancialProviderCommandDispatchAttemptInput
  ): Promise<FinancialProviderCommandDispatchAttempt>;
  recordOutcome(
    input: RecordFinancialProviderCommandOutcomeInput
  ): Promise<FinancialProviderCommandOutcomeFact>;
}

export interface FindFinancialProviderCommandStateInput {
  readonly idempotencyKey: string;
}

export interface FinancialProviderCommandState {
  readonly command: FinancialProviderCommandRecoveryCommand;
  readonly lastDispatchAttempt: FinancialProviderCommandDispatchAttempt | null;
  readonly latestOutcome: FinancialProviderCommandOutcomeFact | null;
}

export interface ForegroundFinancialProviderCommandRepository
  extends Pick<
    FinancialProviderCommandRecoveryRepository,
    'acquireLease' | 'recordDispatchAttempted' | 'recordOutcome'
  > {
  findCommandState(
    input: FindFinancialProviderCommandStateInput
  ): Promise<FinancialProviderCommandState | null>;
}

interface RecoveryCommandRow {
  command_id: string;
  operation_kind: FinancialOperationKind;
  operation_id: string;
  provider_kind: string;
  idempotency_key: string;
  provider_expected_version: string | number;
  request_sha256: string;
  command_identity_sha256: string;
  prepared_financial_command_id: string | null;
  prepared_authority_sha256: string | null;
  task_draft_id: string | null;
  task_id: string | null;
  work_order_id: string | null;
  related_operation_id: string | null;
  amount_cents: string | number | null;
  currency: string | null;
  requested_at: Date | string;
}

interface CandidateRow extends RecoveryCommandRow {
  recovery_action: FinancialProviderCommandRecoveryAction;
  latest_dispatch_attempt_id: string | null;
  latest_recovery_lease_id: string | null;
  latest_attempt_number: string | number | null;
  latest_attempt_request_sha256: string | null;
  latest_outcome_timeout_seconds: number | null;
  latest_attempted_at: Date | string | null;
  latest_outcome_deadline_at: Date | string | null;
  latest_attempt_identity_sha256: string | null;
}

interface LeaseRow {
  recovery_lease_id: string;
  command_id: string;
  recovery_action: FinancialProviderCommandRecoveryAction;
  lease_owner_id: string;
  lease_duration_seconds: number;
  acquired_at: Date | string;
  expires_at: Date | string;
  lease_identity_sha256: string;
}

interface AttemptRow {
  dispatch_attempt_id: string;
  command_id: string;
  recovery_lease_id: string;
  attempt_number: string | number;
  request_sha256: string;
  outcome_timeout_seconds: number;
  attempted_at: Date | string;
  outcome_deadline_at: Date | string;
  attempt_identity_sha256: string;
}

interface OutcomeRow {
  outcome_fact_id: string;
  command_id: string;
  dispatch_attempt_id: string;
  recovery_lease_id: string;
  outcome_kind: FinancialProviderCommandOutcomeKind;
  observation_idempotency_key: string;
  provider_result_sha256: string | null;
  provider_state: FinancialOperationState | null;
  provider_result_version: string | number | null;
  amount_cents: string | number | null;
  currency: string | null;
  external_reference_sha256: string | null;
  effect_certainty: FinancialProviderCommandEffectCertainty;
  retryable: boolean;
  failure_code: string | null;
  recovery_delay_seconds: number | null;
  recovery_not_before: Date | string | null;
  recorded_at: Date | string;
  outcome_identity_sha256: string;
}

interface NormalizedOutcome {
  commandId: string;
  dispatchAttemptId: string;
  recoveryLeaseId: string;
  observationIdempotencyKey: string;
  outcomeKind: FinancialProviderCommandOutcomeKind;
  providerResultSha256: string | null;
  providerState: FinancialOperationState | null;
  providerResultVersion: number | null;
  amountCents: number | null;
  currency: string | null;
  externalReferenceSha256: string | null;
  effectCertainty: FinancialProviderCommandEffectCertainty;
  retryable: boolean;
  failureCode: string | null;
  recoveryDelaySeconds: number | null;
}

const OPERATION_STATES = new Set<FinancialOperationState>([
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

const NONTERMINAL_OBSERVED_STATES = new Set<FinancialOperationState>([
  'PENDING',
  'RETRYABLE_FAILURE',
]);

const LEASE_SELECT = `
  recovery_lease_id, command_id, recovery_action, lease_owner_id,
  lease_duration_seconds, acquired_at, expires_at, lease_identity_sha256`;
const ATTEMPT_SELECT = `
  dispatch_attempt_id, command_id, recovery_lease_id, attempt_number,
  request_sha256, outcome_timeout_seconds, attempted_at, outcome_deadline_at,
  attempt_identity_sha256`;
const OUTCOME_SELECT = `
  outcome_fact_id, command_id, dispatch_attempt_id, recovery_lease_id,
  outcome_kind, observation_idempotency_key, provider_result_sha256,
  provider_state, provider_result_version, effect_certainty, retryable,
  amount_cents, currency, external_reference_sha256, failure_code,
  recovery_delay_seconds, recovery_not_before, recorded_at,
  outcome_identity_sha256`;

function asIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : asIso(value);
}

function safeInteger(
  value: string | number,
  reason: FinancialProviderCommandRecoveryErrorReason
): number {
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > MAX_SAFE_DATABASE_INTEGER) {
    throw new FinancialProviderCommandRecoveryError(reason);
  }
  return numeric;
}

function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new FinancialProviderCommandRecoveryError('IDENTIFIER_INVALID');
  }
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  reason: FinancialProviderCommandRecoveryErrorReason
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new FinancialProviderCommandRecoveryError(reason);
  }
  return Number(value);
}

function leaseFromRow(row: LeaseRow): FinancialProviderCommandRecoveryLease {
  return {
    recoveryLeaseId: row.recovery_lease_id,
    commandId: row.command_id,
    recoveryAction: row.recovery_action,
    leaseOwnerId: row.lease_owner_id,
    leaseDurationSeconds: row.lease_duration_seconds,
    acquiredAt: asIso(row.acquired_at),
    expiresAt: asIso(row.expires_at),
    leaseIdentitySha256: row.lease_identity_sha256,
  };
}

function attemptFromRow(
  row: AttemptRow,
  idempotencyReplayed: boolean
): FinancialProviderCommandDispatchAttempt {
  return {
    dispatchAttemptId: row.dispatch_attempt_id,
    commandId: row.command_id,
    recoveryLeaseId: row.recovery_lease_id,
    attemptNumber: safeInteger(row.attempt_number, 'DISPATCH_ATTEMPT_CONFLICT'),
    requestSha256: row.request_sha256,
    outcomeTimeoutSeconds: row.outcome_timeout_seconds,
    attemptedAt: asIso(row.attempted_at),
    outcomeDeadlineAt: asIso(row.outcome_deadline_at),
    attemptIdentitySha256: row.attempt_identity_sha256,
    idempotencyReplayed,
  };
}

function outcomeFromRow(
  row: OutcomeRow,
  idempotencyReplayed: boolean
): FinancialProviderCommandOutcomeFact {
  return {
    outcomeFactId: row.outcome_fact_id,
    commandId: row.command_id,
    dispatchAttemptId: row.dispatch_attempt_id,
    recoveryLeaseId: row.recovery_lease_id,
    outcomeKind: row.outcome_kind,
    observationIdempotencyKey: row.observation_idempotency_key,
    providerResultSha256: row.provider_result_sha256,
    providerState: row.provider_state,
    providerResultVersion:
      row.provider_result_version === null
        ? null
        : safeInteger(row.provider_result_version, 'OUTCOME_INVALID'),
    amountCents:
      row.amount_cents === null ? null : safeInteger(row.amount_cents, 'OUTCOME_INVALID'),
    currency: row.currency,
    externalReferenceSha256: row.external_reference_sha256,
    effectCertainty: row.effect_certainty,
    retryable: row.retryable,
    failureCode: row.failure_code,
    recoveryDelaySeconds: row.recovery_delay_seconds,
    recoveryNotBefore: nullableIso(row.recovery_not_before),
    recordedAt: asIso(row.recorded_at),
    outcomeIdentitySha256: row.outcome_identity_sha256,
    idempotencyReplayed,
  };
}

function commandFromRow(row: RecoveryCommandRow): FinancialProviderCommandRecoveryCommand {
  if (row.provider_kind !== 'FAKE') {
    throw new FinancialProviderCommandRecoveryError('APPROVED_PROVIDER_UNAVAILABLE');
  }
  return {
    commandId: row.command_id,
    operationKind: row.operation_kind,
    operationId: row.operation_id,
    providerKind: 'FAKE',
    idempotencyKey: row.idempotency_key,
    providerExpectedVersion: safeInteger(row.provider_expected_version, 'PERSISTENCE_INCOMPLETE'),
    requestSha256: row.request_sha256,
    commandIdentitySha256: row.command_identity_sha256,
    preparedFinancialCommandId: row.prepared_financial_command_id,
    preparedAuthoritySha256: row.prepared_authority_sha256,
    taskDraftId: row.task_draft_id,
    taskId: row.task_id,
    workOrderId: row.work_order_id,
    relatedOperationId: row.related_operation_id,
    amountCents:
      row.amount_cents === null ? null : safeInteger(row.amount_cents, 'PERSISTENCE_INCOMPLETE'),
    currency: row.currency,
    requestedAt: asIso(row.requested_at),
  };
}

function latestAttemptFromCandidate(
  row: CandidateRow
): FinancialProviderCommandDispatchAttempt | null {
  if (row.latest_dispatch_attempt_id === null) return null;
  if (
    row.latest_recovery_lease_id === null ||
    row.latest_attempt_number === null ||
    row.latest_attempt_request_sha256 === null ||
    row.latest_outcome_timeout_seconds === null ||
    row.latest_attempted_at === null ||
    row.latest_outcome_deadline_at === null ||
    row.latest_attempt_identity_sha256 === null
  ) {
    throw new FinancialProviderCommandRecoveryError('PERSISTENCE_INCOMPLETE');
  }
  return attemptFromRow(
    {
      dispatch_attempt_id: row.latest_dispatch_attempt_id,
      command_id: row.command_id,
      recovery_lease_id: row.latest_recovery_lease_id,
      attempt_number: row.latest_attempt_number,
      request_sha256: row.latest_attempt_request_sha256,
      outcome_timeout_seconds: row.latest_outcome_timeout_seconds,
      attempted_at: row.latest_attempted_at,
      outcome_deadline_at: row.latest_outcome_deadline_at,
      attempt_identity_sha256: row.latest_attempt_identity_sha256,
    },
    false
  );
}

function normalizeOutcome(input: RecordFinancialProviderCommandOutcomeInput): NormalizedOutcome {
  assertUuid(input.commandId);
  assertUuid(input.dispatchAttemptId);
  assertUuid(input.recoveryLeaseId);
  if (!IDEMPOTENCY_KEY.test(input.observationIdempotencyKey)) {
    throw new FinancialProviderCommandRecoveryError('OUTCOME_INVALID');
  }
  if (input.kind === 'OUTCOME_OBSERVED') {
    const nonterminal = NONTERMINAL_OBSERVED_STATES.has(input.providerState);
    if (
      !SHA256.test(input.providerResultSha256) ||
      !OPERATION_STATES.has(input.providerState) ||
      !Number.isSafeInteger(input.providerResultVersion) ||
      input.providerResultVersion < 0 ||
      !SHA256.test(input.externalReferenceSha256) ||
      (input.amountCents === null) !== (input.currency === null) ||
      (input.amountCents !== null &&
        (!Number.isSafeInteger(input.amountCents) || input.amountCents < 0)) ||
      (input.currency !== null && !/^[A-Z]{3}$/u.test(input.currency)) ||
      (nonterminal
        ? input.retryable !== true ||
          input.effectCertainty !== 'UNKNOWN' ||
          input.recoveryDelaySeconds === null
        : input.retryable !== false ||
          !['CONFIRMED_EFFECT', 'CONFIRMED_NO_EFFECT'].includes(input.effectCertainty) ||
          input.recoveryDelaySeconds !== null)
    ) {
      throw new FinancialProviderCommandRecoveryError('OUTCOME_INVALID');
    }
    return {
      commandId: input.commandId.toLowerCase(),
      dispatchAttemptId: input.dispatchAttemptId.toLowerCase(),
      recoveryLeaseId: input.recoveryLeaseId.toLowerCase(),
      observationIdempotencyKey: input.observationIdempotencyKey,
      outcomeKind: input.kind,
      providerResultSha256: input.providerResultSha256,
      providerState: input.providerState,
      providerResultVersion: input.providerResultVersion,
      amountCents: input.amountCents,
      currency: input.currency,
      externalReferenceSha256: input.externalReferenceSha256,
      effectCertainty: input.effectCertainty,
      retryable: input.retryable,
      failureCode: null,
      recoveryDelaySeconds: nonterminal
        ? boundedInteger(input.recoveryDelaySeconds, 1, 86_400, 'OUTCOME_INVALID')
        : null,
    };
  }

  if (!FAILURE_CODE.test(input.failureCode)) {
    throw new FinancialProviderCommandRecoveryError('OUTCOME_INVALID');
  }
  if (input.kind === 'OUTCOME_UNKNOWN') {
    return {
      commandId: input.commandId.toLowerCase(),
      dispatchAttemptId: input.dispatchAttemptId.toLowerCase(),
      recoveryLeaseId: input.recoveryLeaseId.toLowerCase(),
      observationIdempotencyKey: input.observationIdempotencyKey,
      outcomeKind: input.kind,
      providerResultSha256: null,
      providerState: null,
      providerResultVersion: null,
      amountCents: null,
      currency: null,
      externalReferenceSha256: null,
      effectCertainty: 'UNKNOWN',
      retryable: true,
      failureCode: input.failureCode,
      recoveryDelaySeconds: boundedInteger(
        input.recoveryDelaySeconds,
        1,
        86_400,
        'OUTCOME_INVALID'
      ),
    };
  }

  return {
    commandId: input.commandId.toLowerCase(),
    dispatchAttemptId: input.dispatchAttemptId.toLowerCase(),
    recoveryLeaseId: input.recoveryLeaseId.toLowerCase(),
    observationIdempotencyKey: input.observationIdempotencyKey,
    outcomeKind: input.kind,
    providerResultSha256: null,
    providerState: null,
    providerResultVersion: null,
    amountCents: null,
    currency: null,
    externalReferenceSha256: null,
    effectCertainty: 'CONFIRMED_NO_EFFECT',
    retryable: input.retryable,
    failureCode: input.failureCode,
    recoveryDelaySeconds: input.retryable
      ? boundedInteger(input.recoveryDelaySeconds, 1, 86_400, 'OUTCOME_INVALID')
      : null,
  };
}

function sameOutcome(row: OutcomeRow, outcome: NormalizedOutcome): boolean {
  return (
    row.command_id === outcome.commandId &&
    row.dispatch_attempt_id === outcome.dispatchAttemptId &&
    row.recovery_lease_id === outcome.recoveryLeaseId &&
    row.observation_idempotency_key === outcome.observationIdempotencyKey &&
    row.outcome_kind === outcome.outcomeKind &&
    row.provider_result_sha256 === outcome.providerResultSha256 &&
    row.provider_state === outcome.providerState &&
    (row.provider_result_version === null
      ? outcome.providerResultVersion === null
      : Number(row.provider_result_version) === outcome.providerResultVersion) &&
    row.effect_certainty === outcome.effectCertainty &&
    (row.amount_cents === null
      ? outcome.amountCents === null
      : Number(row.amount_cents) === outcome.amountCents) &&
    row.currency === outcome.currency &&
    row.external_reference_sha256 === outcome.externalReferenceSha256 &&
    row.retryable === outcome.retryable &&
    row.failure_code === outcome.failureCode &&
    row.recovery_delay_seconds === outcome.recoveryDelaySeconds
  );
}

async function lockCommand(query: QueryFn, commandId: string): Promise<void> {
  await query(
    `SELECT pg_advisory_xact_lock(
       hashtext('financial-provider-command-recovery-v1'), hashtext($1)
     )`,
    [commandId]
  );
}

/**
 * PostgreSQL recovery authority. Every mutating method owns its transaction so
 * its fact is committed before the caller crosses the corresponding provider
 * boundary. This repository never loads raw provider requests or references.
 */
export class PostgresFinancialProviderCommandRecoveryRepository implements FinancialProviderCommandRecoveryRepository {
  constructor(private readonly database: Database = db) {}

  async findCommandState(
    input: FindFinancialProviderCommandStateInput
  ): Promise<FinancialProviderCommandState | null> {
    if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
      throw new FinancialProviderCommandRecoveryError('IDENTIFIER_INVALID');
    }
    return this.database.transaction(async (query) => {
      const commandResult = await query<RecoveryCommandRow>(
        `SELECT command_id, operation_kind, operation_id, provider_kind,
                idempotency_key, provider_expected_version, request_sha256,
                command_identity_sha256, prepared_financial_command_id,
                prepared_authority_sha256, task_draft_id, task_id, work_order_id,
                related_operation_id, amount_cents, currency,
                recorded_at AS requested_at
           FROM public.financial_provider_command_journal
          WHERE idempotency_key=$1`,
        [input.idempotencyKey]
      );
      const commandRow = commandResult.rows[0];
      if (!commandRow) return null;
      await lockCommand(query, commandRow.command_id);

      const attemptResult = await query<AttemptRow>(
        `SELECT ${ATTEMPT_SELECT}
           FROM public.financial_provider_command_dispatch_attempts
          WHERE command_id=$1
          ORDER BY attempt_number DESC
          LIMIT 1`,
        [commandRow.command_id]
      );
      const outcomeResult = await query<OutcomeRow>(
        `SELECT ${OUTCOME_SELECT}
           FROM public.financial_provider_command_outcome_facts
          WHERE command_id=$1
          ORDER BY recorded_at DESC, outcome_fact_id DESC
          LIMIT 1`,
        [commandRow.command_id]
      );
      return {
        command: commandFromRow(commandRow),
        lastDispatchAttempt: attemptResult.rows[0]
          ? attemptFromRow(attemptResult.rows[0], false)
          : null,
        latestOutcome: outcomeResult.rows[0]
          ? outcomeFromRow(outcomeResult.rows[0], false)
          : null,
      };
    });
  }

  async claimRecoverable(
    input: ClaimRecoverableFinancialProviderCommandsInput
  ): Promise<readonly FinancialProviderCommandRecoveryClaim[]> {
    assertUuid(input.leaseOwnerId);
    if (input.commandId !== undefined) assertUuid(input.commandId);
    const excludedCommandIds = input.excludeCommandIds ?? [];
    if (excludedCommandIds.length > 50) {
      throw new FinancialProviderCommandRecoveryError('IDENTIFIER_INVALID');
    }
    for (const commandId of excludedCommandIds) assertUuid(commandId);
    const leaseDurationSeconds = boundedInteger(
      input.leaseDurationSeconds ?? 60,
      1,
      900,
      'LEASE_DURATION_INVALID'
    );
    return this.database.transaction(async (query) => {
      const candidates = await query<CandidateRow>(
        `SELECT command.command_id, command.operation_kind, command.operation_id,
                command.provider_kind, command.idempotency_key,
                command.provider_expected_version, command.request_sha256,
                command.command_identity_sha256,
                command.prepared_financial_command_id,
                command.prepared_authority_sha256, command.task_draft_id,
                command.task_id, command.work_order_id,
                command.related_operation_id, command.amount_cents,
                command.currency, command.recorded_at AS requested_at,
                'RECONCILE'::TEXT AS recovery_action,
                latest_attempt.dispatch_attempt_id AS latest_dispatch_attempt_id,
                latest_attempt.recovery_lease_id AS latest_recovery_lease_id,
                latest_attempt.attempt_number AS latest_attempt_number,
                latest_attempt.request_sha256 AS latest_attempt_request_sha256,
                latest_attempt.outcome_timeout_seconds AS latest_outcome_timeout_seconds,
                latest_attempt.attempted_at AS latest_attempted_at,
                latest_attempt.outcome_deadline_at AS latest_outcome_deadline_at,
                latest_attempt.attempt_identity_sha256 AS latest_attempt_identity_sha256
           FROM public.financial_provider_command_journal command
           LEFT JOIN LATERAL (
             SELECT attempt.*
               FROM public.financial_provider_command_dispatch_attempts attempt
              WHERE attempt.command_id = command.command_id
              ORDER BY attempt.attempt_number DESC
              LIMIT 1
           ) latest_attempt ON TRUE
           LEFT JOIN LATERAL (
             SELECT outcome.*
               FROM public.financial_provider_command_outcome_facts outcome
              WHERE outcome.dispatch_attempt_id = latest_attempt.dispatch_attempt_id
              ORDER BY outcome.recorded_at DESC, outcome.outcome_fact_id DESC
              LIMIT 1
           ) latest_outcome ON TRUE
          WHERE command.provider_kind = 'FAKE'
            AND ($1::UUID IS NULL OR command.command_id = $1::UUID)
            AND NOT (command.command_id = ANY($2::UUID[]))
            AND latest_attempt.dispatch_attempt_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
                FROM public.financial_provider_command_outcome_facts terminal
               WHERE terminal.command_id = command.command_id
                 AND (
                   (terminal.outcome_kind = 'OUTCOME_OBSERVED' AND terminal.retryable = FALSE)
                   OR (terminal.outcome_kind = 'FAILED' AND terminal.retryable = FALSE)
                 )
            )
            AND NOT EXISTS (
              SELECT 1
                FROM public.financial_provider_command_recovery_leases active_lease
               WHERE active_lease.command_id = command.command_id
                 AND active_lease.expires_at > clock_timestamp()
                 AND NOT EXISTS (
                   SELECT 1
                     FROM public.financial_provider_command_dispatch_attempts consumed_attempt
                    WHERE consumed_attempt.recovery_lease_id = active_lease.recovery_lease_id
                 )
                 AND NOT EXISTS (
                   SELECT 1
                     FROM public.financial_provider_command_outcome_facts consumed_outcome
                    WHERE consumed_outcome.recovery_lease_id = active_lease.recovery_lease_id
                 )
            )
            AND (
              (
                latest_outcome.outcome_fact_id IS NULL
                AND latest_attempt.outcome_deadline_at <= clock_timestamp()
              )
              OR (
                latest_outcome.outcome_kind IN (
                  'OUTCOME_OBSERVED', 'OUTCOME_UNKNOWN', 'FAILED'
                )
                AND latest_outcome.retryable = TRUE
                AND latest_outcome.recovery_not_before <= clock_timestamp()
              )
            )
          ORDER BY
            CASE
              WHEN latest_outcome.recovery_not_before IS NULL
                THEN latest_attempt.outcome_deadline_at
              ELSE latest_outcome.recovery_not_before
            END,
            command.command_id
          FOR UPDATE OF command SKIP LOCKED
          LIMIT 1`,
        [
          input.commandId?.toLowerCase() ?? null,
          excludedCommandIds.map((commandId) => commandId.toLowerCase()),
        ]
      );

      const claims: FinancialProviderCommandRecoveryClaim[] = [];
      for (const candidate of candidates.rows) {
        const lease = await this.insertLease(
          query,
          candidate.command_id,
          candidate.recovery_action,
          input.leaseOwnerId.toLowerCase(),
          leaseDurationSeconds
        );
        claims.push({
          command: commandFromRow(candidate),
          lease,
          lastDispatchAttempt: latestAttemptFromCandidate(candidate),
        });
      }
      return claims;
    });
  }

  async acquireLease(
    input: AcquireFinancialProviderCommandRecoveryLeaseInput
  ): Promise<FinancialProviderCommandRecoveryLease | null> {
    assertUuid(input.commandId);
    assertUuid(input.leaseOwnerId);
    if (!['DISPATCH', 'RECONCILE'].includes(input.recoveryAction)) {
      throw new FinancialProviderCommandRecoveryError('RECOVERY_ACTION_INVALID');
    }
    const leaseDurationSeconds = boundedInteger(
      input.leaseDurationSeconds ?? 60,
      1,
      900,
      'LEASE_DURATION_INVALID'
    );
    const commandId = input.commandId.toLowerCase();
    return this.database.transaction(async (query) => {
      await lockCommand(query, commandId);
      const command = await query<{ provider_kind: string }>(
        `SELECT provider_kind
           FROM public.financial_provider_command_journal
          WHERE command_id=$1`,
        [commandId]
      );
      const providerKind = command.rows[0]?.provider_kind;
      if (!providerKind) throw new FinancialProviderCommandRecoveryError('COMMAND_NOT_FOUND');
      if (providerKind !== 'FAKE') {
        throw new FinancialProviderCommandRecoveryError('APPROVED_PROVIDER_UNAVAILABLE');
      }
      const active = await query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM public.financial_provider_command_recovery_leases lease
            WHERE lease.command_id=$1
              AND lease.expires_at > clock_timestamp()
              AND NOT EXISTS (
                SELECT 1 FROM public.financial_provider_command_dispatch_attempts attempt
                 WHERE attempt.recovery_lease_id=lease.recovery_lease_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.financial_provider_command_outcome_facts outcome
                 WHERE outcome.recovery_lease_id=lease.recovery_lease_id
              )
         ) AS exists`,
        [commandId]
      );
      if (active.rows[0]?.exists) return null;
      return this.insertLease(
        query,
        commandId,
        input.recoveryAction,
        input.leaseOwnerId.toLowerCase(),
        leaseDurationSeconds
      );
    });
  }

  async recordDispatchAttempted(
    input: RecordFinancialProviderCommandDispatchAttemptInput
  ): Promise<FinancialProviderCommandDispatchAttempt> {
    assertUuid(input.commandId);
    assertUuid(input.recoveryLeaseId);
    const outcomeTimeoutSeconds = boundedInteger(
      input.outcomeTimeoutSeconds ?? 30,
      0,
      900,
      'OUTCOME_TIMEOUT_INVALID'
    );
    const commandId = input.commandId.toLowerCase();
    const recoveryLeaseId = input.recoveryLeaseId.toLowerCase();
    return this.database.transaction(async (query) => {
      await lockCommand(query, commandId);
      const existing = await query<AttemptRow>(
        `SELECT ${ATTEMPT_SELECT}
           FROM public.financial_provider_command_dispatch_attempts
          WHERE recovery_lease_id=$1`,
        [recoveryLeaseId]
      );
      const replay = existing.rows[0];
      if (replay) {
        if (
          replay.command_id !== commandId ||
          replay.outcome_timeout_seconds !== outcomeTimeoutSeconds
        ) {
          throw new FinancialProviderCommandRecoveryError('DISPATCH_ATTEMPT_CONFLICT');
        }
        return attemptFromRow(replay, true);
      }

      const inserted = await query<AttemptRow>(
        `WITH timing AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         )
         INSERT INTO public.financial_provider_command_dispatch_attempts (
           command_id, recovery_lease_id, attempt_number, request_sha256,
           outcome_timeout_seconds, attempted_at, outcome_deadline_at
         )
         SELECT $1, $2,
                COALESCE(MAX(previous.attempt_number), 0) + 1,
                command.request_sha256, $3::INTEGER, timing.now,
                timing.now + make_interval(secs => $3::INTEGER)
           FROM public.financial_provider_command_journal command
           CROSS JOIN timing
           LEFT JOIN public.financial_provider_command_dispatch_attempts previous
             ON previous.command_id = command.command_id
          WHERE command.command_id=$1
          GROUP BY command.request_sha256, timing.now
         RETURNING ${ATTEMPT_SELECT}`,
        [commandId, recoveryLeaseId, outcomeTimeoutSeconds]
      );
      const row = inserted.rows[0];
      if (!row) throw new FinancialProviderCommandRecoveryError('PERSISTENCE_INCOMPLETE');
      return attemptFromRow(row, false);
    });
  }

  async recordOutcome(
    input: RecordFinancialProviderCommandOutcomeInput
  ): Promise<FinancialProviderCommandOutcomeFact> {
    const outcome = normalizeOutcome(input);
    return this.database.transaction(async (query) => {
      await lockCommand(query, outcome.commandId);
      const byIdempotency = await query<OutcomeRow>(
        `SELECT ${OUTCOME_SELECT}
           FROM public.financial_provider_command_outcome_facts
          WHERE observation_idempotency_key=$1`,
        [outcome.observationIdempotencyKey]
      );
      const replay = byIdempotency.rows[0];
      if (replay) {
        if (!sameOutcome(replay, outcome) || replay.recovery_lease_id !== outcome.recoveryLeaseId) {
          throw new FinancialProviderCommandRecoveryError('OUTCOME_IDEMPOTENCY_CONFLICT');
        }
        return outcomeFromRow(replay, true);
      }

      if (
        (outcome.outcomeKind === 'OUTCOME_OBSERVED' && !outcome.retryable) ||
        (outcome.outcomeKind === 'FAILED' && !outcome.retryable)
      ) {
        const terminal = await query<OutcomeRow>(
          `SELECT ${OUTCOME_SELECT}
             FROM public.financial_provider_command_outcome_facts
            WHERE command_id=$1
              AND (
                (outcome_kind='OUTCOME_OBSERVED' AND retryable=FALSE)
                OR (outcome_kind='FAILED' AND retryable=FALSE)
              )`,
          [outcome.commandId]
        );
        const existingTerminal = terminal.rows[0];
        if (existingTerminal) {
          throw new FinancialProviderCommandRecoveryError('TERMINAL_OUTCOME_CONFLICT');
        }
      }

      const inserted = await query<OutcomeRow>(
        `WITH timing AS MATERIALIZED (
           SELECT clock_timestamp() AS now
         )
         INSERT INTO public.financial_provider_command_outcome_facts (
           command_id, dispatch_attempt_id, recovery_lease_id, outcome_kind,
           observation_idempotency_key, provider_result_sha256, provider_state,
           provider_result_version, effect_certainty, retryable, failure_code,
           amount_cents, currency, external_reference_sha256,
           recovery_delay_seconds, recovery_not_before, recorded_at
         )
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                $12, $13, $14, $15::INTEGER,
                CASE
                  WHEN $15::INTEGER IS NULL THEN NULL
                  ELSE timing.now + make_interval(secs => $15::INTEGER)
                END,
                timing.now
           FROM timing
         RETURNING ${OUTCOME_SELECT}`,
        [
          outcome.commandId,
          outcome.dispatchAttemptId,
          outcome.recoveryLeaseId,
          outcome.outcomeKind,
          outcome.observationIdempotencyKey,
          outcome.providerResultSha256,
          outcome.providerState,
          outcome.providerResultVersion,
          outcome.effectCertainty,
          outcome.retryable,
          outcome.failureCode,
          outcome.amountCents,
          outcome.currency,
          outcome.externalReferenceSha256,
          outcome.recoveryDelaySeconds,
        ]
      );
      const row = inserted.rows[0];
      if (!row) throw new FinancialProviderCommandRecoveryError('PERSISTENCE_INCOMPLETE');
      return outcomeFromRow(row, false);
    });
  }

  private async insertLease(
    query: QueryFn,
    commandId: string,
    recoveryAction: FinancialProviderCommandRecoveryAction,
    leaseOwnerId: string,
    leaseDurationSeconds: number
  ): Promise<FinancialProviderCommandRecoveryLease> {
    const inserted = await query<LeaseRow>(
      `WITH timing AS MATERIALIZED (
         SELECT clock_timestamp() AS now
       )
       INSERT INTO public.financial_provider_command_recovery_leases (
         command_id, recovery_action, lease_owner_id, lease_duration_seconds,
         acquired_at, expires_at
       )
       SELECT $1, $2, $3, $4::INTEGER, timing.now,
              timing.now + make_interval(secs => $4::INTEGER)
         FROM timing
       RETURNING ${LEASE_SELECT}`,
      [commandId, recoveryAction, leaseOwnerId, leaseDurationSeconds]
    );
    const row = inserted.rows[0];
    if (!row) throw new FinancialProviderCommandRecoveryError('PERSISTENCE_INCOMPLETE');
    return leaseFromRow(row);
  }
}

const PRE_WORK_ORDER_FAKE_OPERATION_KINDS = new Set<FinancialOperationKind>([
  'PREPARE_PAYMENT_METHOD',
  'AUTHORIZE',
  'SECURE',
]);
const WORK_ORDER_REQUIRED_FAKE_OPERATION_KINDS = new Set<FinancialOperationKind>([
  'CAPTURE',
  'REFUND',
  'SETTLE',
  'FUND',
  'PROVIDER_RELEASE',
  'PAYOUT',
  'OBSERVE_BANK_SETTLEMENT',
]);
const LIFECYCLE_FAKE_OPERATION_KINDS = new Set<FinancialOperationKind>([
  ...PRE_WORK_ORDER_FAKE_OPERATION_KINDS,
  ...WORK_ORDER_REQUIRED_FAKE_OPERATION_KINDS,
]);
const PROVIDER_COMMAND_FAKE_OPERATION_KINDS = new Set<FinancialOperationKind>([
  'ONBOARD_PROVIDER',
  'REFRESH_PROVIDER_ACCOUNT_STATE',
]);
const FOREGROUND_FAKE_OPERATION_KINDS = new Set<FinancialOperationKind>([
  ...LIFECYCLE_FAKE_OPERATION_KINDS,
  ...PROVIDER_COMMAND_FAKE_OPERATION_KINDS,
  'RECONCILE',
]);
const FOREGROUND_NONTERMINAL_STATES = new Set<FinancialOperationState>([
  'PENDING',
  'RETRYABLE_FAILURE',
]);
const FOREGROUND_NO_EFFECT_STATES = new Set<FinancialOperationState>([
  'DECLINED',
  'FAILED',
  'REJECTED',
  'MATCHED',
  'MISMATCH',
]);

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Digest contract enforced independently by migration 20260920. */
export function financialProviderOutcomeProjectionSha256(
  result: FinancialOperationResult
): string {
  const canonical = [
    result.operationId,
    result.operationKind,
    result.providerKind,
    result.state,
    String(result.version),
    result.amountCents === null ? '' : String(result.amountCents),
    result.currency ?? '',
    digestText(result.externalReference),
    String(result.retryable),
  ].join(':');
  return digestText(canonical);
}

function observedOutcomeInput(
  command: FinancialProviderCommandRecoveryCommand,
  attempt: FinancialProviderCommandDispatchAttempt,
  recoveryLeaseId: string,
  observationIdempotencyKey: string,
  result: FinancialOperationResult,
  recoveryDelaySeconds: number
): RecordFinancialProviderCommandObservedOutcomeInput {
  const nonterminal = FOREGROUND_NONTERMINAL_STATES.has(result.state);
  return {
    kind: 'OUTCOME_OBSERVED',
    commandId: command.commandId,
    dispatchAttemptId: attempt.dispatchAttemptId,
    recoveryLeaseId,
    observationIdempotencyKey,
    providerResultSha256: financialProviderOutcomeProjectionSha256(result),
    providerState: result.state,
    providerResultVersion: result.version,
    amountCents: result.amountCents,
    currency: result.currency,
    externalReferenceSha256: digestText(result.externalReference),
    effectCertainty: nonterminal
      ? 'UNKNOWN'
      : FOREGROUND_NO_EFFECT_STATES.has(result.state)
        ? 'CONFIRMED_NO_EFFECT'
        : 'CONFIRMED_EFFECT',
    retryable: nonterminal,
    recoveryDelaySeconds: nonterminal ? recoveryDelaySeconds : null,
  };
}

function assertExactObservedOutcome(
  outcome: FinancialProviderCommandOutcomeFact,
  result: FinancialOperationResult
): void {
  const nonterminal = FOREGROUND_NONTERMINAL_STATES.has(result.state);
  const expectedEffect = nonterminal
    ? 'UNKNOWN'
    : FOREGROUND_NO_EFFECT_STATES.has(result.state)
      ? 'CONFIRMED_NO_EFFECT'
      : 'CONFIRMED_EFFECT';
  if (
    outcome.outcomeKind !== 'OUTCOME_OBSERVED' ||
    outcome.providerResultSha256 !== financialProviderOutcomeProjectionSha256(result) ||
    outcome.providerState !== result.state ||
    outcome.providerResultVersion !== result.version ||
    outcome.amountCents !== result.amountCents ||
    outcome.currency !== result.currency ||
    outcome.externalReferenceSha256 !== digestText(result.externalReference) ||
    outcome.effectCertainty !== expectedEffect ||
    outcome.retryable !== nonterminal
  ) {
    throw new Error('FAKE_FINANCIAL_FOREGROUND_OUTCOME_IDENTITY_MISMATCH');
  }
}

function assertExactCommandState<TRequest>(
  context: ForegroundFinancialProviderCommandContext<TRequest>,
  state: FinancialProviderCommandState
): void {
  const command = state.command;
  if (
    context.providerKind !== 'FAKE' ||
    command.providerKind !== 'FAKE' ||
    command.commandId !== context.command.commandId ||
    command.operationKind !== context.operationKind ||
    command.operationId !== context.operationId ||
    command.idempotencyKey !== context.idempotencyKey ||
    command.providerExpectedVersion !== context.providerExpectedVersion ||
    command.requestSha256 !== context.requestSha256 ||
    command.commandIdentitySha256 !== context.command.commandIdentitySha256 ||
    context.command.requestSha256 !== context.requestSha256
  ) {
    throw new Error('FAKE_FINANCIAL_FOREGROUND_REQUEST_IDENTITY_MISMATCH');
  }
  if (LIFECYCLE_FAKE_OPERATION_KINDS.has(command.operationKind)) {
    if (
      !command.preparedFinancialCommandId ||
      !command.preparedAuthoritySha256 ||
      !command.taskDraftId ||
      !command.taskId
    ) {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_LIFECYCLE_AUTHORITY_REQUIRED');
    }
    if (
      PRE_WORK_ORDER_FAKE_OPERATION_KINDS.has(command.operationKind) &&
      command.workOrderId !== null
    ) {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_PRE_WORK_ORDER_BINDING_REQUIRED');
    }
    if (
      WORK_ORDER_REQUIRED_FAKE_OPERATION_KINDS.has(command.operationKind) &&
      command.workOrderId === null
    ) {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_WORK_ORDER_BINDING_REQUIRED');
    }
  } else if (
    command.preparedFinancialCommandId !== null ||
    command.preparedAuthoritySha256 !== null
  ) {
    throw new Error('FAKE_FINANCIAL_FOREGROUND_NON_LIFECYCLE_AUTHORITY_INVALID');
  }
  if (
    PROVIDER_COMMAND_FAKE_OPERATION_KINDS.has(command.operationKind) &&
    (command.taskDraftId !== null ||
      command.taskId !== null ||
      command.workOrderId !== null ||
      command.relatedOperationId !== null ||
      command.amountCents !== null ||
      command.currency !== null)
  ) {
    throw new Error('FAKE_FINANCIAL_FOREGROUND_PROVIDER_COMMAND_BINDING_INVALID');
  }
  if (
    command.operationKind === 'RECONCILE' &&
    (!command.workOrderId ||
      !command.relatedOperationId ||
      command.taskDraftId !== null ||
      command.taskId !== null ||
      command.amountCents !== null ||
      command.currency !== null)
  ) {
    throw new Error('FAKE_FINANCIAL_FOREGROUND_RECONCILIATION_BINDING_REQUIRED');
  }
  if (
    state.lastDispatchAttempt &&
    (state.lastDispatchAttempt.commandId !== command.commandId ||
      state.lastDispatchAttempt.requestSha256 !== command.requestSha256)
  ) {
    throw new Error('FAKE_FINANCIAL_FOREGROUND_ATTEMPT_IDENTITY_MISMATCH');
  }
}

function sameProviderProjection(left: FinancialOperationResult, right: FinancialOperationResult): boolean {
  return (
    financialProviderOutcomeProjectionSha256(left) === financialProviderOutcomeProjectionSha256(right) &&
    left.idempotencyReplayed === right.idempotencyReplayed
  );
}

export interface DurableFakeFinancialProviderCommandCoordinatorOptions {
  readonly leaseOwnerId: string;
  readonly leaseDurationSeconds?: number;
  /** Must outlive the maximum expected synchronous fake-provider DB statement. */
  readonly outcomeTimeoutSeconds?: number;
  readonly recoveryDelaySeconds?: number;
}

/**
 * Nonproduction, fake-only foreground crash boundary for provider commands.
 * Lifecycle commands must carry their exact committed PREPARED authority;
 * pre-assignment security must remain WorkOrder-free and every downstream
 * positive financial state must be bound to the exact WorkOrder derived by
 * PostgreSQL. APPROVED_PROVIDER commands remain deliberately unavailable.
 */
export class DurableFakeFinancialProviderCommandCoordinator
  implements ForegroundFinancialProviderCommandCoordinator {
  private readonly leaseDurationSeconds: number;
  private readonly outcomeTimeoutSeconds: number;
  private readonly recoveryDelaySeconds: number;

  constructor(
    private readonly repository: ForegroundFinancialProviderCommandRepository,
    private readonly fakeEvents: FakeFinancialOperationRepository,
    private readonly options: DurableFakeFinancialProviderCommandCoordinatorOptions
  ) {
    if (!UUID.test(options.leaseOwnerId)) {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_LEASE_OWNER_INVALID');
    }
    this.leaseDurationSeconds = boundedInteger(
      options.leaseDurationSeconds ?? 90,
      2,
      900,
      'LEASE_DURATION_INVALID'
    );
    this.outcomeTimeoutSeconds = boundedInteger(
      options.outcomeTimeoutSeconds ?? 45,
      1,
      Math.min(900, this.leaseDurationSeconds - 1),
      'OUTCOME_TIMEOUT_INVALID'
    );
    this.recoveryDelaySeconds = boundedInteger(
      options.recoveryDelaySeconds ?? 30,
      1,
      86_400,
      'OUTCOME_INVALID'
    );
  }

  async dispatchOrReplay<TRequest, TResult>(
    context: ForegroundFinancialProviderCommandContext<TRequest>,
    invokeAdapter: (exactCanonicalRequest: TRequest) => Promise<TResult>
  ): Promise<ForegroundFinancialProviderCommandResult<TResult>> {
    if (context.providerKind !== 'FAKE') {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_APPROVED_PROVIDER_REFUSED');
    }
    if (!FOREGROUND_FAKE_OPERATION_KINDS.has(context.operationKind)) {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_OPERATION_HELD');
    }
    const state = await this.repository.findCommandState({
      idempotencyKey: context.idempotencyKey,
    });
    if (!state) throw new Error('FAKE_FINANCIAL_FOREGROUND_REQUESTED_NOT_FOUND');
    assertExactCommandState(context, state);

    if (state.latestOutcome?.outcomeKind === 'OUTCOME_OBSERVED') {
      return this.replayObserved(context, state, state.latestOutcome) as unknown as Promise<
        ForegroundFinancialProviderCommandResult<TResult>
      >;
    }
    if (state.latestOutcome && state.latestOutcome.retryable === false) {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_TERMINAL_FAILURE');
    }
    if (state.lastDispatchAttempt) {
      return this.reconcileExistingAttempt(context, state) as unknown as Promise<
        ForegroundFinancialProviderCommandResult<TResult>
      >;
    }
    return this.dispatch(context, state, invokeAdapter);
  }

  private async dispatch<TRequest, TResult>(
    context: ForegroundFinancialProviderCommandContext<TRequest>,
    state: FinancialProviderCommandState,
    invokeAdapter: (exactCanonicalRequest: TRequest) => Promise<TResult>
  ): Promise<ForegroundFinancialProviderCommandResult<TResult>> {
    const lease = await this.repository.acquireLease({
      commandId: state.command.commandId,
      recoveryAction: 'DISPATCH',
      leaseOwnerId: this.options.leaseOwnerId,
      leaseDurationSeconds: this.leaseDurationSeconds,
    });
    if (!lease) throw new Error('FAKE_FINANCIAL_FOREGROUND_DISPATCH_LEASE_UNAVAILABLE');
    const attempt = await this.repository.recordDispatchAttempted({
      commandId: state.command.commandId,
      recoveryLeaseId: lease.recoveryLeaseId,
      outcomeTimeoutSeconds: this.outcomeTimeoutSeconds,
    });
    let adapterResult: TResult;
    try {
      adapterResult = await invokeAdapter(context.exactRequest);
    } catch (error) {
      const reconciled = await this.findAndVerifyEvent(context);
      if (reconciled) {
        const outcome = await this.recordObserved(
          state.command,
          attempt,
          lease.recoveryLeaseId,
          reconciled.result
        );
        return this.coordinatedResult(context, attempt, outcome, reconciled) as unknown as
          ForegroundFinancialProviderCommandResult<TResult>;
      }
      await this.recordUnknown(
        state.command,
        attempt,
        lease.recoveryLeaseId,
        'FAKE_ADAPTER_THROWN'
      );
      throw error;
    }

    const exactEventResult = await this.findAndVerifyEvent(context);
    if (!exactEventResult) {
      await this.recordUnknown(
        state.command,
        attempt,
        lease.recoveryLeaseId,
        'FAKE_EVENT_NOT_FOUND'
      );
      throw new Error('FAKE_FINANCIAL_FOREGROUND_OUTCOME_UNKNOWN');
    }
    if (
      !adapterResult ||
      typeof adapterResult !== 'object' ||
      !sameProviderProjection(
        adapterResult as unknown as FinancialOperationResult,
        exactEventResult.result
      )
    ) {
      await this.recordUnknown(
        state.command,
        attempt,
        lease.recoveryLeaseId,
        'FAKE_RESULT_MISMATCH'
      );
      throw new Error('FAKE_FINANCIAL_FOREGROUND_ADAPTER_RESULT_MISMATCH');
    }
    const outcome = await this.recordObserved(
      state.command,
      attempt,
      lease.recoveryLeaseId,
      exactEventResult.result
    );
    return this.coordinatedResult(context, attempt, outcome, exactEventResult) as unknown as
      ForegroundFinancialProviderCommandResult<TResult>;
  }

  private async replayObserved<TRequest>(
    context: ForegroundFinancialProviderCommandContext<TRequest>,
    state: FinancialProviderCommandState,
    outcome: FinancialProviderCommandOutcomeFact
  ): Promise<ForegroundFinancialProviderCommandResult<FinancialOperationResult>> {
    const event = await this.findAndVerifyEvent(context, true);
    if (!event) throw new Error('FAKE_FINANCIAL_FOREGROUND_REPLAY_EVENT_NOT_FOUND');
    assertExactObservedOutcome(outcome, event.result);
    if (
      !state.lastDispatchAttempt ||
      outcome.commandId !== state.command.commandId ||
      outcome.dispatchAttemptId !== state.lastDispatchAttempt.dispatchAttemptId
    ) {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_REPLAY_OUTCOME_BINDING_INVALID');
    }
    return this.coordinatedResult(context, state.lastDispatchAttempt, outcome, event);
  }

  private async reconcileExistingAttempt<TRequest>(
    context: ForegroundFinancialProviderCommandContext<TRequest>,
    state: FinancialProviderCommandState
  ): Promise<ForegroundFinancialProviderCommandResult<FinancialOperationResult>> {
    const attempt = state.lastDispatchAttempt;
    if (!attempt) throw new Error('FAKE_FINANCIAL_FOREGROUND_ATTEMPT_NOT_FOUND');
    let lease: FinancialProviderCommandRecoveryLease | null;
    try {
      lease = await this.repository.acquireLease({
        commandId: state.command.commandId,
        recoveryAction: 'RECONCILE',
        leaseOwnerId: this.options.leaseOwnerId,
        leaseDurationSeconds: this.leaseDurationSeconds,
      });
    } catch {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_RECONCILIATION_NOT_DUE');
    }
    if (!lease) throw new Error('FAKE_FINANCIAL_FOREGROUND_RECONCILIATION_LEASE_UNAVAILABLE');
    const result = await this.findAndVerifyEvent(context, true);
    if (!result) {
      await this.recordUnknown(state.command, attempt, lease.recoveryLeaseId, 'FAKE_EVENT_NOT_FOUND');
      throw new Error('FAKE_FINANCIAL_FOREGROUND_OUTCOME_UNKNOWN');
    }
    const outcome = await this.recordObserved(
      state.command,
      attempt,
      lease.recoveryLeaseId,
      result.result,
      'finance-reconcile'
    );
    assertExactObservedOutcome(outcome, result.result);
    return this.coordinatedResult(context, attempt, outcome, result);
  }

  private async findAndVerifyEvent<TRequest>(
    context: ForegroundFinancialProviderCommandContext<TRequest>,
    replayed = false
  ): Promise<{ readonly eventId: string; readonly result: FinancialOperationResult } | null> {
    const event = await this.fakeEvents.findByIdempotencyKey(context.idempotencyKey);
    if (!event) return null;
    return {
      eventId: event.eventId,
      result: resultFromExactStoredFakeFinancialOperation(
      event,
      context.operationKind,
      context.exactRequest,
      context.requestSha256,
      replayed
      ),
    };
  }

  private coordinatedResult<TRequest>(
    context: ForegroundFinancialProviderCommandContext<TRequest>,
    attempt: FinancialProviderCommandDispatchAttempt,
    outcome: FinancialProviderCommandOutcomeFact,
    event: { readonly eventId: string; readonly result: FinancialOperationResult }
  ): ForegroundFinancialProviderCommandResult<FinancialOperationResult> {
    const preparedCommandId = context.command.preparedFinancialCommandId;
    if (
      outcome.outcomeKind !== 'OUTCOME_OBSERVED' ||
      outcome.retryable ||
      outcome.commandId !== context.command.commandId ||
      outcome.dispatchAttemptId !== attempt.dispatchAttemptId
    ) {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_BRIDGE_EVIDENCE_INCOMPLETE');
    }
    if (!LIFECYCLE_FAKE_OPERATION_KINDS.has(context.operationKind)) {
      return {
        result: event.result,
        evidence: {
          commandId: context.command.commandId,
          dispatchAttemptId: attempt.dispatchAttemptId,
          outcomeFactId: outcome.outcomeFactId,
          fakeOperationEventId: event.eventId,
        },
      };
    }
    if (!preparedCommandId) {
      throw new Error('FAKE_FINANCIAL_FOREGROUND_BRIDGE_EVIDENCE_INCOMPLETE');
    }
    const evidence: DurableFakeFinancialCommandEvidence = {
      preparedCommandId,
      commandId: context.command.commandId,
      dispatchAttemptId: attempt.dispatchAttemptId,
      outcomeFactId: outcome.outcomeFactId,
      fakeOperationEventId: event.eventId,
    };
    return {
      result: event.result,
      evidence,
    };
  }

  private recordObserved(
    command: FinancialProviderCommandRecoveryCommand,
    attempt: FinancialProviderCommandDispatchAttempt,
    recoveryLeaseId: string,
    result: FinancialOperationResult,
    prefix = 'finance-foreground'
  ): Promise<FinancialProviderCommandOutcomeFact> {
    return this.repository.recordOutcome(
      observedOutcomeInput(
        command,
        attempt,
        recoveryLeaseId,
        `${prefix}:${recoveryLeaseId}`,
        result,
        this.recoveryDelaySeconds
      )
    );
  }

  private recordUnknown(
    command: FinancialProviderCommandRecoveryCommand,
    attempt: FinancialProviderCommandDispatchAttempt,
    recoveryLeaseId: string,
    failureCode: string
  ): Promise<FinancialProviderCommandOutcomeFact> {
    return this.repository.recordOutcome({
      kind: 'OUTCOME_UNKNOWN',
      commandId: command.commandId,
      dispatchAttemptId: attempt.dispatchAttemptId,
      recoveryLeaseId,
      observationIdempotencyKey: `finance-unknown:${recoveryLeaseId}`,
      failureCode,
      recoveryDelaySeconds: this.recoveryDelaySeconds,
    });
  }
}
