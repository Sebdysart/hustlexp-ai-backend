import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { workerLogger } from '../logger.js';

export const ENGINE_AUTOMATION_MIGRATION = '20260710_engine_automation_contracts';

type QueryResult<Row extends Record<string, unknown> = Record<string, unknown>> = {
  rows: Row[];
};

export interface MigrationClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<QueryResult<Row>>;
}

export interface MigrationRuntime {
  databaseUrl: string;
  candidatePaths: string[];
  readText(filePath: string): Promise<string>;
  createClient(databaseUrl: string): MigrationClient;
}

export type MigrationOutcome = {
  status: 'applied' | 'already_applied';
  migration: string;
  sourcePath: string;
};

export function productionMigrationRuntime(): MigrationRuntime {
  const cwd = process.cwd();
  return {
    databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
    candidatePaths: [
      path.join(cwd, 'backend/database/migrations/20260710_engine_automation_contracts.sql'),
      '/app/backend/database/migrations/20260710_engine_automation_contracts.sql',
    ],
    readText: (filePath) => readFile(filePath, 'utf8'),
    createClient: (databaseUrl) => new Client({ connectionString: databaseUrl }) as MigrationClient,
  };
}

export async function loadMigrationSql(
  runtime: MigrationRuntime,
): Promise<{ sql: string; sourcePath: string }> {
  const failures: Array<{ path: string; reason: string }> = [];
  for (const candidate of runtime.candidatePaths) {
    try {
      const sql = await runtime.readText(candidate);
      if (sql.trim()) return { sql, sourcePath: candidate };
      failures.push({ path: candidate, reason: 'empty_file' });
    } catch (error) {
      failures.push({
        path: candidate,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  throw new Error(`Required engine automation migration is unavailable: ${JSON.stringify(failures)}`);
}

export async function applyEngineAutomationMigration(
  client: MigrationClient,
  sql: string,
  sourcePath: string,
): Promise<MigrationOutcome> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [ENGINE_AUTOMATION_MIGRATION]);
    await client.query(`CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const existing = await client.query<{ name: string }>(
      'SELECT name FROM applied_migrations WHERE name = $1',
      [ENGINE_AUTOMATION_MIGRATION],
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return { status: 'already_applied', migration: ENGINE_AUTOMATION_MIGRATION, sourcePath };
    }

    await client.query(sql);
    await client.query('INSERT INTO applied_migrations (name) VALUES ($1)', [ENGINE_AUTOMATION_MIGRATION]);
    await client.query('COMMIT');
    return { status: 'applied', migration: ENGINE_AUTOMATION_MIGRATION, sourcePath };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runEngineAutomationMigration(
  runtime: MigrationRuntime = productionMigrationRuntime(),
): Promise<MigrationOutcome> {
  if (!runtime.databaseUrl) {
    throw new Error('DATABASE_URL is required before applying engine automation contracts');
  }
  const migration = await loadMigrationSql(runtime);
  const client = runtime.createClient(runtime.databaseUrl);
  await client.connect();
  try {
    const outcome = await applyEngineAutomationMigration(client, migration.sql, migration.sourcePath);
    workerLogger.info(outcome, 'Required engine automation migration verified');
    return outcome;
  } catch (error) {
    workerLogger.fatal({ err: error, migration: ENGINE_AUTOMATION_MIGRATION }, 'Required migration failed');
    throw error;
  } finally {
    await client.end();
  }
}
