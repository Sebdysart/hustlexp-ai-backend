import { createHash } from 'node:crypto';
import { z } from 'zod';
import { FakeFinancialPreparationPayloadSchema } from '../../auth/financial-preparation-command-contract.js';
import {
  UniversalV1ActorAttestationResponseSchema,
  type UniversalV1ActorAttestationHandle,
} from '../../auth/universal-v1-actor-attestation-contracts.js';

import { db, type Database } from '../../db.js';
import type { FinancialOperationKind, FinancialProviderKind } from './FinancialProviderPorts.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,128}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type PreparedFinancialOperationKind = Exclude<
  FinancialOperationKind,
  'ONBOARD_PROVIDER' | 'REFRESH_PROVIDER_ACCOUNT_STATE' | 'INGEST_WEBHOOK' | 'RECONCILE'
>;

const OPERATION_KINDS = new Set<PreparedFinancialOperationKind>([
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

export interface PrepareUniversalV1FinancialCommandInput {
  readonly operationKind: PreparedFinancialOperationKind;
  readonly operationId: string;
  readonly providerKind: FinancialProviderKind;
  readonly idempotencyKey: string;
  readonly providerExpectedVersion: number;
  readonly lifecycleExpectedVersion: number;
  readonly providerRequestSha256: string;
  readonly taskDraftId: string;
  readonly taskId: string | null;
  readonly eligibilityDecisionId: string | null;
  readonly scopeVersionId: string | null;
  readonly changeOrderId: string | null;
  readonly predecessorEventId: string | null;
  readonly completionFactId: string | null;
  readonly relatedOperationId: string | null;
  readonly amountCents: number | null;
  readonly currency: string | null;
  readonly recordedBy: string;
}

export interface PreparedUniversalV1FinancialCommandReceipt extends PrepareUniversalV1FinancialCommandInput {
  readonly preparedCommandId: string;
  readonly commandState: 'PREPARED';
  readonly eventKind:
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
  readonly eligibilityDecisionVersion: number | null;
  readonly eligibilityValidUntil: string | null;
  readonly scopeVersion: number | null;
  readonly scopeHash: string | null;
  readonly workOrderId: string | null;
  readonly workOrderMaterializationVersion: number | null;
  readonly workOrderExecutionContractVersion: number | null;
  readonly changeOrderVersion: number | null;
  readonly completionVersion: number | null;
  readonly predecessorOperationId: string | null;
  readonly predecessorEventKind: string | null;
  readonly predecessorStatus: string | null;
  readonly predecessorLifecycleVersion: number | null;
  readonly requestIdentitySha256: string;
  readonly authorityContextSha256: string;
  /** Database-owned workflow timestamp; never copied from the caller command. */
  readonly occurredAt: string;
  readonly preparedAt: string;
  readonly idempotencyReplayed: boolean;
}

export type PreparedFinancialCommandAuthorityErrorReason =
  | 'ACTOR_ATTESTATION_REQUIRED'
  | 'ACTOR_ATTESTATION_INVALID'
  | 'OPERATION_KIND_INVALID'
  | 'OPERATION_ID_INVALID'
  | 'APPROVED_PROVIDER_REFUSED'
  | 'IDEMPOTENCY_KEY_INVALID'
  | 'PROVIDER_EXPECTED_VERSION_INVALID'
  | 'LIFECYCLE_EXPECTED_VERSION_INVALID'
  | 'PROVIDER_REQUEST_SHA256_INVALID'
  | 'BINDING_INVALID'
  | 'AMOUNT_CURRENCY_INVALID'
  | 'IDEMPOTENCY_CONFLICT'
  | 'OPERATION_VERSION_CONFLICT'
  | 'LIFECYCLE_VERSION_CONFLICT'
  | 'REPLAY_FOREGROUND_COORDINATOR_REQUIRED'
  | 'PERSISTENCE_INCOMPLETE'
  | 'PERSISTENCE_IDENTITY_MISMATCH';

export class PreparedFinancialCommandAuthorityError extends Error {
  constructor(readonly reason: PreparedFinancialCommandAuthorityErrorReason) {
    super(`UNIVERSAL_V1_PREPARED_FINANCIAL_COMMAND_${reason}`);
    this.name = 'PreparedFinancialCommandAuthorityError';
  }
}

export interface UniversalV1PreparedFinancialCommandAuthority {
  /** Resolves only after the database-validated PREPARED fact has committed. */
  prepare(
    input: PrepareUniversalV1FinancialCommandInput,
    attestation?: UniversalV1ActorAttestationHandle
  ): Promise<PreparedUniversalV1FinancialCommandReceipt>;
}

interface PreparedCommandRow {
  prepared_command_id: string;
  command_state: 'PREPARED';
  operation_kind: PreparedFinancialOperationKind;
  event_kind: PreparedUniversalV1FinancialCommandReceipt['eventKind'];
  operation_id: string;
  provider_kind: FinancialProviderKind;
  idempotency_key: string;
  provider_expected_version: string | number;
  lifecycle_expected_version: string | number;
  provider_request_sha256: string;
  task_draft_id: string;
  task_id: string | null;
  eligibility_decision_id: string | null;
  eligibility_decision_version: number | null;
  eligibility_valid_until: Date | string | null;
  scope_version_id: string | null;
  scope_version: number | null;
  scope_hash: string | null;
  work_order_id: string | null;
  work_order_materialization_version: number | null;
  work_order_execution_contract_version: number | null;
  change_order_id: string | null;
  change_order_version: number | null;
  predecessor_event_id: string | null;
  predecessor_operation_id: string | null;
  predecessor_event_kind: string | null;
  predecessor_status: string | null;
  predecessor_lifecycle_version: string | number | null;
  completion_fact_id: string | null;
  completion_version: number | null;
  related_operation_id: string | null;
  amount_cents: string | number | null;
  currency: string | null;
  recorded_by: string;
  occurred_at: Date | string;
  request_identity_sha256: string;
  authority_context_sha256: string;
  prepared_at: Date | string;
}

type NormalizedInput = PrepareUniversalV1FinancialCommandInput;

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function normalizedUuid(value: string | null): string | null {
  return value?.toLowerCase() ?? null;
}

function normalizeInput(input: PrepareUniversalV1FinancialCommandInput): NormalizedInput {
  if (!OPERATION_KINDS.has(input.operationKind)) {
    throw new PreparedFinancialCommandAuthorityError('OPERATION_KIND_INVALID');
  }
  if (!validUuid(input.operationId)) {
    throw new PreparedFinancialCommandAuthorityError('OPERATION_ID_INVALID');
  }
  if (input.providerKind !== 'FAKE') {
    throw new PreparedFinancialCommandAuthorityError('APPROVED_PROVIDER_REFUSED');
  }
  if (!IDEMPOTENCY_KEY.test(input.idempotencyKey)) {
    throw new PreparedFinancialCommandAuthorityError('IDEMPOTENCY_KEY_INVALID');
  }
  if (!Number.isSafeInteger(input.providerExpectedVersion) || input.providerExpectedVersion < 0) {
    throw new PreparedFinancialCommandAuthorityError('PROVIDER_EXPECTED_VERSION_INVALID');
  }
  if (!Number.isSafeInteger(input.lifecycleExpectedVersion) || input.lifecycleExpectedVersion < 0) {
    throw new PreparedFinancialCommandAuthorityError('LIFECYCLE_EXPECTED_VERSION_INVALID');
  }
  if (!SHA256.test(input.providerRequestSha256)) {
    throw new PreparedFinancialCommandAuthorityError('PROVIDER_REQUEST_SHA256_INVALID');
  }
  for (const value of [
    input.taskDraftId,
    input.recordedBy,
    input.taskId,
    input.eligibilityDecisionId,
    input.scopeVersionId,
    input.changeOrderId,
    input.predecessorEventId,
    input.completionFactId,
    input.relatedOperationId,
  ]) {
    if (value !== null && !validUuid(value)) {
      throw new PreparedFinancialCommandAuthorityError('BINDING_INVALID');
    }
  }
  if (
    (input.amountCents === null) !== (input.currency === null) ||
    (input.amountCents !== null &&
      (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)) ||
    (input.currency !== null && !/^[A-Za-z]{3}$/u.test(input.currency))
  ) {
    throw new PreparedFinancialCommandAuthorityError('AMOUNT_CURRENCY_INVALID');
  }
  const taskBindings = [input.taskId, input.eligibilityDecisionId, input.scopeVersionId];
  if (input.operationKind === 'PREPARE_PAYMENT_METHOD') {
    if (
      input.providerExpectedVersion !== 0 ||
      input.lifecycleExpectedVersion !== 0 ||
      ![0, 3].includes(taskBindings.filter((value) => value !== null).length) ||
      input.changeOrderId !== null ||
      input.predecessorEventId !== null ||
      input.completionFactId !== null ||
      input.relatedOperationId !== null ||
      input.amountCents !== null ||
      input.currency !== null
    ) {
      throw new PreparedFinancialCommandAuthorityError('BINDING_INVALID');
    }
  } else if (
    taskBindings.some((value) => value === null) ||
    input.predecessorEventId === null ||
    input.relatedOperationId === null ||
    input.amountCents === null ||
    input.currency === null ||
    input.lifecycleExpectedVersion === 0 ||
    (input.operationKind === 'ADJUST') !== (input.changeOrderId !== null) ||
    (input.operationKind === 'CAPTURE') !== (input.completionFactId !== null)
  ) {
    throw new PreparedFinancialCommandAuthorityError('BINDING_INVALID');
  }

  return {
    ...input,
    operationId: input.operationId.toLowerCase(),
    taskDraftId: input.taskDraftId.toLowerCase(),
    taskId: normalizedUuid(input.taskId),
    eligibilityDecisionId: normalizedUuid(input.eligibilityDecisionId),
    scopeVersionId: normalizedUuid(input.scopeVersionId),
    changeOrderId: normalizedUuid(input.changeOrderId),
    predecessorEventId: normalizedUuid(input.predecessorEventId),
    completionFactId: normalizedUuid(input.completionFactId),
    relatedOperationId: normalizedUuid(input.relatedOperationId),
    currency: input.currency?.toUpperCase() ?? null,
    recordedBy: input.recordedBy.toLowerCase(),
  };
}

function nullableNumber(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function receiptFromRow(
  row: PreparedCommandRow,
  idempotencyReplayed: boolean
): PreparedUniversalV1FinancialCommandReceipt {
  return {
    preparedCommandId: row.prepared_command_id,
    commandState: row.command_state,
    operationKind: row.operation_kind,
    eventKind: row.event_kind,
    operationId: row.operation_id,
    providerKind: row.provider_kind,
    idempotencyKey: row.idempotency_key,
    providerExpectedVersion: Number(row.provider_expected_version),
    lifecycleExpectedVersion: Number(row.lifecycle_expected_version),
    providerRequestSha256: row.provider_request_sha256,
    taskDraftId: row.task_draft_id,
    taskId: row.task_id,
    eligibilityDecisionId: row.eligibility_decision_id,
    eligibilityDecisionVersion: row.eligibility_decision_version,
    eligibilityValidUntil: nullableIso(row.eligibility_valid_until),
    scopeVersionId: row.scope_version_id,
    scopeVersion: row.scope_version,
    scopeHash: row.scope_hash,
    workOrderId: row.work_order_id,
    workOrderMaterializationVersion: row.work_order_materialization_version,
    workOrderExecutionContractVersion: row.work_order_execution_contract_version,
    changeOrderId: row.change_order_id,
    changeOrderVersion: row.change_order_version,
    predecessorEventId: row.predecessor_event_id,
    predecessorOperationId: row.predecessor_operation_id,
    predecessorEventKind: row.predecessor_event_kind,
    predecessorStatus: row.predecessor_status,
    predecessorLifecycleVersion: nullableNumber(row.predecessor_lifecycle_version),
    completionFactId: row.completion_fact_id,
    completionVersion: row.completion_version,
    relatedOperationId: row.related_operation_id,
    amountCents: nullableNumber(row.amount_cents),
    currency: row.currency,
    recordedBy: row.recorded_by,
    occurredAt: iso(row.occurred_at),
    requestIdentitySha256: row.request_identity_sha256,
    authorityContextSha256: row.authority_context_sha256,
    preparedAt: iso(row.prepared_at),
    idempotencyReplayed,
  };
}

function rowMatchesInput(row: PreparedCommandRow, input: NormalizedInput): boolean {
  return (
    row.operation_kind === input.operationKind &&
    row.operation_id.toLowerCase() === input.operationId &&
    row.provider_kind === input.providerKind &&
    row.idempotency_key === input.idempotencyKey &&
    Number(row.provider_expected_version) === input.providerExpectedVersion &&
    Number(row.lifecycle_expected_version) === input.lifecycleExpectedVersion &&
    row.provider_request_sha256 === input.providerRequestSha256 &&
    row.task_draft_id.toLowerCase() === input.taskDraftId &&
    normalizedUuid(row.task_id) === input.taskId &&
    normalizedUuid(row.eligibility_decision_id) === input.eligibilityDecisionId &&
    normalizedUuid(row.scope_version_id) === input.scopeVersionId &&
    normalizedUuid(row.change_order_id) === input.changeOrderId &&
    normalizedUuid(row.predecessor_event_id) === input.predecessorEventId &&
    normalizedUuid(row.completion_fact_id) === input.completionFactId &&
    normalizedUuid(row.related_operation_id) === input.relatedOperationId &&
    nullableNumber(row.amount_cents) === input.amountCents &&
    row.currency === input.currency &&
    row.recorded_by.toLowerCase() === input.recordedBy
  );
}

function assertStoredRequest(
  row: PreparedCommandRow,
  input: NormalizedInput,
  reason:
    | 'IDEMPOTENCY_CONFLICT'
    | 'OPERATION_VERSION_CONFLICT'
    | 'LIFECYCLE_VERSION_CONFLICT'
    | 'PERSISTENCE_IDENTITY_MISMATCH'
): void {
  if (!rowMatchesInput(row, input)) {
    throw new PreparedFinancialCommandAuthorityError(reason);
  }
  if (!SHA256.test(row.request_identity_sha256) || !SHA256.test(row.authority_context_sha256)) {
    throw new PreparedFinancialCommandAuthorityError('PERSISTENCE_IDENTITY_MISMATCH');
  }
}

const preparedEventKinds = [
  'PAYMENT_METHOD_PREPARED',
  'AUTHORIZED',
  'SECURED',
  'VOIDED',
  'ADJUSTMENT_AUTHORIZED',
  'CAPTURED',
  'REFUNDED',
  'REVERSED',
  'SETTLEMENT_OBSERVED',
  'FUNDING_OBSERVED',
  'PROVIDER_RELEASED',
  'PAYOUT_OBSERVED',
  'BANK_SETTLEMENT_OBSERVED',
] as const;
const operationEvent: Readonly<
  Record<PreparedFinancialOperationKind, (typeof preparedEventKinds)[number]>
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
const storedUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
const storedHash = z
  .string()
  .regex(SHA256)
  .refine((value) => value !== '0'.repeat(64));
const storedVersion = z.number().int().safe().nonnegative();
const storedPositiveVersion = z.number().int().safe().positive();
const storedTimestamp = z.string().datetime({ offset: true });
const preparedRowSchema = z
  .object({
    prepared_command_id: storedUuid,
    command_state: z.literal('PREPARED'),
    operation_kind: FakeFinancialPreparationPayloadSchema.shape.operationKind,
    event_kind: z.enum(preparedEventKinds),
    operation_id: storedUuid,
    provider_kind: z.literal('FAKE'),
    idempotency_key: z.string().regex(IDEMPOTENCY_KEY),
    provider_expected_version: storedVersion,
    lifecycle_expected_version: storedVersion,
    provider_request_sha256: storedHash,
    task_draft_id: storedUuid,
    task_id: storedUuid.nullable(),
    eligibility_decision_id: storedUuid.nullable(),
    eligibility_decision_version: storedPositiveVersion.nullable(),
    eligibility_valid_until: storedTimestamp.nullable(),
    scope_version_id: storedUuid.nullable(),
    scope_version: storedPositiveVersion.nullable(),
    scope_hash: storedHash.nullable(),
    work_order_id: storedUuid.nullable(),
    work_order_materialization_version: storedPositiveVersion.nullable(),
    work_order_execution_contract_version: z.union([z.literal(0), z.literal(1)]).nullable(),
    change_order_id: storedUuid.nullable(),
    change_order_version: storedPositiveVersion.nullable(),
    predecessor_event_id: storedUuid.nullable(),
    predecessor_operation_id: storedUuid.nullable(),
    predecessor_event_kind: z.enum(preparedEventKinds).nullable(),
    predecessor_status: z
      .enum(['REQUESTED', 'SUCCEEDED', 'DECLINED', 'FAILED', 'RETRYABLE_FAILURE'])
      .nullable(),
    predecessor_lifecycle_version: storedVersion.nullable(),
    completion_fact_id: storedUuid.nullable(),
    completion_version: storedPositiveVersion.nullable(),
    related_operation_id: storedUuid.nullable(),
    amount_cents: storedPositiveVersion.nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .nullable(),
    recorded_by: storedUuid,
    occurred_at: storedTimestamp,
    request_identity_sha256: storedHash,
    authority_context_sha256: storedHash,
    prepared_at: storedTimestamp,
  })
  .strict()
  .refine((row) => {
    if (operationEvent[row.operation_kind] !== row.event_kind) return false;
    const completeOrAbsent = (values: unknown[]) =>
      values.every((value) => value === null) || values.every((value) => value !== null);
    return (
      completeOrAbsent([
        row.task_id,
        row.eligibility_decision_id,
        row.eligibility_decision_version,
        row.eligibility_valid_until,
        row.scope_version_id,
        row.scope_version,
        row.scope_hash,
      ]) &&
      completeOrAbsent([
        row.work_order_id,
        row.work_order_materialization_version,
        row.work_order_execution_contract_version,
      ]) &&
      completeOrAbsent([row.change_order_id, row.change_order_version]) &&
      completeOrAbsent([row.completion_fact_id, row.completion_version]) &&
      completeOrAbsent([
        row.predecessor_event_id,
        row.predecessor_operation_id,
        row.predecessor_event_kind,
        row.predecessor_status,
        row.predecessor_lifecycle_version,
      ])
    );
  });

const preparedResponseSchema = z
  .object({
    prepared_command: preparedRowSchema,
    idempotency_replayed: z.boolean(),
    actor_request_sha256: z.string().regex(SHA256),
    actor_assertion_id: z.string().uuid(),
    target_authority_id: z.string().uuid(),
  })
  .strict();

/** One actor-attested sealed command; no runtime table access or actor fallback. */
export class PostgresUniversalV1PreparedFinancialCommandAuthority implements UniversalV1PreparedFinancialCommandAuthority {
  constructor(private readonly database: Database = db) {}
  async prepare(
    rawInput: PrepareUniversalV1FinancialCommandInput,
    attestation?: UniversalV1ActorAttestationHandle
  ): Promise<PreparedUniversalV1FinancialCommandReceipt> {
    const input = Object.freeze(normalizeInput(rawInput));
    if (!attestation)
      throw new PreparedFinancialCommandAuthorityError('ACTOR_ATTESTATION_REQUIRED');
    const { recordedBy: _callerActor, ...intent } = input;
    const payload = Object.freeze(FakeFinancialPreparationPayloadSchema.parse(intent));
    const parsed = UniversalV1ActorAttestationResponseSchema.safeParse(
      await attestation.issue({
        commandKind: 'PREPARE_FAKE_FINANCIAL_COMMAND',
        commandPayload: payload,
      })
    );
    if (
      !parsed.success ||
      parsed.data.command_kind !== 'PREPARE_FAKE_FINANCIAL_COMMAND' ||
      parsed.data.actor_assertion_token === '0'.repeat(64) ||
      parsed.data.canonical_request_sha256 === '0'.repeat(64) ||
      Date.parse(parsed.data.assertion_expires_at) <= Date.now()
    )
      throw new PreparedFinancialCommandAuthorityError('ACTOR_ATTESTATION_INVALID');
    const assertion = Object.freeze(parsed.data);
    return this.database.transaction(async (query) => {
      const result = await query(
        'SELECT * FROM public.hxos_prepare_authenticated_fake_financial_command_v13($1,$2)',
        [assertion.actor_assertion_token, payload]
      );
      if (result.rows.length !== 1 || result.rowCount !== 1)
        throw new PreparedFinancialCommandAuthorityError('PERSISTENCE_INCOMPLETE');
      const response = preparedResponseSchema.safeParse(result.rows[0]);
      if (
        !response.success ||
        response.data.actor_request_sha256 !== assertion.canonical_request_sha256
      )
        throw new PreparedFinancialCommandAuthorityError('PERSISTENCE_IDENTITY_MISMATCH');
      const row: PreparedCommandRow = response.data.prepared_command;
      assertStoredRequest(row, input, 'PERSISTENCE_IDENTITY_MISMATCH');
      return Object.freeze(receiptFromRow(row, response.data.idempotency_replayed));
    });
  }
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

function hash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function deterministicUuid(value: unknown): string {
  const digest = hash(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

/** Test-only authority; runtime factories always select PostgreSQL validation. */
export class InMemoryUniversalV1PreparedFinancialCommandAuthority implements UniversalV1PreparedFinancialCommandAuthority {
  private readonly byIdempotency = new Map<string, PreparedUniversalV1FinancialCommandReceipt>();
  private readonly byOperationVersion = new Map<
    string,
    PreparedUniversalV1FinancialCommandReceipt
  >();
  private readonly byLifecycleVersion = new Map<
    string,
    PreparedUniversalV1FinancialCommandReceipt
  >();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async prepare(
    rawInput: PrepareUniversalV1FinancialCommandInput
  ): Promise<PreparedUniversalV1FinancialCommandReceipt> {
    const input = normalizeInput(rawInput);
    const operationKey = [
      input.providerKind,
      input.operationKind,
      input.operationId,
      input.providerExpectedVersion,
    ].join(':');
    const lifecycleKey = `${input.taskDraftId}:${input.lifecycleExpectedVersion}`;
    const candidates: Array<
      [
        PreparedUniversalV1FinancialCommandReceipt | undefined,
        'IDEMPOTENCY_CONFLICT' | 'OPERATION_VERSION_CONFLICT' | 'LIFECYCLE_VERSION_CONFLICT',
      ]
    > = [
      [this.byIdempotency.get(input.idempotencyKey), 'IDEMPOTENCY_CONFLICT'],
      [this.byOperationVersion.get(operationKey), 'OPERATION_VERSION_CONFLICT'],
      [this.byLifecycleVersion.get(lifecycleKey), 'LIFECYCLE_VERSION_CONFLICT'],
    ];
    for (const [existing, conflict] of candidates) {
      if (!existing) continue;
      const row = {
        operation_kind: existing.operationKind,
        operation_id: existing.operationId,
        provider_kind: existing.providerKind,
        idempotency_key: existing.idempotencyKey,
        provider_expected_version: existing.providerExpectedVersion,
        lifecycle_expected_version: existing.lifecycleExpectedVersion,
        task_draft_id: existing.taskDraftId,
        task_id: existing.taskId,
        eligibility_decision_id: existing.eligibilityDecisionId,
        scope_version_id: existing.scopeVersionId,
        change_order_id: existing.changeOrderId,
        predecessor_event_id: existing.predecessorEventId,
        completion_fact_id: existing.completionFactId,
        related_operation_id: existing.relatedOperationId,
        amount_cents: existing.amountCents,
        currency: existing.currency,
        recorded_by: existing.recordedBy,
        provider_request_sha256: existing.providerRequestSha256,
      } as PreparedCommandRow;
      if (!rowMatchesInput(row, input)) {
        throw new PreparedFinancialCommandAuthorityError(conflict);
      }
      return { ...existing, idempotencyReplayed: true };
    }

    const requestIdentitySha256 = hash(input);
    const databaseNow = this.now().toISOString();
    const receipt: PreparedUniversalV1FinancialCommandReceipt = {
      ...input,
      preparedCommandId: deterministicUuid({ type: 'prepared-financial-command', input }),
      commandState: 'PREPARED',
      eventKind: (
        {
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
        } as const
      )[input.operationKind],
      eligibilityDecisionVersion: null,
      eligibilityValidUntil: null,
      scopeVersion: null,
      scopeHash: null,
      workOrderId: null,
      workOrderMaterializationVersion: null,
      workOrderExecutionContractVersion: null,
      changeOrderVersion: null,
      completionVersion: null,
      predecessorOperationId: null,
      predecessorEventKind: null,
      predecessorStatus: null,
      predecessorLifecycleVersion: null,
      requestIdentitySha256,
      authorityContextSha256: hash({ requestIdentitySha256, mode: 'IN_MEMORY_TEST_ONLY' }),
      occurredAt: databaseNow,
      preparedAt: databaseNow,
      idempotencyReplayed: false,
    };
    this.byIdempotency.set(input.idempotencyKey, receipt);
    this.byOperationVersion.set(operationKey, receipt);
    this.byLifecycleVersion.set(lifecycleKey, receipt);
    return receipt;
  }
}
