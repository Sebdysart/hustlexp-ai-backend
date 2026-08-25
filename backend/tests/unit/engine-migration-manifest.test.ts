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

  it('binds the complete packaged SQL directory as well as the runtime registry', async () => {
    await expect(engineMigrationArtifactDigest()).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
});
