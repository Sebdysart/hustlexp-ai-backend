import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const transaction = vi.fn(async (work: (q: typeof query) => unknown) => work(query));
  return { query, transaction };
});

vi.mock('../../src/db.js', () => ({ db: { query: mocks.query, transaction: mocks.transaction } }));

import {
  controlledTestDurationEvidenceEnabled,
  ControlledTestDurationEvidenceService,
} from '../../src/services/ControlledTestDurationEvidenceService.js';

const original = { ...process.env };
const enabled = {
  NODE_ENV: 'test',
  HXOS_ALLOW_LOCAL_TEST_DURATION_EVIDENCE: 'true',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  HXOS_LOCAL_TEST_DURATION_EVIDENCE_SECRET: 'd'.repeat(64),
};
const params = {
  taskId: '9feafefb-eb9b-4d02-a42b-5223c3552c0a',
  actorId: '84000000-0000-4000-8000-000000000003',
  sourceQuoteVersionId: '91120922-2a1d-44df-b542-9fcf8904b3a1',
  minimumMinutes: 45,
  expectedMinutes: 105,
  maximumMinutes: 150,
  policyVersion: 'price-book-duration-v1',
  sourceEvidenceHash: 'a'.repeat(64),
  sourceEnvironment: 'TEST' as const,
  idempotencyKey: 'duration-evidence-0001',
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, enabled);
  mocks.transaction.mockImplementation(async (work) => work(mocks.query));
});

afterEach(() => {
  process.env = { ...original };
});

describe('ControlledTestDurationEvidenceService', () => {
  it('is disabled by default and rejects production-shaped configurations', () => {
    expect(controlledTestDurationEvidenceEnabled(enabled)).toBe(true);
    for (const override of [
      { NODE_ENV: 'production' },
      { HXOS_ALLOW_LOCAL_TEST_DURATION_EVIDENCE: 'false' },
      { ENGINE_API_MODE: 'live' },
      { STRIPE_MODE: 'live' },
      { HXOS_LOCAL_TEST_DURATION_EVIDENCE_SECRET: 'short' },
    ]) expect(controlledTestDurationEvidenceEnabled({ ...enabled, ...override })).toBe(false);
  });

  it('supplements an open controlled task without rewriting quote scope or economics', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM hxos_local_test_duration_evidence') && sql.includes('idempotency_key')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM tasks') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          id: params.taskId, state: 'OPEN', worker_id: null,
          automation_classification: 'CONTROLLED_TEST', estimated_duration_minutes: null,
        }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO hxos_local_test_duration_evidence')) {
        return { rows: [{
          id: '84000000-0000-4000-8000-000000000098',
          task_id: params.taskId,
          source_quote_version_id: params.sourceQuoteVersionId,
          duration_min_minutes: 45,
          duration_expected_minutes: 105,
          duration_max_minutes: 150,
          policy_version: 'price-book-duration-v1',
          source_evidence_hash: 'a'.repeat(64),
          source_environment: 'TEST',
          request_hash: expect.any(String),
        }], rowCount: 1 };
      }
      if (sql.includes('UPDATE tasks')) {
        return { rows: [{ id: params.taskId, estimated_duration_minutes: 105 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(ControlledTestDurationEvidenceService.apply(params)).resolves.toMatchObject({
      success: true,
      data: {
        taskId: params.taskId,
        estimatedDurationMinutes: 105,
        minimumMinutes: 45,
        maximumMinutes: 150,
        idempotencyReplayed: false,
      },
    });
  });

  it.each([
    ['unbounded estimate', { expectedMinutes: 151 }],
    ['unsupported policy', { policyVersion: 'client-guess-v1' }],
    ['forged hash', { sourceEvidenceHash: 'invalid' }],
    ['production source', { sourceEnvironment: 'PRODUCTION' as const }],
  ])('rejects %s', async (_label, override) => {
    await expect(ControlledTestDurationEvidenceService.apply({ ...params, ...override })).resolves.toMatchObject({
      success: false,
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
