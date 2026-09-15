import type { PoolClient, QueryConfig } from 'pg';
import { db, type QueryFn } from '../../db.js';

// One process-wide admission budget for ALL product-analytics SQL. No waiting
// queue: contention drops telemetry / returns an unavailable dashboard section.
export const ANALYTICS_DB_LIMIT = 3;
export const ANALYTICS_ACQUIRE_MS = 100;
export const ANALYTICS_STATEMENT_MS = 1000;
export const ANALYTICS_LOCK_MS = 100;
export const ANALYTICS_CLIENT_MS = 1500;
let active = 0;

export class AnalyticsCapacityError extends Error {
  constructor() { super('Analytics database capacity unavailable'); }
}

export const analyticsQuery: QueryFn = async <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
  const pool = db.getPool();
  const max = pool.options.max ?? 20;
  const limit = Math.min(ANALYTICS_DB_LIMIT, Math.floor(max / 4));
  const available = max - (pool.totalCount - pool.idleCount);
  // Analytics owns at most 25% of pool capacity (and at most three slots).
  // Leave two additional free slots at admission and never join an existing
  // wait queue. Tiny pools (<4) disable analytics entirely.
  if (active >= limit || pool.waitingCount > 0 || available <= 2) throw new AnalyticsCapacityError();
  active++;
  let client: PoolClient | undefined;
  let destroy = false;
  let expired = false;
  let handedOff = false;
  let acquisitionTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const connection = pool.connect().then((connected) => {
      if (expired) { connected.release(); active--; return undefined; }
      return connected;
    }, (error: unknown) => {
      if (expired) { active--; return undefined; }
      throw error;
    });
    client = await Promise.race([
      connection,
      new Promise<never>((_, reject) => { acquisitionTimer = setTimeout(() => {
        expired = true;
        handedOff = true; // Keep the slot until the late connection is released.
        reject(new AnalyticsCapacityError());
      }, ANALYTICS_ACQUIRE_MS); }),
    ]);
    if (!client) throw new AnalyticsCapacityError();
    clearTimeout(acquisitionTimer);
    const acquired = client;
    const query = (text: string, values?: unknown[]) => {
      // The installed pg runtime supports per-query query_timeout, while its
      // QueryConfig typings expose that option only on ClientConfig.
      const config: QueryConfig & { query_timeout: number } = {
        text, values, query_timeout: ANALYTICS_CLIENT_MS,
      };
      return acquired.query(config);
    };
    // SET LOCAL cannot leak timeout settings back into the business pool.
    // Destroy on any failure (including client timeout) rather than release a
    // connection with a running query or an open/aborted transaction.
    await query('BEGIN');
    await query("SELECT set_config('statement_timeout',$1,true), set_config('lock_timeout',$2,true)",
      [String(ANALYTICS_STATEMENT_MS), String(ANALYTICS_LOCK_MS)]);
    const result = await query(sql, params);
    await query('COMMIT');
    return { rows: result.rows as T[], rowCount: result.rowCount ?? 0 };
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    clearTimeout(acquisitionTimer);
    client?.release(destroy);
    if (!handedOff) active--;
  }
};
