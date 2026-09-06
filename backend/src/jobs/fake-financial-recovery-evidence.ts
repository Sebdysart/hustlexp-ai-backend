import { z } from 'zod';
import { db } from '../db.js';
import { releaseManifestDigest } from '../releaseManifest.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import { configuredRuntimeDatabaseStartup } from './runtime-database-startup-config.js';
import { fakeFinancialOutboxJobPayload } from './fake-financial-outbox-publisher.js';
import {
  decodeFakeFinancialAdmittedRequestRow,
  decodeFakeFinancialRecoveryRequestRow,
} from './fake-financial-admitted-request.js';
import { decodeAdmittedFakeFinancialExecutionEvent } from './fake-financial-admitted-execution.js';

const inputSchema = z
  .object({ jobId: z.string(), payload: fakeFinancialOutboxJobPayload })
  .strict();
const responseSchema = z
  .object({
    request_evidence: z.record(z.unknown()),
    admission_evidence: z.record(z.unknown()).nullable(),
    provider_event: z.record(z.unknown()).nullable(),
  })
  .strict();
export type FakeFinancialRecoveryEvidenceInput = z.infer<typeof inputSchema>;
function refuse(reason: string): never {
  throw new Error(`FAKE_FINANCIAL_RECOVERY_EVIDENCE_${reason}`);
}
function currentReaderAuthority() {
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

/** Reads through the installed worker data plane. A restarted worker needs only
 * the retained ID-only job, not an in-memory admission receipt or an expired lease.
 * The returned evidence cannot be used as an execution capability. */
export async function readFakeFinancialRecoveryEvidence(input: FakeFinancialRecoveryEvidenceInput) {
  const binding = inputSchema.parse(input);
  if (
    binding.jobId !==
    `hx-fake-fin-${binding.payload.commandId.replaceAll('-', '')}-${binding.payload.jobAuthoritySha256}`
  )
    return refuse('JOB_IDENTITY_MISMATCH');
  Object.freeze(binding.payload);
  Object.freeze(binding);
  const authority = currentReaderAuthority();
  const evidence = await db.transaction(async (query) => {
    const result = await query(
      'SELECT * FROM public.hxos_read_fake_financial_recovery_evidence_v13($1,$2,$3)',
      [binding.payload.outboxRequestId, binding.jobId, binding.payload.jobAuthoritySha256]
    );
    if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('CARDINALITY');
    return decodeFakeFinancialRecoveryEvidenceRow(result.rows[0], binding, authority);
  });
  const current = currentReaderAuthority();
  if (
    Object.keys(authority).some(
      (key) => authority[key as keyof typeof authority] !== current[key as keyof typeof current]
    )
  )
    return refuse('READER_AUTHORITY_CHANGED');
  return evidence;
}

/** Pure validation; this receipt cannot authorize provider dispatch. */
export function decodeFakeFinancialRecoveryEvidenceRow(
  value: unknown,
  binding: FakeFinancialRecoveryEvidenceInput,
  authority: ReturnType<typeof currentReaderAuthority>
) {
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return refuse('RESPONSE_INVALID');
  const row = parsed.data;
  const request = decodeFakeFinancialRecoveryRequestRow(row.request_evidence);
  if (
    request.evidence.command_id !== binding.payload.commandId ||
    request.evidence.outbox_request_id !== binding.payload.outboxRequestId ||
    request.evidence.bullmq_job_id !== binding.jobId ||
    request.evidence.job_authority_sha256 !== binding.payload.jobAuthoritySha256
  )
    return refuse('JOB_BINDING_MISMATCH');
  // Old release/target provenance remains readable after target replacement.
  // The caller itself must still be a currently enrolled nonproduction worker.
  if (
    request.evidence.target_database_name !== authority.databaseName ||
    request.evidence.release_environment !== authority.environment
  )
    return refuse('ENVIRONMENT_TARGET_MISMATCH');
  const admission =
    row.admission_evidence === null
      ? null
      : decodeFakeFinancialAdmittedRequestRow(row.admission_evidence);
  if (
    admission &&
    Object.entries(request.evidence).some(
      ([key, value]) => admission.evidence[key as keyof typeof admission.evidence] !== value
    )
  )
    return refuse('ADMISSION_BINDING_MISMATCH');
  if (row.provider_event !== null && admission === null) return refuse('EVENT_WITHOUT_ADMISSION');
  const observation =
    row.provider_event === null
      ? null
      : decodeAdmittedFakeFinancialExecutionEvent(row.provider_event, admission!);
  if (observation && observation.event.idempotencyReplayed !== true)
    return refuse('EVENT_REPLAY_REQUIRED');
  return Object.freeze({
    kind: observation
      ? 'COMMITTED_EVENT'
      : admission
        ? 'NO_COMMITTED_EVENT'
        : 'NO_COMMITTED_ADMISSION',
    request,
    admission,
    observation,
    providerExecutionCapability: false as const,
    positiveMoneyCapability: false as const,
    productionCapability: false as const,
  });
}
