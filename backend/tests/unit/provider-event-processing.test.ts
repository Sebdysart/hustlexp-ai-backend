import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import {
  PostgresProviderEventProcessingRepository,
  ProviderEventProcessingError,
  providerEventNormalizationIdempotencyKey,
} from '../../src/services/payment/ProviderEventProcessing.js';
import {
  syntheticFinancialWebhookNormalizationIdempotencyKey,
} from '../../src/services/payment/SyntheticFinancialWebhookInbox.js';

const observationId = '10000000-0000-4000-8000-000000000001';
const operationId = '20000000-0000-4000-8000-000000000002';
const attemptId = '30000000-0000-4000-8000-000000000003';
const leaseToken = '40000000-0000-4000-8000-000000000004';
const providerEventReference = 'provider-event-processing-unit-1';
const rawPayload = Buffer.from('{"providerKind":"FAKE"}', 'utf8');
const rawPayloadSha256 = createHash('sha256').update(rawPayload).digest('hex');

function databaseUsing(query: QueryFn): Database {
  return {
    transaction: vi.fn(<T>(callback: (transactionQuery: QueryFn) => Promise<T>) => callback(query)),
  } as unknown as Database;
}

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    observation_id: observationId,
    processing_state: 'PENDING',
    attempt_count: 0,
    retryable_failure_count: 0,
    active_attempt_id: null,
    active_lease_token: null,
    provider_kind: 'FAKE',
    provider_event_reference: providerEventReference,
    provider_event_kind: 'financial_operation.observed',
    operation_id: operationId,
    raw_payload: rawPayload,
    raw_payload_sha256: rawPayloadSha256,
    ...overrides,
  };
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    attempt_id: attemptId,
    observation_id: observationId,
    attempt_number: 1,
    lease_token: leaseToken,
    leased_by: 'provider-event-replay:unit-1',
    leased_at: '2026-08-28T20:00:00.000Z',
    lease_expires_at: '2026-08-28T20:00:30.000Z',
    normalization_idempotency_key: providerEventNormalizationIdempotencyKey(
      'FAKE',
      providerEventReference,
    ),
    ...overrides,
  };
}

function outcome(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    outcome_id: '50000000-0000-4000-8000-000000000005',
    attempt_id: attemptId,
    observation_id: observationId,
    outcome_kind: kind,
    retry_at: null,
    recorded_at: '2026-08-28T20:00:01.000Z',
    ...overrides,
  };
}

describe('provider-event processing repository', () => {
  it('uses the exact same normalization identity as authenticated ingress', () => {
    expect(providerEventNormalizationIdempotencyKey('FAKE', providerEventReference)).toBe(
      syntheticFinancialWebhookNormalizationIdempotencyKey('FAKE', providerEventReference),
    );
  });

  it('claims authenticated fake observations with SKIP LOCKED and exact normalization identity', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('FOR UPDATE OF processing SKIP LOCKED')) {
        return { rows: [candidate()], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.provider_event_processing_attempts')) {
        return { rows: [attempt({
          attempt_id: params?.[0],
          lease_token: params?.[3],
          leased_by: params?.[4],
          normalization_idempotency_key: params?.[6],
        })], rowCount: 1 };
      }
      if (sql.includes('UPDATE public.provider_event_processing_state')) {
        return { rows: [{ observation_id: observationId }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) as QueryFn;
    const repository = new PostgresProviderEventProcessingRepository(databaseUsing(query));

    const claim = await repository.claimNext('provider-event-replay:unit-1', 30_000);

    expect(claim).toMatchObject({
      observationId,
      attemptNumber: 1,
      retryableFailureCount: 0,
      providerKind: 'FAKE',
      providerEventReference,
      operationId,
      rawPayload,
      rawPayloadSha256,
      normalizationIdempotencyKey: providerEventNormalizationIdempotencyKey(
        'FAKE',
        providerEventReference,
      ),
    });
    const select = calls[0];
    expect(select?.sql).toContain('FOR UPDATE OF processing SKIP LOCKED');
    expect(select?.sql).toContain("receipt.authentication_status='VERIFIED'");
    const insert = calls.find(({ sql }) =>
      sql.includes('INSERT INTO public.provider_event_processing_attempts'));
    expect(insert?.params?.[6]).toBe(
      providerEventNormalizationIdempotencyKey('FAKE', providerEventReference),
    );
  });

  it('closes an expired crash lease before claiming its replay attempt', async () => {
    const calls: string[] = [];
    const oldAttemptId = '60000000-0000-4000-8000-000000000006';
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql);
      if (sql.includes('FOR UPDATE OF processing SKIP LOCKED')) {
        return { rows: [candidate({
          processing_state: 'LEASED',
          attempt_count: 1,
          active_attempt_id: oldAttemptId,
          active_lease_token: leaseToken,
        })], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.provider_event_processing_outcomes')) {
        expect(params).toEqual([oldAttemptId, observationId, leaseToken]);
        return { rows: [outcome('LEASE_EXPIRED', { attempt_id: oldAttemptId })], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.provider_event_processing_attempts')) {
        return { rows: [attempt({
          attempt_id: params?.[0],
          attempt_number: 2,
          lease_token: params?.[3],
          leased_by: params?.[4],
          normalization_idempotency_key: params?.[6],
        })], rowCount: 1 };
      }
      if (sql.includes('UPDATE public.provider_event_processing_state')) {
        return { rows: [{ observation_id: observationId }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) as QueryFn;
    const repository = new PostgresProviderEventProcessingRepository(databaseUsing(query));

    const claim = await repository.claimNext('provider-event-replay:unit-2', 30_000);

    expect(claim?.attemptNumber).toBe(2);
    expect(calls.findIndex(sql => sql.includes("'LEASE_EXPIRED'"))).toBeLessThan(
      calls.findIndex(sql => sql.includes('INSERT INTO public.provider_event_processing_attempts')),
    );
  });

  it('appends success before terminalizing coordination state', async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.includes('SELECT observation_id')) {
        return { rows: [{ observation_id: observationId }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO public.provider_event_processing_outcomes')) {
        return { rows: [outcome('SUCCEEDED')], rowCount: 1 };
      }
      if (sql.includes('UPDATE public.provider_event_processing_state')) {
        return { rows: [{ observation_id: observationId }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) as QueryFn;
    const repository = new PostgresProviderEventProcessingRepository(databaseUsing(query));

    await expect(repository.completeSuccess({
      observationId,
      attemptId,
      leaseToken,
      result: {
        operationId,
        version: 3,
        state: 'ACCEPTED',
        idempotencyReplayed: true,
      },
    })).resolves.toMatchObject({ outcomeKind: 'SUCCEEDED' });
    expect(calls.findIndex(sql => sql.includes('INSERT INTO'))).toBeLessThan(
      calls.findIndex(sql => sql.includes('UPDATE public.provider_event_processing_state')),
    );
  });

  it('rejects stale completion after lease loss without appending an outcome', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT observation_id')) return { rows: [], rowCount: 0 };
      throw new Error('stale completion must not write');
    }) as QueryFn;
    const repository = new PostgresProviderEventProcessingRepository(databaseUsing(query));

    await expect(repository.completeTerminalFailure({
      observationId,
      attemptId,
      leaseToken,
      detailCode: 'BOUNDARY_REFUSED',
    })).rejects.toEqual(new ProviderEventProcessingError('LEASE_LOST'));
  });
});
