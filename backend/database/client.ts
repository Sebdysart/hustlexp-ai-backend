import { Pool } from '@neondatabase/serverless';
import { config } from '../config';

interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

const isStubMode = !config.database.url || config.app.isDevelopment;

let pool: Pool | null = null;

if (!isStubMode) {
  pool = new Pool({ connectionString: config.database.url });
  console.log('✅ Neon database pool initialized');
} else {
  console.log('⚠️  Database running in STUB mode (no DATABASE_URL configured)');
}

export const db = {
  query: async <T = Record<string, unknown>>(
    sqlQuery: string,
    params?: unknown[]
  ): Promise<QueryResult<T>> => {
    if (isStubMode || !pool) {
      console.log('[DB Stub] Query:', sqlQuery, params);
      return { rows: [] as T[], rowCount: 0 };
    }

    try {
      const result = await pool.query(sqlQuery, params);
      return {
        rows: result.rows as T[],
        rowCount: result.rowCount ?? 0,
      };
    } catch (error) {
      console.error('[DB Error]', error);
      throw error;
    }
  },
};
