import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import pg from 'pg';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-fake-financial-execution.js';

/** Fresh synthetic fixture with an explicit supplemental boundary; never reuses a schema. */
export async function createUniversalV1DisposableDatabase(options: {
  bootstrapOwnerRole?: string;
  canonicalMigrationLedger?: boolean;
  throughFinancialMigration: (typeof CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES)[number]['name'];
}): Promise<{
  pool: pg.Pool;
  databaseUrl: string;
  close(): Promise<void>;
}> {
  const finalMigrationIndex = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.findIndex(
    (entry) => entry.name === options.throughFinancialMigration
  );
  if (finalMigrationIndex < 0) throw new Error('DISPOSABLE_MIGRATION_BOUNDARY_INVALID');
  const financialMigrations = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.slice(
    0,
    finalMigrationIndex + 1
  );
  const source = new URL(process.env.DATABASE_URL ?? '');
  if (
    !['postgres:', 'postgresql:'].includes(source.protocol) ||
    source.hostname !== '127.0.0.1' ||
    source.port !== '5432' ||
    source.username !== 'hx_ci_runner' ||
    !/^\/hx_ci_(?:admin|invariant|system)_test$/u.test(source.pathname) ||
    source.search ||
    source.hash
  )
    throw new Error('EXACT_DISPOSABLE_DATABASE_REQUIRED');
  const databaseName = `hx_ci_v13_${randomUUID().replaceAll('-', '')}_test`;
  if (!/^hx_ci_v13_[a-f0-9]{32}_test$/u.test(databaseName)) {
    throw new Error('DISPOSABLE_DATABASE_NAME_INVALID');
  }
  source.pathname = '/hx_ci_admin_test';
  const admin = new pg.Client({ connectionString: source.toString() });
  source.pathname = `/${databaseName}`;
  const databaseUrl = source.toString();
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  let created = false;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    try {
      await pool.end();
      if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    } finally {
      await admin.end();
    }
  };
  await admin.connect();
  try {
    const version = await admin.query<{ version: number }>(
      "SELECT current_setting('server_version_num')::integer AS version"
    );
    if (version.rows[0]!.version < 160000 || version.rows[0]!.version >= 170000) {
      throw new Error('POSTGRES_16_REQUIRED');
    }
    if (options.bootstrapOwnerRole) {
      if (!/^hx_ci_[a-f0-9]{20}_command$/u.test(options.bootstrapOwnerRole))
        throw new Error('EXACT_SYNTHETIC_BOOTSTRAP_OWNER_REQUIRED');
      const owner = await admin.query('SELECT * FROM pg_catalog.pg_roles WHERE rolname=$1', [
        options.bootstrapOwnerRole,
      ]);
      const role = owner.rows[0];
      if (
        !role ||
        role.rolcanlogin ||
        role.rolsuper ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication ||
        role.rolbypassrls
      )
        throw new Error('UNSAFE_SYNTHETIC_BOOTSTRAP_OWNER');
    }
    await admin.query(
      `CREATE DATABASE "${databaseName}" TEMPLATE template0${
        options.bootstrapOwnerRole ? ' OWNER "' + options.bootstrapOwnerRole + '"' : ''
      }`
    );
    created = true;
    const client = await pool.connect();
    try {
      if (options.bootstrapOwnerRole) {
        await client.query('ALTER SCHEMA public OWNER TO "' + options.bootstrapOwnerRole + '"');
        await client.query('SET ROLE "' + options.bootstrapOwnerRole + '"');
        try {
          await client.query('CREATE EXTENSION pgcrypto WITH SCHEMA public');
        } finally {
          await client.query('RESET ROLE');
        }
      }
      await client.query(
        await readFile(new URL('../../database/constitutional-schema.sql', import.meta.url), 'utf8')
      );
      // Exercise legacy compatibility by default; readiness uses the fresh
      // migrator's canonical ledger, including its checksum constraint.
      await client.query(`CREATE TABLE public.applied_migrations (
        name TEXT PRIMARY KEY, sha256 CHAR(64) ${
          options.canonicalMigrationLedger ? "NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$')" : ''
        },
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )`);
      for (const registration of [...REQUIRED_MIGRATION_FILES, ...financialMigrations]) {
        const sql = await readFile(
          new URL(`../../database/migrations/${registration.fileName}`, import.meta.url),
          'utf8'
        );
        const digest = createHash('sha256').update(sql, 'utf8').digest('hex');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          if ('evidenceTable' in registration) {
            await client.query(
              `INSERT INTO public.${registration.evidenceTable}
              (migration_name,migration_sql_sha256) VALUES ($1,$2)`,
              [registration.name, digest]
            );
          }
          await client.query('INSERT INTO public.applied_migrations(name,sha256) VALUES ($1,$2)', [
            registration.name,
            digest,
          ]);
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      client.release();
    }
    return { pool, databaseUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}
