import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName = '20260923_legacy_escrow_insert_containment_v1.sql';
const migrationPath = resolve(
  process.cwd(),
  'backend/database/migrations',
  fileName,
);
const migration = readFileSync(migrationPath, 'utf8');

describe('legacy escrow insert containment migration', () => {
  it('is append-only engine migration 129 after command recovery', () => {
    const containmentIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260923_legacy_escrow_insert_containment_v1'
    );
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(140);
    expect(REQUIRED_MIGRATION_FILES.slice(containmentIndex - 1, containmentIndex + 1)).toEqual([
      {
        name: '20260920_financial_provider_command_recovery_v1',
        fileName: '20260920_financial_provider_command_recovery_v1.sql',
      },
      {
        name: '20260923_legacy_escrow_insert_containment_v1',
        fileName,
      },
    ]);
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
  });

  it('fails closed unless plural escrow authority is a non-inherited regular table', () => {
    for (const token of [
      "namespace.nspname = 'public'",
      "relation.relname = 'escrows'",
      "relation.relkind = 'r'",
      'pg_catalog.pg_inherits',
      "pg_catalog.to_regclass('public.escrow') IS NOT NULL",
      'singular public.escrow lineage requires explicit review',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('denies inserts except in the exact isolated invariant and system CI databases', () => {
    for (const token of [
      "session_user = 'hx_ci_runner'",
      "current_user = 'hx_ci_runner'",
      "'hx_ci_invariant_test'",
      "'hx_ci_system_test'",
      'HXUV1-ESCROW-1: new legacy escrow creation is retired',
      "ERRCODE = 'P0001'",
    ]) {
      expect(migration).toContain(token);
    }

    expect(migration).not.toMatch(
      /(?:hx_ci_fresh_test|hx_ci_upgrade_test|current_setting|set_config|provider_kind|stripe|APPROVED_PROVIDER|payment_creation_enabled)/iu,
    );
  });

  it('installs an always-enabled insert-only invoker trigger and preserves recovery updates', () => {
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toMatch(
      /CREATE TRIGGER legacy_escrow_insert_containment_v1\s+BEFORE INSERT ON public\.escrows\s+FOR EACH ROW EXECUTE FUNCTION public\.enforce_legacy_escrow_insert_containment_v1\(\);/u,
    );
    expect(migration).toContain(
      'ENABLE ALWAYS TRIGGER legacy_escrow_insert_containment_v1',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.enforce_legacy_escrow_insert_containment_v1() FROM PUBLIC',
    );
    expect(migration).not.toMatch(/BEFORE\s+(?:UPDATE|DELETE)|BEFORE\s+INSERT\s+OR\s+UPDATE/iu);
    expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE)\s+(?:TABLE\s+)?public\.escrows\b/iu);
  });

  it('has no blocker under the repository migration-safety policy', () => {
    expect(
      analyzeMigrationFile(migrationPath, migration).filter(
        (issue) => issue.severity === 'BLOCKER',
      ),
    ).toEqual([]);
  });
});
