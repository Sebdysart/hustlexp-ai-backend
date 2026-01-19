/**
 * Test Database Connection for System Integrity Tests
 * 
 * Uses local Postgres (not Neon serverless) to avoid driver-level query plan caching
 * that interferes with schema-mutation tests.
 * 
 * This is the correct architecture: integrity tests require deterministic query planning,
 * which serverless drivers cannot guarantee.
 */

import { Pool } from 'pg';

// Use local Postgres for integrity tests
// REQUIRED: Set LOCAL_TEST_DB_URL to a local Postgres instance (not Neon serverless)
// Example: postgresql://postgres:postgres@localhost:5432/hustlexp_test
const TEST_DB_URL = process.env.LOCAL_TEST_DB_URL;

if (!TEST_DB_URL) {
  throw new Error(
    'LOCAL_TEST_DB_URL environment variable is required for system integrity tests.\n' +
    'These tests require local Postgres (not Neon serverless) to avoid driver-level query plan caching.\n' +
    'Set LOCAL_TEST_DB_URL to a local Postgres connection string, e.g.:\n' +
    '  postgresql://postgres:postgres@localhost:5432/hustlexp_test\n' +
    'See backend/tests/system/README.md for setup instructions.'
  );
}

let testPool: Pool | null = null;

export function getTestPool(): Pool {
  if (!testPool) {
    // Parse connection string or use explicit connection params
    const url = new URL(TEST_DB_URL.replace(/^postgresql:\/\//, 'http://'));
    testPool = new Pool({
      host: url.hostname,
      port: parseInt(url.port || '5432', 10),
      database: url.pathname.slice(1) || 'hustlexp_test',
      user: url.username || 'postgres',
      password: url.password || 'postgres',
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      // CRITICAL: Disable prepared statements for schema-mutation tests
      // This ensures fresh query planning when schema changes during test execution
      prepareThreshold: 0,
    });
    
    // Force explicit search path to prevent future regressions
    testPool.on('connect', async (client) => {
      await client.query('SET search_path TO public');
    });
    
    console.log('✅ Test database pool initialized (local Postgres, no prepared statements)');
  }
  return testPool;
}

export async function closeTestPool(): Promise<void> {
  if (testPool) {
    await testPool.end();
    testPool = null;
    console.log('✅ Test database pool closed');
  }
}

// Export a db-like interface for compatibility
export const testDb = {
  query: async <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> => {
    const pool = getTestPool();
    const result = await pool.query(sql, params);
    return {
      rows: result.rows as T[],
      rowCount: result.rowCount ?? 0,
    };
  },
};
