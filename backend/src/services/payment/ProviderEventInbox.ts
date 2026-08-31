import { createHash } from 'node:crypto';

import { db, type Database, type QueryFn } from '../../db.js';

export const PROVIDER_EVENT_INBOX_MAX_PAYLOAD_BYTES = 1_048_576;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PROVIDER_KIND = /^[A-Z][A-Z0-9_]{1,63}$/u;
const AUTHENTICATION_SCHEME = /^[A-Z][A-Z0-9_-]{1,63}$/u;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{16,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_PROVIDER_TEXT_LENGTH = 255;
const MAX_AUTHENTICATION_CLOCK_SKEW_MS = 5 * 60_000;

export type ProviderEventInboxErrorReason =
  | 'AUTHENTICATION_REQUIRED'
  | 'AUTHENTICATION_SCHEME_INVALID'
  | 'AUTHENTICATION_EVIDENCE_INVALID'
  | 'AUTHENTICATION_TIME_INVALID'
  | 'AUTHENTICATION_TIME_IN_FUTURE'
  | 'PROVIDER_KIND_INVALID'
  | 'PROVIDER_EVENT_REFERENCE_INVALID'
  | 'PROVIDER_EVENT_KIND_INVALID'
  | 'OPERATION_ID_INVALID'
  | 'IDEMPOTENCY_KEY_INVALID'
  | 'RAW_PAYLOAD_INVALID'
  | 'EVENT_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'PERSISTENCE_INCOMPLETE';

export class ProviderEventInboxError extends Error {
  constructor(readonly reason: ProviderEventInboxErrorReason) {
    super(`PROVIDER_EVENT_INBOX_${reason}`);
    this.name = 'ProviderEventInboxError';
  }
}

export interface VerifiedProviderEventAuthentication {
  readonly status: 'VERIFIED';
  readonly scheme: string;
  readonly evidenceSha256: string;
  readonly verifiedAt: string;
}

export interface RecordProviderEventInput {
  readonly providerKind: string;
  readonly providerEventReference: string;
  readonly providerEventKind: string;
  readonly operationId: string;
  readonly ingressIdempotencyKey: string;
  readonly rawPayload: Uint8Array;
  readonly authentication: VerifiedProviderEventAuthentication;
}

export interface ProviderEventInboxReceipt {
  readonly observationId: string;
  readonly receiptId: string;
  readonly providerKind: string;
  readonly providerEventReference: string;
  readonly providerEventKind: string;
  readonly operationId: string;
  readonly rawPayloadSha256: string;
  readonly rawPayloadBytes: number;
  readonly ingressIdempotencyKey: string;
  readonly authenticationScheme: string;
  readonly authenticationEvidenceSha256: string;
  readonly authenticatedAt: string;
  readonly firstReceivedAt: string;
  readonly receivedAt: string;
  readonly observationReplayed: boolean;
  readonly idempotencyReplayed: boolean;
}

interface PreparedProviderEvent {
  readonly providerKind: string;
  readonly providerEventReference: string;
  readonly providerEventKind: string;
  readonly operationId: string;
  readonly ingressIdempotencyKey: string;
  readonly rawPayload: Buffer;
  readonly rawPayloadSha256: string;
  readonly rawPayloadBytes: number;
  readonly authenticationScheme: string;
  readonly authenticationEvidenceSha256: string;
  readonly authenticatedAt: string;
  readonly requestSha256: string;
}

interface ObservationRow {
  observation_id: string;
  provider_kind: string;
  provider_event_reference: string;
  provider_event_kind: string;
  operation_id: string;
  raw_payload_sha256: string;
  raw_payload_bytes: number;
  first_received_at: Date | string;
}

interface ReceiptRow {
  receipt_id: string;
  observation_id: string;
  ingress_idempotency_key: string;
  request_sha256: string;
  authentication_scheme: string;
  authentication_evidence_sha256: string;
  authenticated_at: Date | string;
  received_at: Date | string;
}

interface ReceiptWithObservationRow extends ObservationRow, ReceiptRow {}

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

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

function assertProviderText(value: unknown, reason: ProviderEventInboxErrorReason): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > MAX_PROVIDER_TEXT_LENGTH
    || value.trim() !== value
    || containsControlCharacter(value)
  ) {
    throw new ProviderEventInboxError(reason);
  }
}

function canonicalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function prepareProviderEvent(input: RecordProviderEventInput, now: Date): PreparedProviderEvent {
  if (typeof input.providerKind !== 'string' || !PROVIDER_KIND.test(input.providerKind)) {
    throw new ProviderEventInboxError('PROVIDER_KIND_INVALID');
  }
  assertProviderText(input.providerEventReference, 'PROVIDER_EVENT_REFERENCE_INVALID');
  assertProviderText(input.providerEventKind, 'PROVIDER_EVENT_KIND_INVALID');
  if (typeof input.operationId !== 'string' || !UUID.test(input.operationId)) {
    throw new ProviderEventInboxError('OPERATION_ID_INVALID');
  }
  if (
    typeof input.ingressIdempotencyKey !== 'string'
    || !IDEMPOTENCY_KEY.test(input.ingressIdempotencyKey)
  ) {
    throw new ProviderEventInboxError('IDEMPOTENCY_KEY_INVALID');
  }
  if (
    !(input.rawPayload instanceof Uint8Array)
    || input.rawPayload.byteLength < 1
    || input.rawPayload.byteLength > PROVIDER_EVENT_INBOX_MAX_PAYLOAD_BYTES
  ) {
    throw new ProviderEventInboxError('RAW_PAYLOAD_INVALID');
  }
  if (!input.authentication || input.authentication.status !== 'VERIFIED') {
    throw new ProviderEventInboxError('AUTHENTICATION_REQUIRED');
  }
  if (
    typeof input.authentication.scheme !== 'string'
    || !AUTHENTICATION_SCHEME.test(input.authentication.scheme)
  ) {
    throw new ProviderEventInboxError('AUTHENTICATION_SCHEME_INVALID');
  }
  if (
    typeof input.authentication.evidenceSha256 !== 'string'
    || !SHA256.test(input.authentication.evidenceSha256)
  ) {
    throw new ProviderEventInboxError('AUTHENTICATION_EVIDENCE_INVALID');
  }
  const authenticatedAt = canonicalTimestamp(input.authentication.verifiedAt);
  if (!authenticatedAt) throw new ProviderEventInboxError('AUTHENTICATION_TIME_INVALID');
  const nowMilliseconds = now.getTime();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new ProviderEventInboxError('AUTHENTICATION_TIME_INVALID');
  }
  if (Date.parse(authenticatedAt) > nowMilliseconds + MAX_AUTHENTICATION_CLOCK_SKEW_MS) {
    throw new ProviderEventInboxError('AUTHENTICATION_TIME_IN_FUTURE');
  }

  const rawPayload = Buffer.from(input.rawPayload);
  const rawPayloadSha256 = sha256(rawPayload);
  // Verification time is receipt evidence, not request identity: an exact
  // signed redelivery can be verified later without becoming a conflict.
  const requestIdentity = {
    providerKind: input.providerKind,
    providerEventReference: input.providerEventReference,
    providerEventKind: input.providerEventKind,
    operationId: input.operationId.toLowerCase(),
    ingressIdempotencyKey: input.ingressIdempotencyKey,
    rawPayloadSha256,
    rawPayloadBytes: rawPayload.byteLength,
    authenticationScheme: input.authentication.scheme,
    authenticationEvidenceSha256: input.authentication.evidenceSha256,
  };
  return {
    ...requestIdentity,
    rawPayload,
    authenticatedAt,
    requestSha256: sha256(stableJson(requestIdentity)),
  };
}

function assertObservationMatches(row: ObservationRow, input: PreparedProviderEvent): void {
  if (
    row.provider_kind !== input.providerKind
    || row.provider_event_reference !== input.providerEventReference
    || row.provider_event_kind !== input.providerEventKind
    || row.operation_id !== input.operationId
    || row.raw_payload_sha256 !== input.rawPayloadSha256
    || Number(row.raw_payload_bytes) !== input.rawPayloadBytes
  ) {
    throw new ProviderEventInboxError('EVENT_CONFLICT');
  }
}

function mapReceipt(
  observation: ObservationRow,
  receipt: ReceiptRow,
  observationReplayed: boolean,
  idempotencyReplayed: boolean,
): ProviderEventInboxReceipt {
  return {
    observationId: observation.observation_id,
    receiptId: receipt.receipt_id,
    providerKind: observation.provider_kind,
    providerEventReference: observation.provider_event_reference,
    providerEventKind: observation.provider_event_kind,
    operationId: observation.operation_id,
    rawPayloadSha256: observation.raw_payload_sha256,
    rawPayloadBytes: Number(observation.raw_payload_bytes),
    ingressIdempotencyKey: receipt.ingress_idempotency_key,
    authenticationScheme: receipt.authentication_scheme,
    authenticationEvidenceSha256: receipt.authentication_evidence_sha256,
    authenticatedAt: new Date(receipt.authenticated_at).toISOString(),
    firstReceivedAt: new Date(observation.first_received_at).toISOString(),
    receivedAt: new Date(receipt.received_at).toISOString(),
    observationReplayed,
    idempotencyReplayed,
  };
}

const OBSERVATION_SELECT = `
  observation_id, provider_kind, provider_event_reference, provider_event_kind,
  operation_id, raw_payload_sha256, raw_payload_bytes, first_received_at`;

const RECEIPT_SELECT = `
  receipt_id, observation_id, ingress_idempotency_key, request_sha256,
  authentication_scheme, authentication_evidence_sha256,
  authenticated_at, received_at`;

async function insertReceipt(
  query: QueryFn,
  observationId: string,
  input: PreparedProviderEvent,
): Promise<ReceiptRow> {
  const inserted = await query<ReceiptRow>(
    `INSERT INTO public.provider_event_inbox_receipts (
       observation_id, ingress_idempotency_key, request_sha256,
       authentication_status, authentication_scheme,
       authentication_evidence_sha256, authenticated_at
     ) VALUES ($1,$2,$3,'VERIFIED',$4,$5,$6::timestamptz)
     RETURNING ${RECEIPT_SELECT}`,
    [
      observationId,
      input.ingressIdempotencyKey,
      input.requestSha256,
      input.authenticationScheme,
      input.authenticationEvidenceSha256,
      input.authenticatedAt,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw new ProviderEventInboxError('PERSISTENCE_INCOMPLETE');
  return row;
}

/**
 * Durable provider-neutral inbox boundary.
 *
 * The caller must verify provider authenticity before this method. Recording a
 * fact never normalizes an event, changes financial state, calls a provider, or
 * enables production money. Processing/replay workers are deliberately outside
 * this foundation.
 */
export class PostgresProviderEventInboxRepository {
  constructor(
    private readonly database: Database = db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recordAuthenticatedEvent(input: RecordProviderEventInput): Promise<ProviderEventInboxReceipt> {
    const prepared = prepareProviderEvent(input, this.now());
    try {
      return await this.database.transaction(async (query) => {
        const locks = [
          `event:${prepared.providerKind}:${prepared.providerEventReference}`,
          `idempotency:${prepared.ingressIdempotencyKey}`,
        ].sort();
        for (const lock of locks) {
          await query(
            `SELECT pg_advisory_xact_lock(
               hashtext('provider-event-inbox-v1'), hashtext($1)
             )`,
            [lock],
          );
        }

        const byEvent = await query<ObservationRow>(
          `SELECT ${OBSERVATION_SELECT}
           FROM public.provider_event_inbox_observations
           WHERE provider_kind=$1 AND provider_event_reference=$2`,
          [prepared.providerKind, prepared.providerEventReference],
        );
        const byIdempotency = await query<ReceiptWithObservationRow>(
          `SELECT
             observation.observation_id, observation.provider_kind,
             observation.provider_event_reference, observation.provider_event_kind,
             observation.operation_id, observation.raw_payload_sha256,
             observation.raw_payload_bytes, observation.first_received_at,
             receipt.receipt_id, receipt.ingress_idempotency_key,
             receipt.request_sha256, receipt.authentication_scheme,
             receipt.authentication_evidence_sha256, receipt.authenticated_at,
             receipt.received_at
           FROM public.provider_event_inbox_receipts receipt
           JOIN public.provider_event_inbox_observations observation
             ON observation.observation_id=receipt.observation_id
           WHERE receipt.ingress_idempotency_key=$1`,
          [prepared.ingressIdempotencyKey],
        );

        const existingReceipt = byIdempotency.rows[0];
        if (existingReceipt) {
          if (existingReceipt.request_sha256 !== prepared.requestSha256) {
            throw new ProviderEventInboxError('IDEMPOTENCY_CONFLICT');
          }
          assertObservationMatches(existingReceipt, prepared);
          return mapReceipt(existingReceipt, existingReceipt, true, true);
        }

        const existingObservation = byEvent.rows[0];
        if (existingObservation) {
          assertObservationMatches(existingObservation, prepared);
          const receipt = await insertReceipt(query, existingObservation.observation_id, prepared);
          return mapReceipt(existingObservation, receipt, true, false);
        }

        const observationResult = await query<ObservationRow>(
          `INSERT INTO public.provider_event_inbox_observations (
             provider_kind, provider_event_reference, provider_event_kind,
             operation_id, raw_payload, raw_payload_sha256, raw_payload_bytes
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING ${OBSERVATION_SELECT}`,
          [
            prepared.providerKind,
            prepared.providerEventReference,
            prepared.providerEventKind,
            prepared.operationId,
            prepared.rawPayload,
            prepared.rawPayloadSha256,
            prepared.rawPayloadBytes,
          ],
        );
        const observation = observationResult.rows[0];
        if (!observation) throw new ProviderEventInboxError('PERSISTENCE_INCOMPLETE');
        const receipt = await insertReceipt(query, observation.observation_id, prepared);
        return mapReceipt(observation, receipt, false, false);
      });
    } catch (error) {
      if (error instanceof ProviderEventInboxError) throw error;
      throw new ProviderEventInboxError('PERSISTENCE_INCOMPLETE');
    }
  }
}
