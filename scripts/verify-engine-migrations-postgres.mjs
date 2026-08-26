import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  applyEngineAutomationMigration,
  loadMigrationSql,
  normalizeMigrationSqlForAtomicApply,
  productionMigrationRuntime,
  readDatabaseIdentity,
  runEngineAutomationMigration,
} from '../dist/backend/src/jobs/engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from '../dist/backend/src/jobs/engine-automation-migration-files.js';
import { engineMigrationManifest } from '../dist/backend/src/jobs/engine-migration-manifest.js';
import { verifyRuntimeSchema } from '../dist/backend/src/serverStartupMigrations.js';

const { Client } = pg;
const adminDatabaseUrl = process.env.ADMIN_DATABASE_URL?.trim();
if (!adminDatabaseUrl) throw new Error('ADMIN_DATABASE_URL is required');

const credentials = {
  migrator: { role: 'hx_ci_migrator', password: 'hx_ci_migrator_password' },
  runtime: { role: 'hx_ci_runtime', password: 'hx_ci_runtime_password' },
};

const databaseNames = {
  fresh: 'hx_ci_fresh_test',
  upgrade: 'hx_ci_upgrade_test',
};

function databaseUrl(name, credential) {
  const url = new URL(adminDatabaseUrl);
  url.username = credential.role;
  url.password = credential.password;
  url.pathname = `/${name}`;
  return url.toString();
}

function executableSql(sql) {
  return sql.split(/\r?\n/).filter((line) => !line.startsWith('\\')).join('\n');
}

async function configureExpectedDatabaseIdentity(name) {
  const client = new Client({ connectionString: databaseUrl(name, credentials.migrator) });
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

async function provisionRoles(admin) {
  await admin.query(`
    DO $roles$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_ci_migrator') THEN
        CREATE ROLE hx_ci_migrator LOGIN PASSWORD 'hx_ci_migrator_password' NOINHERIT;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hx_ci_runtime') THEN
        CREATE ROLE hx_ci_runtime LOGIN PASSWORD 'hx_ci_runtime_password' NOINHERIT;
      END IF;
    END;
    $roles$;
    ALTER ROLE hx_ci_migrator WITH LOGIN PASSWORD 'hx_ci_migrator_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ALTER ROLE hx_ci_runtime WITH LOGIN PASSWORD 'hx_ci_runtime_password'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
  `);
}

async function recreateDatabase(admin, name, template = null) {
  if (!/^hx_ci_[a-z_]+_test$/.test(name)) throw new Error(`Unsafe CI database name: ${name}`);
  if (template && !/^hx_ci_[a-z_]+_test$/.test(template)) {
    throw new Error(`Unsafe CI template database name: ${template}`);
  }
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(
    template
      ? `CREATE DATABASE ${name} WITH TEMPLATE ${template} OWNER hx_ci_migrator`
      : `CREATE DATABASE ${name} OWNER hx_ci_migrator`
  );
  await admin.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${name} FROM PUBLIC`);
  await admin.query(`GRANT CONNECT ON DATABASE ${name} TO hx_ci_runtime`);
  const boundaryClient = new Client({ connectionString: databaseUrl(name, credentials.migrator) });
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

async function grantRuntimeDml(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(`
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE CREATE ON SCHEMA public FROM hx_ci_runtime;
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

async function assertExactRegistry(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const expected = await engineMigrationManifest();
    const result = await client.query(
      `SELECT name, ordinal, source_sha256
       FROM public.applied_migrations
       ORDER BY ordinal`
    );
    assert.deepEqual(
      result.rows,
      expected.map(({ name, ordinal, sha256 }) => ({
        name,
        ordinal,
        source_sha256: sha256,
      })),
      'database migration ledger must equal the ordered, hash-bound runtime registry',
    );
  } finally {
    await client.end();
  }
}

async function assertRuntimeAdmission(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const logs = [];
    const logger = {
      debug: () => undefined,
      error: (value, message) => logs.push({ level: 'error', value, message }),
      info: (value, message) => logs.push({ level: 'info', value, message }),
      warn: () => undefined,
    };
    const verified = await verifyRuntimeSchema(logger, (sql, values) => client.query(sql, values));
    assert.equal(verified.migrationCount, 116);
    assert.equal(logs.at(-1)?.level, 'info');
  } finally {
    await client.end();
  }
}

async function migrateWithSeparatedRoles(name) {
  const runtimeUrl = databaseUrl(name, credentials.runtime);
  const migrationUrl = databaseUrl(name, credentials.migrator);
  process.env.DATABASE_URL = runtimeUrl;
  process.env.MIGRATION_DATABASE_URL = migrationUrl;
  await configureExpectedDatabaseIdentity(name);
  const outcomes = await runEngineAutomationMigration();
  return { outcomes, runtimeUrl, migrationUrl };
}

async function verifyFresh(name) {
  const { outcomes, runtimeUrl, migrationUrl } = await migrateWithSeparatedRoles(name);
  assert.equal(outcomes.length, REQUIRED_MIGRATION_FILES.length);
  assert.ok(outcomes.every((outcome) => outcome.status === 'applied'));
  const replay = await migrateWithSeparatedRoles(name);
  assert.ok(replay.outcomes.every((outcome) => outcome.status === 'already_applied'));
  await grantRuntimeDml(migrationUrl);
  await assertExactRegistry(runtimeUrl);
  await assertRuntimeAdmission(runtimeUrl);
}

async function applyRange(runtime, client, runtimeRole, startIndex, endIndex) {
  for (const [relativeIndex, spec] of runtime.migrationSpecs
    .slice(startIndex, endIndex)
    .entries()) {
    const migration = await loadMigrationSql(runtime, spec);
    const migrationSql = normalizeMigrationSqlForAtomicApply(
      spec.name,
      migration.sql,
      migration.sourcePath,
    );
    const outcome = await applyEngineAutomationMigration(
      client,
      migrationSql,
      migration.sourcePath,
      runtimeRole,
      spec.name,
      startIndex + relativeIndex + 1,
      migration.sourceSha256,
    );
    assert.equal(outcome.status, 'applied');
  }
}

async function applyBootstrap(runtime, client, runtimeRole) {
  const spec = runtime.bootstrapSpec;
  assert.ok(spec, 'constitutional bootstrap must be registered');
  const migration = await loadMigrationSql(runtime, spec);
  const migrationSql = normalizeMigrationSqlForAtomicApply(
    spec.name,
    migration.sql,
    migration.sourcePath,
  );
  const outcome = await applyEngineAutomationMigration(
    client,
    migrationSql,
    migration.sourcePath,
    runtimeRole,
    spec.name,
    0,
    migration.sourceSha256,
  );
  assert.equal(outcome.status, 'applied');
}

async function verifyUpgrade(name) {
  const runtimeUrl = databaseUrl(name, credentials.runtime);
  const migrationUrl = databaseUrl(name, credentials.migrator);
  process.env.DATABASE_URL = runtimeUrl;
  process.env.MIGRATION_DATABASE_URL = migrationUrl;
  await configureExpectedDatabaseIdentity(name);
  const runtime = productionMigrationRuntime();
  const runtimeIdentityClient = runtime.createClient(runtimeUrl);
  const client = runtime.createClient(migrationUrl);
  await runtimeIdentityClient.connect();
  await client.connect();
  try {
    const runtimeIdentity = await readDatabaseIdentity(runtimeIdentityClient);
    const migrationIdentity = await readDatabaseIdentity(client);
    assert.equal(runtimeIdentity.database, migrationIdentity.database);
    assert.notEqual(runtimeIdentity.role, migrationIdentity.role);

    await applyBootstrap(runtime, client, runtimeIdentity.role);

    const splitIndex = runtime.migrationSpecs.findIndex(
      (spec) => spec.name === '20260720_offline_action_sync_contract',
    );
    assert.ok(splitIndex > 0, 'upgrade split migration must be registered');
    await applyRange(runtime, client, runtimeIdentity.role, 0, splitIndex);
    const seed = executableSql(await readFile(
      path.resolve('backend/tests/integration/upgrade-convergence-seed.pg.sql'),
      'utf8',
    ));
    await client.query(seed);
    await applyRange(
      runtime,
      client,
      runtimeIdentity.role,
      splitIndex,
      runtime.migrationSpecs.length,
    );

    const assertions = executableSql(await readFile(
      path.resolve('backend/tests/integration/upgrade-convergence-assert.pg.sql'),
      'utf8',
    ));
    await client.query(assertions);
    const recoveryContract = executableSql(await readFile(
      path.resolve('backend/tests/integration/quote-payment-recovery-contract.pg.sql'),
      'utf8',
    ));
    await client.query(recoveryContract);

    for (const [index, spec] of runtime.migrationSpecs.entries()) {
      const migration = await loadMigrationSql(runtime, spec);
      const migrationSql = normalizeMigrationSqlForAtomicApply(
        spec.name,
        migration.sql,
        migration.sourcePath,
      );
      const outcome = await applyEngineAutomationMigration(
        client,
        migrationSql,
        migration.sourcePath,
        runtimeIdentity.role,
        spec.name,
        index + 1,
        migration.sourceSha256,
      );
      assert.equal(outcome.status, 'already_applied');
    }
  } finally {
    await runtimeIdentityClient.end();
    await client.end();
  }
  await grantRuntimeDml(migrationUrl);
  await assertExactRegistry(runtimeUrl);
  await assertRuntimeAdmission(runtimeUrl);
}

async function assertRuntimePrivilegeAttacks(name) {
  const runtimeUrl = databaseUrl(name, credentials.runtime);
  const client = new Client({ connectionString: runtimeUrl });
  await client.connect();
  try {
    const attacks = [
      'CREATE TABLE public.hx_runtime_attack(id integer)',
      'CREATE TEMP TABLE hx_runtime_temp_attack(id integer)',
      'ALTER TABLE public.tasks DISABLE TRIGGER task_region_policy_accept_gate',
      'ALTER TABLE public.tasks ADD COLUMN hx_runtime_attack text',
      `CREATE TRIGGER hx_runtime_trigger_attack BEFORE UPDATE ON public.tasks
         FOR EACH ROW EXECUTE FUNCTION public.enforce_task_region_policy_on_accept()`,
      'CREATE OR REPLACE FUNCTION public.reject_pr276_incident_table_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$',
      'SELECT public.reject_pr276_incident_table_mutation()',
      'TRUNCATE TABLE public.ops_business_claim_links',
      "SET session_replication_role = 'replica'",
      "INSERT INTO public.applied_migrations(name, ordinal, source_sha256) VALUES ('runtime_attack', 999, repeat('0', 64))",
      "UPDATE public.schema_versions SET checksum = 'runtime_attack'",
      'DELETE FROM public.hx_database_identity',
      'TRUNCATE TABLE public.applied_migrations',
      'ALTER TABLE public.applied_migrations DISABLE TRIGGER migration_control_destructive_guard',
    ];
    for (const attack of attacks) {
      await assert.rejects(client.query(attack), /permission denied|must be owner/i);
    }
    const identity = await client.query('SELECT current_user AS role');
    assert.equal(identity.rows[0]?.role, credentials.runtime.role);
  } finally {
    await client.end();
  }
}

async function assertRuntimeInvariantTriggerAttacks() {
  const attacks = [
    {
      name: 'hx_ci_invariant_missing_test',
      sql: 'DROP TRIGGER task_terminal_guard ON public.tasks',
    },
    {
      name: 'hx_ci_invariant_disabled_test',
      sql: 'ALTER TABLE public.tasks DISABLE TRIGGER task_terminal_guard',
    },
    {
      name: 'hx_ci_invariant_decoy_test',
      sql: `
        CREATE TABLE public.hx_invariant_decoy(state text);
        DROP TRIGGER task_terminal_guard ON public.tasks;
        CREATE TRIGGER task_terminal_guard
          BEFORE UPDATE ON public.hx_invariant_decoy
          FOR EACH ROW
          EXECUTE FUNCTION public.prevent_task_terminal_mutation();
      `,
    },
  ];
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    for (const attack of attacks) {
      await recreateDatabase(admin, attack.name);
      try {
        await migrateWithSeparatedRoles(attack.name);
        await grantRuntimeDml(databaseUrl(attack.name, credentials.migrator));
        const migrator = new Client({
          connectionString: databaseUrl(attack.name, credentials.migrator),
        });
        await migrator.connect();
        try {
          await migrator.query(attack.sql);
        } finally {
          await migrator.end();
        }
        await assert.rejects(
          assertRuntimeAdmission(databaseUrl(attack.name, credentials.runtime)),
          /Runtime database schema verification failed/
        );
      } finally {
        await admin.query(`DROP DATABASE IF EXISTS ${attack.name} WITH (FORCE)`);
      }
    }
  } finally {
    await admin.end();
  }
}

assert.equal(REQUIRED_MIGRATION_FILES.length, 115);
const admin = new Client({ connectionString: adminDatabaseUrl });
await admin.connect();
try {
  await provisionRoles(admin);
  await recreateDatabase(admin, databaseNames.fresh);
  await recreateDatabase(admin, databaseNames.upgrade);
} finally {
  await admin.end();
}

await verifyFresh(databaseNames.fresh);
await verifyUpgrade(databaseNames.upgrade);
await assertRuntimeInvariantTriggerAttacks();
await assertRuntimePrivilegeAttacks(databaseNames.fresh);
process.stdout.write('HXOS_ENGINE_MIGRATIONS_POSTGRES_OK 115_LEDGER_ENTRIES\n');
