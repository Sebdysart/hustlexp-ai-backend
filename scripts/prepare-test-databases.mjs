import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

export const TEST_DATABASE_USER = 'hx_ci_runner';
export const TEST_DATABASE_PORT = '5432';
export const ADMIN_DATABASE = 'hx_ci_admin_test';
export const TEST_DATABASES = Object.freeze({
  invariant: 'hx_ci_invariant_test',
  system: 'hx_ci_system_test',
});
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const NONPRODUCTION_TEST_FINANCIAL_MIGRATIONS = Object.freeze([
  Object.freeze({
    name: '20260827_fake_financial_provider_v1',
    path: resolve(
      scriptDirectory,
      '../backend/database/migrations/20260827_fake_financial_provider_v1.sql'
    ),
    evidenceTable: 'hxos_fake_financial_schema_evidence_v1',
    requiredMarker: 'hxos_fake_financial_operation_events_v1',
  }),
  Object.freeze({
    name: '20260903_fake_financial_provider_account_refresh_v2',
    path: resolve(
      scriptDirectory,
      '../backend/database/migrations/20260903_fake_financial_provider_account_refresh_v2.sql'
    ),
    evidenceTable: 'hxos_fake_financial_schema_evidence_v2',
    requiredMarker: 'REFRESH_PROVIDER_ACCOUNT_STATE',
  }),
  Object.freeze({
    name: '20260910_fake_financial_settlement_completion_v3',
    path: resolve(
      scriptDirectory,
      '../backend/database/migrations/20260910_fake_financial_settlement_completion_v3.sql'
    ),
    evidenceTable: 'hxos_fake_financial_schema_evidence_v3',
    requiredMarker: 'OBSERVE_BANK_SETTLEMENT',
  }),
  Object.freeze({
    name: '20260921_universal_v1_fake_financial_lifecycle_bridge_v1',
    path: resolve(
      scriptDirectory,
      '../backend/database/migrations/20260921_universal_v1_fake_financial_lifecycle_bridge_v1.sql'
    ),
    evidenceTable: 'hxos_fake_financial_schema_evidence_v4',
    requiredMarker: 'universal_v1_fake_financial_lifecycle_bridges',
  }),
]);
export const NONPRODUCTION_TEST_FINANCIAL_MIGRATION =
  NONPRODUCTION_TEST_FINANCIAL_MIGRATIONS.at(-1).name;
export const NONPRODUCTION_TEST_FINANCIAL_MIGRATION_PATH =
  NONPRODUCTION_TEST_FINANCIAL_MIGRATIONS.at(-1).path;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);

function parseDatabaseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export function validatePreparationPolicy(env = process.env) {
  const errors = [];
  if (env.NODE_ENV !== 'test') errors.push('NODE_ENV must be test');
  if (env.HX_ALLOW_CI_DB_RECREATE !== 'true') {
    errors.push('HX_ALLOW_CI_DB_RECREATE must explicitly equal true');
  }
  const url = parseDatabaseUrl(env.DATABASE_URL || '');
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    errors.push('DATABASE_URL must be a PostgreSQL URL');
    return errors;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    errors.push('DATABASE_URL host must be an explicit loopback address');
  }
  if ((url.port || TEST_DATABASE_PORT) !== TEST_DATABASE_PORT) {
    errors.push(`DATABASE_URL port must be ${TEST_DATABASE_PORT}`);
  }
  if (url.pathname !== `/${ADMIN_DATABASE}`) {
    errors.push(`DATABASE_URL must target ${ADMIN_DATABASE}`);
  }
  if (url.username !== TEST_DATABASE_USER) {
    errors.push(`DATABASE_URL user must be ${TEST_DATABASE_USER}`);
  }
  if (url.search || url.hash) {
    errors.push('DATABASE_URL must not contain query parameters or fragments');
  }
  return errors;
}

export function validatePreparedDatabaseUrl(value, expectedDatabase) {
  const errors = [];
  if (!Object.values(TEST_DATABASES).includes(expectedDatabase)) {
    return [`Unrecognized prepared database: ${expectedDatabase}`];
  }
  const url = parseDatabaseUrl(value || '');
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    return ['Prepared database URL must be a PostgreSQL URL'];
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    errors.push('Prepared database host must be an explicit loopback address');
  }
  if ((url.port || TEST_DATABASE_PORT) !== TEST_DATABASE_PORT) {
    errors.push(`Prepared database port must be ${TEST_DATABASE_PORT}`);
  }
  if (url.pathname !== `/${expectedDatabase}`) {
    errors.push(`Prepared database URL must target ${expectedDatabase}`);
  }
  if (url.username !== TEST_DATABASE_USER) {
    errors.push(`Prepared database user must be ${TEST_DATABASE_USER}`);
  }
  if (url.search || url.hash) {
    errors.push('Prepared database URL must not contain query parameters or fragments');
  }
  return errors;
}

export function testDatabaseUrls(adminDatabaseUrl) {
  const admin = new URL(adminDatabaseUrl);
  return Object.fromEntries(
    Object.entries(TEST_DATABASES).map(([role, name]) => {
      const target = new URL(admin);
      target.pathname = `/${name}`;
      const value = target.toString();
      const errors = validatePreparedDatabaseUrl(value, name);
      if (errors.length > 0) {
        throw new Error(`Refusing derived test database URL: ${errors.join('; ')}`);
      }
      return [role, value];
    })
  );
}

async function recreateDatabases(adminDatabaseUrl) {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    for (const name of Object.values(TEST_DATABASES)) {
      if (!/^hx_ci_(invariant|system)_test$/u.test(name)) {
        throw new Error(`Unsafe test database target: ${name}`);
      }
      await client.query(
        `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name]
      );
      await client.query(`DROP DATABASE IF EXISTS ${name}`);
      await client.query(`CREATE DATABASE ${name}`);
    }
  } finally {
    await client.end();
  }
}

async function migrateDatabases(urls) {
  const { productionMigrationRuntime, runEngineAutomationMigration } =
    await import('../dist/backend/src/jobs/engine-automation-migration.js');
  for (const [role, databaseUrl] of Object.entries(urls)) {
    const runtime = productionMigrationRuntime();
    runtime.databaseUrl = databaseUrl;
    const results = await runEngineAutomationMigration(runtime);
    if (results.some((result) => result.status !== 'applied')) {
      throw new Error(`${role} database did not receive a fresh exact migration chain`);
    }
    console.log(
      `Prepared isolated ${role} PostgreSQL test database (${results.length} migrations)`
    );
  }
}

/**
 * Install the separately gated fake-finance evidence store in disposable test
 * databases only. These migrations intentionally remain outside the production
 * startup registry, so required tests must opt into it after the exact
 * production chain has succeeded. No row created by this schema represents
 * external value or a processor action.
 */
async function installNonproductionFinancialFixture(urls) {
  const { Client } = await import('pg');
  const migrations = await Promise.all(
    NONPRODUCTION_TEST_FINANCIAL_MIGRATIONS.map(async (migration) => {
      const sql = await readFile(migration.path, 'utf8');
      const sha256 = createHash('sha256').update(sql, 'utf8').digest('hex');
      if (!sql.includes(migration.requiredMarker) || !/^[0-9a-f]{64}$/u.test(sha256)) {
        throw new Error(`Invalid nonproduction fake-finance fixture migration: ${migration.name}`);
      }
      return { ...migration, sql, sha256 };
    })
  );

  for (const [role, databaseUrl] of Object.entries(urls)) {
    const expectedDatabase = TEST_DATABASES[role];
    const validationErrors = validatePreparedDatabaseUrl(databaseUrl, expectedDatabase);
    if (validationErrors.length > 0) {
      throw new Error(`Refusing nonproduction fixture for ${role}: ${validationErrors.join('; ')}`);
    }
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await client.query('BEGIN');
      for (const migration of migrations) {
        await client.query(migration.sql);
        await client.query(
          `INSERT INTO ${migration.evidenceTable}
             (migration_name, migration_sql_sha256)
           VALUES ($1, $2)`,
          [migration.name, migration.sha256]
        );
        await client.query(
          `INSERT INTO applied_migrations(name, sha256)
           VALUES ($1, $2)`,
          [migration.name, migration.sha256]
        );
        const evidence = await client.query(
          `SELECT migration_sql_sha256
           FROM ${migration.evidenceTable}
           WHERE migration_name = $1`,
          [migration.name]
        );
        if (evidence.rows[0]?.migration_sql_sha256?.trim() !== migration.sha256) {
          throw new Error(`${role} fake-finance fixture evidence mismatch: ${migration.name}`);
        }
      }
      await client.query('COMMIT');
      console.log(
        `Prepared isolated ${role} fake-finance fixture ` +
          `(${migrations.map((migration) => migration.sha256).join(',')})`
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
  }
}

async function main() {
  const errors = validatePreparationPolicy(process.env);
  if (errors.length > 0) throw new Error(`Refusing CI database preparation: ${errors.join('; ')}`);
  const urls = testDatabaseUrls(process.env.DATABASE_URL);
  await recreateDatabases(process.env.DATABASE_URL);
  await migrateDatabases(urls);
  await installNonproductionFinancialFixture(urls);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
