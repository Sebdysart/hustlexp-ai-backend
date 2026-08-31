import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_MIGRATION_FILES } from './engine-automation-migration-files.js';

export interface EngineMigrationManifestEntry {
  name: string;
  fileName: string;
  sha256: string;
}

export async function engineMigrationManifest(
  root = process.cwd(),
): Promise<EngineMigrationManifestEntry[]> {
  const entries = await Promise.all(REQUIRED_MIGRATION_FILES.map(async ({ name, fileName }) => {
    const sql = await readFile(path.join(root, 'backend/database/migrations', fileName));
    return {
      name,
      fileName,
      sha256: createHash('sha256').update(sql).digest('hex'),
    };
  }));
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

export async function engineMigrationArtifactDigest(
  root = process.cwd(),
): Promise<string> {
  const migrationDirectory = path.join(root, 'backend/database/migrations');
  const registered = await engineMigrationManifest(root);
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
    .update(JSON.stringify({ registered, directory }))
    .digest('hex');
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.stdout.write(`${await engineMigrationArtifactDigest()}\n`);
}
