import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  NONPRODUCTION_TEST_FINANCIAL_MIGRATION,
  NONPRODUCTION_TEST_FINANCIAL_MIGRATION_PATH,
  NONPRODUCTION_TEST_FINANCIAL_MIGRATIONS,
  testDatabaseUrls,
  validatePreparationPolicy,
  validatePreparedDatabaseUrl,
} from './prepare-test-databases.mjs';

const safeEnv = {
  NODE_ENV: 'test',
  HX_ALLOW_CI_DB_RECREATE: 'true',
  DATABASE_URL: 'postgresql://hx_ci_runner:hx_ci_password@127.0.0.1:5432/hx_ci_admin_test',
};

test('accepts only an explicitly authorized loopback CI admin database', () => {
  assert.deepEqual(validatePreparationPolicy(safeEnv), []);
  const urls = testDatabaseUrls(safeEnv.DATABASE_URL);
  assert.deepEqual(urls, {
    invariant: 'postgresql://hx_ci_runner:hx_ci_password@127.0.0.1:5432/hx_ci_invariant_test',
    system: 'postgresql://hx_ci_runner:hx_ci_password@127.0.0.1:5432/hx_ci_system_test',
  });
  assert.deepEqual(validatePreparedDatabaseUrl(urls.invariant, 'hx_ci_invariant_test'), []);
  assert.deepEqual(validatePreparedDatabaseUrl(urls.system, 'hx_ci_system_test'), []);
});

test('refuses production, remote, unapproved, or broadly named database targets', () => {
  for (const env of [
    { ...safeEnv, NODE_ENV: 'production' },
    { ...safeEnv, HX_ALLOW_CI_DB_RECREATE: 'false' },
    { ...safeEnv, DATABASE_URL: 'postgresql://ci:ci@db.example.com:5432/hx_ci_admin_test' },
    { ...safeEnv, DATABASE_URL: 'postgresql://ci:ci@127.0.0.1:5432/postgres' },
    { ...safeEnv, DATABASE_URL: 'postgresql://hx_ci_runner:ci@localhost:5432/hx_ci_admin_test' },
    { ...safeEnv, DATABASE_URL: 'postgresql://hx_ci_runner:ci@127.0.0.1:5444/hx_ci_admin_test' },
    {
      ...safeEnv,
      DATABASE_URL: 'postgresql://hx_ci_runner:ci@127.0.0.1:5432/hx_ci_admin_test?sslmode=require',
    },
    { ...safeEnv, DATABASE_URL: '' },
  ]) {
    assert.notEqual(validatePreparationPolicy(env).length, 0);
  }
});

test('prepared test URLs remain fixed to the isolated user and database names', () => {
  for (const [value, database] of [
    ['postgresql://other:ci@127.0.0.1:5432/hx_ci_invariant_test', 'hx_ci_invariant_test'],
    ['postgresql://hx_ci_runner:ci@db.example.com:5432/hx_ci_system_test', 'hx_ci_system_test'],
    ['postgresql://hx_ci_runner:ci@127.0.0.1:5432/postgres', 'hx_ci_system_test'],
    ['postgresql://hx_ci_runner:ci@127.0.0.1:5444/hx_ci_system_test', 'hx_ci_system_test'],
  ]) {
    assert.notEqual(validatePreparedDatabaseUrl(value, database).length, 0);
  }
  assert.notEqual(validatePreparedDatabaseUrl(safeEnv.DATABASE_URL, 'production').length, 0);
});

test('pins the required-test fake-finance fixture to the append-only nonproduction migration', async () => {
  assert.equal(
    NONPRODUCTION_TEST_FINANCIAL_MIGRATION,
    '20260922_universal_v1_fake_terminal_lifecycle_intent_v1'
  );
  assert.equal(
    NONPRODUCTION_TEST_FINANCIAL_MIGRATION_PATH,
    NONPRODUCTION_TEST_FINANCIAL_MIGRATIONS.at(-1).path
  );
  assert.deepEqual(
    NONPRODUCTION_TEST_FINANCIAL_MIGRATIONS.map(({ name }) => name),
    [
      '20260827_fake_financial_provider_v1',
      '20260903_fake_financial_provider_account_refresh_v2',
      '20260910_fake_financial_settlement_completion_v3',
      '20260921_universal_v1_fake_financial_lifecycle_bridge_v1',
      '20260922_universal_v1_fake_terminal_lifecycle_intent_v1',
    ]
  );
  const sql = await Promise.all(
    NONPRODUCTION_TEST_FINANCIAL_MIGRATIONS.map((migration) => readFile(migration.path, 'utf8'))
  );
  assert.match(sql[0], /hxos_fake_financial_operations_v1/u);
  assert.match(sql[0], /hxos_fake_financial_operation_events_v1/u);
  assert.match(sql[0], /provider_kind TEXT NOT NULL DEFAULT 'FAKE'/u);
  assert.doesNotMatch(sql[0], /REFRESH_PROVIDER_ACCOUNT_STATE/u);
  assert.match(sql[1], /REFRESH_PROVIDER_ACCOUNT_STATE/u);
  assert.match(sql[1], /hxos_fake_financial_schema_evidence_v2/u);
  assert.match(sql[2], /PROVIDER_RELEASE/u);
  assert.match(sql[2], /OBSERVE_BANK_SETTLEMENT/u);
  assert.match(sql[2], /hxos_fake_financial_schema_evidence_v3/u);
  assert.match(sql[3], /universal_v1_fake_financial_lifecycle_bridges/u);
  assert.match(sql[3], /hxos_fake_financial_schema_evidence_v4/u);
  assert.match(sql[3], /nonproduction fake-provider v3/u);
  assert.match(sql[4], /universal_v1_fake_terminal_lifecycle_intents/u);
  assert.match(sql[4], /universal_v1_fake_provider_account_facts/u);
  assert.match(sql[4], /universal_v1_fake_reconciliation_bridges/u);
  assert.match(sql[4], /hxos_fake_financial_schema_evidence_v5/u);
  for (const migrationSql of sql) {
    assert.match(migrationSql, /append-only/iu);
    assert.doesNotMatch(migrationSql, /stripe_events/u);
    assert.match(
      createHash('sha256').update(migrationSql, 'utf8').digest('hex'),
      /^[0-9a-f]{64}$/u
    );
  }
});
