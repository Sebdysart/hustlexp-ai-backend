import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import {
  runLegacyMigrationChecksumReconciliation,
  type ReconciliationClient,
  type ReconciliationMode,
} from '../backend/src/jobs/legacy-migration-checksum-reconciliation.js';

const DEFAULT_MANIFEST = 'backend/database/legacy-migration-checksum-reconciliation.HOLD.json';
const MANIFEST_DIRECTORY = 'backend/database/migration-checksum-manifests/';

function usage(): never {
  throw new Error(
    'USAGE: tsx scripts/reconcile-legacy-migration-checksums.ts (--plan|--apply) [--manifest <repository-relative-json>]'
  );
}

function parseArguments(argv: readonly string[]): {
  mode: ReconciliationMode;
  manifestPath: string;
} {
  let mode: ReconciliationMode | undefined;
  let manifest = DEFAULT_MANIFEST;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan' || argument === '--apply') {
      if (mode) usage();
      mode = argument === '--plan' ? 'plan' : 'apply';
      continue;
    }
    if (argument === '--manifest') {
      const value = argv[index + 1];
      if (!value) usage();
      manifest = value;
      index += 1;
      continue;
    }
    usage();
  }
  if (!mode) usage();
  if (
    path.isAbsolute(manifest) ||
    manifest.includes('\\') ||
    path.posix.normalize(manifest) !== manifest ||
    (!manifest.startsWith(MANIFEST_DIRECTORY) && manifest !== DEFAULT_MANIFEST) ||
    !manifest.endsWith('.json')
  ) {
    throw new Error(
      `MANIFEST_PATH_DENIED: use ${DEFAULT_MANIFEST} or a reviewed JSON file under ${MANIFEST_DIRECTORY}`
    );
  }
  return { mode, manifestPath: manifest };
}

function createClient(databaseUrl: string): ReconciliationClient {
  const client = new Client({ connectionString: databaseUrl });
  return {
    connect: () => client.connect(),
    end: () => client.end(),
    query: async (sql, values) => {
      const result = await client.query(sql, values);
      return { rows: result.rows };
    },
  };
}

async function main(): Promise<void> {
  const { mode, manifestPath } = parseArguments(process.argv.slice(2));
  const repositoryRoot = process.cwd();
  const result = await runLegacyMigrationChecksumReconciliation(mode, {
    repositoryRoot,
    databaseUrl: process.env.DATABASE_URL?.trim() ?? '',
    manifestPath: path.resolve(repositoryRoot, manifestPath.split('/').join(path.sep)),
    environment: process.env,
    readText: (filePath) => readFile(filePath, 'utf8'),
    createClient,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown reconciliation failure';
  console.error(message);
  process.exitCode = 1;
});
