import { createHash } from 'node:crypto';

import { db, type Database, type QueryFn } from '../../db.js';
import type { FinancialOperationKind, FinancialProviderKind } from './FinancialProviderPorts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,128}$/u;
const RELEASE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{7,127}$/u;
const REVISION = /^[0-9a-f]{40}$/u;
const MAX_CANONICAL_REQUEST_BYTES = 65_536;

const OPERATION_KINDS = new Set<FinancialOperationKind>([
  'PREPARE_PAYMENT_METHOD',
  'AUTHORIZE',
  'SECURE',
  'VOID',
  'ADJUST',
  'CAPTURE',
  'REFUND',
  'REVERSAL',
  'ONBOARD_PROVIDER',
  'REFRESH_PROVIDER_ACCOUNT_STATE',
  'SETTLE',
  'FUND',
  'PROVIDER_RELEASE',
  'PAYOUT',
  'OBSERVE_BANK_SETTLEMENT',
  'INGEST_WEBHOOK',
  'RECONCILE',
]);

const LIFECYCLE_OPERATION_KINDS = new Set<FinancialOperationKind>([
  'PREPARE_PAYMENT_METHOD',
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

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

export type FinancialProviderCommandActorKind =
  | 'NAMED_OPERATOR'
  | 'SERVICE_PRINCIPAL'
  | 'PARTICIPANT';
export type FinancialProviderCommandReleaseEnvironment =
  | 'local'
  | 'preview'
  | 'staging'
  | 'production';
export type FinancialProviderCommandReleaseAuthenticationStatus =
  | 'VERIFIED'
  | 'MISSING'
  | 'INVALID'
  | 'UNTRUSTED_KEY';

export interface FinancialProviderCommandSafeEvidence {
  readonly preparedFinancialCommandId?: string;
  readonly preparedAuthoritySha256?: string;
  readonly taskDraftId?: string;
  readonly taskId?: string;
  readonly workOrderId?: string;
  readonly relatedOperationId?: string;
  readonly amountCents?: number;
  readonly currency?: string;
}

export interface FinancialProviderCommandActorEvidence {
  readonly actorId: string;
  readonly actorKind: FinancialProviderCommandActorKind;
}

export interface FinancialProviderCommandReleaseEvidence {
  readonly manifestDigest: string;
  readonly releaseId: string;
  readonly revision: string;
  readonly environment: FinancialProviderCommandReleaseEnvironment;
  readonly authenticationStatus: FinancialProviderCommandReleaseAuthenticationStatus;
}

export interface RecordFinancialProviderCommandInput<TRequest = unknown> {
  readonly operationKind: FinancialOperationKind;
  readonly operationId: string;
  readonly providerKind: FinancialProviderKind;
  readonly idempotencyKey: string;
  readonly providerExpectedVersion: number;
  /**
   * Exact adapter request, canonicalized and hashed in memory. The journal
   * intentionally does not persist this value or any provider secrets in it.
   */
  readonly exactRequest: TRequest;
  readonly evidence?: FinancialProviderCommandSafeEvidence;
  readonly actor?: FinancialProviderCommandActorEvidence;
  readonly release?: FinancialProviderCommandReleaseEvidence;
}

export interface FinancialProviderCommandReceipt {
  readonly commandId: string;
  readonly operationKind: FinancialOperationKind;
  readonly operationId: string;
  readonly providerKind: FinancialProviderKind;
  readonly idempotencyKey: string;
  readonly providerExpectedVersion: number;
  readonly requestSha256: string;
  readonly commandIdentitySha256: string;
  readonly preparedFinancialCommandId: string | null;
  readonly preparedAuthoritySha256: string | null;
  readonly recordedAt: string;
  readonly idempotencyReplayed: boolean;
}

export type FinancialProviderCommandJournalErrorReason =
  | 'OPERATION_KIND_INVALID'
  | 'OPERATION_ID_INVALID'
  | 'PROVIDER_KIND_INVALID'
  | 'IDEMPOTENCY_KEY_INVALID'
  | 'PROVIDER_EXPECTED_VERSION_INVALID'
  | 'REQUEST_INVALID'
  | 'REQUEST_TOO_LARGE'
  | 'EVIDENCE_INVALID'
  | 'ACTOR_EVIDENCE_INVALID'
  | 'RELEASE_EVIDENCE_INVALID'
  | 'APPROVED_PROVIDER_EVIDENCE_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OPERATION_VERSION_CONFLICT'
  | 'PERSISTENCE_INCOMPLETE'
  | 'PERSISTENCE_IDENTITY_MISMATCH'
  | 'REQUEST_REPLAY_ADAPTER_REFUSED'
  | 'FOREGROUND_DISPATCH_COORDINATOR_REQUIRED';

export class FinancialProviderCommandJournalError extends Error {
  constructor(readonly reason: FinancialProviderCommandJournalErrorReason) {
    super(`FINANCIAL_PROVIDER_COMMAND_JOURNAL_${reason}`);
    this.name = 'FinancialProviderCommandJournalError';
  }
}

export interface FinancialProviderCommandJournal {
  /** Resolves only after the immutable REQUESTED record has committed. */
  recordRequested<TRequest>(
    input: RecordFinancialProviderCommandInput<TRequest>
  ): Promise<FinancialProviderCommandReceipt>;
}

export interface ForegroundFinancialProviderCommandContext<TRequest> {
  readonly command: FinancialProviderCommandReceipt;
  readonly operationKind: FinancialOperationKind;
  readonly operationId: string;
  readonly providerKind: FinancialProviderKind;
  readonly idempotencyKey: string;
  readonly providerExpectedVersion: number;
  readonly exactRequest: TRequest;
  readonly requestSha256: string;
}

export interface DurableFakeFinancialCommandEvidence {
  readonly preparedCommandId: string;
  readonly commandId: string;
  readonly dispatchAttemptId: string;
  readonly outcomeFactId: string;
  readonly fakeOperationEventId: string;
}

export interface ForegroundFinancialProviderCommandResult<TResult> {
  readonly result: TResult;
  readonly evidence: DurableFakeFinancialCommandEvidence;
}

/**
 * Optional, fake-only runtime coordinator. Implementations must durably record
 * DISPATCH_ATTEMPTED before adapter entry and an exact outcome before return.
 */
export interface ForegroundFinancialProviderCommandCoordinator {
  dispatchOrReplay<TRequest, TResult>(
    context: ForegroundFinancialProviderCommandContext<TRequest>,
    invokeAdapter: (exactCanonicalRequest: TRequest) => Promise<TResult>
  ): Promise<ForegroundFinancialProviderCommandResult<TResult>>;
}

interface NormalizedEvidence {
  preparedFinancialCommandId: string | null;
  preparedAuthoritySha256: string | null;
  taskDraftId: string | null;
  taskId: string | null;
  workOrderId: string | null;
  relatedOperationId: string | null;
  amountCents: number | null;
  currency: string | null;
}

interface NormalizedActor {
  actorId: string;
  actorKind: FinancialProviderCommandActorKind;
}

interface NormalizedRelease {
  manifestDigest: string;
  releaseId: string;
  revision: string;
  environment: FinancialProviderCommandReleaseEnvironment;
  authenticationStatus: FinancialProviderCommandReleaseAuthenticationStatus;
}

interface PreparedFinancialProviderCommand {
  operationKind: FinancialOperationKind;
  operationId: string;
  providerKind: FinancialProviderKind;
  idempotencyKey: string;
  providerExpectedVersion: number;
  canonicalRequestJson: string;
  requestSha256: string;
  commandIdentitySha256: string;
  evidence: NormalizedEvidence;
  actor: NormalizedActor | null;
  release: NormalizedRelease | null;
}

interface CommandRow {
  command_id: string;
  operation_kind: FinancialOperationKind;
  operation_id: string;
  provider_kind: FinancialProviderKind;
  idempotency_key: string;
  provider_expected_version: string | number;
  request_sha256: string;
  command_identity_sha256: string;
  prepared_financial_command_id: string | null;
  prepared_authority_sha256: string | null;
  recorded_at: Date | string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function invalidRequest(): never {
  throw new FinancialProviderCommandJournalError('REQUEST_INVALID');
}

function canonicalize(
  value: unknown,
  ancestors: Set<object>,
  allowUndefined: boolean
): CanonicalJson | undefined {
  if (value === undefined) {
    if (allowUndefined) return undefined;
    return invalidRequest();
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) return invalidRequest();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') return invalidRequest();
  if (ancestors.has(value)) return invalidRequest();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        const normalized = canonicalize(entry, ancestors, false);
        if (normalized === undefined) return invalidRequest();
        return normalized;
      });
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return invalidRequest();
    if (Object.getOwnPropertySymbols(value).length > 0) return invalidRequest();
    const normalized: { [key: string]: CanonicalJson } = {};
    for (const key of Object.keys(value).sort()) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        return invalidRequest();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || descriptor.get || descriptor.set) return invalidRequest();
      const child = canonicalize(descriptor.value, ancestors, true);
      if (child !== undefined) normalized[key] = child;
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

function exactCanonicalRequest(value: unknown): string {
  const normalized = canonicalize(value, new Set<object>(), false);
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') {
    return invalidRequest();
  }
  const json = JSON.stringify(normalized);
  if (Buffer.byteLength(json, 'utf8') > MAX_CANONICAL_REQUEST_BYTES) {
    throw new FinancialProviderCommandJournalError('REQUEST_TOO_LARGE');
  }
  return json;
}

/** Exact digest shared by PREPARED and REQUESTED authority boundaries. */
export function canonicalFinancialProviderRequestSha256(exactRequest: unknown): string {
  return sha256(exactCanonicalRequest(exactRequest));
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function normalizeEvidence(
  evidence: FinancialProviderCommandSafeEvidence | undefined
): NormalizedEvidence {
  const normalized: NormalizedEvidence = {
    preparedFinancialCommandId: evidence?.preparedFinancialCommandId ?? null,
    preparedAuthoritySha256: evidence?.preparedAuthoritySha256 ?? null,
    taskDraftId: evidence?.taskDraftId ?? null,
    taskId: evidence?.taskId ?? null,
    workOrderId: evidence?.workOrderId ?? null,
    relatedOperationId: evidence?.relatedOperationId ?? null,
    amountCents: evidence?.amountCents ?? null,
    currency: evidence?.currency?.toUpperCase() ?? null,
  };
  for (const id of [
    normalized.preparedFinancialCommandId,
    normalized.taskDraftId,
    normalized.taskId,
    normalized.workOrderId,
    normalized.relatedOperationId,
  ]) {
    if (id !== null && !validUuid(id)) {
      throw new FinancialProviderCommandJournalError('EVIDENCE_INVALID');
    }
  }
  if (
    (normalized.preparedFinancialCommandId === null) !==
      (normalized.preparedAuthoritySha256 === null) ||
    (normalized.preparedAuthoritySha256 !== null &&
      !/^[a-f0-9]{64}$/u.test(normalized.preparedAuthoritySha256)) ||
    (normalized.amountCents === null) !== (normalized.currency === null) ||
    (normalized.amountCents !== null &&
      (!Number.isSafeInteger(normalized.amountCents) || normalized.amountCents < 0)) ||
    (normalized.currency !== null && !/^[A-Z]{3}$/u.test(normalized.currency))
  ) {
    throw new FinancialProviderCommandJournalError('EVIDENCE_INVALID');
  }
  return normalized;
}

function normalizeActor(
  actor: FinancialProviderCommandActorEvidence | undefined
): NormalizedActor | null {
  if (!actor) return null;
  if (
    !validUuid(actor.actorId) ||
    !['NAMED_OPERATOR', 'SERVICE_PRINCIPAL', 'PARTICIPANT'].includes(actor.actorKind)
  ) {
    throw new FinancialProviderCommandJournalError('ACTOR_EVIDENCE_INVALID');
  }
  return { actorId: actor.actorId.toLowerCase(), actorKind: actor.actorKind };
}

function normalizeRelease(
  release: FinancialProviderCommandReleaseEvidence | undefined
): NormalizedRelease | null {
  if (!release) return null;
  if (
    !RELEASE_DIGEST.test(release.manifestDigest) ||
    release.manifestDigest === `sha256:${'0'.repeat(64)}` ||
    !RELEASE_ID.test(release.releaseId) ||
    !REVISION.test(release.revision) ||
    /^0{40}$/u.test(release.revision) ||
    !['local', 'preview', 'staging', 'production'].includes(release.environment) ||
    !['VERIFIED', 'MISSING', 'INVALID', 'UNTRUSTED_KEY'].includes(release.authenticationStatus)
  ) {
    throw new FinancialProviderCommandJournalError('RELEASE_EVIDENCE_INVALID');
  }
  return {
    manifestDigest: release.manifestDigest,
    releaseId: release.releaseId,
    revision: release.revision,
    environment: release.environment,
    authenticationStatus: release.authenticationStatus,
  };
}

function prepareFinancialProviderCommand<TRequest>(
  input: RecordFinancialProviderCommandInput<TRequest>
): PreparedFinancialProviderCommand {
  if (!OPERATION_KINDS.has(input.operationKind)) {
    throw new FinancialProviderCommandJournalError('OPERATION_KIND_INVALID');
  }
  if (!validUuid(input.operationId)) {
    throw new FinancialProviderCommandJournalError('OPERATION_ID_INVALID');
  }
  if (!['FAKE', 'APPROVED_PROVIDER'].includes(input.providerKind)) {
    throw new FinancialProviderCommandJournalError('PROVIDER_KIND_INVALID');
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new FinancialProviderCommandJournalError('IDEMPOTENCY_KEY_INVALID');
  }
  if (!Number.isSafeInteger(input.providerExpectedVersion) || input.providerExpectedVersion < 0) {
    throw new FinancialProviderCommandJournalError('PROVIDER_EXPECTED_VERSION_INVALID');
  }
  const canonicalRequestJson = exactCanonicalRequest(input.exactRequest);
  const requestSha256 = sha256(canonicalRequestJson);
  const evidence = normalizeEvidence(input.evidence);
  const actor = normalizeActor(input.actor);
  const release = normalizeRelease(input.release);
  if (
    input.providerKind === 'APPROVED_PROVIDER' &&
    (!actor || !release || release.authenticationStatus !== 'VERIFIED')
  ) {
    throw new FinancialProviderCommandJournalError('APPROVED_PROVIDER_EVIDENCE_REQUIRED');
  }
  const identity = {
    schemaVersion: 1,
    operationKind: input.operationKind,
    operationId: input.operationId.toLowerCase(),
    providerKind: input.providerKind,
    idempotencyKey: input.idempotencyKey,
    providerExpectedVersion: input.providerExpectedVersion,
    requestSha256,
    evidence,
    actor,
    release,
  };
  return {
    ...identity,
    canonicalRequestJson,
    commandIdentitySha256: sha256(JSON.stringify(identity)),
  };
}

function operationVersionKey(command: PreparedFinancialProviderCommand): string {
  return [
    command.providerKind,
    command.operationKind,
    command.operationId,
    String(command.providerExpectedVersion),
  ].join(':');
}

function receiptFromRow(
  row: CommandRow,
  idempotencyReplayed: boolean
): FinancialProviderCommandReceipt {
  return {
    commandId: row.command_id,
    operationKind: row.operation_kind,
    operationId: row.operation_id,
    providerKind: row.provider_kind,
    idempotencyKey: row.idempotency_key,
    providerExpectedVersion: Number(row.provider_expected_version),
    requestSha256: row.request_sha256,
    commandIdentitySha256: row.command_identity_sha256,
    preparedFinancialCommandId: row.prepared_financial_command_id,
    preparedAuthoritySha256: row.prepared_authority_sha256,
    recordedAt: new Date(row.recorded_at).toISOString(),
    idempotencyReplayed,
  };
}

function assertStoredIdentity(
  row: CommandRow,
  command: PreparedFinancialProviderCommand,
  conflict: 'IDEMPOTENCY_CONFLICT' | 'OPERATION_VERSION_CONFLICT' | 'PERSISTENCE_IDENTITY_MISMATCH'
): void {
  if (row.command_identity_sha256 !== command.commandIdentitySha256) {
    throw new FinancialProviderCommandJournalError(conflict);
  }
}

const COMMAND_SELECT = `
  command_id, operation_kind, operation_id, provider_kind, idempotency_key,
  provider_expected_version, request_sha256, command_identity_sha256,
  prepared_financial_command_id, prepared_authority_sha256, recorded_at`;

/**
 * PostgreSQL command journal. Do not wrap this repository in a caller-owned
 * transaction: `recordRequested` must return only after its own commit so the
 * provider callback cannot race an uncommitted command fact.
 */
export class PostgresFinancialProviderCommandJournal implements FinancialProviderCommandJournal {
  constructor(private readonly database: Database = db) {}

  async recordRequested<TRequest>(
    input: RecordFinancialProviderCommandInput<TRequest>
  ): Promise<FinancialProviderCommandReceipt> {
    const command = prepareFinancialProviderCommand(input);
    return this.database.transaction(async (query) => this.recordInTransaction(query, command));
  }

  private async recordInTransaction(
    query: QueryFn,
    command: PreparedFinancialProviderCommand
  ): Promise<FinancialProviderCommandReceipt> {
    const locks = [
      `idempotency:${command.idempotencyKey}`,
      `operation-version:${operationVersionKey(command)}`,
    ].sort();
    for (const lock of locks) {
      await query(
        `SELECT pg_advisory_xact_lock(
           hashtext('financial-provider-command-journal-v1'), hashtext($1)
         )`,
        [lock]
      );
    }

    const byIdempotency = await query<CommandRow>(
      `SELECT ${COMMAND_SELECT}
         FROM public.financial_provider_command_journal
        WHERE idempotency_key=$1`,
      [command.idempotencyKey]
    );
    const replay = byIdempotency.rows[0];
    if (replay) {
      assertStoredIdentity(replay, command, 'IDEMPOTENCY_CONFLICT');
      return receiptFromRow(replay, true);
    }

    const byOperationVersion = await query<CommandRow>(
      `SELECT ${COMMAND_SELECT}
         FROM public.financial_provider_command_journal
        WHERE provider_kind=$1
          AND operation_kind=$2
          AND operation_id=$3
          AND provider_expected_version=$4`,
      [
        command.providerKind,
        command.operationKind,
        command.operationId,
        command.providerExpectedVersion,
      ]
    );
    const occupiedOperationVersion = byOperationVersion.rows[0];
    if (occupiedOperationVersion) {
      assertStoredIdentity(occupiedOperationVersion, command, 'OPERATION_VERSION_CONFLICT');
      return receiptFromRow(occupiedOperationVersion, true);
    }

    const inserted = await query<CommandRow>(
      `INSERT INTO public.financial_provider_command_journal (
         operation_kind, operation_id, provider_kind, idempotency_key,
         provider_expected_version, request_sha256, command_identity_sha256,
         prepared_financial_command_id, prepared_authority_sha256,
         task_draft_id, task_id, work_order_id, related_operation_id,
         amount_cents, currency, recorded_actor_id, recorded_actor_kind,
         release_manifest_digest, release_id, release_revision,
         release_environment, release_authentication_status
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
       )
       RETURNING ${COMMAND_SELECT}`,
      [
        command.operationKind,
        command.operationId,
        command.providerKind,
        command.idempotencyKey,
        command.providerExpectedVersion,
        command.requestSha256,
        command.commandIdentitySha256,
        command.evidence.preparedFinancialCommandId,
        command.evidence.preparedAuthoritySha256,
        command.evidence.taskDraftId,
        command.evidence.taskId,
        command.evidence.workOrderId,
        command.evidence.relatedOperationId,
        command.evidence.amountCents,
        command.evidence.currency,
        command.actor?.actorId ?? null,
        command.actor?.actorKind ?? null,
        command.release?.manifestDigest ?? null,
        command.release?.releaseId ?? null,
        command.release?.revision ?? null,
        command.release?.environment ?? null,
        command.release?.authenticationStatus ?? null,
      ]
    );
    const row = inserted.rows[0];
    if (!row) {
      throw new FinancialProviderCommandJournalError('PERSISTENCE_INCOMPLETE');
    }
    assertStoredIdentity(row, command, 'PERSISTENCE_IDENTITY_MISMATCH');
    return receiptFromRow(row, false);
  }
}

interface InMemoryCommandRecord {
  receipt: FinancialProviderCommandReceipt;
  commandIdentitySha256: string;
}

/** Deterministic test/local implementation. It retains hashes and safe receipt metadata only. */
export class InMemoryFinancialProviderCommandJournal implements FinancialProviderCommandJournal {
  private readonly byIdempotency = new Map<string, InMemoryCommandRecord>();
  private readonly byOperationVersion = new Map<string, InMemoryCommandRecord>();
  private sequence = 0;

  constructor(private readonly now: () => Date = () => new Date()) {}

  async recordRequested<TRequest>(
    input: RecordFinancialProviderCommandInput<TRequest>
  ): Promise<FinancialProviderCommandReceipt> {
    const command = prepareFinancialProviderCommand(input);
    const replay = this.byIdempotency.get(command.idempotencyKey);
    if (replay) {
      if (replay.commandIdentitySha256 !== command.commandIdentitySha256) {
        throw new FinancialProviderCommandJournalError('IDEMPOTENCY_CONFLICT');
      }
      return { ...replay.receipt, idempotencyReplayed: true };
    }
    const operationKey = operationVersionKey(command);
    const occupiedOperationVersion = this.byOperationVersion.get(operationKey);
    if (occupiedOperationVersion) {
      throw new FinancialProviderCommandJournalError('OPERATION_VERSION_CONFLICT');
    }
    this.sequence += 1;
    const commandId = `00000000-0000-4000-8000-${String(this.sequence).padStart(12, '0')}`;
    const receipt: FinancialProviderCommandReceipt = {
      commandId,
      operationKind: command.operationKind,
      operationId: command.operationId,
      providerKind: command.providerKind,
      idempotencyKey: command.idempotencyKey,
      providerExpectedVersion: command.providerExpectedVersion,
      requestSha256: command.requestSha256,
      commandIdentitySha256: command.commandIdentitySha256,
      preparedFinancialCommandId: command.evidence.preparedFinancialCommandId,
      preparedAuthoritySha256: command.evidence.preparedAuthoritySha256,
      recordedAt: this.now().toISOString(),
      idempotencyReplayed: false,
    };
    const record = { receipt, commandIdentitySha256: command.commandIdentitySha256 };
    this.byIdempotency.set(command.idempotencyKey, record);
    this.byOperationVersion.set(operationKey, record);
    return receipt;
  }
}

export interface JournaledFinancialProviderInvocation<TResult> {
  readonly command: FinancialProviderCommandReceipt;
  readonly result: TResult;
  readonly evidence?: DurableFakeFinancialCommandEvidence;
}

/**
 * The only orchestration primitive in this module: await durable commitment,
 * verify the exact receipt, and only then enter the adapter callback. It does
 * not select an adapter or grant a capability.
 */
export class JournaledFinancialProviderInvoker {
  constructor(
    private readonly journal: FinancialProviderCommandJournal,
    private readonly foregroundCoordinator?: ForegroundFinancialProviderCommandCoordinator
  ) {}

  hasForegroundCoordinator(): boolean {
    return this.foregroundCoordinator !== undefined;
  }

  async invokeAfterCommit<TRequest, TResult>(
    input: RecordFinancialProviderCommandInput<TRequest>,
    invokeAdapter: (
      exactCanonicalRequest: TRequest,
      receipt: FinancialProviderCommandReceipt
    ) => Promise<TResult>
  ): Promise<JournaledFinancialProviderInvocation<TResult>> {
    const prepared = prepareFinancialProviderCommand(input);
    const receipt = await this.journal.recordRequested(input);
    if (
      receipt.requestSha256 !== prepared.requestSha256 ||
      receipt.commandIdentitySha256 !== prepared.commandIdentitySha256
    ) {
      throw new FinancialProviderCommandJournalError('PERSISTENCE_IDENTITY_MISMATCH');
    }
    const exactCanonicalRequest = JSON.parse(prepared.canonicalRequestJson) as TRequest;
    if (this.foregroundCoordinator) {
      const coordinated = await this.foregroundCoordinator.dispatchOrReplay(
        {
          command: receipt,
          operationKind: input.operationKind,
          operationId: input.operationId.toLowerCase(),
          providerKind: input.providerKind,
          idempotencyKey: input.idempotencyKey,
          providerExpectedVersion: input.providerExpectedVersion,
          exactRequest: exactCanonicalRequest,
          requestSha256: prepared.requestSha256,
        },
        (request) => invokeAdapter(request, receipt)
      );
      return { command: receipt, result: coordinated.result, evidence: coordinated.evidence };
    }
    if (receipt.idempotencyReplayed) {
      throw new FinancialProviderCommandJournalError('REQUEST_REPLAY_ADAPTER_REFUSED');
    }
    if (LIFECYCLE_OPERATION_KINDS.has(input.operationKind)) {
      throw new FinancialProviderCommandJournalError(
        'FOREGROUND_DISPATCH_COORDINATOR_REQUIRED'
      );
    }
    const result = await invokeAdapter(exactCanonicalRequest, receipt);
    return { command: receipt, result };
  }
}
