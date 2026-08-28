import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  engineMigrationArtifactDigest,
  engineMigrationManifest,
} from '../../src/jobs/engine-migration-manifest.js';

describe('engine migration manifest', () => {
  it('binds every registered runtime migration to its exact file hash', async () => {
    const manifest = await engineMigrationManifest();
    expect(manifest).toHaveLength(REQUIRED_MIGRATION_FILES.length);
    expect(new Set(manifest.map((entry) => entry.name)).size).toBe(manifest.length);
    expect(new Set(manifest.map((entry) => entry.fileName)).size).toBe(manifest.length);
    for (const entry of manifest) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('matches the reviewed artifact digest used by Build Validation', async () => {
    const [actual, expected] = await Promise.all([
      engineMigrationArtifactDigest(),
      readFile('backend/database/engine-migration-artifact.sha256', 'utf8')
        .then((value) => value.trim()),
    ]);
    expect(expected).toMatch(/^[a-f0-9]{64}$/);
    expect(actual).toBe(expected);
  });
});
