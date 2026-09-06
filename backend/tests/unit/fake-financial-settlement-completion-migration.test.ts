import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES } from '../../src/jobs/nonproduction-fake-financial-execution.js';

const migrationName = '20260910_fake_financial_settlement_completion_v3';
const migration = readFileSync(
  resolve(process.cwd(), `backend/database/migrations/${migrationName}.sql`),
  'utf8'
);
describe('fake financial settlement completion v3 migration', () => {
  it('adds the two missing provider-neutral operations through append-only evidence', () => {
    expect(migration).toContain("'PROVIDER_RELEASE'");
    expect(migration).toContain("'OBSERVE_BANK_SETTLEMENT'");
    expect(migration).toContain('hxos_fake_financial_operations_operation_kind_v3_check');
    expect(migration).toContain('VALIDATE CONSTRAINT');
    expect(migration).toContain('hxos_fake_financial_schema_evidence_v3');
    expect(migration).toContain('BEFORE UPDATE OR DELETE');
    expect(migration).toContain('BEFORE TRUNCATE');
  });

  it('is registered only in the exact nonproduction fake migration chain', () => {
    const fakeMigrationNames = CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES.map(
      ({ name }) => name
    );
    const migrationIndex = fakeMigrationNames.indexOf(migrationName);

    expect(migrationIndex).toBeGreaterThan(0);
    expect(CANONICAL_FAKE_FINANCIAL_MIGRATION_FILES[migrationIndex]).toEqual({
      name: migrationName,
      fileName: `${migrationName}.sql`,
      evidenceTable: 'hxos_fake_financial_schema_evidence_v3',
    });
    expect(fakeMigrationNames[migrationIndex - 1]).toBe(
      '20260903_fake_financial_provider_account_refresh_v2'
    );
    expect(
      REQUIRED_MIGRATION_FILES.some(
        ({ name, fileName }) => name === migrationName || fileName === `${migrationName}.sql`
      )
    ).toBe(false);
  });

  it('does not add processor-specific or production-money authority', () => {
    expect(migration).not.toMatch(
      /stripe_|payment_intent|connect_account|APPROVED_PROVIDER|payment_creation_enabled/iu
    );
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
  });
});
