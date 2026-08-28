import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  MIGRATION_VERIFICATION_DATABASES,
  validateMigrationVerificationPolicy,
} from './verify-engine-migrations-postgres.mjs';

const safeEnv = {
  NODE_ENV: 'test',
  HX_ALLOW_CI_DB_RECREATE: 'true',
  DATABASE_URL: 'postgresql://hx_ci_runner:hx_ci_password@127.0.0.1:5432/hx_ci_admin_test',
};

test('migration verification accepts only the explicit isolated recreate authority', () => {
  assert.deepEqual(validateMigrationVerificationPolicy(safeEnv), []);
  assert.deepEqual(MIGRATION_VERIFICATION_DATABASES, {
    fresh: 'hx_ci_fresh_test',
    upgrade: 'hx_ci_upgrade_test',
  });
});

test('migration verification refuses production, remote, wrong-user, and broad database authority', () => {
  for (const env of [
    { ...safeEnv, NODE_ENV: 'production' },
    { ...safeEnv, HX_ALLOW_CI_DB_RECREATE: undefined },
    { ...safeEnv, HX_ALLOW_CI_DB_RECREATE: '1' },
    { ...safeEnv, DATABASE_URL: 'postgresql://hx_ci_runner:ci@db.example.com:5432/hx_ci_admin_test' },
    { ...safeEnv, DATABASE_URL: 'postgresql://postgres:ci@127.0.0.1:5432/hx_ci_admin_test' },
    { ...safeEnv, DATABASE_URL: 'postgresql://hx_ci_runner:ci@127.0.0.1:5432/postgres' },
    { ...safeEnv, DATABASE_URL: 'postgresql://hx_ci_runner:ci@127.0.0.1:5444/hx_ci_admin_test' },
  ]) {
    assert.notEqual(validateMigrationVerificationPolicy(env).length, 0);
  }
});

test('force-drop implementation checks exact recreate authority before connecting or dropping', async () => {
  const source = await readFile(
    new URL('./verify-engine-migrations-postgres.mjs', import.meta.url),
    'utf8',
  );
  const start = source.indexOf('async function recreateDatabase(');
  const end = source.indexOf('\n}\n\nasync function assertExactRegistry', start);
  assert.ok(start >= 0 && end > start, 'recreateDatabase implementation must remain discoverable');
  const implementation = source.slice(start, end);

  const authorityIndex = implementation.indexOf('assertMigrationVerificationAuthority(');
  const connectIndex = implementation.indexOf('new Client(');
  const forceDropIndex = implementation.indexOf('DROP DATABASE IF EXISTS');
  assert.ok(authorityIndex >= 0, 'explicit recreate authority is required');
  assert.ok(authorityIndex < connectIndex, 'authority must be checked before connecting');
  assert.ok(connectIndex < forceDropIndex, 'the validated admin connection precedes force-drop');
  assert.match(implementation, /MIGRATION_VERIFICATION_DATABASE_SET\.has\(name\)/u);
});

test('PostgreSQL verification executes the legacy assignment-alias bypass proof', async () => {
  const source = await readFile(
    new URL('./verify-engine-migrations-postgres.mjs', import.meta.url),
    'utf8',
  );
  assert.match(source, /async function assertHardAssignmentAliasContainment/u);
  assert.match(source, /BEFORE INSERT OR UPDATE ON tasks/u);
  assert.match(source, /assert\.doesNotMatch\([\s\S]*?UPDATE OF/u);
  assert.match(source, /SET assigned_hustler_id=/u);
  assert.match(source, /hard assignment remains held/u);
  assert.equal(
    source.match(/await assertHardAssignmentAliasContainment\(url\);/gu)?.length,
    2,
  );
});

test('PostgreSQL verification executes the TaskDraft claim upgrade and raw-rerun matrix', async () => {
  const source = await readFile(
    new URL('./verify-engine-migrations-postgres.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /universal-v1-task-draft-claim-upgrade-seed\.pg\.sql/u,
  );
  assert.match(source, /hx_task_draft_claim_source\.poster_profiles/u);
  assert.match(source, /hx_task_draft_claim_source\.audit_log/u);
  assert.match(source, /assertTaskDraftClaimUpgradeMatrix/u);
  assert.match(source, /assertTaskDraftClaimObservationImmutability/u);
  assert.match(source, /await client\.query\(migration\.sql\)/u);
  assert.match(
    source,
    /20260905_universal_v1_task_draft_legacy_claim_import_repair/u,
  );
  assert.match(source, /assertPostRepairClaimLikeInsertRejected/u);
  assert.match(source, /canonical_events: 0/u);
  assert.match(source, /inferred_source_users: 0/u);
});
