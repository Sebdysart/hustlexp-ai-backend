import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const EXPECTED_V12_SHA256 = 'a'.repeat(64);
const EXPECTED_ORDINAL146_SHA256 = 'b'.repeat(64);
const EXPECTED_SEAL_SHA256 = 'c'.repeat(64);
const EXPECTED_V13_SHA256 = 'e'.repeat(64);
const DATABASE_URL = 'postgresql://hx_ci_runner@127.0.0.1:5432/hx_ci_system_test';

const mocks = vi.hoisted(() => {
  const query = vi.fn();
  return {
    query,
    assertConfiguredTarget: vi.fn(() => ({ opaqueTarget: true })),
    assertAuthorized: vi.fn(() => ({ environment: 'local' })),
  };
});

vi.mock('../../src/db.js', () => ({
  db: {
    readQuery: mocks.query,
  },
}));

vi.mock('../../src/jobs/nonproduction-database-target.js', () => ({
  assertConfiguredNonproductionDatabaseTarget: mocks.assertConfiguredTarget,
}));

vi.mock('../../src/jobs/work-order-command-role-authority.js', () => ({
  WORK_ORDER_ORDINAL146_SQL_SHA256: 'b'.repeat(64),
  WORK_ORDER_FAKE_FINANCIAL_V12_SQL_SHA256: 'a'.repeat(64),
  WORK_ORDER_BOOTSTRAP_SEAL_SQL_SHA256: 'c'.repeat(64),
  FAKE_FINANCIAL_OUTBOX_V13_SQL_SHA256: 'e'.repeat(64),
}));

vi.mock('../../src/services/payment/NonproductionFinancialAuthorization.js', () => ({
  assertNonproductionFakeFinanceAuthorized: mocks.assertAuthorized,
  nonproductionFakeFinanceEnabled: vi.fn(() => true),
}));

import { issueLiveFakeFinancialDatabaseCapability } from '../../src/services/payment/FakeFinancialProvider.js';

describe('live fake-financial sealed database capability authority', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('DATABASE_URL', DATABASE_URL);
    vi.stubEnv('VITEST', 'true');
    vi.stubEnv('HX_ALLOW_CI_DB_RECREATE', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('issues only through the sealed runtime reader with all four exact SQL digests', async () => {
    mocks.query.mockResolvedValueOnce({
      rows: [{
        operations_relation: 'public.hxos_fake_financial_operations_v1',
        events_relation: 'public.hxos_fake_financial_operation_events_v1',
        ordinal146_sql_sha256: EXPECTED_ORDINAL146_SHA256,
        v12_sql_sha256: EXPECTED_V12_SHA256,
        seal_sql_sha256: EXPECTED_SEAL_SHA256,
        v13_sql_sha256: EXPECTED_V13_SHA256,
      }],
      rowCount: 1,
    });

    await expect(issueLiveFakeFinancialDatabaseCapability()).resolves.toMatchObject({
      environment: 'local',
      databaseTarget: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });

    expect(mocks.query).toHaveBeenCalledOnce();
    const [sql, values] = mocks.query.mock.calls[0]!;
    expect(sql).toContain('public.hxos_read_universal_v1_fake_financial_runtime_authority_v13()');
    expect(sql).toContain('runtime.ordinal146_sql_sha256');
    expect(sql).toContain('runtime.v12_sql_sha256');
    expect(sql).toContain('runtime.seal_sql_sha256');
    expect(sql).toContain('runtime.v13_sql_sha256');
    expect(values).toEqual([]);
  });

  it.each([
    ['missing sealed authority', [], 0],
    ['contradictory row count', [], 1],
    ['wrong ordinal146 digest', [{
      operations_relation: 'public.hxos_fake_financial_operations_v1',
      events_relation: 'public.hxos_fake_financial_operation_events_v1',
      ordinal146_sql_sha256: 'd'.repeat(64),
      v12_sql_sha256: EXPECTED_V12_SHA256,
      seal_sql_sha256: EXPECTED_SEAL_SHA256,
      v13_sql_sha256: EXPECTED_V13_SHA256,
    }], 1],
    ['wrong v12 digest', [{
      operations_relation: 'public.hxos_fake_financial_operations_v1',
      events_relation: 'public.hxos_fake_financial_operation_events_v1',
      ordinal146_sql_sha256: EXPECTED_ORDINAL146_SHA256,
      v12_sql_sha256: 'd'.repeat(64),
      seal_sql_sha256: EXPECTED_SEAL_SHA256,
      v13_sql_sha256: EXPECTED_V13_SHA256,
    }], 1],
    ['wrong bootstrap seal digest', [{
      operations_relation: 'public.hxos_fake_financial_operations_v1',
      events_relation: 'public.hxos_fake_financial_operation_events_v1',
      ordinal146_sql_sha256: EXPECTED_ORDINAL146_SHA256,
      v12_sql_sha256: EXPECTED_V12_SHA256,
      seal_sql_sha256: 'd'.repeat(64),
      v13_sql_sha256: EXPECTED_V13_SHA256,
    }], 1],
  ])('refuses %s', async (_caseName, rows, rowCount) => {
    mocks.query.mockResolvedValueOnce({ rows, rowCount });

    await expect(issueLiveFakeFinancialDatabaseCapability()).rejects.toThrow(
      'NONPRODUCTION_FAKE_FINANCE_REFUSED:LIVE_FAKE_FINANCE_SEALED_AUTHORITY_REQUIRED',
    );
  });

  it.each([undefined, null, '0'.repeat(64), 'f'.repeat(64)])(
    'refuses a missing, NULL, zero, or mismatched v13 digest: %s', async (v13Digest) => {
      mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{
        operations_relation: 'public.hxos_fake_financial_operations_v1',
        events_relation: 'public.hxos_fake_financial_operation_events_v1',
        ordinal146_sql_sha256: EXPECTED_ORDINAL146_SHA256,
        v12_sql_sha256: EXPECTED_V12_SHA256,
        seal_sql_sha256: EXPECTED_SEAL_SHA256,
        v13_sql_sha256: v13Digest,
      }] });
      await expect(issueLiveFakeFinancialDatabaseCapability()).rejects.toThrow(
        'NONPRODUCTION_FAKE_FINANCE_REFUSED:LIVE_FAKE_FINANCE_SEALED_AUTHORITY_REQUIRED'
      );
    }
  );

  it('fails closed when the data plane cannot read sealed authority', async () => {
    mocks.query.mockRejectedValueOnce(new Error('relation does not exist'));

    await expect(issueLiveFakeFinancialDatabaseCapability()).rejects.toThrow(
      'NONPRODUCTION_FAKE_FINANCE_REFUSED:LIVE_FAKE_FINANCE_SEALED_AUTHORITY_REQUIRED',
    );
  });
});
