import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db, type Database } from '../../db.js';
import { releaseManifestDigest } from '../../releaseManifest.js';
import { configuredRuntimeDatabaseStartup } from '../../jobs/runtime-database-startup-config.js';
import { assertNonproductionFakeFinanceAuthorized } from './NonproductionFinancialAuthorization.js';
import { ProviderEventInboxError, type ProviderEventInboxReceipt } from './ProviderEventInbox.js';
import { SyntheticFinancialAuthorityError } from './SyntheticFinancialCommandAuthority.js';
import { syntheticFinancialObservationSchema } from './SyntheticFinancialCommandSchemas.js';
import {
  fakeFinancialWebhookKeyIdSchema,
  fakeFinancialWebhookTargetSchema,
  fakeFinancialWebhookSignedBytes,
  fakeFinancialWebhookAuthenticationEvidence,
  FAKE_FINANCIAL_WEBHOOK_AUTHENTICATION_SCHEME,
} from './FakeFinancialWebhookAuthentication.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z
  .string()
  .datetime({ offset: true })
  .refine((value) => /(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value));
const receiptSchema = fakeFinancialWebhookTargetSchema
  .extend({
    observationId: fakeFinancialWebhookKeyIdSchema,
    receiptId: fakeFinancialWebhookKeyIdSchema,
    providerKind: z.literal('FAKE'),
    providerEventReference: z.string(),
    providerEventKind: z.literal('FINANCIAL_OPERATION_OBSERVED'),
    operationId: fakeFinancialWebhookKeyIdSchema,
    rawPayloadSha256: digest,
    rawPayloadBytes: z.number().int().min(2).max(16_384),
    ingressIdempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{16,128}$/u),
    authenticationScheme: z.literal(FAKE_FINANCIAL_WEBHOOK_AUTHENTICATION_SCHEME),
    authenticationEvidenceSha256: digest,
    authenticatedAt: timestamp,
    firstReceivedAt: timestamp,
    receivedAt: timestamp,
    observationReplayed: z.boolean(),
    idempotencyReplayed: z.boolean(),
    signedPayloadSha256: digest,
  })
  .strict();
const rowSchema = z.object({ receipt: receiptSchema }).strict();
const inputSchema = z
  .object({
    keyId: fakeFinancialWebhookKeyIdSchema,
    rawBody: z
      .string()
      .min(2)
      .refine(
        (value) =>
          Buffer.byteLength(value, 'utf8') <= 16_384 &&
          Buffer.from(value, 'utf8').toString('utf8') === value
      ),
    signature: z.string().regex(/^[a-f0-9]{64}$/u),
    ingressIdempotencyKey: z
      .string()
      .regex(/^[A-Za-z0-9:_-]{16,128}$/u)
      .optional(),
  })
  .strict();
export type SealedSyntheticFinancialWebhookInput = z.infer<typeof inputSchema>;
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function unavailable(): never {
  throw new ProviderEventInboxError('PERSISTENCE_INCOMPLETE');
}
function micros(value: string): bigint {
  const fraction = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/u.exec(value)?.[1] ?? '';
  return BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, '0').slice(3));
}
function currentAuthority() {
  const manifest = assertNonproductionFakeFinanceAuthorized({ component: 'backend' });
  const configured = configuredRuntimeDatabaseStartup('api');
  if (configured.expectedTarget.environment !== manifest.environment) return unavailable();
  return Object.freeze({
    environment: manifest.environment,
    databaseName: configured.expectedTarget.databaseName,
    targetDigest: configured.targetDigest,
    manifestDigest: releaseManifestDigest(manifest),
  });
}
function mapFailure(error: unknown): never {
  // Database errors may contain SQL context or signed payloads. Expose only
  // exact closed codes; an uncertain commit never becomes an accepted receipt.
  const value = error as { code?: unknown; message?: unknown } | null;
  const reason =
    value?.code === 'P0001' && typeof value.message === 'string'
      ? /^HXUV1-FINHOOK-13: ([A-Z_]+)$/u.exec(value.message)?.[1]
      : null;
  if (reason === 'SIGNATURE_INVALID')
    throw new SyntheticFinancialAuthorityError('WEBHOOK_HMAC_INVALID');
  if (reason === 'EVENT_CONFLICT' || reason === 'IDEMPOTENCY_CONFLICT')
    throw new ProviderEventInboxError(reason);
  if (reason === 'PAYLOAD_INVALID') throw new ProviderEventInboxError('RAW_PAYLOAD_INVALID');
  if (reason === 'IDEMPOTENCY_INVALID')
    throw new ProviderEventInboxError('IDEMPOTENCY_KEY_INVALID');
  return unavailable();
}

/** The API forwards raw signed evidence. PostgreSQL verifies it using a private
 * key and commits the inbox, delivery receipt and immutable provenance together. */
export class SealedSyntheticFinancialWebhookInbox {
  constructor(private readonly database: Database = db) {}
  async record(
    value: SealedSyntheticFinancialWebhookInput
  ): Promise<Readonly<ProviderEventInboxReceipt>> {
    let input: SealedSyntheticFinancialWebhookInput;
    try {
      input = Object.freeze(inputSchema.parse(value));
    } catch {
      return unavailable();
    }
    const authority = currentAuthority();
    let observation: z.infer<typeof syntheticFinancialObservationSchema>;
    try {
      observation = syntheticFinancialObservationSchema.parse(JSON.parse(input.rawBody));
    } catch {
      return unavailable();
    }
    const raw = Buffer.from(input.rawBody, 'utf8');
    const ingressKey =
      input.ingressIdempotencyKey ??
      'provider-event:' +
        createHash('sha256')
          .update('FAKE\0' + observation.providerEventReference, 'utf8')
          .digest('hex');
    let receipt: Readonly<ProviderEventInboxReceipt>;
    try {
      receipt = await this.database.transaction(async (query) => {
        const result = await query(
          'SELECT public.hxos_record_authenticated_fake_financial_webhook_v13($1,$2,$3,$4) AS receipt',
          [input.keyId, raw, input.signature, input.ingressIdempotencyKey ?? null]
        );
        if (result.rowCount !== 1 || result.rows.length !== 1) return unavailable();
        const parsed = rowSchema.safeParse(result.rows[0]);
        if (!parsed.success) return unavailable();
        const row = parsed.data.receipt;
        const signed = fakeFinancialWebhookSignedBytes(
          {
            keyId: row.keyId,
            targetAuthorityId: row.targetAuthorityId,
            targetAuthorityVersion: row.targetAuthorityVersion,
            targetDatabaseName: row.targetDatabaseName,
            environment: row.environment,
            releaseManifestSha256: row.releaseManifestSha256,
          },
          raw
        );
        if (
          row.keyId !== input.keyId ||
          row.environment !== authority.environment ||
          row.targetDatabaseName !== authority.databaseName ||
          row.releaseManifestSha256 !== authority.manifestDigest ||
          row.operationId !== observation.operationId ||
          row.providerEventReference !== observation.providerEventReference ||
          row.rawPayloadSha256 !== hash(raw) ||
          row.rawPayloadBytes !== raw.length ||
          row.ingressIdempotencyKey !== ingressKey ||
          row.signedPayloadSha256 !== hash(signed) ||
          row.authenticationEvidenceSha256 !==
            fakeFinancialWebhookAuthenticationEvidence(signed, input.signature) ||
          micros(row.authenticatedAt) !== micros(row.receivedAt) ||
          micros(row.firstReceivedAt) > micros(row.receivedAt) ||
          (row.idempotencyReplayed && !row.observationReplayed)
        )
          return unavailable();
        const {
          keyId: _key,
          targetAuthorityId: _target,
          targetAuthorityVersion: _version,
          targetDatabaseName: _database,
          environment: _environment,
          releaseManifestSha256: _release,
          signedPayloadSha256: _signed,
          ...publicReceipt
        } = row;
        return Object.freeze(publicReceipt);
      });
    } catch (error) {
      return mapFailure(error);
    }
    const after = currentAuthority();
    if (
      Object.keys(authority).some(
        (key) => authority[key as keyof typeof authority] !== after[key as keyof typeof after]
      )
    )
      return unavailable();
    return receipt;
  }
}
