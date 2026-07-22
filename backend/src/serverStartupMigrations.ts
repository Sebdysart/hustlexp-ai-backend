import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.js';
import { logger } from './logger.js';

type StartupLogger = {
  debug: typeof logger.debug;
  error: typeof logger.error;
  info: typeof logger.info;
  warn: typeof logger.warn;
};

function candidatePaths(relativePath: string): string[] {
  const current = process.cwd();
  return [
    join(current, relativePath),
    join(current, 'backend', relativePath.replace(/^backend\//, '')),
    join('/app', relativePath),
    join(current, '..', relativePath),
  ];
}

function readFirstFile(paths: string[], startLog: StartupLogger): string | null {
  for (const path of paths) {
    try {
      const contents = readFileSync(path, 'utf-8');
      startLog.info({ path, chars: contents.length }, 'Found migration file');
      return contents;
    } catch (error) {
      startLog.debug({
        path,
        code: (error as Record<string, unknown>)?.code,
      }, 'Migration not at path');
    }
  }
  return null;
}

async function executeSql(sql: string): Promise<void> {
  const client = await db.getPool().connect();
  try {
    await client.query(sql);
  } finally {
    client.release();
  }
}

async function applyConstitutionalSchema(startLog: StartupLogger): Promise<void> {
  const cwd = process.cwd();
  startLog.info({ cwd }, 'Searching for schema file');
  const sql = readFirstFile(
    candidatePaths('backend/database/constitutional-schema.sql'),
    startLog,
  );
  if (!sql) {
    startLog.error('Could not find constitutional-schema.sql in any candidate path');
    try {
      startLog.debug({ contents: readdirSync(cwd).slice(0, 20) }, 'CWD directory listing');
    } catch {
      // Directory listing is diagnostic only.
    }
    return;
  }
  await executeSql(sql);
  startLog.info('Auto-migration complete');
}

function missingSchema(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  const code = (error as Record<string, unknown>)?.code;
  return message.includes('schema_versions') || message.includes('does not exist') || code === '42P01';
}

async function ensureConstitutionalSchema(startLog: StartupLogger): Promise<void> {
  try {
    await db.query('SELECT 1 FROM schema_versions LIMIT 1');
    startLog.info('Schema tables exist');
  } catch (error) {
    startLog.warn({
      code: (error as Record<string, unknown>)?.code,
      message: error instanceof Error ? error.message.substring(0, 120) : undefined,
    }, 'Schema check failed');
    if (!missingSchema(error)) {
      startLog.error({ err: error }, 'Unexpected schema error');
      return;
    }
    startLog.warn('Tables missing — running auto-migration');
    try {
      await applyConstitutionalSchema(startLog);
    } catch (migrationError) {
      const details = migrationError as Record<string, unknown>;
      startLog.error({
        err: migrationError,
        position: details?.position,
        detail: details?.detail,
      }, 'Auto-migration failed');
    }
  }
}

async function ensureUserColumns(startLog: StartupLogger): Promise<void> {
  try {
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS firebase_uid TEXT UNIQUE');
    await db.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT');
    await db.query('CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid)');
    startLog.info('firebase_uid + bio columns ensured');
  } catch (error) {
    const message = error instanceof Error ? error.message.substring(0, 120) : String(error);
    startLog.warn({ message }, 'Column migration note');
  }
}

async function migrationAlreadyApplied(name: string): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM applied_migrations WHERE name = $1', [name]);
  return result.rows.length > 0;
}

async function ensureMigrationLedger(): Promise<void> {
  await db.query(`CREATE TABLE IF NOT EXISTS applied_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

async function applyMissingTables(startLog: StartupLogger): Promise<void> {
  const name = 'add_missing_tables_v2';
  if (await migrationAlreadyApplied(name)) {
    startLog.debug({ migration: name }, 'Migration already applied');
    return;
  }
  startLog.info({ migration: name }, 'Running table creation migration');
  const sql = readFirstFile(
    candidatePaths('backend/database/startup/add_missing_tables_v2.sql'),
    startLog,
  );
  if (!sql) throw new Error('Could not find add_missing_tables_v2.sql');
  const client = await db.getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query('INSERT INTO applied_migrations (name) VALUES ($1)', [name]);
    await client.query('COMMIT');
    startLog.info({ migration: name, tables: 16 }, 'Migration complete — 16 tables created');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const PERFORMANCE_INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_matching_scores_hustler_feed
    ON task_matching_scores(hustler_id, expires_at DESC, relevance_score DESC);
  CREATE INDEX IF NOT EXISTS idx_matching_scores_hustler_distance
    ON task_matching_scores(hustler_id, expires_at DESC, distance_miles ASC);
  CREATE INDEX IF NOT EXISTS idx_tasks_state_category
    ON tasks(state, category, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tasks_state_price
    ON tasks(state, price DESC, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_escrows_task_state ON escrows(task_id, state);
  CREATE INDEX IF NOT EXISTS idx_task_messages_task_created
    ON task_messages(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_xp_ledger_user_created
    ON xp_ledger(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_task_ratings_ratee ON task_ratings(ratee_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_created
    ON notifications(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
    ON notifications(user_id, is_read) WHERE is_read = false;
  CREATE INDEX IF NOT EXISTS idx_outbox_events_unprocessed
    ON outbox_events(processed_at, created_at ASC) WHERE processed_at IS NULL;
  CREATE INDEX IF NOT EXISTS idx_proofs_task_state ON proofs(task_id, state);
`;

async function applyPerformanceIndexes(startLog: StartupLogger): Promise<void> {
  const name = 'performance_indexes_v1';
  if (await migrationAlreadyApplied(name)) {
    startLog.debug({ migration: name }, 'Migration already applied');
    return;
  }
  startLog.info({ migration: name }, 'Running performance indexes migration');
  await db.query(PERFORMANCE_INDEX_SQL);
  await db.query('INSERT INTO applied_migrations (name) VALUES ($1)', [name]);
  startLog.info({ migration: name, indexes: 12 }, 'Performance indexes created');
}

async function reportSchemaState(startLog: StartupLogger): Promise<void> {
  try {
    const version = await db.query<{ version: string; applied_at: string }>(
      'SELECT version, applied_at FROM schema_versions ORDER BY applied_at DESC LIMIT 1',
    );
    if (version.rows.length > 0) {
      startLog.info({
        schemaVersion: version.rows[0].version,
        appliedAt: version.rows[0].applied_at,
      }, 'Schema version loaded');
    } else {
      startLog.warn('No schema version found');
    }
    const triggers = await db.query(`
      SELECT trigger_name FROM information_schema.triggers
      WHERE trigger_schema = 'public'
      AND trigger_name IN (
        'xp_requires_released_escrow',
        'escrow_released_requires_completed_task',
        'task_completed_requires_accepted_proof',
        'task_terminal_guard',
        'escrow_terminal_guard'
      )
    `);
    startLog.info({ triggersActive: triggers.rows.length, expected: 5 }, 'Invariant triggers check');
  } catch (error) {
    startLog.error({ err: error }, 'Schema version check failed');
  }
}

export async function runStartupMigrations(startLog: StartupLogger): Promise<void> {
  await ensureConstitutionalSchema(startLog);
  await ensureUserColumns(startLog);
  try {
    await ensureMigrationLedger();
    await applyMissingTables(startLog);
  } catch (error) {
    startLog.error({
      err: error,
      position: (error as Record<string, unknown>)?.position,
    }, 'Migration error');
  }
  try {
    await applyPerformanceIndexes(startLog);
  } catch (error) {
    startLog.warn({ err: error }, 'Performance indexes migration warning');
  }
  await reportSchemaState(startLog);
}
