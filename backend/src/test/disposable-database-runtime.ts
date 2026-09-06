import pg from 'pg';

import type { QueryFn, QueryResult } from '../database-contracts.js';
import { installDisposableTestDatabaseRuntime, type DatabaseRuntime } from '../db.js';
import { runTransactionOnClient } from '../db-transaction-runner.js';

const { Pool } = pg;

const DISPOSABLE_DATABASES = new Set([
  'hx_ci_invariant_test',
  'hx_ci_system_test',
  'hx_ci_fresh_test',
  'hx_ci_upgrade_test',
]);

function refuse(reason: string): never {
  throw new Error(`DISPOSABLE_TEST_DATABASE_RUNTIME_REFUSED:${reason}`);
}

function exactPositiveInteger(value: string | undefined, fallback: number): number {
  const candidate = value?.trim() || String(fallback);
  if (!/^\d+$/u.test(candidate)) return refuse('POOL_CONFIG_INVALID');
  const parsed = Number(candidate);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 120_000) {
    return refuse('POOL_CONFIG_INVALID');
  }
  return parsed;
}

function disposableUrl(): string {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.VITEST !== 'true' ||
    process.env.HX_ALLOW_CI_DB_RECREATE !== 'true'
  ) {
    return refuse('TEST_GUARDS_REQUIRED');
  }
  if (process.env.DATABASE_REPLICA_URL?.trim()) return refuse('REPLICA_FORBIDDEN');
  const raw = process.env.DATABASE_URL?.trim() ?? '';
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refuse('DATABASE_URL_INVALID');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//u, ''));
  const role = decodeURIComponent(parsed.username);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    (parsed.port || '5432') !== '5432' ||
    role !== 'hx_ci_runner' ||
    !DISPOSABLE_DATABASES.has(databaseName) ||
    parsed.hash ||
    [...parsed.searchParams.keys()].some((key) => key !== 'sslmode') ||
    (parsed.searchParams.has('sslmode') && parsed.searchParams.get('sslmode') !== 'disable')
  ) {
    return refuse('DATABASE_TARGET_NOT_DISPOSABLE');
  }
  return raw;
}

function result<Row>(value: pg.QueryResult): QueryResult<Row> {
  return {
    rows: value.rows as Row[],
    rowCount: value.rowCount ?? 0,
  };
}

/**
 * Install legacy-suite compatibility only for the four disposable CI
 * databases. This module is imported exclusively by Vitest setup and is never
 * reachable from an API, worker, attester, migration, or package start entry.
 */
export function installDisposableVitestDatabaseRuntime(): void {
  const connectionString = disposableUrl();
  const maxConnections = exactPositiveInteger(process.env.DB_POOL_MAX, 20);
  const pool = new Pool({
    connectionString,
    max: maxConnections,
    idleTimeoutMillis: exactPositiveInteger(process.env.DB_IDLE_TIMEOUT_MS, 30_000),
    connectionTimeoutMillis: exactPositiveInteger(process.env.DB_CONNECT_TIMEOUT_MS, 10_000),
    statement_timeout: exactPositiveInteger(process.env.DB_STATEMENT_TIMEOUT_MS, 30_000),
    application_name: 'hustlexp-disposable-vitest-runtime',
  });

  const query: QueryFn = async <Row = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<QueryResult<Row>> => result<Row>(await pool.query(sql, params));

  const transaction = <T>(
    beginStatement: 'BEGIN' | 'BEGIN ISOLATION LEVEL SERIALIZABLE',
    callback: (bound: QueryFn) => Promise<T>
  ): Promise<T> =>
    pool.connect().then((client) =>
      runTransactionOnClient({
        client,
        beginStatement,
        execute: callback,
      })
    );

  const runtime: DatabaseRuntime = Object.freeze({
    query,
    readQuery: query,
    transaction: <T>(callback: (bound: QueryFn) => Promise<T>) => transaction('BEGIN', callback),
    serializableTransaction: <T>(callback: (bound: QueryFn) => Promise<T>) =>
      transaction('BEGIN ISOLATION LEVEL SERIALIZABLE', callback),
    readOnlyAttestationTransaction: <T>(callback: (bound: QueryFn) => Promise<T>) =>
      transaction('BEGIN', async (bound) => {
        await bound('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
        await bound('SET LOCAL search_path=pg_catalog');
        await bound("SET LOCAL statement_timeout='1000ms'");
        await bound("SET LOCAL lock_timeout='250ms'");
        return callback(bound);
      }),
    stats: () => {
      const totalConnections = pool.totalCount;
      return {
        totalConnections,
        idleConnections: pool.idleCount,
        waitingRequests: pool.waitingCount,
        maxConnections,
        utilizationPercent: Math.round((totalConnections / maxConnections) * 100),
        replicaConnections: null,
        replicaIdle: null,
        replicaConfigured: false as const,
      };
    },
    close: () => pool.end(),
  });
  installDisposableTestDatabaseRuntime(runtime);
}
