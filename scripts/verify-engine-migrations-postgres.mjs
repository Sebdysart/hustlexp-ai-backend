import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import {
  applyEngineAutomationMigration,
  loadMigrationSql,
  productionMigrationRuntime,
  runEngineAutomationMigration,
} from '../dist/backend/src/jobs/engine-automation-migration.js';
import { REQUIRED_MIGRATION_FILES } from '../dist/backend/src/jobs/engine-automation-migration-files.js';

const { Client } = pg;
const adminDatabaseUrl = process.env.DATABASE_URL?.trim();
if (!adminDatabaseUrl) throw new Error('DATABASE_URL is required');

const databaseNames = {
  fresh: 'hx_ci_fresh_test',
  upgrade: 'hx_ci_upgrade_test',
};

function databaseUrl(name) {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function executableSql(sql) {
  return sql.split(/\r?\n/).filter((line) => !line.startsWith('\\')).join('\n');
}

async function recreateDatabase(client, name) {
  if (!/^hx_ci_[a-z_]+_test$/.test(name)) throw new Error(`Unsafe CI database name: ${name}`);
  await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await client.query(`CREATE DATABASE ${name}`);
}

async function assertExactRegistry(url) {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const result = await client.query('SELECT name FROM applied_migrations ORDER BY name');
    assert.deepEqual(
      result.rows.map((row) => row.name),
      REQUIRED_MIGRATION_FILES.map((entry) => entry.name).sort(),
      'database migration ledger must equal the exact runtime registry',
    );
  } finally {
    await client.end();
  }
}

async function verifyFresh(url) {
  process.env.DATABASE_URL = url;
  const first = await runEngineAutomationMigration();
  assert.equal(first.length, REQUIRED_MIGRATION_FILES.length);
  assert.ok(first.every((outcome) => outcome.status === 'applied'));
  const replay = await runEngineAutomationMigration();
  assert.ok(replay.every((outcome) => outcome.status === 'already_applied'));
  await assertExactRegistry(url);
}

async function verifyUpgrade(url) {
  const runtime = productionMigrationRuntime();
  runtime.databaseUrl = url;
  const client = runtime.createClient(url);
  await client.connect();
  try {
    const baseline = await readFile(
      path.resolve('backend/database/constitutional-schema.sql'),
      'utf8',
    );
    await client.query(baseline);

    const splitIndex = runtime.migrationSpecs.findIndex(
      (spec) => spec.name === '20260720_offline_action_sync_contract',
    );
    assert.ok(splitIndex > 0, 'upgrade split migration must be registered');

    for (const spec of runtime.migrationSpecs.slice(0, splitIndex)) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name,
      );
      assert.equal(outcome.status, 'applied');
    }

    const seed = executableSql(await readFile(
      path.resolve('backend/tests/integration/upgrade-convergence-seed.pg.sql'),
      'utf8',
    ));
    await client.query(seed);

    for (const spec of runtime.migrationSpecs.slice(splitIndex)) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name,
      );
      assert.equal(outcome.status, 'applied');
    }

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

    for (const spec of runtime.migrationSpecs) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name,
      );
      assert.equal(outcome.status, 'already_applied');
    }
  } finally {
    await client.end();
  }
  await assertExactRegistry(url);
}

const admin = new Client({ connectionString: adminDatabaseUrl });
await admin.connect();
try {
  await recreateDatabase(admin, databaseNames.fresh);
  await recreateDatabase(admin, databaseNames.upgrade);
} finally {
  await admin.end();
}

await verifyFresh(databaseUrl(databaseNames.fresh));
await verifyUpgrade(databaseUrl(databaseNames.upgrade));
process.stdout.write(
  `HXOS_ENGINE_MIGRATIONS_POSTGRES_OK ${REQUIRED_MIGRATION_FILES.length}\n`,
);
