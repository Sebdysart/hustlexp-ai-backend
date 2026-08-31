import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  productionStartupMigrationRuntime,
  runStartupMigrations,
  type StartupMigrationRuntime,
} from '../../src/serverStartupMigrations.js';

const log = {
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
};

function sha256(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function exactRuntime(): StartupMigrationRuntime & { query: ReturnType<typeof vi.fn> } {
  const files = new Map([
    ['/one.sql', 'SELECT 1;'],
    ['/two.sql', 'SELECT 2;'],
  ]);
  const query = vi.fn(async () => ({
    rows: [
      { name: 'one', sha256: sha256('SELECT 1;') },
      { name: 'two', sha256: sha256('SELECT 2;') },
    ],
  }));
  return {
    migrationSpecs: [
      { name: 'one', candidatePaths: ['/one.sql'] },
      { name: 'two', candidatePaths: ['/two.sql'] },
    ],
    readText: async (filePath) => {
      const sql = files.get(filePath);
      if (sql === undefined) throw new Error('missing');
      return sql;
    },
    query,
  };
}

describe('API startup migration authority', () => {
  it('validates exact canonical SHA-256 evidence with one read-only query', async () => {
    const runtime = exactRuntime();

    await expect(runStartupMigrations(log, runtime)).resolves.toBeUndefined();

    expect(runtime.query).toHaveBeenCalledOnce();
    const [sql, values] = runtime.query.mock.calls[0] as [string, unknown[]];
    expect(sql.trimStart()).toMatch(/^SELECT\b/u);
    expect(sql).toContain('name, sha256');
    expect(values).toEqual([['one', 'two']]);
  });

  it.each([
    ['missing', [{ name: 'one', sha256: sha256('SELECT 1;') }], 'EVIDENCE_MISSING'],
    [
      'invalid digest',
      [
        { name: 'one', sha256: sha256('SELECT 1;') },
        { name: 'two', sha256: 'not-a-digest' },
      ],
      'INVALID_SHA256',
    ],
    [
      'digest drift',
      [
        { name: 'one', sha256: sha256('SELECT 1;') },
        { name: 'two', sha256: sha256('changed SQL') },
      ],
      'CHECKSUM_DRIFT',
    ],
  ])('fails closed for %s migration evidence', async (_label, rows, code) => {
    const runtime = exactRuntime();
    runtime.query.mockResolvedValueOnce({ rows });

    await expect(runStartupMigrations(log, runtime)).rejects.toThrow(code);
  });

  it('fails before querying the database when canonical SQL is unavailable', async () => {
    const runtime = exactRuntime();
    runtime.readText = async () => {
      throw new Error('missing');
    };

    await expect(runStartupMigrations(log, runtime)).rejects.toThrow(
      'STARTUP_MIGRATION_FILE_UNAVAILABLE',
    );
    expect(runtime.query).not.toHaveBeenCalled();
  });

  it('derives its production registry only from REQUIRED_MIGRATION_FILES', () => {
    const runtime = productionStartupMigrationRuntime();
    expect(runtime.migrationSpecs.map(({ name }) => name)).toEqual(
      REQUIRED_MIGRATION_FILES.map(({ name }) => name),
    );
  });

  it('contains no schema or migration write statement on the API startup path', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'backend/src/serverStartupMigrations.ts'),
      'utf8',
    );
    expect(source).not.toMatch(
      /\.query\(\s*[`'"]\s*(?:CREATE|ALTER|INSERT|UPDATE|DELETE|DROP|TRUNCATE)\b/iu,
    );
    expect(source).not.toContain('getPool()');
    expect(source).not.toContain('.connect()');
  });
});
