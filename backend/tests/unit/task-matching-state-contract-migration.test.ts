import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'backend/database/migrations/20260829_task_matching_state_contract.sql',
);
const registryPath = resolve(
  process.cwd(),
  'backend/src/jobs/engine-automation-migration-files.ts',
);

describe('task MATCHING state append-only migration', () => {
  it('registers the repair after the operator authority contract', () => {
    const registry = readFileSync(registryPath, 'utf8');
    const operator = registry.indexOf("name: '20260828_operator_authority_contract'");
    const matching = registry.indexOf("name: '20260829_task_matching_state_contract'");

    expect(operator).toBeGreaterThanOrEqual(0);
    expect(matching).toBeGreaterThan(operator);
    expect(registry).toContain("fileName: '20260829_task_matching_state_contract.sql'");
  });

  it('converges the database state machine without changing data or authority', () => {
    const migration = readFileSync(migrationPath, 'utf8');

    expect(migration).toContain('DROP CONSTRAINT IF EXISTS tasks_state_check');
    expect(migration).toContain("'MATCHING'");
    expect(migration).toContain('VALIDATE CONSTRAINT tasks_state_check');
    expect(migration).toContain('tasks_instant_mode_check');
    expect(migration).toContain("state = 'MATCHING'");
    expect(migration).not.toMatch(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+tasks\b/iu);
    expect(migration).not.toMatch(/HX_PAYMENT|stripe_|payouts_enabled|deployment_manifest/iu);
  });
});
