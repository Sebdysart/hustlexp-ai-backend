import { z } from 'zod';
import { db } from '../db.js';
import { releaseManifestDigest } from '../releaseManifest.js';
import { assertNonproductionFakeFinanceAuthorized } from '../services/payment/NonproductionFinancialAuthorization.js';
import {
  resultFromExactStoredFakeFinancialOperation,
  type StoredFakeFinancialOperation,
} from '../services/payment/FakeFinancialProvider.js';
import { FAKE_FINANCIAL_SCENARIO_VALUES } from '../services/payment/FakeFinancialScenarioPolicy.js';
import { FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS } from '../services/payment/FakeFinancialDurableRequest.js';
import { configuredRuntimeDatabaseStartup } from './runtime-database-startup-config.js';
import { decodeFakeFinancialAdmittedRequestRow } from './fake-financial-admitted-request.js';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z
  .union([z.date(), z.string().datetime({ offset: true })])
  .transform((value) => new Date(value).toISOString());
const amount = z
  .union([
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    z
      .string()
      .regex(/^[1-9][0-9]{0,15}$/u)
      .transform(Number)
      .refine(Number.isSafeInteger),
  ])
  .nullable();
const eventSchema = z
  .object({
    event_id: uuid,
    operation_id: uuid,
    operation_kind: z.enum(FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS),
    event_version: z.number().int().min(1).max(2147483647),
    state: z.enum([
      'PENDING',
      'SUCCEEDED',
      'DECLINED',
      'FAILED',
      'RETRYABLE_FAILURE',
      'VOIDED',
      'REFUNDED',
      'PARTIALLY_REFUNDED',
      'REVERSED',
    ]),
    scenario: z.enum(FAKE_FINANCIAL_SCENARIO_VALUES),
    amount_cents: amount,
    currency: z
      .string()
      .regex(/^[a-z]{3}$/u)
      .nullable(),
    related_operation_id: uuid.nullable(),
    external_reference: z.string().regex(/^fake_[a-z_]+_[a-f0-9]{24}$/u),
    idempotency_key: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
    identity_sha256: digest,
    request_sha256: digest,
    provider_request_sha256: digest,
    response_sha256: digest,
    retryable: z.boolean(),
    metadata: z.record(z.unknown()),
    recorded_at: timestamp,
    expires_at: timestamp.nullable(),
    admitted_job_validation_id: uuid,
    projection_contract_version: z.union([z.literal(1), z.literal(2)]),
    idempotency_replayed: z.boolean(),
  })
  .strict();
type AdmittedRequest = ReturnType<typeof decodeFakeFinancialAdmittedRequestRow>;
export interface AdmittedFakeFinancialExecutionCapability {
  readonly kind: 'ADMITTED_FAKE_FINANCIAL_EXECUTION';
  readonly jobValidationId: string;
}
interface Binding {
  readonly readback: AdmittedRequest;
  readonly targetDigest: string;
  readonly manifestDigest: string;
}
const capabilities = new WeakMap<object, Binding>();
function refuse(reason: string): never {
  throw new Error(`FAKE_FINANCIAL_ADMITTED_EXECUTION_${reason}`);
}

function currentAuthority() {
  const manifest = assertNonproductionFakeFinanceAuthorized({ component: 'worker' });
  const configuration = configuredRuntimeDatabaseStartup('worker');
  if (configuration.expectedTarget.environment !== manifest.environment)
    return refuse('ENVIRONMENT_MISMATCH');
  return { manifest, configuration, manifestDigest: releaseManifestDigest(manifest) };
}
function assertBinding(readback: AdmittedRequest, authority: ReturnType<typeof currentAuthority>) {
  const row = readback.evidence;
  if (
    row.release_manifest_digest !== authority.manifestDigest ||
    row.release_id !== authority.manifest.releaseId ||
    row.release_environment !== authority.manifest.environment ||
    row.target_database_name !== authority.configuration.expectedTarget.databaseName ||
    ![
      authority.manifest.components.backend.revision,
      authority.manifest.components.worker.revision,
    ].includes(row.release_revision)
  )
    return refuse('RELEASE_TARGET_MISMATCH');
}

/** Only the installed data plane is used. Each query revalidates the enrolled
 * worker, live target and four SQL pins; callers cannot supply a Pool/verifier. */
export async function issueAdmittedFakeFinancialExecutionCapability(
  jobValidationId: string,
  workerInstanceId: string
): Promise<AdmittedFakeFinancialExecutionCapability> {
  uuid.parse(jobValidationId);
  uuid.parse(workerInstanceId);
  const authority = currentAuthority();
  const readback = await db.transaction(async (query) => {
    const result = await query(
      'SELECT * FROM public.hxos_read_admitted_fake_financial_request_v13($1,$2)',
      [jobValidationId, workerInstanceId]
    );
    if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('ADMISSION_CARDINALITY');
    const read = decodeFakeFinancialAdmittedRequestRow(result.rows[0]);
    if (
      read.evidence.job_validation_id !== jobValidationId ||
      read.evidence.worker_instance_id !== workerInstanceId
    )
      return refuse('ADMISSION_IDENTITY_MISMATCH');
    assertBinding(read, authority);
    return read;
  });
  const current = currentAuthority();
  assertBinding(readback, current);
  if (current.configuration.targetDigest !== authority.configuration.targetDigest)
    return refuse('TARGET_CHANGED');
  const capability = Object.freeze<AdmittedFakeFinancialExecutionCapability>({
    kind: 'ADMITTED_FAKE_FINANCIAL_EXECUTION',
    jobValidationId,
  });
  capabilities.set(
    capability,
    Object.freeze({
      readback,
      targetDigest: current.configuration.targetDigest,
      manifestDigest: current.manifestDigest,
    })
  );
  return capability;
}

/** One dispatch per issued capability, including failures and uncertain COMMIT.
 * A failed call is recovered by reading durable facts, never by reusing this token. */
export async function executeAdmittedFakeFinancialCommand(
  capability: AdmittedFakeFinancialExecutionCapability
) {
  const binding = capabilities.get(capability);
  if (!binding) return refuse('OPAQUE_CAPABILITY_REQUIRED');
  capabilities.delete(capability);
  const authority = currentAuthority();
  assertBinding(binding.readback, authority);
  if (
    binding.targetDigest !== authority.configuration.targetDigest ||
    binding.manifestDigest !== authority.manifestDigest
  )
    return refuse('AUTHORITY_CHANGED');
  return db.transaction(async (query) => {
    const result = await query(
      'SELECT * FROM public.hxos_execute_admitted_fake_financial_request_v13($1,$2)',
      [binding.readback.evidence.job_validation_id, binding.readback.evidence.worker_instance_id]
    );
    if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('EVENT_CARDINALITY');
    return decodeAdmittedFakeFinancialExecutionEvent(result.rows[0], binding.readback);
  });
}

/** Receipt validation only; useful for exact durable-event recovery as well. */
export function decodeAdmittedFakeFinancialExecutionEvent(
  value: unknown,
  readback: AdmittedRequest
) {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) return refuse('EVENT_INVALID');
  const row = parsed.data;
  if (row.admitted_job_validation_id !== readback.evidence.job_validation_id)
    return refuse('EVENT_ADMISSION_MISMATCH');
  const event: StoredFakeFinancialOperation = Object.freeze({
    projectionContractVersion: row.projection_contract_version,
    eventId: row.event_id,
    operationId: row.operation_id,
    operationKind: row.operation_kind,
    providerKind: 'FAKE',
    state: row.state,
    version: row.event_version,
    amountCents: row.amount_cents,
    currency: row.currency,
    externalReference: row.external_reference,
    idempotencyReplayed: row.idempotency_replayed,
    retryable: row.retryable,
    scenario: row.scenario,
    idempotencyKey: row.idempotency_key,
    identitySha256: row.identity_sha256,
    requestSha256: row.request_sha256,
    providerRequestSha256: row.provider_request_sha256,
    responseSha256: row.response_sha256,
    relatedOperationId: row.related_operation_id,
    metadata: Object.freeze(row.metadata),
    recordedAt: row.recorded_at,
    expiresAt: row.expires_at,
  });
  const providerResult = resultFromExactStoredFakeFinancialOperation(
    event,
    readback.durableRequest.operationKind,
    readback.durableRequest.request,
    readback.durableRequest.providerRequestSha256,
    row.idempotency_replayed
  );
  return Object.freeze({ event, providerResult: Object.freeze(providerResult) });
}
