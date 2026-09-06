import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  engineMigrationArtifactDigest,
  engineMigrationArtifactDigestFromPayload,
  engineMigrationManifest,
} from '../../src/jobs/engine-migration-manifest.js';

describe('engine migration manifest', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function copyArtifactRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'hustlexp-migration-manifest-'));
    temporaryRoots.push(root);
    const targetDatabase = join(root, 'backend/database');
    await mkdir(targetDatabase, { recursive: true });
    await Promise.all([
      cp(join(process.cwd(), 'backend/database/migrations'), join(targetDatabase, 'migrations'), {
        recursive: true,
      }),
      cp(
        join(process.cwd(), 'backend/database/constitutional-schema.sql'),
        join(targetDatabase, 'constitutional-schema.sql')
      ),
    ]);
    return root;
  }

  it('binds every registered runtime migration to its exact file hash', async () => {
    const manifest = await engineMigrationManifest();
    expect(manifest).toHaveLength(REQUIRED_MIGRATION_FILES.length);
    expect(manifest.map((entry) => entry.name)).toEqual(
      REQUIRED_MIGRATION_FILES.map((entry) => entry.name)
    );
    expect(new Set(manifest.map((entry) => entry.name)).size).toBe(manifest.length);
    expect(new Set(manifest.map((entry) => entry.fileName)).size).toBe(manifest.length);
    for (const entry of manifest) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('binds the registered execution order into the artifact digest', () => {
    const payload = {
      constitutionalBaseline: { fileName: 'constitutional-schema.sql', sha256: '1'.repeat(64) },
      registered: [
        { name: 'first', fileName: 'first.sql', sha256: '2'.repeat(64) },
        { name: 'second', fileName: 'second.sql', sha256: '3'.repeat(64) },
      ],
      directory: [
        { fileName: 'first.sql', sha256: '2'.repeat(64) },
        { fileName: 'second.sql', sha256: '3'.repeat(64) },
      ],
    };

    expect(engineMigrationArtifactDigestFromPayload(payload)).not.toBe(
      engineMigrationArtifactDigestFromPayload({
        ...payload,
        registered: [...payload.registered].reverse(),
      })
    );
  });

  it('matches the reviewed artifact digest used by Build Validation', async () => {
    const [actual, expected] = await Promise.all([
      engineMigrationArtifactDigest(),
      readFile('backend/database/engine-migration-artifact.sha256', 'utf8').then((value) =>
        value.trim()
      ),
    ]);
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    expect(actual).toBe(expected);
  });

  it('binds the exact constitutional baseline bytes into the artifact digest', async () => {
    const root = await copyArtifactRoot();
    const baselinePath = join(root, 'backend/database/constitutional-schema.sql');
    const before = await engineMigrationArtifactDigest(root);
    const baseline = await readFile(baselinePath);

    await writeFile(
      baselinePath,
      Buffer.concat([baseline, Buffer.from('\n-- synthetic baseline drift\n', 'utf8')])
    );

    await expect(engineMigrationArtifactDigest(root)).resolves.not.toBe(before);
  });

  it('fails closed when the constitutional baseline is absent', async () => {
    const root = await copyArtifactRoot();
    const baselinePath = join(root, 'backend/database/constitutional-schema.sql');
    await rm(baselinePath);

    await expect(engineMigrationArtifactDigest(root)).rejects.toMatchObject({
      code: 'ENOENT',
      path: baselinePath,
    });
  });
});
