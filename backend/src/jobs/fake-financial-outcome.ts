import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { releaseManifestDigest } from '../releaseManifest.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import { financialProviderOutcomeProjectionSha256 } from '../services/payment/FinancialProviderCommandRecovery.js';
import { configuredRuntimeDatabaseStartup } from './runtime-database-startup-config.js';
import { fakeFinancialOutboxJobPayload } from './fake-financial-outbox-publisher.js';
import { decodeFakeFinancialAdmittedRequestRow } from './fake-financial-admitted-request.js';
import { decodeAdmittedFakeFinancialExecutionEvent } from './fake-financial-admitted-execution.js';
import {
  fakeFinancialTerminalObservationEnvelopeSchema,
  decodeFakeFinancialTerminalObservation,
} from './fake-financial-terminal-observation.js';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
// JSONB preserves PostgreSQL microseconds; receipt windows must not lose them.
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  );
const inputSchema = z
  .object({
    jobId: z.string(),
    payload: fakeFinancialOutboxJobPayload,
    jobValidationId: uuid,
    workerInstanceId: uuid,
    recoveryLeaseId: uuid,
  })
  .strict();
const acquireInputSchema = inputSchema
  .extend({ leaseSeconds: z.number().int().min(1).max(900) })
  .strict();
export type FakeFinancialOutcomeInput = z.infer<typeof inputSchema>;
export type FakeFinancialReconcileLeaseInput = z.infer<typeof acquireInputSchema>;
const leaseSchema = z
  .object({
    recovery_lease_id: uuid,
    command_id: uuid,
    recovery_action: z.enum(['DISPATCH', 'RECONCILE']),
    lease_owner_id: uuid,
    lease_duration_seconds: z.number().int().min(1).max(900),
    acquired_at: timestamp,
    expires_at: timestamp,
    lease_identity_sha256: digest,
    admitted_job_validation_id: uuid.nullable(),
  })
  .strict();
const outcomeSchema = z
  .object({
    outcome_fact_id: uuid,
    command_id: uuid,
    dispatch_attempt_id: uuid,
    recovery_lease_id: uuid,
    outcome_kind: z.enum(['OUTCOME_OBSERVED', 'OUTCOME_UNKNOWN', 'FAILED']),
    observation_idempotency_key: z.string(),
    provider_result_sha256: digest.nullable(),
    provider_state: z.string().nullable(),
    provider_result_version: integer.nullable(),
    amount_cents: integer.nullable(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .nullable(),
    external_reference_sha256: digest.nullable(),
    effect_certainty: z.enum(['CONFIRMED_EFFECT', 'CONFIRMED_NO_EFFECT', 'UNKNOWN']),
    retryable: z.boolean(),
    failure_code: z.enum(['FAKE_EVENT_NOT_OBSERVED', 'FAKE_ADMISSION_FENCED_NO_EFFECT']).nullable(),
    recovery_delay_seconds: z.literal(1).nullable(),
    recovery_not_before: timestamp.nullable(),
    recorded_at: timestamp,
    outcome_identity_sha256: digest,
  })
  .strict();
const leaseResponseSchema = z
  .object({
    admission_evidence: z.record(z.unknown()),
    recovery_lease: leaseSchema,
    idempotency_replayed: z.boolean(),
  })
  .strict();
const outcomeResponseSchema = leaseResponseSchema
  .extend({
    outcome_fact: outcomeSchema,
    provider_event: z.record(z.unknown()).nullable(),
  })
  .strict();
type Admission = ReturnType<typeof decodeFakeFinancialAdmittedRequestRow>;
type Lease = z.infer<typeof leaseSchema>;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function refuse(reason: string): never {
  throw new Error(`FAKE_FINANCIAL_OUTCOME_${reason}`);
}
function micros(value: string): bigint {
  const match = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  return (
    BigInt(new Date(value).getTime()) * 1000n + BigInt((match?.[1] ?? '').padEnd(6, '0').slice(3))
  );
}
function admissionMicros(value: unknown): bigint {
  return micros(value instanceof Date ? value.toISOString() : timestamp.parse(value));
}
function currentAuthority() {
  const manifest = assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
  const configuration = configuredRuntimeDatabaseStartup('worker');
  if (configuration.expectedTarget.environment !== manifest.environment)
    return refuse('ENVIRONMENT_MISMATCH');
  return {
    environment: manifest.environment,
    databaseName: configuration.expectedTarget.databaseName,
    targetDigest: configuration.targetDigest,
    manifestDigest: releaseManifestDigest(manifest),
  };
}
function assertInput(input: FakeFinancialOutcomeInput) {
  if (
    input.jobId !==
    `hx-fake-fin-${input.payload.commandId.replaceAll('-', '')}-${input.payload.jobAuthoritySha256}`
  )
    return refuse('JOB_IDENTITY_MISMATCH');
  Object.freeze(input.payload);
  Object.freeze(input);
}
function decodeBinding(
  value: unknown,
  input: FakeFinancialOutcomeInput,
  authority: ReturnType<typeof currentAuthority>
) {
  const admission = decodeFakeFinancialAdmittedRequestRow(value);
  const row = admission.evidence;
  if (
    row.job_validation_id !== input.jobValidationId ||
    row.command_id !== input.payload.commandId ||
    row.outbox_request_id !== input.payload.outboxRequestId ||
    row.bullmq_job_id !== input.jobId ||
    row.job_authority_sha256 !== input.payload.jobAuthoritySha256
  )
    return refuse('ADMISSION_BINDING_MISMATCH');
  // Original target/release may be historical; the executing reader stays enrolled.
  if (
    row.target_database_name !== authority.databaseName ||
    row.release_environment !== authority.environment
  )
    return refuse('ENVIRONMENT_TARGET_MISMATCH');
  return admission;
}
function assertLease(lease: Lease, input: FakeFinancialOutcomeInput, admission: Admission) {
  if (
    lease.recovery_lease_id !== input.recoveryLeaseId ||
    lease.command_id !== input.payload.commandId ||
    lease.lease_owner_id !== input.workerInstanceId
  )
    return refuse('LEASE_BINDING_MISMATCH');
  if (
    lease.recovery_action === 'DISPATCH'
      ? lease.admitted_job_validation_id !== null ||
        lease.recovery_lease_id !== admission.evidence.recovery_lease_id ||
        lease.lease_owner_id !== admission.evidence.worker_instance_id
      : lease.admitted_job_validation_id !== admission.evidence.job_validation_id
  )
    return refuse('LEASE_ADMISSION_MISMATCH');
  if (
    micros(lease.expires_at) !==
    micros(lease.acquired_at) + BigInt(lease.lease_duration_seconds) * 1_000_000n
  )
    return refuse('LEASE_WINDOW_MISMATCH');
  if (
    lease.lease_identity_sha256 !==
    hash(
      [
        lease.command_id,
        lease.recovery_lease_id,
        lease.recovery_action,
        lease.lease_owner_id,
        String(lease.lease_duration_seconds),
      ].join(':')
    )
  )
    return refuse('LEASE_HASH_MISMATCH');
}
async function committed<T>(
  action: (authority: ReturnType<typeof currentAuthority>) => Promise<T>
) {
  const authority = currentAuthority();
  const receipt = await action(authority);
  const current = currentAuthority();
  if (
    Object.keys(authority).some(
      (key) => authority[key as keyof typeof authority] !== current[key as keyof typeof current]
    )
  )
    return refuse('AUTHORITY_CHANGED');
  return receipt;
}

/** The caller retains the lease UUID across uncertain commits. Replaying it
 * returns its original window; this function never renews or dispatches. */
export async function acquireFakeFinancialReconcileLease(value: FakeFinancialReconcileLeaseInput) {
  const input = acquireInputSchema.parse(value);
  assertInput(input);
  return committed((authority) =>
    db.transaction(async (query) => {
      const result = await query(
        'SELECT * FROM public.hxos_acquire_fake_financial_reconcile_lease_v13($1,$2,$3,$4)',
        [input.jobValidationId, input.workerInstanceId, input.recoveryLeaseId, input.leaseSeconds]
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('CARDINALITY');
      const parsed = leaseResponseSchema.safeParse(result.rows[0]);
      if (!parsed.success) return refuse('LEASE_RESPONSE_INVALID');
      const row = parsed.data;
      const admission = decodeBinding(row.admission_evidence, input, authority);
      assertLease(row.recovery_lease, input, admission);
      if (
        row.recovery_lease.recovery_action !== 'RECONCILE' ||
        row.recovery_lease.lease_duration_seconds !== input.leaseSeconds
      )
        return refuse('RECONCILE_LEASE_REQUIRED');
      return Object.freeze({
        admission,
        lease: Object.freeze(row.recovery_lease),
        idempotencyReplayed: row.idempotency_replayed,
        providerExecutionCapability: false as const,
        positiveMoneyCapability: false as const,
        productionCapability: false as const,
      });
    })
  );
}

/** Records DB-derived observations, UNKNOWNs, or expired no-effect fences. No input permits a
 * caller to claim no effect; errors and lost COMMIT acknowledgements propagate. */
export async function recordFakeFinancialOutcome(value: FakeFinancialOutcomeInput) {
  const input = inputSchema.parse(value);
  assertInput(input);
  return committed((authority) =>
    db.transaction(async (query) => {
      const result = await query(
        'SELECT * FROM public.hxos_record_fake_financial_outcome_v13($1,$2,$3)',
        [input.jobValidationId, input.workerInstanceId, input.recoveryLeaseId]
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('CARDINALITY');
      return decodeFakeFinancialOutcomeRow(result.rows[0], input, authority);
    })
  );
}

/** Pure validation shared by outcome recording and committed lifecycle materialization. */
export function decodeFakeFinancialOutcomeRow(
  value: unknown,
  input: FakeFinancialOutcomeInput,
  authority: ReturnType<typeof currentAuthority>
) {
  const parsed = outcomeResponseSchema.safeParse(value);
  if (!parsed.success) return refuse('RESPONSE_INVALID');
  const row = parsed.data;
  const admission = decodeBinding(row.admission_evidence, input, authority);
  assertLease(row.recovery_lease, input, admission);
  const outcome = row.outcome_fact;
  if (
    outcome.command_id !== input.payload.commandId ||
    outcome.dispatch_attempt_id !== admission.evidence.dispatch_attempt_id ||
    outcome.recovery_lease_id !== input.recoveryLeaseId ||
    outcome.observation_idempotency_key !== `finance-outcome-v13:${input.recoveryLeaseId}`
  )
    return refuse('OUTCOME_BINDING_MISMATCH');
  const envelope =
    row.provider_event && 'kind' in row.provider_event
      ? fakeFinancialTerminalObservationEnvelopeSchema.parse(row.provider_event)
      : null;
  const originalEvent = envelope?.original_event ?? row.provider_event;
  const observation =
    originalEvent === null
      ? null
      : decodeAdmittedFakeFinancialExecutionEvent(originalEvent, admission);
  const resolution =
    envelope && observation
      ? decodeFakeFinancialTerminalObservation(
          envelope.resolution,
          admission,
          observation,
          originalEvent?.recorded_at
        )
      : null;
  if (
    resolution &&
    (row.recovery_lease.recovery_action !== 'RECONCILE' ||
      outcome.outcome_kind !== 'OUTCOME_OBSERVED' ||
      outcome.retryable)
  )
    return refuse('RESOLUTION_RECONCILE_REQUIRED');
  if (outcome.outcome_kind === 'FAILED') {
    if (
      observation !== null ||
      row.recovery_lease.recovery_action !== 'RECONCILE' ||
      admission.evidence.provider_expected_version !== 0 ||
      outcome.effect_certainty !== 'CONFIRMED_NO_EFFECT' ||
      outcome.retryable !== true ||
      outcome.failure_code !== 'FAKE_ADMISSION_FENCED_NO_EFFECT' ||
      outcome.recovery_delay_seconds !== 1 ||
      (micros(outcome.recorded_at) < admissionMicros(row.admission_evidence.lease_expires_at) &&
        micros(outcome.recorded_at) <
          admissionMicros(row.admission_evidence.outcome_deadline_at)) ||
      [
        outcome.provider_result_sha256,
        outcome.provider_state,
        outcome.provider_result_version,
        outcome.amount_cents,
        outcome.currency,
        outcome.external_reference_sha256,
      ].some((value) => value !== null)
    )
      return refuse('FENCE_BUNDLE_MISMATCH');
  } else if (outcome.outcome_kind === 'OUTCOME_UNKNOWN') {
    if (
      observation !== null ||
      outcome.effect_certainty !== 'UNKNOWN' ||
      outcome.retryable !== true ||
      outcome.failure_code !== 'FAKE_EVENT_NOT_OBSERVED' ||
      outcome.recovery_delay_seconds !== 1 ||
      [
        outcome.provider_result_sha256,
        outcome.provider_state,
        outcome.provider_result_version,
        outcome.amount_cents,
        outcome.currency,
        outcome.external_reference_sha256,
      ].some((value) => value !== null)
    )
      return refuse('UNKNOWN_BUNDLE_MISMATCH');
  } else {
    if (!observation || !observation.event.idempotencyReplayed)
      return refuse('COMMITTED_EVENT_REQUIRED');
    const providerResult = {
      ...(resolution?.providerResult ?? observation.providerResult),
      operationId: admission.evidence.operation_id,
    };
    const pending = ['PENDING', 'RETRYABLE_FAILURE'].includes(providerResult.state);
    const certainty = pending
      ? 'UNKNOWN'
      : ['DECLINED', 'FAILED', 'REJECTED', 'MISMATCH'].includes(providerResult.state)
        ? 'CONFIRMED_NO_EFFECT'
        : 'CONFIRMED_EFFECT';
    if (
      outcome.provider_state !== providerResult.state ||
      outcome.provider_result_version !== providerResult.version ||
      outcome.amount_cents !== providerResult.amountCents ||
      outcome.currency !== providerResult.currency ||
      outcome.external_reference_sha256 !== hash(providerResult.externalReference) ||
      outcome.provider_result_sha256 !== financialProviderOutcomeProjectionSha256(providerResult) ||
      outcome.retryable !== providerResult.retryable ||
      outcome.retryable !== pending ||
      outcome.effect_certainty !== certainty ||
      outcome.failure_code !== null ||
      outcome.recovery_delay_seconds !== (pending ? 1 : null)
    )
      return refuse('OBSERVED_BUNDLE_MISMATCH');
  }
  if (
    outcome.recovery_delay_seconds === null
      ? outcome.recovery_not_before !== null
      : outcome.recovery_not_before === null ||
        micros(outcome.recovery_not_before) !== micros(outcome.recorded_at) + 1_000_000n
  )
    return refuse('OUTCOME_WINDOW_MISMATCH');
  if (
    micros(outcome.recorded_at) < micros(row.recovery_lease.acquired_at) ||
    micros(outcome.recorded_at) >= micros(row.recovery_lease.expires_at)
  )
    return refuse('OUTCOME_LEASE_WINDOW_MISMATCH');
  const expectedHash = hash(
    [
      outcome.command_id,
      outcome.dispatch_attempt_id,
      outcome.recovery_lease_id,
      outcome.outcome_kind,
      outcome.observation_idempotency_key,
      outcome.provider_result_sha256 ?? '',
      outcome.provider_state ?? '',
      outcome.provider_result_version === null ? '' : String(outcome.provider_result_version),
      outcome.effect_certainty,
      String(outcome.retryable),
      outcome.failure_code ?? '',
      outcome.recovery_delay_seconds === null ? '' : String(outcome.recovery_delay_seconds),
    ].join(':')
  );
  if (outcome.outcome_identity_sha256 !== expectedHash) return refuse('OUTCOME_HASH_MISMATCH');
  return Object.freeze({
    admission,
    lease: Object.freeze(row.recovery_lease),
    outcome: Object.freeze(outcome),
    observation,
    ...(resolution ? { resolution } : {}),
    idempotencyReplayed: row.idempotency_replayed,
    providerExecutionCapability: false as const,
    positiveMoneyCapability: false as const,
    productionCapability: false as const,
  });
}

export {
  inputSchema as fakeFinancialOutcomeInputSchema,
  outcomeResponseSchema as fakeFinancialOutcomeReceiptSchema,
  committed as withCommittedFakeFinancialOutcomeAuthority,
  micros as fakeFinancialTimestampMicros,
};
