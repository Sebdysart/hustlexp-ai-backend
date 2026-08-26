import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONSTITUTIONAL_BOOTSTRAP_FILE,
  REQUIRED_MIGRATION_FILES,
} from './engine-automation-migration-files.js';

export interface EngineMigrationManifestEntry {
  name: string;
  fileName: string;
  ordinal: number;
  sha256: string;
}

export function engineMigrationRegisteredDigest(
  entries: readonly EngineMigrationManifestEntry[],
): string {
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

export async function engineMigrationManifest(
  root = process.cwd(),
): Promise<EngineMigrationManifestEntry[]> {
  const declared = [
    {
      ...CONSTITUTIONAL_BOOTSTRAP_FILE,
      sourcePath: path.join(root, 'backend/database', CONSTITUTIONAL_BOOTSTRAP_FILE.fileName),
    },
    ...REQUIRED_MIGRATION_FILES.map((entry) => ({
      ...entry,
      sourcePath: path.join(root, 'backend/database/migrations', entry.fileName),
    })),
  ];
  return Promise.all(declared.map(async ({ name, fileName, sourcePath }, ordinal) => {
    const sql = await readFile(sourcePath);
    return {
      name,
      fileName,
      ordinal,
      sha256: createHash('sha256').update(sql).digest('hex'),
    };
  }));
}

export async function engineMigrationArtifactDigest(
  root = process.cwd(),
): Promise<string> {
  const migrationDirectory = path.join(root, 'backend/database/migrations');
  const registered = await engineMigrationManifest(root);
  const constitutionalBootstrap = {
    fileName: CONSTITUTIONAL_BOOTSTRAP_FILE.fileName,
    sha256: createHash('sha256')
      .update(await readFile(path.join(root, 'backend/database', CONSTITUTIONAL_BOOTSTRAP_FILE.fileName)))
      .digest('hex'),
  };
  const directory = await Promise.all(
    (await readdir(migrationDirectory))
      .filter((fileName) => fileName.endsWith('.sql'))
      .sort()
      .map(async (fileName) => ({
        fileName,
        sha256: createHash('sha256')
          .update(await readFile(path.join(migrationDirectory, fileName)))
          .digest('hex'),
      })),
  );
  return createHash('sha256')
    .update(JSON.stringify({ constitutionalBootstrap, registered, directory }))
    .digest('hex');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await engineMigrationArtifactDigest()}\n`);
}
