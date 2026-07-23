import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const migrationPath = resolve(
  root,
  'backend/database/migrations/20260720_proof_verification_signal_contract.sql'
);
const minimizationMigrationPath = resolve(
  root,
  'backend/database/migrations/20260720_proof_media_metadata_minimization.sql'
);

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('HX/OS proof verification signal contract', () => {
  it('ships an additive, constrained proof-signal migration through production startup', () => {
    expect(existsSync(migrationPath)).toBe(true);
    expect(existsSync(minimizationMigrationPath)).toBe(true);
    if (!existsSync(migrationPath)) return;

    const migration = readFileSync(migrationPath, 'utf8');
    const minimizationMigration = readFileSync(minimizationMigrationPath, 'utf8');
    const harness = source('backend/tests/integration/proof-verification-signal-contract.pg.sql');
    for (const field of [
      'deepfake_score',
      'biometric_analyzed_at',
      'biometric_signal_status',
      'biometric_provider',
      'biometric_failure_reason_code',
      'biometric_policy_version',
      'metadata',
      'capture_source',
      'exif_timestamp',
      'exif_gps_lat',
      'exif_gps_lng',
      'exif_device_model',
      'capture_validation_passed',
      'capture_validation_failures',
    ])
      expect(migration).toContain(field);
    expect(migration).toContain('proof_submissions_deepfake_score_ck');
    expect(migration).toContain('proof_submissions_biometric_signal_status_ck');
    expect(migration).toContain('WHERE NOT EXISTS');
    expect(migration).toContain('exif_gps_lat IS NOT NULL');
    expect(migration).toContain('exif_gps_lng IS NOT NULL');
    expect(minimizationMigration).toContain('proof_submissions_raw_media_metadata_stripped_ck');
    expect(minimizationMigration).toMatch(/SET\s+exif_timestamp\s*=\s*NULL/i);

    const runner = [
      source('backend/src/jobs/engine-automation-migration.ts'),
      source('backend/src/jobs/engine-automation-migration-files.ts'),
    ].join('\n');
    const dockerfile = source('Dockerfile');
    expect(runner).toMatch(
      /PROOF_VERIFICATION_SIGNAL_CONTRACT_MIGRATION\s*=\s*'20260720_proof_verification_signal_contract'/
    );
    expect(runner).toMatch(
      /PROOF_MEDIA_METADATA_MINIMIZATION_MIGRATION\s*=\s*'20260720_proof_media_metadata_minimization'/
    );
    expect(runner).toContain("fileName: '20260720_proof_verification_signal_contract.sql'");
    expect(runner).toContain("fileName: '20260720_proof_media_metadata_minimization.sql'");
    expect(dockerfile).toContain(
      '/app/backend/database/migrations/20260720_proof_verification_signal_contract.sql'
    );
    expect(dockerfile).toContain(
      '/app/backend/database/migrations/20260720_proof_media_metadata_minimization.sql'
    );
    expect(harness).toContain('out-of-range liveness score unexpectedly succeeded');
    expect(harness).toContain('fabricated VERIFIED signal state unexpectedly succeeded');
    expect(harness).toContain('PROOF_VERIFICATION_SIGNAL_DATABASE_CONTRACT_OK');
  });

  it('uses canonical proof IDs and rejects silent zero-row persistence', () => {
    const biometric = source('backend/src/services/BiometricVerificationService.ts');
    const photo = source('backend/src/services/PhotoVerificationService.ts');
    const worker = source('backend/src/jobs/biometric-analyzer-worker.ts');

    expect(biometric).toMatch(/WHERE\s+proof_id\s*=\s*\$3/i);
    expect(biometric).toContain('PROOF_SIGNAL_TARGET_NOT_FOUND');
    expect(photo).toMatch(/WHERE\s+proof_id\s*=\s*\$4/i);
    expect(photo).toContain('PROOF_SIGNAL_TARGET_NOT_FOUND');
    expect(photo).toMatch(/exif_timestamp\s*=\s*NULL/i);
    expect(photo).toMatch(/exif_gps_lat\s*=\s*NULL/i);
    expect(photo).toMatch(/exif_gps_lng\s*=\s*NULL/i);
    expect(photo).toMatch(/exif_device_model\s*=\s*NULL/i);
    expect(worker).toMatch(/WHERE\s+proof_id\s*=\s*\$1/i);
  });

  it('never fabricates biometric confidence when no provider is configured', () => {
    const biometric = source('backend/src/services/BiometricVerificationService.ts');
    expect(biometric).toContain('BIOMETRIC_PROVIDER_UNAVAILABLE');
    expect(biometric).not.toContain('let livenessScore = 0.85');
    expect(biometric).not.toContain('let deepfakeScore = 0.15');
  });

  it('creates a verification metadata row for every accepted proof submission', () => {
    const submission = source('backend/src/services/ProofSubmissionService.ts');
    expect(submission).toContain('insertVerificationEvidence');
    expect(submission).not.toMatch(
      /async function insertVerificationEvidence[\s\S]*?gpsLatitude == null[\s\S]*?return;/
    );
  });

  it('erases every sensitive proof signal during deletion', () => {
    const gdpr = source('backend/src/services/GDPRService.ts');
    for (const assignment of [
      'deepfake_score = NULL',
      'biometric_analyzed_at = NULL',
      "biometric_signal_status = 'NOT_RUN'",
      'biometric_provider = NULL',
      'biometric_failure_reason_code = NULL',
      "metadata = '{}'::jsonb",
      'exif_timestamp = NULL',
      'exif_gps_lat = NULL',
      'exif_gps_lng = NULL',
      'exif_device_model = NULL',
      'capture_validation_failures = ARRAY[]::TEXT[]',
    ])
      expect(gdpr).toContain(assignment);
  });
});
