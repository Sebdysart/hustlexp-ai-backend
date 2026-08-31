import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import type { Database, QueryFn } from '../../src/db.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  PostgresProviderObservationNormalizationRepository,
} from '../../src/services/payment/ProviderObservationNormalization.js';
import {
  syntheticFinancialObservationSchema,
} from '../../src/services/payment/SyntheticFinancialCommandSchemas.js';

const migration = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260928_provider_observation_normalization_v1.sql',
), 'utf8');

const observation = {
  version: 'HX_SYNTHETIC_FINANCIAL_OBSERVATION_V1',
  kind: 'FINANCIAL_OPERATION_OBSERVED',
  providerKind: 'FAKE',
  providerEventReference: 'evt-provider-observation-1',
  operationId: '10000000-0000-4000-8000-000000000001',
  operationKind: 'AUTHORIZE',
  predecessorProviderVersion: 0,
  observedProviderVersion: 1,
  observedState: 'SUCCEEDED',
  externalReference: 'fake-authorize-observation-1',
  amountCents: 12_500,
  currency: 'USD',
  providerOccurredAt: '2026-08-28T20:00:00.000Z',
} as const;

function databaseUsing(query: QueryFn): Database {
  return {
    transaction: vi.fn(<T>(callback: (transactionQuery: QueryFn) => Promise<T>) => callback(query)),
  } as unknown as Database;
}

describe('provider observation normalization', () => {
  it('accepts only the closed causal observation envelope', () => {
    expect(syntheticFinancialObservationSchema.parse(observation)).toEqual(observation);
    for (const authorityField of ['taskDraftId', 'taskId', 'actorId', 'scenario', 'idempotencyKey']) {
      expect(syntheticFinancialObservationSchema.safeParse({
        ...observation,
        [authorityField]: 'provider-cannot-claim-this',
      }).success).toBe(false);
    }
    expect(syntheticFinancialObservationSchema.safeParse({
      ...observation,
      observedProviderVersion: 2,
    }).success).toBe(false);
    expect(syntheticFinancialObservationSchema.safeParse({
      ...observation,
      providerKind: 'APPROVED_PROVIDER',
    }).success).toBe(false);
    expect(syntheticFinancialObservationSchema.safeParse({
      ...observation,
      operationKind: 'PREPARE_PAYMENT_METHOD',
      amountCents: null,
      currency: null,
    }).success).toBe(true);
    expect(syntheticFinancialObservationSchema.safeParse({
      ...observation,
      amountCents: null,
      currency: null,
    }).success).toBe(false);
  });

  it('normalizes by observation identity only and maps immutable database evidence', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('normalize_financial_provider_observation_v1')) {
        return {
          rows: [{
            receipt: {
              normalizationId: '20000000-0000-4000-8000-000000000002',
              idempotencyReplayed: false,
            },
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('provider_financial_observation_normalizations')) {
        return {
          rows: [{
            normalization_id: '20000000-0000-4000-8000-000000000002',
            observation_id: '30000000-0000-4000-8000-000000000003',
            command_id: '40000000-0000-4000-8000-000000000004',
            dispatch_attempt_id: '50000000-0000-4000-8000-000000000005',
            outcome_fact_id: '60000000-0000-4000-8000-000000000006',
            operation_id: observation.operationId,
            operation_kind: observation.operationKind,
            provider_kind: 'FAKE',
            predecessor_provider_version: 0,
            observed_provider_version: 1,
            observed_state: 'SUCCEEDED',
            amount_cents: 12_500,
            currency: 'USD',
            materialization_state: 'TERMINAL_CORROBORATED',
            provider_occurred_at: observation.providerOccurredAt,
            normalized_at: '2026-08-28T20:00:01.000Z',
            followup_due_at: null,
            expires_at: null,
          }],
          rowCount: 1,
        };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    }) as QueryFn;
    const repository = new PostgresProviderObservationNormalizationRepository(databaseUsing(query));

    await expect(repository.normalizeAuthenticatedObservation(
      '30000000-0000-4000-8000-000000000003',
    )).resolves.toMatchObject({
      operationId: observation.operationId,
      operationKind: 'AUTHORIZE',
      predecessorProviderVersion: 0,
      version: 1,
      state: 'SUCCEEDED',
      materializationState: 'TERMINAL_CORROBORATED',
      idempotencyReplayed: false,
    });
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('normalize_financial_provider_observation_v1($1::uuid)'),
      ['30000000-0000-4000-8000-000000000003'],
    );
    expect(JSON.stringify(query.mock.calls)).not.toContain(observation.externalReference);
  });

  it('registers engine migration 132 with append-only causal and backlog truth', () => {
    expect(REQUIRED_MIGRATION_FILES.length).toBeGreaterThanOrEqual(132);
    expect(REQUIRED_MIGRATION_FILES[131]).toEqual({
      name: '20260928_provider_observation_normalization_v1',
      fileName: '20260928_provider_observation_normalization_v1.sql',
    });
    expect(migration).toMatch(/provider_event_inbox_observations/iu);
    expect(migration).toMatch(/financial_provider_command_journal/iu);
    expect(migration).toMatch(/financial_provider_command_dispatch_attempts/iu);
    expect(migration).toMatch(/terminal observation lacks exact committed outcome authority/iu);
    expect(migration).toMatch(/outcome\.provider_result_sha256 = expected_provider_result_sha256/iu);
    expect(migration).toMatch(/inbox_record\.first_received_at < dispatch_record\.attempted_at/iu);
    expect(migration).toMatch(/receipt\.received_at >= dispatch_record\.attempted_at/iu);
    expect(migration).toMatch(/authenticated observation receipt precedes DISPATCH_ATTEMPTED authority/iu);
    expect(migration).toMatch(/provider-clock tolerance only; it does not relax receipt order/iu);
    expect(migration).toMatch(/materialization_state = 'RESERVED'/iu);
    expect(migration).toMatch(/expires_at = normalized_at \+ INTERVAL '24 hours'/iu);
    expect(migration).toMatch(/provider_financial_observation_backlog_v1/iu);
    expect(migration).toMatch(/normalized provider observation evidence is append-only/iu);
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION public\.normalize_financial_provider_observation_v1\(UUID\) FROM PUBLIC/iu);
    expect(migration).not.toMatch(/INSERT INTO public\.task_financial/iu);
    expect(migration).not.toMatch(/INSERT INTO public\.hxos_fake_financial/iu);
  });
});
