import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import pg from 'pg';

import type { QueryFn } from '../database-contracts.js';
import {
  createWorkOrderCommandAuthorityTransaction,
  verifyWorkOrderCommandAuthority,
} from './work-order-command-role-authority.js';

/** Read-only live privilege certification for one exact connected database. */
export async function runWorkOrderCommandRoleAuthorityReadback(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('WORK_ORDER_COMMAND_AUTHORITY_DATABASE_URL_REQUIRED');
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    min: 0,
    idleTimeoutMillis: 1_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30_000,
    application_name: 'hustlexp-work-order-authority-readback',
  });
  try {
    const transaction = createWorkOrderCommandAuthorityTransaction(async () => {
      const client = await pool.connect();
      const query: QueryFn = async <Row = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      };
      return { query, release: (destroy?: boolean) => client.release(destroy) };
    });
    const report = await verifyWorkOrderCommandAuthority(transaction, process.env);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'READY') process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runWorkOrderCommandRoleAuthorityReadback().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
