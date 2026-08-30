import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import {
  PostgresProviderEventInboxRepository,
  ProviderEventInboxError,
  type RecordProviderEventInput,
} from '../../src/services/payment/ProviderEventInbox.js';

const now = new Date('2026-08-28T20:00:00.000Z');
const operationId = 'd8aa43e5-0385-44d5-b99c-a755869ed721';
const observationId = '953ab3eb-6426-4b9b-af33-3563173e97f0';
const receiptId = '75fe42a7-837d-4d79-beb2-ea1c03ff1c70';
const rawPayload = Buffer.from('{"id":"provider-event-unit-1","type":"authorized"}', 'utf8');
const rawPayloadSha256 = createHash('sha256').update(rawPayload).digest('hex');
const authenticationEvidenceSha256 = createHash('sha256').update('verified-header').digest('hex');

const input: RecordProviderEventInput = {
  providerKind: 'FAKE',
  providerEventReference: 'provider-event-unit-1',
  providerEventKind: 'financial_security.authorized',
  operationId,
  ingressIdempotencyKey: 'provider-event-unit:receipt:0001',
  rawPayload,
  authentication: {
    status: 'VERIFIED',
    scheme: 'HMAC_SHA256',
    evidenceSha256: authenticationEvidenceSha256,
    verifiedAt: '2026-08-28T19:59:59.000Z',
  },
};

function databaseUsing(query: QueryFn): {
  database: Database;
  transaction: ReturnType<typeof vi.fn>;
} {
  const transaction = vi.fn(<T>(callback: (transactionQuery: QueryFn) => Promise<T>) =>
    callback(query));
  return {
    database: { transaction } as unknown as Database,
    transaction,
  };
}

function observationRow(overrides: Record<string, unknown> = {}) {
  return {
    observation_id: observationId,
    provider_kind: input.providerKind,
    provider_event_reference: input.providerEventReference,
    provider_event_kind: input.providerEventKind,
    operation_id: operationId,
    raw_payload_sha256: rawPayloadSha256,
    raw_payload_bytes: rawPayload.byteLength,
    first_received_at: '2026-08-28T20:00:00.000Z',
    ...overrides,
  };
}

function receiptRow(overrides: Record<string, unknown> = {}) {
  return {
    receipt_id: receiptId,
    observation_id: observationId,
    ingress_idempotency_key: input.ingressIdempotencyKey,
    request_sha256: 'a'.repeat(64),
    authentication_scheme: input.authentication.scheme,
    authentication_evidence_sha256: authenticationEvidenceSha256,
    authenticated_at: input.authentication.verifiedAt,
    received_at: '2026-08-28T20:00:00.001Z',
    ...overrides,
  };
}

describe('provider-neutral provider-event inbox repository', () => {
  it('hashes and stores exact raw bytes, then returns only metadata', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM public.provider_event_inbox_observations')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM public.provider_event_inbox_receipts receipt')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO public.provider_event_inbox_observations')) {
        return { rows: [observationRow()], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.provider_event_inbox_receipts')) {
        return { rows: [receiptRow()], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) as QueryFn;
    const { database } = databaseUsing(query);
    const repository = new PostgresProviderEventInboxRepository(database, () => now);

    const result = await repository.recordAuthenticatedEvent(input);
    expect(result).toEqual({
      observationId,
      receiptId,
      providerKind: 'FAKE',
      providerEventReference: input.providerEventReference,
      providerEventKind: input.providerEventKind,
      operationId,
      rawPayloadSha256,
      rawPayloadBytes: rawPayload.byteLength,
      ingressIdempotencyKey: input.ingressIdempotencyKey,
      authenticationScheme: 'HMAC_SHA256',
      authenticationEvidenceSha256,
      authenticatedAt: input.authentication.verifiedAt,
      firstReceivedAt: '2026-08-28T20:00:00.000Z',
      receivedAt: '2026-08-28T20:00:00.001Z',
      observationReplayed: false,
      idempotencyReplayed: false,
    });

    const insert = calls.find(({ sql }) =>
      sql.includes('INSERT INTO public.provider_event_inbox_observations'));
    expect(Buffer.isBuffer(insert?.params?.[4])).toBe(true);
    expect(Buffer.from(insert?.params?.[4] as Uint8Array)).toEqual(rawPayload);
    expect(insert?.params?.[5]).toBe(rawPayloadSha256);
    expect(result).not.toHaveProperty('rawPayload');
  });

  it('rejects an unverified envelope before opening a database transaction', async () => {
    const query = vi.fn() as unknown as QueryFn;
    const { database, transaction } = databaseUsing(query);
    const repository = new PostgresProviderEventInboxRepository(database, () => now);
    const unauthenticated = {
      ...input,
      authentication: { ...input.authentication, status: 'UNVERIFIED' },
    } as unknown as RecordProviderEventInput;

    await expect(repository.recordAuthenticatedEvent(unauthenticated)).rejects.toThrow(
      new ProviderEventInboxError('AUTHENTICATION_REQUIRED'),
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects oversized input, malformed authority, and future verification evidence', async () => {
    const query = vi.fn() as unknown as QueryFn;
    const { database, transaction } = databaseUsing(query);
    const repository = new PostgresProviderEventInboxRepository(database, () => now);
    const cases: Array<[RecordProviderEventInput, string]> = [
      [{ ...input, providerKind: 'stripe' }, 'PROVIDER_EVENT_INBOX_PROVIDER_KIND_INVALID'],
      [{ ...input, operationId: 'not-a-uuid' }, 'PROVIDER_EVENT_INBOX_OPERATION_ID_INVALID'],
      [{ ...input, ingressIdempotencyKey: 'short' }, 'PROVIDER_EVENT_INBOX_IDEMPOTENCY_KEY_INVALID'],
      [{ ...input, rawPayload: new Uint8Array() }, 'PROVIDER_EVENT_INBOX_RAW_PAYLOAD_INVALID'],
      [{
        ...input,
        authentication: { ...input.authentication, verifiedAt: '2026-08-28T20:06:00.000Z' },
      }, 'PROVIDER_EVENT_INBOX_AUTHENTICATION_TIME_IN_FUTURE'],
    ];
    for (const [candidate, message] of cases) {
      await expect(repository.recordAuthenticatedEvent(candidate)).rejects.toThrow(message);
    }
    expect(transaction).not.toHaveBeenCalled();
  });

  it('fails closed when a provider event reference resolves to different immutable evidence', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM public.provider_event_inbox_observations')) {
        return { rows: [observationRow({ raw_payload_sha256: 'f'.repeat(64) })], rowCount: 1 };
      }
      if (sql.includes('FROM public.provider_event_inbox_receipts receipt')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error('writes must not occur for conflicting provider evidence');
    }) as QueryFn;
    const { database } = databaseUsing(query);
    const repository = new PostgresProviderEventInboxRepository(database, () => now);

    await expect(repository.recordAuthenticatedEvent(input)).rejects.toThrow(
      'PROVIDER_EVENT_INBOX_EVENT_CONFLICT',
    );
  });

  it('replays the same signed receipt when only its later verification time differs', async () => {
    let storedRequestSha256 = '';
    let storedAuthenticatedAt = '';
    let receiptInsertCount = 0;
    let stored = false;
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM public.provider_event_inbox_observations')) {
        return { rows: stored ? [observationRow()] : [], rowCount: stored ? 1 : 0 };
      }
      if (sql.includes('FROM public.provider_event_inbox_receipts receipt')) {
        return {
          rows: stored ? [{
            ...observationRow(),
            ...receiptRow({
              request_sha256: storedRequestSha256,
              authenticated_at: storedAuthenticatedAt,
            }),
          }] : [],
          rowCount: stored ? 1 : 0,
        };
      }
      if (sql.includes('INSERT INTO public.provider_event_inbox_observations')) {
        return { rows: [observationRow()], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.provider_event_inbox_receipts')) {
        receiptInsertCount += 1;
        storedRequestSha256 = String(params?.[2]);
        storedAuthenticatedAt = String(params?.[5]);
        stored = true;
        return {
          rows: [receiptRow({
            request_sha256: storedRequestSha256,
            authenticated_at: storedAuthenticatedAt,
          })],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) as QueryFn;
    const { database } = databaseUsing(query);
    const repository = new PostgresProviderEventInboxRepository(
      database,
      () => new Date('2026-08-28T20:05:00.000Z'),
    );

    const first = await repository.recordAuthenticatedEvent(input);
    const replay = await repository.recordAuthenticatedEvent({
      ...input,
      authentication: {
        ...input.authentication,
        verifiedAt: '2026-08-28T20:00:01.000Z',
      },
    });

    expect(first.idempotencyReplayed).toBe(false);
    expect(replay).toMatchObject({
      observationId: first.observationId,
      receiptId: first.receiptId,
      authenticatedAt: input.authentication.verifiedAt,
      observationReplayed: true,
      idempotencyReplayed: true,
    });
    expect(receiptInsertCount).toBe(1);
    expect(storedAuthenticatedAt).toBe(input.authentication.verifiedAt);
  });

  it('converts database unavailability into a typed retryable persistence failure', async () => {
    const database = {
      transaction: vi.fn().mockRejectedValue(new Error('socket detail must not escape')),
    } as unknown as Database;
    const repository = new PostgresProviderEventInboxRepository(database, () => now);

    await expect(repository.recordAuthenticatedEvent(input)).rejects.toEqual(
      new ProviderEventInboxError('PERSISTENCE_INCOMPLETE'),
    );
  });
});
