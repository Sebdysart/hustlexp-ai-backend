import { createHash } from 'node:crypto';
import { z } from 'zod';
import { syntheticFinancialObservationSchema } from '../services/payment/SyntheticFinancialCommandSchemas.js';
import { fakeFinancialWebhookSignedBytes } from '../services/payment/FakeFinancialWebhookAuthentication.js';
import { financialProviderOutcomeProjectionSha256 } from '../services/payment/FinancialProviderCommandRecovery.js';
import type { decodeFakeFinancialAdmittedRequestRow } from './fake-financial-admitted-request.js';
import type { decodeAdmittedFakeFinancialExecutionEvent } from './fake-financial-admitted-execution.js';

const uuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  );
const resolutionSchema = z
  .object({
    contract_version: z.literal(1),
    observation_id: uuid,
    receipt_id: uuid,
    key_id: uuid,
    target_authority_id: uuid,
    raw_payload: z.string().min(2).max(16384),
    raw_payload_sha256: digest,
    signed_payload_sha256: digest,
    authentication_evidence_sha256: digest,
    authenticated_at: timestamp,
    verified_at: timestamp,
    provider_occurred_at: timestamp,
    provider_expires_at: timestamp.nullable(),
    provider_result_sha256: digest,
    resolution_identity_sha256: digest,
  })
  .strict();
export const fakeFinancialTerminalObservationEnvelopeSchema = z
  .object({
    kind: z.literal('HX_FAKE_TERMINAL_OBSERVATION_V13'),
    original_event: z.record(z.unknown()),
    resolution: resolutionSchema,
  })
  .strict();
type Admission = ReturnType<typeof decodeFakeFinancialAdmittedRequestRow>;
type Observation = ReturnType<typeof decodeAdmittedFakeFinancialExecutionEvent>;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const framedHash = (parts: string[]) =>
  hash(parts.map((value) => `${Buffer.byteLength(value, 'utf8')}:${value}`).join('|'));
function refuse(reason: string): never {
  throw new Error('FAKE_FINANCIAL_TERMINAL_OBSERVATION_' + reason);
}
function micros(value: string): bigint {
  const part = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)?.[1] ?? '';
  return BigInt(new Date(value).getTime()) * 1000n + BigInt(part.padEnd(6, '0').slice(3));
}

/** A terminal projection is separate from the unchanged original provider event.
 * It cannot authorize dispatch. PostgreSQL owns committed verification provenance. */
export function decodeFakeFinancialTerminalObservation(
  value: unknown,
  admission: Admission,
  original: Observation,
  rawRecordedAt: unknown
) {
  const parsed = resolutionSchema.safeParse(value);
  if (!parsed.success) return refuse('RESPONSE_INVALID');
  const row = parsed.data,
    witness = admission.evidence,
    raw = original.event;
  let payload: z.infer<typeof syntheticFinancialObservationSchema>;
  try {
    payload = syntheticFinancialObservationSchema.parse(JSON.parse(row.raw_payload));
  } catch {
    return refuse('PAYLOAD_INVALID');
  }
  const bytes = Buffer.from(row.raw_payload, 'utf8');
  if (
    bytes.length > 16384 ||
    bytes.toString('utf8') !== row.raw_payload ||
    row.raw_payload_sha256 !== hash(bytes)
  )
    return refuse('RAW_BYTES_MISMATCH');
  const expectedSuccess =
    raw.operationKind === 'VOID'
      ? 'VOIDED'
      : raw.operationKind === 'REVERSAL'
        ? 'REVERSED'
        : raw.operationKind === 'REFUND'
          ? raw.amountCents! <
            Number(JSON.parse(witness.canonical_provider_request).originalAmountCents)
            ? 'PARTIALLY_REFUNDED'
            : 'REFUNDED'
          : 'SUCCEEDED';
  if (
    !['PENDING', 'RETRYABLE_FAILURE'].includes(raw.state) ||
    !raw.retryable ||
    payload.operationId !== witness.operation_id ||
    payload.operationKind !== witness.operation_kind ||
    payload.predecessorProviderVersion !== witness.provider_expected_version ||
    payload.observedProviderVersion !== raw.version ||
    payload.amountCents !== raw.amountCents ||
    (payload.currency !== raw.currency?.toUpperCase() &&
      !(payload.currency === null && raw.currency === null)) ||
    payload.externalReference !== raw.externalReference ||
    ![expectedSuccess, 'FAILED', 'DECLINED'].includes(payload.observedState) ||
    row.target_authority_id !== witness.target_authority_id
  )
    return refuse('COMMAND_BINDING_MISMATCH');
  const signed = fakeFinancialWebhookSignedBytes(
    {
      keyId: row.key_id,
      targetAuthorityId: row.target_authority_id,
      targetAuthorityVersion: witness.target_authority_version,
      targetDatabaseName: witness.target_database_name,
      environment: witness.release_environment,
      releaseManifestSha256: witness.release_manifest_digest,
    },
    bytes
  );
  if (row.signed_payload_sha256 !== hash(signed)) return refuse('SIGNED_SCOPE_MISMATCH');
  const originalTime = timestamp.safeParse(rawRecordedAt);
  const providerTime = micros(row.provider_occurred_at);
  if (
    !originalTime.success ||
    !timestamp.safeParse(payload.providerOccurredAt).success ||
    providerTime !== micros(payload.providerOccurredAt) ||
    providerTime < micros(originalTime.data) ||
    providerTime > micros(row.authenticated_at) ||
    micros(row.verified_at) < micros(row.authenticated_at)
  )
    return refuse('PROVIDER_TIME_MISMATCH');
  const expectedExpiry =
    payload.observedState === 'SUCCEEDED' &&
    ['AUTHORIZE', 'SECURE', 'ADJUST'].includes(raw.operationKind)
      ? providerTime + 900_000_000n
      : null;
  if (
    row.provider_expires_at === null
      ? expectedExpiry !== null
      : expectedExpiry !== micros(row.provider_expires_at)
  )
    return refuse('PROVIDER_EXPIRY_MISMATCH');
  const providerResult = Object.freeze({
    ...original.providerResult,
    operationId: witness.operation_id,
    state: z
      .enum([
        'SUCCEEDED',
        'FAILED',
        'DECLINED',
        'VOIDED',
        'REFUNDED',
        'PARTIALLY_REFUNDED',
        'REVERSED',
      ])
      .parse(payload.observedState),
    version: payload.observedProviderVersion,
    retryable: false,
    recordedAt: row.provider_occurred_at,
    expiresAt: row.provider_expires_at,
    amountCents: payload.amountCents,
    currency: payload.currency,
    externalReference: payload.externalReference,
  });
  if (row.provider_result_sha256 !== financialProviderOutcomeProjectionSha256(providerResult))
    return refuse('PROJECTION_HASH_MISMATCH');
  const identity = framedHash([
    'HX_FAKE_TERMINAL_OBSERVATION_RESOLUTION_V13',
    '1',
    witness.command_id,
    witness.job_validation_id,
    witness.dispatch_attempt_id,
    raw.eventId,
    raw.responseSha256,
    witness.provider_request_sha256,
    row.observation_id,
    row.receipt_id,
    row.raw_payload_sha256,
    row.authentication_evidence_sha256,
    row.signed_payload_sha256,
    row.target_authority_id,
    row.provider_result_sha256,
    String(providerTime),
    expectedExpiry === null ? '' : String(expectedExpiry),
  ]);
  if (row.resolution_identity_sha256 !== identity) return refuse('RESOLUTION_HASH_MISMATCH');
  return Object.freeze({
    evidence: Object.freeze(row),
    providerResult,
    providerExecutionCapability: false as const,
    positiveMoneyCapability: false as const,
    productionCapability: false as const,
  });
}
