import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { workerLogger } from '../logger.js';

export const ENGINE_AUTOMATION_MIGRATION = '20260710_engine_automation_contracts';
export const PROOF_ALIGNMENT_MIGRATION = '20260711_required_proof_alignment';
export const EXPERTISE_SUPPLY_MIGRATION = '20260711_required_expertise_supply';
export const TASK_OUTCOME_CLASSIFICATION_MIGRATION = '20260711_task_outcome_classification';
export const HUSTLER_IDENTITY_LINK_MIGRATION = '20260712_hustler_identity_link';
export const DISPATCH_EXPIRY_PAYMENT_CANCEL_MIGRATION = '20260712_dispatch_expiry_pending_payment_cancel';

const REQUIRED_MIGRATION_FILES = [
  { name: ENGINE_AUTOMATION_MIGRATION, fileName: '20260710_engine_automation_contracts.sql' },
  { name: PROOF_ALIGNMENT_MIGRATION, fileName: '011-proof-alignment.sql' },
  { name: EXPERTISE_SUPPLY_MIGRATION, fileName: 'expertise_supply_control.sql' },
  { name: TASK_OUTCOME_CLASSIFICATION_MIGRATION, fileName: '20260711_task_outcome_classification.sql' },
  { name: HUSTLER_IDENTITY_LINK_MIGRATION, fileName: '20260712_hustler_identity_link.sql' },
  {
    name: DISPATCH_EXPIRY_PAYMENT_CANCEL_MIGRATION,
    fileName: '20260712_dispatch_expiry_pending_payment_cancel.sql',
  },
] as const;

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
  migrationSpecs: MigrationSpec[];
  readText(filePath: string): Promise<string>;
  createClient(databaseUrl: string): MigrationClient;
}

export type MigrationSpec = {
  name: string;
  candidatePaths: string[];
};

export type MigrationOutcome = {
  status: 'applied' | 'already_applied';
  migration: string;
  sourcePath: string;
};

export function productionMigrationRuntime(): MigrationRuntime {
  const cwd = process.cwd();
  return {
    databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
    migrationSpecs: REQUIRED_MIGRATION_FILES.map(({ name, fileName }) => ({
      name,
      candidatePaths: [
        path.join(cwd, 'backend/database/migrations', fileName),
        path.join('/app/backend/database/migrations', fileName),
      ],
    })),
    readText: (filePath) => readFile(filePath, 'utf8'),
    createClient: (databaseUrl) => new Client({ connectionString: databaseUrl }) as MigrationClient,
  };
}

export async function loadMigrationSql(
  runtime: MigrationRuntime,
  spec: MigrationSpec = runtime.migrationSpecs[0],
): Promise<{ sql: string; sourcePath: string }> {
  const failures: Array<{ path: string; reason: string }> = [];
  for (const candidate of spec.candidatePaths) {
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
  throw new Error(`Required migration ${spec.name} is unavailable: ${JSON.stringify(failures)}`);
}

export async function applyEngineAutomationMigration(
  client: MigrationClient,
  sql: string,
  sourcePath: string,
  migrationName: string = ENGINE_AUTOMATION_MIGRATION,
): Promise<MigrationOutcome> {
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [migrationName]);
    await client.query(`CREATE TABLE IF NOT EXISTS applied_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    const existing = await client.query<{ name: string }>(
      'SELECT name FROM applied_migrations WHERE name = $1',
      [migrationName],
    );
    if (existing.rows.length > 0) {
      await client.query('COMMIT');
      return { status: 'already_applied', migration: migrationName, sourcePath };
    }

    await client.query(sql);
    await client.query('INSERT INTO applied_migrations (name) VALUES ($1)', [migrationName]);
    await client.query('COMMIT');
    return { status: 'applied', migration: migrationName, sourcePath };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

export async function runEngineAutomationMigration(
  runtime: MigrationRuntime = productionMigrationRuntime(),
): Promise<MigrationOutcome[]> {
  if (!runtime.databaseUrl) {
    throw new Error('DATABASE_URL is required before applying engine automation contracts');
  }
  const client = runtime.createClient(runtime.databaseUrl);
  await client.connect();
  try {
    const outcomes: MigrationOutcome[] = [];
    for (const spec of runtime.migrationSpecs) {
      const migration = await loadMigrationSql(runtime, spec);
      const outcome = await applyEngineAutomationMigration(
        client,
        migration.sql,
        migration.sourcePath,
        spec.name,
      );
      outcomes.push(outcome);
      workerLogger.info(outcome, 'Required engine migration verified');
    }
    return outcomes;
  } catch (error) {
    workerLogger.fatal({ err: error }, 'Required engine migration failed');
    throw error;
  } finally {
    await client.end();
  }
}
