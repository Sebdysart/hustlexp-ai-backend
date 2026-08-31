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
    {
      ...safeEnv,
      DATABASE_URL: 'postgresql://hx_ci_runner:ci@db.example.com:5432/hx_ci_admin_test',
    },
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
    'utf8'
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
    'utf8'
  );
  assert.match(source, /async function assertHardAssignmentAliasContainment/u);
  assert.match(source, /BEFORE INSERT OR UPDATE ON tasks/u);
  assert.match(source, /assert\.doesNotMatch\([\s\S]*?UPDATE OF/u);
  assert.match(source, /SET assigned_hustler_id=/u);
  assert.match(source, /hard assignment remains held/u);
  assert.equal(source.match(/await assertHardAssignmentAliasContainment\(url\);/gu)?.length, 2);
});

test('PostgreSQL verification executes the TaskDraft claim upgrade and raw-rerun matrix', async () => {
  const source = await readFile(
    new URL('./verify-engine-migrations-postgres.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /universal-v1-task-draft-claim-upgrade-seed\.pg\.sql/u);
  assert.match(source, /hx_task_draft_claim_source\.poster_profiles/u);
  assert.match(source, /hx_task_draft_claim_source\.audit_log/u);
  assert.match(source, /assertTaskDraftClaimUpgradeMatrix/u);
  assert.match(source, /assertTaskDraftClaimObservationImmutability/u);
  assert.match(source, /await client\.query\(migration\.sql\)/u);
  assert.match(source, /20260905_universal_v1_task_draft_legacy_claim_import_repair/u);
  assert.match(source, /assertPostRepairClaimLikeInsertRejected/u);
  assert.match(source, /canonical_events: 0/u);
  assert.match(source, /inferred_source_users: 0/u);
});

test('PostgreSQL verification refuses partial completion audit truth and raw-replays 138', async () => {
  const source = await readFile(
    new URL('./verify-engine-migrations-postgres.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /20261004_universal_v1_completion_notice_dispatch_v1/u);
  assert.match(source, /HXUV1-NOTICE-UPGRADE-1/u);
  assert.match(source, /seedPartialCompletionReceipt/u);
  assert.match(source, /session_replication_role = 'replica'/u);
  assert.match(source, /partialReceiptBeforeRefusal/u);
  assert.match(source, /preserve the malformed historical row byte-for-byte/u);
  assert.match(source, /raw migration-138 replay must not rewrite/u);
  assert.match(source, /completionNoticeRawReplayProven/u);
  assert.match(source, /receipt_shape_validated/u);
});

test('PostgreSQL verification certifies purpose-bound occurrence audit migration 139', async () => {
  const source = await readFile(
    new URL('./verify-engine-migrations-postgres.mjs', import.meta.url),
    'utf8'
  );
  assert.match(source, /20261005_universal_v1_occurrence_access_audit_v1/u);
  assert.match(source, /assertOccurrenceAccessAuditCatalog/u);
  assert.match(source, /migration 139 column order, types, and nullability must remain exact/u);
  assert.match(source, /one primary key, two restrictive FKs, and five checks/u);
  assert.match(source, /universal_v1_occurrence_access_actor_time/u);
  assert.match(source, /universal_v1_occurrence_access_task_time/u);
  assert.match(source, /securityDefiner: true/u);
  assert.match(source, /assert_universal_v1_ops_case_operator_v1/u);
  assert.match(source, /table_ambient_access_revoked/u);
  assert.match(source, /function_ambient_access_revoked/u);
  assert.match(source, /rawReplayNumber <= 2/u);
  assert.match(source, /raw migration-139 replay \$\{rawReplayNumber\}/u);
  assert.match(source, /must reject actor-role forgery/u);
  assert.match(source, /must recheck current named-operator authority/u);
  assert.match(source, /must reject update, delete, and truncate/u);
  assert.equal(source.match(/await assertOccurrenceAccessAudit\(url,/gu)?.length, 2);

  const freshStart = source.indexOf('async function verifyFresh(url)');
  const upgradeStart = source.indexOf('async function verifyUpgrade(url)');
  const freshPath = source.slice(freshStart, upgradeStart);
  assert.match(
    freshPath,
    /loadRegisteredMigration\(OCCURRENCE_ACCESS_AUDIT_MIGRATION\)[\s\S]*assertOccurrenceAccessAudit\(url, occurrenceAccessAudit\.sql\)/u
  );

  const preSplitLoop = source.indexOf(
    'for (const spec of runtime.migrationSpecs.slice(0, splitIndex))',
    upgradeStart
  );
  const tailLoop = source.indexOf(
    'for (const spec of runtime.migrationSpecs.slice(splitIndex))',
    preSplitLoop
  );
  const exactTailBinding = source.indexOf('occurrenceAccessAuditSql = migration.sql;', tailLoop);
  assert.ok(tailLoop > preSplitLoop);
  assert.ok(exactTailBinding > tailLoop, 'upgrade path must bind migration 139 in the tail loop');
  assert.equal(
    source.slice(preSplitLoop, tailLoop).includes('occurrenceAccessAuditSql = migration.sql;'),
    false,
    'the pre-split loop cannot bind migration 139'
  );
  assert.match(
    source.slice(
      exactTailBinding,
      source.indexOf('async function verifyRecoveryTimestampPrecision')
    ),
    /assertOccurrenceAccessAudit\(url, occurrenceAccessAuditSql\)/u
  );
});
