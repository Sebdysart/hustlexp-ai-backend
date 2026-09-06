import { z } from 'zod';
import { db } from '../db.js';
import {
  decodeFakeFinancialDurableRequest,
  FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS,
} from '../services/payment/FakeFinancialDurableRequest.js';
import {
  fakeFinancialOutboxJobPayload,
  type FakeFinancialOutboxDatabase,
} from './fake-financial-outbox-publisher.js';

const uuid = z
  .string()
  .regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const admissionSchema = z
  .object({
    job_validation_id: uuid,
    command_id: uuid,
    recovery_lease_id: uuid,
    dispatch_attempt_id: uuid,
    provider_request_sha256: digest,
    command_identity_sha256: digest,
    prepared_command_id: uuid,
    prepared_authority_sha256: digest,
  })
  .strict();
export type FakeFinancialAdmissionReceipt = Readonly<z.infer<typeof admissionSchema>>;
const timestamp = z
  .union([z.date(), z.string().datetime({ offset: true })])
  .transform((value) =>
    typeof value === 'string' ? new Date(value).toISOString() : value.toISOString()
  );
const storedVersion = z.union([
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  z
    .string()
    .regex(/^(?:0|[1-9][0-9]{0,15})$/u)
    .transform(Number)
    .refine(Number.isSafeInteger),
]);
const readSchema = admissionSchema
  .extend({
    worker_instance_id: uuid,
    dispatch_admission_id: uuid,
    outbox_request_id: uuid,
    validation_identity_sha256: digest,
    admission_identity_sha256: digest,
    job_authority_sha256: digest,
    bullmq_job_id: z.string(),
    payload_contract_version: z.literal(1),
    canonical_provider_request: z.string(),
    operation_kind: z.enum(FAKE_FINANCIAL_DURABLE_REQUEST_OPERATIONS),
    operation_id: uuid,
    idempotency_key: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
    provider_expected_version: storedVersion,
    lease_expires_at: timestamp,
    outcome_deadline_at: timestamp,
    target_authority_id: uuid,
    target_authority_version: z.number().int().positive(),
    target_database_name: z.string().min(1).max(63),
    release_environment: z.enum(['local', 'preview', 'staging']),
    release_manifest_digest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .refine((value) => value !== `sha256:${'0'.repeat(64)}`),
    release_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{7,127}$/u),
    release_revision: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .refine((value) => value !== '0'.repeat(40)),
    provider_execution_capability: z.literal(false),
    positive_money_capability: z.literal(false),
    production_capability: z.literal(false),
  })
  .strict();
const recoveryRequestSchema = readSchema.omit({
  job_validation_id: true,
  worker_instance_id: true,
  dispatch_admission_id: true,
  recovery_lease_id: true,
  dispatch_attempt_id: true,
  validation_identity_sha256: true,
  admission_identity_sha256: true,
  lease_expires_at: true,
  outcome_deadline_at: true,
  provider_execution_capability: true,
  positive_money_capability: true,
  production_capability: true,
});
const inputSchema = z
  .object({
    workerInstanceId: uuid,
    jobId: z.string(),
    payload: fakeFinancialOutboxJobPayload,
    bullmqAttemptNumber: z.number().int().min(0).max(64),
    leaseSeconds: z.number().int().min(2).max(300),
    outcomeTimeoutSeconds: z.number().int().min(1).max(299),
  })
  .strict()
  .refine((value) => value.outcomeTimeoutSeconds < value.leaseSeconds);
export type FakeFinancialAdmissionInput = z.infer<typeof inputSchema>;

function refuse(reason: string): never {
  throw new Error(`FAKE_FINANCIAL_ADMITTED_REQUEST_${reason}`);
}

/** Historical request evidence only; a missing event does not establish whether an effect happened. */
export function decodeFakeFinancialRecoveryRequestRow(value: unknown) {
  const parsed = recoveryRequestSchema.safeParse(value);
  if (!parsed.success) return refuse('RECOVERY_REQUEST_INVALID');
  const row = parsed.data;
  const durableRequest = decodeFakeFinancialDurableRequest(
    row.operation_kind,
    row.canonical_provider_request,
    row.provider_request_sha256
  );
  if (
    String(durableRequest.request.operationId).toLowerCase() !== row.operation_id ||
    durableRequest.request.idempotencyKey !== row.idempotency_key ||
    durableRequest.request.expectedVersion !== row.provider_expected_version
  )
    return refuse('REQUEST_IDENTITY_MISMATCH');
  return Object.freeze({ evidence: Object.freeze(row), durableRequest });
}

/** Byte/shape validation only; this decoder does not issue execution authority. */
export function decodeFakeFinancialAdmittedRequestRow(value: unknown) {
  const parsed = readSchema.safeParse(value);
  if (!parsed.success) return refuse('READ_INVALID');
  const row = parsed.data;
  const durableRequest = decodeFakeFinancialDurableRequest(
    row.operation_kind,
    row.canonical_provider_request,
    row.provider_request_sha256
  );
  if (
    String(durableRequest.request.operationId).toLowerCase() !== row.operation_id ||
    durableRequest.request.idempotencyKey !== row.idempotency_key ||
    durableRequest.request.expectedVersion !== row.provider_expected_version ||
    new Date(row.outcome_deadline_at).getTime() > new Date(row.lease_expires_at).getTime()
  )
    return refuse('REQUEST_IDENTITY_MISMATCH');
  return Object.freeze({ evidence: Object.freeze(row), durableRequest });
}

/** Fixed sealed ports. Receipts grant no provider capability; a future execution
 * write must revalidate the admission, lease and target inside that transaction. */
export class PostgresFakeFinancialAdmittedRequestRepository {
  private readonly admissions = new WeakMap<object, Readonly<FakeFinancialAdmissionInput>>();
  constructor(private readonly database: FakeFinancialOutboxDatabase = db) {}

  async admit(input: FakeFinancialAdmissionInput): Promise<FakeFinancialAdmissionReceipt> {
    const binding = inputSchema.parse(input);
    if (
      binding.jobId !==
      `hx-fake-fin-${binding.payload.commandId.replaceAll('-', '')}-${binding.payload.jobAuthoritySha256}`
    )
      return refuse('JOB_IDENTITY_MISMATCH');
    Object.freeze(binding.payload);
    Object.freeze(binding);
    const receipt = await this.database.transaction(async (query) => {
      const result = await query(
        'SELECT * FROM hx_authority.record_fake_financial_job_dispatch_evidence_v13($1,$2,$3,$4,$5,$6,$7)',
        [
          binding.payload.outboxRequestId,
          binding.jobId,
          binding.payload.jobAuthoritySha256,
          binding.workerInstanceId,
          binding.bullmqAttemptNumber,
          binding.leaseSeconds,
          binding.outcomeTimeoutSeconds,
        ]
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('ADMISSION_CARDINALITY');
      const parsed = admissionSchema.safeParse(result.rows[0]);
      if (!parsed.success) return refuse('ADMISSION_INVALID');
      if (parsed.data.command_id !== binding.payload.commandId)
        return refuse('ADMISSION_IDENTITY_MISMATCH');
      return Object.freeze(parsed.data);
    });
    // Lost COMMIT acknowledgement cannot make this receipt available to readback.
    this.admissions.set(receipt, binding);
    return receipt;
  }

  async read(admission: FakeFinancialAdmissionReceipt) {
    const binding = this.admissions.get(admission);
    if (!binding) return refuse('ADMISSION_NOT_ISSUED');
    return this.database.transaction(async (query) => {
      const result = await query(
        'SELECT * FROM public.hxos_read_admitted_fake_financial_request_v13($1,$2)',
        [admission.job_validation_id, binding.workerInstanceId]
      );
      if (result.rowCount !== 1 || result.rows.length !== 1) return refuse('READ_CARDINALITY');
      const decoded = decodeFakeFinancialAdmittedRequestRow(result.rows[0]);
      const row = decoded.evidence;
      if (
        Object.entries(admission).some(([key, value]) => row[key as keyof typeof row] !== value) ||
        row.worker_instance_id !== binding.workerInstanceId ||
        row.outbox_request_id !== binding.payload.outboxRequestId ||
        row.job_authority_sha256 !== binding.payload.jobAuthoritySha256 ||
        row.bullmq_job_id !== binding.jobId
      )
        return refuse('READ_IDENTITY_MISMATCH');
      return decoded;
    });
  }
}
