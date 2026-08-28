import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { db } from './db.js';
import { REQUIRED_MIGRATION_FILES } from './jobs/engine-automation-migration-files.js';
import { logger } from './logger.js';

type StartupLogger = {
  debug: typeof logger.debug;
  error: typeof logger.error;
  info: typeof logger.info;
  warn: typeof logger.warn;
};

export type StartupMigrationSpec = {
  name: string;
  candidatePaths: string[];
};

type StartupMigrationEvidence = {
  name: string;
  sha256: string | null;
};

export type StartupMigrationRuntime = {
  migrationSpecs: readonly StartupMigrationSpec[];
  readText(filePath: string): Promise<string>;
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: StartupMigrationEvidence[] }>;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function productionStartupMigrationRuntime(): StartupMigrationRuntime {
  const cwd = process.cwd();
  return {
    migrationSpecs: REQUIRED_MIGRATION_FILES.map(({ name, fileName }) => ({
      name,
      candidatePaths: [
        path.join(cwd, 'backend/database/migrations', fileName),
        path.join('/app/backend/database/migrations', fileName),
      ],
    })),
    readText: (filePath) => readFile(filePath, 'utf8'),
    query: async (sql, values) => {
      const result = await db.query<StartupMigrationEvidence>(sql, values);
      return { rows: result.rows };
    },
  };
}

async function readRequiredMigration(
  runtime: StartupMigrationRuntime,
  spec: StartupMigrationSpec,
): Promise<string> {
  for (const candidatePath of spec.candidatePaths) {
    try {
      const sql = await runtime.readText(candidatePath);
      if (sql.trim()) return sql;
    } catch {
      // Every canonical production path is checked before failing closed.
    }
  }
  throw new Error(`STARTUP_MIGRATION_FILE_UNAVAILABLE: ${spec.name}`);
}

async function expectedMigrationDigests(
  runtime: StartupMigrationRuntime,
): Promise<Map<string, string>> {
  const expected = new Map<string, string>();
  for (const spec of runtime.migrationSpecs) {
    if (expected.has(spec.name)) {
      throw new Error(`STARTUP_MIGRATION_REGISTRY_DUPLICATE: ${spec.name}`);
    }
    const sql = await readRequiredMigration(runtime, spec);
    expected.set(spec.name, createHash('sha256').update(sql, 'utf8').digest('hex'));
  }
  return expected;
}

/**
 * API processes never own schema changes. They only attest that the canonical
 * worker-owned migration chain is already present with its exact SQL digests.
 */
export async function runStartupMigrations(
  startLog: StartupLogger,
  runtime: StartupMigrationRuntime = productionStartupMigrationRuntime(),
): Promise<void> {
  const expected = await expectedMigrationDigests(runtime);
  const names = [...expected.keys()];
  const result = await runtime.query(
    `SELECT name, sha256
     FROM applied_migrations
     WHERE name = ANY($1::text[])`,
    [names],
  );

  const observed = new Map<string, string>();
  for (const row of result.rows) {
    if (!expected.has(row.name)) {
      throw new Error(`STARTUP_MIGRATION_UNEXPECTED_EVIDENCE: ${row.name}`);
    }
    if (observed.has(row.name)) {
      throw new Error(`STARTUP_MIGRATION_DUPLICATE_EVIDENCE: ${row.name}`);
    }
    const recordedSha256 = row.sha256?.trim() ?? '';
    if (!SHA256_PATTERN.test(recordedSha256)) {
      throw new Error(`STARTUP_MIGRATION_INVALID_SHA256: ${row.name}`);
    }
    if (recordedSha256 !== expected.get(row.name)) {
      throw new Error(`STARTUP_MIGRATION_CHECKSUM_DRIFT: ${row.name}`);
    }
    observed.set(row.name, recordedSha256);
  }

  for (const name of names) {
    if (!observed.has(name)) {
      throw new Error(`STARTUP_MIGRATION_EVIDENCE_MISSING: ${name}`);
    }
  }

  startLog.info(
    { migrationCount: observed.size },
    'Canonical migration evidence verified; API startup performed no schema writes',
  );
}
