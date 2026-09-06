import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { runEngineAutomationMigrationWithReceipt } from './engine-automation-migration.js';

/** Explicit one-shot schema writer. API and worker processes never call this. */
export async function runAuthorizedMigrationCommand(): Promise<void> {
  const { outcomes, receipt } = await runEngineAutomationMigrationWithReceipt();
  process.stdout.write(
    `${JSON.stringify({
      status: 'complete',
      receiptType: 'migration-execution-diagnostic-v1',
      acceptanceEligible: false,
      receipt,
      migrationCount: outcomes.length,
    })}\n`
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runAuthorizedMigrationCommand().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
