import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');

const REPAIR = read('backend/database/migrations/20260720_schema_convergence_repair.sql');
const CONSTITUTIONAL = read('backend/database/constitutional-schema.sql');
const LAUNCH = read('backend/database/launch-schema.sql');
const FINGERPRINT = read('backend/tests/integration/hxos-catalog-fingerprint.sql');
const RUNNER = [
  read('backend/src/jobs/engine-automation-migration.ts'),
  read('backend/src/jobs/engine-automation-migration-files.ts'),
].join('\n');
const UPGRADE_ASSERT = read('backend/tests/integration/upgrade-convergence-assert.pg.sql');

describe('HX/OS clean and upgraded schema convergence repair', () => {
  it('removes only duplicate proof constraint aliases', () => {
    for (const legacyName of [
      'proof_submissions_biometric_signal_status_check',
      'proof_submissions_biometric_provider_check',
      'proof_submissions_metadata_check',
      'proof_submissions_capture_source_check',
    ]) {
      expect(REPAIR).toContain(`DROP CONSTRAINT IF EXISTS ${legacyName}`);
    }
    expect(REPAIR).not.toMatch(/drop\s+(?:table|column)/i);
  });

  it.each([
    ['constitutional baseline', CONSTITUTIONAL],
    ['launch baseline', LAUNCH],
  ])('names every proof constraint canonically in the %s', (_label, baseline) => {
    for (const canonicalName of [
      'proof_submissions_biometric_signal_status_ck',
      'proof_submissions_biometric_provider_ck',
      'proof_submissions_metadata_object_ck',
      'proof_submissions_capture_source_ck',
    ]) {
      expect(baseline).toContain(`CONSTRAINT ${canonicalName}`);
    }
  });

  it('normalizes physical column order while preserving semantic column shape', () => {
    expect(FINGERPRINT).not.toContain("column_name || '|' || ordinal_position");
    expect(FINGERPRINT).toContain('ORDER BY table_name,column_name');
    for (const semanticField of ['data_type', 'udt_name', 'is_nullable', 'column_default']) {
      expect(FINGERPRINT).toContain(semanticField);
    }
  });

  it('registers the omitted admin contract and terminal convergence repair', () => {
    expect(RUNNER).toContain(
      "ADMIN_CAPABILITY_CONTRACT_MIGRATION = '20260719_admin_capability_contract'",
    );
    expect(RUNNER).toContain("fileName: '20260719_admin_capability_contract.sql'");
    expect(RUNNER).toContain(
      "SCHEMA_CONVERGENCE_REPAIR_MIGRATION = '20260720_schema_convergence_repair'",
    );
    expect(RUNNER).toContain("fileName: '20260720_schema_convergence_repair.sql'");
  });

  it('requires the exact current migration chain and preserves legacy reconciliation classification', () => {
    expect(UPGRADE_ASSERT).toContain('count(*)=96 AND count(DISTINCT name)=96');
    expect(UPGRADE_ASSERT).toContain('reconciliation_contract_version=0');
    expect(UPGRADE_ASSERT).toContain('offline_payload_hash IS NULL');
  });
});
