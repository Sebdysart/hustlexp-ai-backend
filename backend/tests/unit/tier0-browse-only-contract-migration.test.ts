import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { taskEligibilityPredicates } from '../../src/services/TaskEligibilityPolicy.js';
import { productionMigrationRuntime } from '../../src/jobs/engine-automation-migration.js';

const migrationPath = resolve(
  process.cwd(),
  'backend/database/migrations/20260719_tier0_browse_only_contract.sql',
);
const SQL = readFileSync(migrationPath, 'utf8');

describe('Tier 0 browse-only contract', () => {
  it('makes Tier 0 a valid persisted onboarding state', () => {
    expect(SQL).toContain('CHECK (trust_tier IN (0, 1, 2, 3, 4, 9))');
    expect(SQL).toContain('CHECK (trust_tier BETWEEN 0 AND 4)');
    expect(SQL).toContain('users ALTER COLUMN trust_tier SET DEFAULT 0');
    expect(SQL).toContain('capability_profiles ALTER COLUMN trust_tier SET DEFAULT 0');
  });

  it('fails closed at the database acceptance boundary', () => {
    expect(SQL).toContain('v_worker.worker_trust_tier < 1');
    expect(SQL).toContain('NOT v_worker.is_verified');
    expect(SQL).toContain("NULLIF(BTRIM(v_worker.phone), '') IS NULL");
    expect(SQL).toContain('HXWE15: Tier 0 is browse-only');
    expect(SQL).not.toContain('worker_trust_tier <= 0 THEN 2000');
  });

  it('excludes Tier 0 and unverified identities from discovery and mutation SQL', () => {
    const predicates = taskEligibilityPredicates();
    expect(predicates).toContain('feed_worker.trust_tier >= 1');
    expect(predicates).toContain('feed_worker.is_verified = TRUE');
    expect(predicates).toContain("NULLIF(BTRIM(feed_worker.phone), '') IS NOT NULL");
    expect(predicates).not.toContain('feed_worker.trust_tier <= 0 THEN 2000');
  });

  it('is included in the production migration sequence', () => {
    expect(productionMigrationRuntime().migrationSpecs.some((spec) => (
      spec.candidatePaths.includes('/app/backend/database/migrations/20260719_tier0_browse_only_contract.sql')
    ))).toBe(true);
  });
});
