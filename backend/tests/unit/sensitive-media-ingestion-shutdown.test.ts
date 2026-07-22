import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8');
}

const sql = source('backend/database/migrations/20260721_sensitive_media_ingestion_shutdown.sql');

describe('sensitive media ingestion shutdown', () => {
  it('clears and constrains every unsupported persisted media field', () => {
    for (const field of [
      'avatar_url',
      'license_url',
      'document_url',
      'before_photo_url',
      'photo_url',
      'lidar_depth_map_url',
    ]) {
      expect(sql).toContain(field);
    }
    expect(sql).toContain('users_avatar_receipt_only_ck');
    expect(sql).toContain('worker_skills_license_receipt_only_ck');
    expect(sql).toContain('license_verifications_document_receipt_only_ck');
    expect(sql).toContain('insurance_verifications_document_receipt_only_ck');
    expect(sql).toContain('tasks_before_photo_receipt_only_ck');
    expect(sql).toContain('proof_submissions_receipt_only_media_ck');
    expect(sql).toContain('verified = FALSE');
  });

  it('rejects direct URLs at every exposed unsupported ingestion boundary', () => {
    expect(source('backend/src/routers/task-router-common.ts')).toContain(
      'Direct proof media URLs are disabled; use finalized upload receipts.',
    );
    expect(source('backend/src/routers/skills.ts')).toContain(
      'Direct skill-license media URLs are disabled.',
    );
    expect(source('backend/src/routers/tutorial.ts')).toContain(
      'Equipment photo scanning is unavailable until receipt-backed metadata stripping is implemented.',
    );
    expect(source('backend/src/routers/user.ts')).toContain(
      'Avatar updates are disabled until receipt-backed metadata stripping is available.',
    );
    expect(source('backend/src/routers/biometric.ts')).toContain(
      'Direct face-photo analysis is disabled.',
    );
    expect(source('backend/src/services/LicenseVerificationService.ts')).toContain(
      'Direct license document URLs are disabled',
    );
    expect(source('backend/src/services/InsuranceVerificationService.ts')).toContain(
      'Direct insurance document URLs are disabled',
    );
  });

  it('places credential review behind persisted trust-admin authority', () => {
    const router = source('backend/src/routers/capabilityCoreRoutes.ts');
    expect(router).toContain('approveLicense: trustAdminProcedure');
    expect(router).toContain('rejectLicense: trustAdminProcedure');
    expect(router).toContain('getPendingLicenses: trustAdminProcedure');
  });

  it('is startup ordered and packaged as the final migration', () => {
    const runner = source('backend/src/jobs/engine-automation-migration.ts');
    const dockerfile = source('Dockerfile');
    expect(runner).toContain('20260721_sensitive_media_ingestion_shutdown');
    expect(dockerfile).toContain('20260721_sensitive_media_ingestion_shutdown.sql');
  });
});
