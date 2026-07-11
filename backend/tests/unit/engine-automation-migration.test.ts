import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import {
  ENGINE_AUTOMATION_MIGRATION,
  applyEngineAutomationMigration,
  loadMigrationSql,
  productionMigrationRuntime,
  runEngineAutomationMigration,
  type MigrationClient,
  type MigrationRuntime,
} from '../../src/jobs/engine-automation-migration.js';

function clientWithQueries(existing = false): MigrationClient & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    connect: vi.fn(async () => undefined),
    end: vi.fn(async () => undefined),
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      return { rows: sql.startsWith('SELECT name') && existing ? [{ name: ENGINE_AUTOMATION_MIGRATION }] : [] };
    }) as MigrationClient['query'],
  };
}

function runtime(overrides: Partial<MigrationRuntime> = {}): MigrationRuntime {
  return {
    databaseUrl: 'postgres://automation-test',
    candidatePaths: ['/missing.sql', '/migration.sql'],
    readText: vi.fn(async (filePath: string) => {
      if (filePath === '/migration.sql') return 'SELECT 1;';
      throw new Error('not found');
    }),
    createClient: vi.fn(() => clientWithQueries()),
    ...overrides,
  };
}

describe('required engine automation migration', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('builds production filesystem and PostgreSQL adapters without opening a connection', async () => {
    process.env.DATABASE_URL = 'postgres://runtime';
    const actual = productionMigrationRuntime();
    expect(actual.databaseUrl).toBe('postgres://runtime');
    expect(actual.candidatePaths).toContain('/app/backend/database/migrations/20260710_engine_automation_contracts.sql');
    await expect(actual.readText(actual.candidatePaths[0]!)).resolves.toContain('CREATE TABLE IF NOT EXISTS task_reservations');
    expect(actual.createClient('postgres://runtime')).toBeInstanceOf(Client);
  });

  it('loads the first non-empty migration and records failed candidates', async () => {
    const readText = vi.fn(async (filePath: string) => {
      if (filePath === '/empty.sql') return '  ';
      if (filePath === '/good.sql') return 'SELECT 1;';
      throw new Error('missing');
    });
    await expect(loadMigrationSql(runtime({
      candidatePaths: ['/missing.sql', '/empty.sql', '/good.sql'],
      readText,
    }))).resolves.toEqual({ sql: 'SELECT 1;', sourcePath: '/good.sql' });
    expect(readText).toHaveBeenCalledTimes(3);
  });

  it('fails closed when every migration candidate is unusable', async () => {
    await expect(loadMigrationSql(runtime({
      candidatePaths: ['/missing.sql', '/empty.sql'],
      readText: vi.fn(async (filePath: string) => filePath === '/empty.sql' ? '' : Promise.reject('missing')),
    }))).rejects.toThrow('Required engine automation migration is unavailable');
  });

  it('applies and records the migration atomically', async () => {
    const client = clientWithQueries();
    const outcome = await applyEngineAutomationMigration(client, 'ALTER TABLE tasks ADD COLUMN demo TEXT;', '/migration.sql');
    expect(outcome.status).toBe('applied');
    expect(client.queries).toContain('ALTER TABLE tasks ADD COLUMN demo TEXT;');
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('replays without executing the migration SQL', async () => {
    const client = clientWithQueries(true);
    const outcome = await applyEngineAutomationMigration(client, 'SHOULD NOT RUN', '/migration.sql');
    expect(outcome.status).toBe('already_applied');
    expect(client.queries).not.toContain('SHOULD NOT RUN');
    expect(client.queries.at(-1)).toBe('COMMIT');
  });

  it('rolls back and preserves the original migration failure', async () => {
    const client = clientWithQueries();
    const query = client.query as ReturnType<typeof vi.fn>;
    query.mockImplementation(async (sql: string) => {
      client.queries.push(sql);
      if (sql === 'BROKEN SQL') throw new Error('migration exploded');
      return { rows: [] };
    });
    await expect(applyEngineAutomationMigration(client, 'BROKEN SQL', '/migration.sql'))
      .rejects.toThrow('migration exploded');
    expect(client.queries.at(-1)).toBe('ROLLBACK');
  });

  it('connects, applies, logs, and always closes the runtime client', async () => {
    const client = clientWithQueries();
    await expect(runEngineAutomationMigration(runtime({ createClient: () => client })))
      .resolves.toMatchObject({ status: 'applied' });
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('closes the client after an application failure', async () => {
    const client = clientWithQueries();
    const query = client.query as ReturnType<typeof vi.fn>;
    query.mockRejectedValueOnce(new Error('begin failed'));
    await expect(runEngineAutomationMigration(runtime({ createClient: () => client })))
      .rejects.toThrow('begin failed');
    expect(client.end).toHaveBeenCalledOnce();
  });

  it('refuses to create a client without DATABASE_URL', async () => {
    const createClient = vi.fn(() => clientWithQueries());
    await expect(runEngineAutomationMigration(runtime({ databaseUrl: '', createClient })))
      .rejects.toThrow('DATABASE_URL is required');
    expect(createClient).not.toHaveBeenCalled();
  });
});
