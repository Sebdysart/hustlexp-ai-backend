import { describe, expect, it } from 'vitest';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import {
  engineMigrationArtifactDigest,
  engineMigrationManifest,
  engineMigrationRegisteredDigest,
} from '../../src/jobs/engine-migration-manifest.js';

describe('engine migration manifest', () => {
  it('binds every registered runtime migration to its exact file hash', async () => {
    const manifest = await engineMigrationManifest();
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(115);
    expect(manifest).toHaveLength(REQUIRED_MIGRATION_FILES.length + 1);
    expect(manifest[0]).toEqual(expect.objectContaining({
      name: 'constitutional_schema_v1',
      fileName: 'constitutional-schema.sql',
      ordinal: 0,
    }));
    expect(manifest.map((entry) => entry.ordinal)).toEqual(
      manifest.map((_entry, ordinal) => ordinal)
    );
    expect(new Set(manifest.map((entry) => entry.name)).size).toBe(manifest.length);
    expect(new Set(manifest.map((entry) => entry.fileName)).size).toBe(manifest.length);
    for (const entry of manifest) {
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('binds the complete packaged SQL directory as well as the runtime registry', async () => {
    await expect(engineMigrationArtifactDigest()).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it('binds declared registry order so swapping entries changes source identity', async () => {
    const manifest = await engineMigrationManifest();
    const swapped = [...manifest];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    expect(engineMigrationRegisteredDigest(swapped)).not.toBe(
      engineMigrationRegisteredDigest(manifest)
    );
  });

  it('preserves the merged PR276 ledger identities and appends one forward repair', () => {
    expect(REQUIRED_MIGRATION_FILES.slice(-11)).toEqual([
      { name: '20260819_ops_web_hardening', fileName: '20260819_ops_web_hardening.sql' },
      { name: '20260821_ops_business_claim_links', fileName: '20260821_ops_business_claim_links.sql' },
      { name: '20260821_business_ownership', fileName: '20260821_business_ownership.sql' },
      { name: '20260821_business_claim_links_extra', fileName: '20260821_business_claim_links_extra.sql' },
      { name: '20260823_business_fulfiller_lifecycle', fileName: '20260823_business_fulfiller_lifecycle.sql' },
      { name: '20260823_business_payout_tables', fileName: '20260823_business_payout_tables.sql' },
      { name: '20260824_enforce_controlled_test_business_acceptance', fileName: '20260824_enforce_controlled_test_business_acceptance.sql' },
      { name: '20260824_business_controlled_test_acceptance', fileName: '20260824_business_controlled_test_acceptance.sql' },
      { name: '20260824_orchestration_mode', fileName: '20260824_orchestration_mode.sql' },
      { name: '20260823_quote_payment_recovery', fileName: '20260823_quote_payment_recovery.sql' },
      { name: '20260825_pr276_incident_containment', fileName: '20260825_pr276_incident_containment.sql' },
    ]);
  });
});
