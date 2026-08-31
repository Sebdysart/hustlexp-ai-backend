import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { engineMigrationArtifactDigest } from './engine-migration-manifest.js';
import { runEngineAutomationMigration } from './engine-automation-migration.js';
import { assertMigrationExecutionAuthorized } from './migration-execution-authority.js';

/** Explicit one-shot schema writer. API and worker processes never call this. */
export async function runAuthorizedMigrationCommand(): Promise<void> {
  const migrationArtifactDigest = await engineMigrationArtifactDigest();
  const authority = assertMigrationExecutionAuthorized({ migrationArtifactDigest });
  const outcomes = await runEngineAutomationMigration();
  process.stdout.write(`${JSON.stringify({
    status: 'complete',
    authority,
    migrationCount: outcomes.length,
  })}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  runAuthorizedMigrationCommand().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
