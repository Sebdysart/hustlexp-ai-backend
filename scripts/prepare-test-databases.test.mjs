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
    '20261016_universal_v1_fake_financial_command_outbox_authority_v13'
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
      '20260926_universal_v1_change_order_three_phase_v1',
      '20260927_universal_v1_change_order_recovery_v1',
      '20261002_universal_v1_dispute_fake_release_gate_v8',
      '20261010_universal_v1_fake_financial_expiry_v9',
      '20261011_universal_v1_fake_financial_expiry_recovery_v10',
      '20261013_nonproduction_runtime_insert_authority_v1',
      '20261015_universal_v1_work_order_fake_financial_authority_hardening_v12',
      '20261015_universal_v1_work_order_bootstrap_seal_v1',
      '20261016_universal_v1_fake_financial_command_outbox_authority_v13',
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
  assert.match(sql[5], /universal_v1_change_order_materialization_commands/u);
  assert.match(sql[5], /hxos_fake_financial_schema_evidence_v6/u);
  assert.match(sql[6], /universal_v1_change_order_recovery_terminal_facts/u);
  assert.match(sql[6], /hxos_fake_financial_schema_evidence_v7/u);
  assert.match(sql[7], /aa_universal_v1_dispute_terminal_intent_gate/u);
  assert.match(sql[7], /hxos_fake_financial_schema_evidence_v8/u);
  assert.match(sql[7], /enforce_universal_v1_dispute_release_gate_v1/u);
  assert.match(sql[8], /hxos_fake_financial_schema_evidence_v9/u);
  assert.match(sql[8], /hxos_fake_financial_legacy_expiry_dispositions_v9/u);
  assert.match(sql[8], /LEGACY_EXPIRY_UNPROVEN/u);
  assert.match(sql[8], /COMPENSATION_REQUIRED/u);
  assert.match(sql[8], /hxos_fake_financial_legacy_expiry_compensation_commands_v9/u);
  assert.match(sql[8], /hxos_fake_financial_legacy_expiry_compensation_attempts_v9/u);
  assert.match(sql[8], /hxos_fake_financial_legacy_expiry_compensation_outcomes_v9/u);
  assert.match(sql[8], /hxos_fake_financial_legacy_expiry_compensations_v9/u);
  assert.match(sql[8], /provider_expires_at/u);
  assert.match(sql[8], /expiry_authority_sha256/u);
  assert.match(sql[9], /hxos_fake_financial_schema_evidence_v10/u);
  assert.match(sql[9], /hxos_fake_financial_legacy_expiry_noncompensable_facts_v10/u);
  assert.match(sql[9], /hxos_prepare_legacy_expiry_compensation_v10/u);
  assert.match(sql[9], /hxos_record_legacy_expiry_compensation_attempt_v10/u);
  assert.match(sql[9], /hxos_finalize_legacy_expiry_compensation_v10/u);
  assert.match(sql[10], /hxos_fake_financial_schema_evidence_v11/u);
  assert.match(sql[10], /hxos_record_financial_provider_command_v1/u);
  assert.match(sql[10], /hxos_record_fake_reconciliation_bridge_v1/u);
  assert.match(sql[11], /hxos_fake_financial_schema_evidence_v12/u);
  assert.match(sql[11], /HXUV1-WOCMD-V12-4/u);
  assert.doesNotMatch(sql[11], /^\s*(?:CREATE ROLE|GRANT)\b/imu);
  assert.match(sql[12], /hxos_work_order_bootstrap_seal_evidence_v1/u);
  assert.match(sql[12], /assert_universal_v1_work_order_bootstrap_seal_v1/u);
  assert.match(sql[12], /HXUV1-WOCMD-SEAL-4/u);
  assert.doesNotMatch(sql[12], /^\s*(?:CREATE ROLE|GRANT)\b/imu);
  assert.match(sql[13], /hxos_fake_financial_schema_evidence_v13/u);
  assert.match(sql[13], /fake_financial_command_outbox_requests_v13/u);
  assert.match(sql[13], /HXUV1-FINOUT-13-47/u);
  for (const migrationSql of sql) {
    assert.match(migrationSql, /append-only/iu);
    assert.doesNotMatch(migrationSql, /stripe_events/u);
    assert.match(
      createHash('sha256').update(migrationSql, 'utf8').digest('hex'),
      /^[0-9a-f]{64}$/u
    );
  }
});
