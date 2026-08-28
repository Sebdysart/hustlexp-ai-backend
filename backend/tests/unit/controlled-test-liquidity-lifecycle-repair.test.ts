import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(resolve(
  process.cwd(),
  'backend/database/migrations/20260720_controlled_test_liquidity_lifecycle_repair.sql',
), 'utf8');

describe('controlled TEST liquidity lifecycle repair', () => {
  it('requires authority for cell binding or assignment, not later lifecycle state', () => {
    for (const invariant of [
      "v_requires_marker := TG_OP='INSERT'",
      'OLD.liquidity_cell_id IS DISTINCT FROM NEW.liquidity_cell_id',
      'OLD.automation_classification IS DISTINCT FROM NEW.automation_classification',
      'OLD.worker_id IS DISTINCT FROM NEW.worker_id AND NEW.worker_id IS NOT NULL',
      "OLD.state IN ('OPEN','MATCHING') AND NEW.state='ACCEPTED'",
      'v_is_test IS TRUE AND v_requires_marker',
    ]) expect(migration).toContain(invariant);
    expect(migration).not.toContain("NEW.state='PROOF_SUBMITTED'");
    expect(migration).not.toContain("NEW.state='COMPLETED'");
  });
});
