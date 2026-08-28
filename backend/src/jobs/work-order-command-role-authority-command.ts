import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { db } from '../db.js';
import { verifyWorkOrderCommandAuthority } from './work-order-command-role-authority.js';

/** Read-only live privilege certification for one exact connected database. */
export async function runWorkOrderCommandRoleAuthorityReadback(): Promise<void> {
  try {
    const report = await verifyWorkOrderCommandAuthority(db.query, process.env);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'READY') process.exitCode = 1;
  } finally {
    await db.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runWorkOrderCommandRoleAuthorityReadback().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
