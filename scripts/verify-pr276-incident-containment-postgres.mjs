import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  applyEngineAutomationMigration,
  loadMigrationSql,
  normalizeMigrationSqlForAtomicApply,
  productionMigrationRuntime,
  readDatabaseIdentity,
} from '../dist/backend/src/jobs/engine-automation-migration.js';

const { Client } = pg;
const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL?.trim();
if (!adminDatabaseUrl) throw new Error('ADMIN_DATABASE_URL is required');

const MIGRATOR = { role: 'hx_ci_migrator', password: 'hx_ci_migrator_password' };
const RUNTIME = { role: 'hx_ci_runtime', password: 'hx_ci_runtime_password' };
const BASE_DATABASE = 'hx_ci_pr276_base_test';
const PR276_NAMES = [
  '20260819_ops_web_hardening',
  '20260821_ops_business_claim_links',
  '20260821_business_ownership',
  '20260821_business_claim_links_extra',
  '20260823_business_fulfiller_lifecycle',
  '20260823_business_payout_tables',
  '20260824_enforce_controlled_test_business_acceptance',
  '20260824_business_controlled_test_acceptance',
  '20260824_orchestration_mode',
];
const QUOTE_RECOVERY = '20260823_quote_payment_recovery';
const CONTAINMENT = '20260825_pr276_incident_containment';
const BASELINE_COUNT = 103;
const FIRST_TASK = 'b2000000-0000-4000-8000-000000000001';
const SECOND_TASK = 'b2000000-0000-4000-8000-000000000002';

const BASELINE_FUNCTIONS = [
  'enforce_task_region_policy_on_accept',
  'enforce_task_worker_eligibility_on_accept',
  'enforce_controlled_test_offer_acceptance',
  'enforce_controlled_test_provider_capability_on_accept',
  'enforce_task_liquidity_cell_on_accept',
  'enforce_worker_offer_decision_on_accept',
];
const BASELINE_TRIGGERS = [
  'task_region_policy_accept_insert_gate',
  'task_region_policy_accept_gate',
  'task_worker_eligibility_accept_insert_gate',
  'task_worker_eligibility_accept_gate',
  'controlled_test_provider_capability_accept_guard',
  'controlled_test_offer_accept_guard',
  'task_liquidity_cell_accept_gate',
  'task_worker_offer_accept_gate',
];

const MANUAL_LIQUIDITY_BYPASS = `
  DROP TRIGGER IF EXISTS task_liquidity_cell_accept_gate ON public.tasks;
  CREATE TRIGGER task_liquidity_cell_accept_gate
  BEFORE INSERT OR UPDATE OF state, worker_id, liquidity_cell_id, orchestration_mode
  ON public.tasks FOR EACH ROW WHEN (NEW.orchestration_mode <> 'OPS_MANUAL')
  EXECUTE FUNCTION public.enforce_task_liquidity_cell_on_accept();
`;
const MANUAL_OFFER_BYPASS = `
  DROP TRIGGER IF EXISTS task_worker_offer_accept_gate ON public.tasks;
  CREATE TRIGGER task_worker_offer_accept_gate
  BEFORE INSERT OR UPDATE OF state, worker_id, orchestration_mode
  ON public.tasks FOR EACH ROW WHEN (NEW.orchestration_mode <> 'OPS_MANUAL')
  EXECUTE FUNCTION public.enforce_worker_offer_decision_on_accept();
`;

function urlFor(database, credential) {
  const url = new URL(adminDatabaseUrl);
  url.username = credential.role;
  url.password = credential.password;
  url.pathname = `/${database}`;
  return url.toString();
}

function executableSql(sql) {
  return sql.split(/\r?\n/).filter((line) => !line.startsWith('\\')).join('\n');
}

async function configureExpectedDatabaseIdentity(database) {
  const client = new Client({ connectionString: urlFor(database, MIGRATOR) });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT
        pg_catalog.current_database() AS database_name,
        database_row.oid::text AS database_oid,
        control.system_identifier::text AS cluster_system_identifier
      FROM pg_catalog.pg_database database_row
      CROSS JOIN pg_catalog.pg_control_system() control
      WHERE database_row.datname = pg_catalog.current_database()
    `);
    const identity = result.rows[0];
    assert.ok(identity?.database_name && identity?.database_oid && identity?.cluster_system_identifier);
    process.env.HX_MIGRATION_EXPECTED_DATABASE_NAME = identity.database_name;
    process.env.HX_MIGRATION_EXPECTED_DATABASE_OID = identity.database_oid;
    process.env.HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER =
      identity.cluster_system_identifier;
  } finally {
    await client.end();
  }
}

async function ensureRoles(admin) {
  await admin.query(`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hx_ci_migrator') THEN
        CREATE ROLE hx_ci_migrator LOGIN PASSWORD 'hx_ci_migrator_password' NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hx_ci_runtime') THEN
        CREATE ROLE hx_ci_runtime LOGIN PASSWORD 'hx_ci_runtime_password' NOINHERIT;
      END IF;
    END $roles$;
    ALTER ROLE hx_ci_migrator WITH LOGIN PASSWORD 'hx_ci_migrator_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ALTER ROLE hx_ci_runtime WITH LOGIN PASSWORD 'hx_ci_runtime_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  `);
}

async function recreateDatabase(admin, name, template = null) {
  if (!/^hx_ci_[a-z0-9_]+_test$/.test(name)) throw new Error(`Unsafe CI database name: ${name}`);
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  if (template) {
    await admin.query(`CREATE DATABASE ${name} WITH TEMPLATE ${template} OWNER hx_ci_migrator`);
  } else {
    await admin.query(`CREATE DATABASE ${name} OWNER hx_ci_migrator`);
  }
  await admin.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${name} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${name} TO hx_ci_runtime`);
  const boundaryClient = new Client({ connectionString: urlFor(name, MIGRATOR) });
  await boundaryClient.connect();
  try {
    await boundaryClient.query(`
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE CREATE ON SCHEMA public FROM hx_ci_runtime;
    `);
  } finally {
    await boundaryClient.end();
  }
}

async function withMigrationClient(database, callback) {
  const runtimeUrl = urlFor(database, RUNTIME);
  const migrationUrl = urlFor(database, MIGRATOR);
  process.env.DATABASE_URL = runtimeUrl;
  process.env.MIGRATION_DATABASE_URL = migrationUrl;
  await configureExpectedDatabaseIdentity(database);
  const runtime = productionMigrationRuntime();
  const runtimeClient = runtime.createClient(runtimeUrl);
  const client = runtime.createClient(migrationUrl);
  await runtimeClient.connect();
  await client.connect();
  try {
    const runtimeIdentity = await readDatabaseIdentity(runtimeClient);
    const migrationIdentity = await readDatabaseIdentity(client);
    assert.equal(runtimeIdentity.database, migrationIdentity.database);
    assert.notEqual(runtimeIdentity.role, migrationIdentity.role);
    return await callback({ client, runtime, runtimeRole: runtimeIdentity.role });
  } finally {
    await runtimeClient.end();
    await client.end();
  }
}

async function applySpec(context, name) {
  const index = context.runtime.migrationSpecs.findIndex((candidate) => candidate.name === name);
  const spec = context.runtime.migrationSpecs[index];
  assert.ok(spec, `registered migration ${name}`);
  const migration = await loadMigrationSql(context.runtime, spec);
  const migrationSql = normalizeMigrationSqlForAtomicApply(
    spec.name,
    migration.sql,
    migration.sourcePath,
  );
  return applyEngineAutomationMigration(
    context.client,
    migrationSql,
    migration.sourcePath,
    context.runtimeRole,
    spec.name,
    index + 1,
    migration.sourceSha256,
  );
}

async function applyBootstrap(context) {
  const spec = context.runtime.bootstrapSpec;
  assert.ok(spec, 'constitutional bootstrap must be registered');
  const migration = await loadMigrationSql(context.runtime, spec);
  const migrationSql = normalizeMigrationSqlForAtomicApply(
    spec.name,
    migration.sql,
    migration.sourcePath,
  );
  return applyEngineAutomationMigration(
    context.client,
    migrationSql,
    migration.sourcePath,
    context.runtimeRole,
    spec.name,
    0,
    migration.sourceSha256,
  );
}

async function executeSpecWithoutLedger(context, name) {
  const spec = context.runtime.migrationSpecs.find((candidate) => candidate.name === name);
  assert.ok(spec, `registered migration ${name}`);
  const migration = await loadMigrationSql(context.runtime, spec);
  const migrationSql = normalizeMigrationSqlForAtomicApply(
    spec.name,
    migration.sql,
    migration.sourcePath,
  );
  await context.client.query(migrationSql);
}

async function catalogFingerprint(client) {
  const functions = await client.query(
    `SELECT proname AS name, prosrc AS body, proconfig
       FROM pg_proc
      WHERE pronamespace='public'::regnamespace AND proname=ANY($1::text[])
      ORDER BY proname`,
    [BASELINE_FUNCTIONS],
  );
  const triggers = await client.query(
    `SELECT tgname AS name, pg_get_triggerdef(oid) AS definition
       FROM pg_trigger
      WHERE tgrelid='public.tasks'::regclass AND NOT tgisinternal AND tgname=ANY($1::text[])
      ORDER BY tgname`,
    [BASELINE_TRIGGERS],
  );
  return {
    functionBodies: functions.rows.map(({ name, body }) => ({
      name,
      digest: createHash('sha256').update(body.replace(/\s+/g, ' ').trim()).digest('hex'),
    })),
    functionSearchPaths: functions.rows.map(({ name, proconfig }) => ({ name, proconfig })),
    triggers: triggers.rows,
  };
}

async function buildTemplate(admin) {
  await recreateDatabase(admin, BASE_DATABASE);
  await withMigrationClient(BASE_DATABASE, async (context) => {
    assert.equal(context.runtime.migrationSpecs[BASELINE_COUNT]?.name, PR276_NAMES[0]);
    const bootstrap = await applyBootstrap(context);
    assert.equal(bootstrap.status, 'applied');
    for (const spec of context.runtime.migrationSpecs.slice(0, BASELINE_COUNT)) {
      const outcome = await applySpec(context, spec.name);
      assert.equal(outcome.status, 'applied');
    }
    const seed = executableSql(await readFile(
      path.resolve('backend/tests/integration/upgrade-convergence-seed.pg.sql'),
      'utf8',
    ));
    await context.client.query(seed);
    await context.client.query(
      `INSERT INTO public.tasks
       SELECT (jsonb_populate_record(
         NULL::public.tasks,
         to_jsonb(source_task) || jsonb_build_object(
           'id', $2::text,
           'title', 'Second containment fixture'
         )
       )).*
       FROM public.tasks source_task WHERE source_task.id=$1::uuid`,
      [FIRST_TASK, SECOND_TASK],
    );
    const fingerprint = await catalogFingerprint(context.client);
    assert.equal(fingerprint.functionBodies.length, BASELINE_FUNCTIONS.length);
    assert.equal(fingerprint.triggers.length, BASELINE_TRIGGERS.length);
  });
}

async function grantRuntime(database) {
  const client = new Client({ connectionString: urlFor(database, MIGRATOR) });
  await client.connect();
  try {
    await client.query(`
      REVOKE CREATE ON SCHEMA public FROM PUBLIC, hx_ci_runtime;
      GRANT USAGE ON SCHEMA public TO hx_ci_runtime;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO hx_ci_runtime;
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO hx_ci_runtime;
      REVOKE TRIGGER, TRUNCATE, REFERENCES ON ALL TABLES IN SCHEMA public FROM hx_ci_runtime;
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON public.ops_business_claim_links,
           public.hxos_local_test_business_payout_destinations,
           public.hxos_local_test_business_payout_transfers
        FROM hx_ci_runtime;
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON public.applied_migrations,
           public.schema_versions,
           public.hx_database_identity
        FROM hx_ci_runtime;
      REVOKE EXECUTE ON FUNCTION public.reject_pr276_incident_table_mutation()
        FROM hx_ci_runtime;
      REVOKE EXECUTE ON FUNCTION public.reject_control_table_destructive_mutation()
        FROM hx_ci_runtime;
    `);
  } finally {
    await client.end();
  }
}

async function assertRuntimeAttacks(database) {
  const client = new Client({ connectionString: urlFor(database, RUNTIME) });
  await client.connect();
  try {
    for (const sql of [
      'CREATE TABLE public.hx_runtime_attack(id integer)',
      'CREATE TEMP TABLE hx_runtime_temp_attack(id integer)',
      'ALTER TABLE public.tasks ADD COLUMN hx_runtime_attack text',
      'ALTER TABLE public.tasks DISABLE TRIGGER task_region_policy_accept_gate',
      `CREATE TRIGGER hx_runtime_trigger_attack BEFORE UPDATE ON public.tasks
         FOR EACH ROW EXECUTE FUNCTION public.enforce_task_region_policy_on_accept()`,
      'ALTER TABLE public.ops_business_claim_links DISABLE TRIGGER pr276_incident_dml_guard',
      'TRUNCATE TABLE public.ops_business_claim_links',
      "SET session_replication_role = 'replica'",
      "INSERT INTO public.applied_migrations(name, ordinal, source_sha256) VALUES ('runtime_attack', 999, repeat('0', 64))",
      "UPDATE public.schema_versions SET checksum = 'runtime_attack'",
      'DELETE FROM public.hx_database_identity',
      'TRUNCATE TABLE public.applied_migrations',
      'ALTER TABLE public.applied_migrations DISABLE TRIGGER migration_control_destructive_guard',
      `INSERT INTO public.ops_business_claim_links(
         id, task_draft_id, token_hash, status, expires_at
       ) VALUES (gen_random_uuid(), gen_random_uuid(), repeat('a',64), 'OPEN', now()+interval '1 hour')`,
      'SELECT public.reject_pr276_incident_table_mutation()',
    ]) {
      await assert.rejects(client.query(sql), /permission denied|must be owner/i);
    }
  } finally {
    await client.end();
  }
}

async function runContract(client, shouldPass) {
  const contract = executableSql(await readFile(
    path.resolve('backend/tests/integration/pr276-incident-containment.pg.sql'),
    'utf8',
  ));
  if (shouldPass) await client.query(contract);
  else await assert.rejects(client.query(contract), /HXPR276 assertion failed|does not exist/);
}

async function runDisputeReleaseContract(client) {
  const contract = executableSql(await readFile(
    path.resolve('backend/tests/integration/dispute-release-authority.pg.sql'),
    'utf8',
  ));
  const result = await client.query(contract);
  const statements = Array.isArray(result) ? result : [result];
  assert.equal(
    statements.some((statement) => statement.rows?.some?.(
      (row) => row.result === 'DISPUTE_RELEASE_AUTHORITY_DATABASE_CONTRACT_OK',
    )),
    true,
    'dispute release authority PostgreSQL contract did not report success',
  );
}

async function runRefundProviderClaimContract(client) {
  const contract = executableSql(await readFile(
    path.resolve('backend/tests/integration/refund-provider-claim-authority.pg.sql'),
    'utf8',
  ));
  const result = await client.query(contract);
  const statements = Array.isArray(result) ? result : [result];
  assert.equal(
    statements.some((statement) => statement.rows?.some?.(
      (row) => row.result === 'REFUND_PROVIDER_CLAIM_AUTHORITY_DATABASE_CONTRACT_OK',
    )),
    true,
    'refund provider claim PostgreSQL contract did not report success',
  );
}

async function scenario(admin, options) {
  await recreateDatabase(admin, options.database, BASE_DATABASE);
  let replayFingerprint;
  await withMigrationClient(options.database, async (context) => {
    const baselineFingerprint = await catalogFingerprint(context.client);

    if (options.skew === 'catalog_only') {
      for (const name of PR276_NAMES) await executeSpecWithoutLedger(context, name);
    } else if (options.skew === 'ledger_only' || options.skew === 'checkerboard') {
      for (const [index, name] of PR276_NAMES.entries()) {
        if (options.skew === 'checkerboard' && index % 2 === 0) {
          await executeSpecWithoutLedger(context, name);
        } else {
          await context.client.query(
            'INSERT INTO public.applied_migrations(name) VALUES ($1) ON CONFLICT DO NOTHING',
            [name],
          );
        }
      }
    } else {
      for (const name of PR276_NAMES.slice(0, options.prefix)) await applySpec(context, name);
    }

    for (const name of PR276_NAMES) await applySpec(context, name);

    if (options.manualBypass === 'liquidity' || options.manualBypass === 'both') {
      await context.client.query(MANUAL_LIQUIDITY_BYPASS);
    }
    if (options.manualBypass === 'offer' || options.manualBypass === 'both') {
      await context.client.query(MANUAL_OFFER_BYPASS);
    }

    if (options.quoteInitiallyPresent) await applySpec(context, QUOTE_RECOVERY);
    await applySpec(context, QUOTE_RECOVERY);

    const orchestrationColumn = await context.client.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_attribute
          WHERE attrelid='public.tasks'::regclass
            AND attname='orchestration_mode' AND NOT attisdropped
       ) AS present`,
    );
    if (orchestrationColumn.rows[0]?.present) {
      await context.client.query(
        `UPDATE public.tasks SET orchestration_mode='OPS_MANUAL' WHERE id=$1::uuid`,
        [FIRST_TASK],
      );
    }

    await applySpec(context, CONTAINMENT);
    await runContract(context.client, options.shouldPass);

    if (options.shouldPass) {
      await runDisputeReleaseContract(context.client);
      await runRefundProviderClaimContract(context.client);
      const containedFingerprint = await catalogFingerprint(context.client);
      assert.deepEqual(containedFingerprint.functionBodies, baselineFingerprint.functionBodies);
      assert.deepEqual(containedFingerprint.triggers, baselineFingerprint.triggers);
      for (const { proconfig } of containedFingerprint.functionSearchPaths) {
        assert.deepEqual(proconfig, ['search_path=pg_catalog, public']);
      }
      const beforeReplay = await catalogFingerprint(context.client);
      const replay = await applySpec(context, CONTAINMENT);
      assert.equal(replay.status, 'already_applied');
      replayFingerprint = await catalogFingerprint(context.client);
      assert.deepEqual(replayFingerprint, beforeReplay);
    }
  });
  if (options.shouldPass) {
    await grantRuntime(options.database);
    await assertRuntimeAttacks(options.database);
  }
  return replayFingerprint;
}

const admin = new Client({ connectionString: adminDatabaseUrl });
await admin.connect();
try {
  await ensureRoles(admin);
  await buildTemplate(admin);

  for (let prefix = 0; prefix <= 9; prefix += 1) {
    await scenario(admin, {
      database: `hx_ci_prefix_${prefix}_test`,
      prefix,
      quoteInitiallyPresent: prefix % 2 === 1,
      shouldPass: true,
    });
  }
  await scenario(admin, {
    database: 'hx_ci_catalog_only_test',
    prefix: 0,
    skew: 'catalog_only',
    quoteInitiallyPresent: false,
    shouldPass: true,
  });
  await scenario(admin, {
    database: 'hx_ci_ledger_only_test',
    prefix: 0,
    skew: 'ledger_only',
    quoteInitiallyPresent: true,
    shouldPass: false,
  });
  await scenario(admin, {
    database: 'hx_ci_checkerboard_test',
    prefix: 0,
    skew: 'checkerboard',
    quoteInitiallyPresent: false,
    shouldPass: false,
  });
  for (const manualBypass of ['liquidity', 'offer', 'both']) {
    await scenario(admin, {
      database: `hx_ci_manual_${manualBypass}_test`,
      prefix: 9,
      manualBypass,
      quoteInitiallyPresent: true,
      shouldPass: true,
    });
  }
} finally {
  await admin.end();
}

process.stdout.write('HXOS_PR276_INCIDENT_CONTAINMENT_POSTGRES_OK\n');
