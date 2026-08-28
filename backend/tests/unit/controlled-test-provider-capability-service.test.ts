import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  const transaction = vi.fn(async (work: (q: typeof query) => unknown) => work(query));
  return { query, transaction };
});

vi.mock('../../src/db.js', () => ({
  db: { query: mocks.query, transaction: mocks.transaction },
}));

import {
  controlledTestProviderCapabilityEnabled,
  ControlledTestProviderCapabilityService,
} from '../../src/services/ControlledTestProviderCapabilityService.js';

const original = { ...process.env };
const enabled = {
  NODE_ENV: 'test',
  HXOS_ALLOW_LOCAL_TEST_PROVIDER_CAPABILITY: 'true',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  HXOS_LOCAL_TEST_PROVIDER_CAPABILITY_SECRET: 'c'.repeat(64),
};
const taskId = '9feafefb-eb9b-4d02-a42b-5223c3552c0a';
const workerId = '84000000-0000-4000-8000-000000000002';
const actorId = '84000000-0000-4000-8000-000000000003';
const sourceHustlerId = '83000000-0000-4000-8000-000000000002';
const sourceExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const params = {
  taskId,
  workerId,
  actorId,
  sourceHustlerId,
  category: 'furniture_assembly',
  tools: ['screwdriver', 'allen keys', 'drill'],
  serviceCity: 'Bellevue',
  serviceState: 'WA',
  serviceRadiusMiles: 15,
  sourcePolicyVersion: 'hxos_local_certification_v1',
  sourceEvidenceHash: 'a'.repeat(64),
  sourceExpiresAt,
  idempotencyKey: 'provider-capability-0001',
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, enabled);
  mocks.transaction.mockImplementation(async (work) => work(mocks.query));
});

afterEach(() => {
  process.env = { ...original };
});

describe('ControlledTestProviderCapabilityService', () => {
  it('is disabled by default and for every production-shaped configuration', () => {
    expect(controlledTestProviderCapabilityEnabled(enabled)).toBe(true);
    for (const override of [
      { NODE_ENV: 'production' },
      { HXOS_ALLOW_LOCAL_TEST_PROVIDER_CAPABILITY: 'false' },
      { ENGINE_API_MODE: 'live' },
      { STRIPE_MODE: 'live' },
      { HXOS_LOCAL_TEST_PROVIDER_CAPABILITY_SECRET: 'short' },
    ]) expect(controlledTestProviderCapabilityEnabled({ ...enabled, ...override })).toBe(false);
  });

  it('stores an append-only site-originated capability witness for the exact task and worker', async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM hxos_local_test_provider_capability_evidence') && sql.includes('idempotency_key')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM tasks') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          id: taskId, state: 'OPEN', worker_id: null, category: 'furniture_assembly',
          rough_location: 'Bellevue area', region_code: 'US-WA',
          automation_classification: 'CONTROLLED_TEST',
        }], rowCount: 1 };
      }
      if (sql.includes('FROM users worker')) {
        return { rows: [{
          id: workerId, default_mode: 'worker', account_status: 'ACTIVE',
          is_minor: false, is_banned: false, location_city: 'Bellevue', location_state: 'WA',
        }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO hxos_local_test_provider_capability_evidence')) {
        return { rows: [{
          id: '84000000-0000-4000-8000-000000000099',
          task_id: taskId,
          worker_id: workerId,
          category: 'furniture_assembly',
          tools: ['allen keys', 'drill', 'screwdriver'],
          service_city: 'Bellevue',
          service_state: 'WA',
          service_radius_miles: 15,
          source_hustler_id: sourceHustlerId,
          source_policy_version: 'hxos_local_certification_v1',
          source_evidence_hash: 'a'.repeat(64),
          source_expires_at: sourceExpiresAt,
          request_hash: expect.any(String),
        }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });

    await expect(ControlledTestProviderCapabilityService.record(params)).resolves.toMatchObject({
      success: true,
      data: {
        taskId,
        workerId,
        category: 'furniture_assembly',
        serviceRadiusMiles: 15,
        sourceExpiresAt,
        idempotencyReplayed: false,
      },
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes(
      "set_config('hustlexp.local_test_provider_capability_enabled', 'true', true)",
    ))).toBe(true);
    const lookup = mocks.query.mock.calls.find(([sql]) => String(sql).includes(
      'FROM hxos_local_test_provider_capability_evidence',
    ));
    expect(String(lookup?.[0])).toContain('WHERE idempotency_key=$1');
    expect(String(lookup?.[0])).not.toContain('task_id=$2');
  });

  it.each([
    ['wrong category', { category: 'moving' }],
    ['wrong service city', { serviceCity: 'Seattle' }],
    ['empty source policy', { sourcePolicyVersion: '' }],
    ['forged evidence hash', { sourceEvidenceHash: 'invalid' }],
    ['expired source evidence', { sourceExpiresAt: new Date(Date.now() - 1000).toISOString() }],
    ['overlong source evidence', { sourceExpiresAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString() }],
  ])('fails closed for %s', async (_label, override) => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM hxos_local_test_provider_capability_evidence')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM tasks')) return { rows: [{
        id: taskId, state: 'OPEN', worker_id: null, category: 'furniture_assembly',
        rough_location: 'Bellevue area', region_code: 'US-WA',
        automation_classification: 'CONTROLLED_TEST',
      }], rowCount: 1 };
      if (sql.includes('FROM users worker')) return { rows: [{
        id: workerId, default_mode: 'worker', account_status: 'ACTIVE',
        is_minor: false, is_banned: false, location_city: 'Bellevue', location_state: 'WA',
      }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    await expect(ControlledTestProviderCapabilityService.record({ ...params, ...override })).resolves.toMatchObject({
      success: false,
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes(
      'INSERT INTO hxos_local_test_provider_capability_evidence',
    ))).toBe(false);
  });
});
