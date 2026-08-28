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
  controlledTestLiquidityEnabled,
  ControlledTestLiquidityService,
} from '../../src/services/ControlledTestLiquidityService.js';

const enabled = {
  NODE_ENV: 'test',
  HXOS_ALLOW_LOCAL_TEST_LIQUIDITY: 'true',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  HXOS_LOCAL_TEST_LIQUIDITY_SECRET: 'l'.repeat(64),
};
const original = { ...process.env };
const taskId = '9feafefb-eb9b-4d02-a42b-5223c3552c0a';
const workerId = '84000000-0000-4000-8000-000000000002';
const actorId = '84000000-0000-4000-8000-000000000003';
const cellId = '84000000-0000-4000-8000-000000000004';
const backgroundCheckId = '84000000-0000-4000-8000-000000000005';
const payoutDestinationId = `pd_hxos_test_${'a'.repeat(32)}`;

const task = {
  id: taskId,
  state: 'OPEN',
  worker_id: null,
  category: 'furniture_assembly',
  rough_location: 'Bellevue area',
  region_code: 'US-WA',
  risk_level: 'LOW',
  trust_tier_required: 2,
  price: 13000,
  hustler_payout_cents: 9750,
  platform_margin_cents: 3250,
  automation_classification: 'CONTROLLED_TEST',
  background_check_required: true,
  license_required: false,
  insurance_required: false,
  escrow_state: 'FUNDED',
};

const worker = {
  id: workerId,
  default_mode: 'worker',
  account_status: 'ACTIVE',
  is_minor: false,
  is_banned: false,
  trust_hold: false,
  trust_hold_until: null,
  trust_tier: 4,
  is_verified: true,
  identity_verification_status: 'VERIFIED',
  identity_verification_environment: 'CONTROLLED_TEST',
  identity_verification_expires_at: '2099-01-01T00:00:00.000Z',
  phone: '+14255550199',
  plan: 'pro',
  risk_clearance: ['low', 'medium', 'high'],
  background_check_valid: true,
  background_check_expires_at: '2099-01-01T00:00:00.000Z',
  background_check_source_id: backgroundCheckId,
  background_check_provider: 'local_certification_test',
  background_check_environment: 'CONTROLLED_TEST',
  background_check_is_test: true,
  screening_status: 'CLEAR',
  screening_provider: 'local_certification_test',
  screening_environment: 'CONTROLLED_TEST',
  screening_is_test: true,
  screening_report_status: 'CLEAR',
  screening_report_is_test: true,
  payout_destination_id: payoutDestinationId,
  payout_destination_status: 'ACTIVE',
  payout_destination_is_test: true,
  provider_capability_evidence_id: '84000000-0000-4000-8000-000000000006',
  active_commitments: '0',
  active_disputes: false,
  license_ready: true,
  insurance_ready: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(process.env, enabled);
  mocks.transaction.mockImplementation(async (work) => work(mocks.query));
});

afterEach(() => {
  process.env = { ...original };
});

function successfulQueries() {
  mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM hxos_local_test_liquidity_witnesses') && sql.includes('idempotency_key')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM tasks t') && sql.includes('FOR UPDATE OF t')) {
      return { rows: [task], rowCount: 1 };
    }
    if (sql.includes('FROM users worker')) return { rows: [worker], rowCount: 1 };
    if (sql.includes('INSERT INTO zone_category_cells')) {
      return { rows: [{ id: cellId, state: 'LIMITED' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO hxos_local_test_liquidity_witnesses')) {
      return { rows: [{ id: values?.[0] }], rowCount: 1 };
    }
    if (sql.includes('UPDATE tasks')) {
      return { rows: [{ id: taskId, liquidity_cell_id: cellId }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  });
}

describe('ControlledTestLiquidityService', () => {
  it('is disabled by default and rejects every production-shaped configuration', () => {
    expect(controlledTestLiquidityEnabled(enabled)).toBe(true);
    for (const override of [
      { NODE_ENV: 'production' },
      { HXOS_ALLOW_LOCAL_TEST_LIQUIDITY: 'false' },
      { ENGINE_API_MODE: 'live' },
      { STRIPE_MODE: 'live' },
      { HXOS_LOCAL_TEST_LIQUIDITY_SECRET: 'short' },
    ]) {
      expect(controlledTestLiquidityEnabled({ ...enabled, ...override })).toBe(false);
    }
  });

  it('derives one non-public TEST cell from exact task and provider evidence', async () => {
    successfulQueries();
    const result = await ControlledTestLiquidityService.prepareAndBind({
      taskId,
      workerId,
      actorId,
      idempotencyKey: 'liquidity-prepare-0001',
    }, new Date('2026-07-20T18:30:00.000Z'));

    expect(result).toMatchObject({
      success: true,
      data: {
        taskId,
        workerId,
        cellId,
        geoZone: 'hxos-test-us-wa-bellevue-area',
        state: 'LIMITED',
        activeVerifiedProviders: 1,
        averageContributionCents: 3250,
        publicInstantRequestsAllowed: false,
        expansionEligible: false,
        isTest: true,
        idempotencyReplayed: false,
      },
    });
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql)).join('\n');
    expect(statements).toContain("set_config('hustlexp.local_test_liquidity_enabled', 'true', true)");
    expect(statements).toContain('INSERT INTO hxos_local_test_liquidity_witnesses');
    expect(statements).toContain("'CONTROLLED_TEST',TRUE");
    expect(statements).toContain('FALSE,FALSE');
    expect(statements).toContain('UPDATE tasks');
  });

  it('fails closed when the task is not an isolated funded controlled transaction', async () => {
    successfulQueries();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM hxos_local_test_liquidity_witnesses')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM tasks t')) {
        return { rows: [{ ...task, automation_classification: 'PRODUCTION' }], rowCount: 1 };
      }
      return { rows: [worker], rowCount: 1 };
    });

    await expect(ControlledTestLiquidityService.prepareAndBind({
      taskId,
      workerId,
      actorId,
      idempotencyKey: 'liquidity-prepare-0002',
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'LOCAL_TEST_LIQUIDITY_TASK_INELIGIBLE' },
    });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO zone_category_cells'))).toBe(false);
  });

  it('fails closed when screening, payout, or provider availability evidence is incomplete', async () => {
    successfulQueries();
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM hxos_local_test_liquidity_witnesses')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM tasks t')) return { rows: [task], rowCount: 1 };
      if (sql.includes('FROM users worker')) {
        return { rows: [{ ...worker, screening_report_status: 'PENDING' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await expect(ControlledTestLiquidityService.prepareAndBind({
      taskId,
      workerId,
      actorId,
      idempotencyKey: 'liquidity-prepare-0003',
    })).resolves.toMatchObject({
      success: false,
      error: { code: 'LOCAL_TEST_LIQUIDITY_PROVIDER_INELIGIBLE' },
    });
  });
});
