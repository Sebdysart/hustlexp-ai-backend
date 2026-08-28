import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'backend/database/migrations/20260909_universal_v1_reconciliation_alias_repair.sql'
);
const sql = readFileSync(migrationPath, 'utf8');
const migrationRegistry = readFileSync(
  resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration-files.ts'),
  'utf8'
);

describe('Universal V1 reconciliation alias repair migration', () => {
  it('registers the append-only repair immediately after Work Order authority', () => {
    const workOrderAuthority = "name: '20260908_universal_v1_provider_work_order_authority'";
    const repair = "name: '20260909_universal_v1_reconciliation_alias_repair'";

    expect(migrationRegistry).toContain(repair);
    expect(migrationRegistry).toContain(
      "fileName: '20260909_universal_v1_reconciliation_alias_repair.sql'"
    );
    expect(migrationRegistry.indexOf(workOrderAuthority)).toBeLessThan(
      migrationRegistry.indexOf(repair)
    );
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
  });

  it('removes both predecessor shadowing sites while retaining exact trigger timing', () => {
    expect(sql).toContain('prior_reconciliation task_reconciliation_facts%ROWTYPE;');
    expect(sql).toContain('SELECT * INTO prior_reconciliation');
    expect(sql).toContain('JOIN authority_chain chain_predecessor');
    expect(sql).toContain('successor.predecessor_event_id = chain_predecessor.event_id');
    expect(sql).not.toContain('predecessor task_reconciliation_facts%ROWTYPE;');
    expect(sql).not.toContain('JOIN authority_chain predecessor');
    expect(sql).toContain(
      'DROP TRIGGER IF EXISTS universal_reconciliation_bindings_guard ON task_reconciliation_facts;'
    );
    expect(sql).toMatch(
      /CREATE TRIGGER universal_reconciliation_bindings_guard\s+BEFORE INSERT ON task_reconciliation_facts\s+FOR EACH ROW EXECUTE FUNCTION enforce_universal_reconciliation_bindings\(\);/u
    );
  });

  it('preserves every reconciliation invariant without enabling real-money or assignment effects', () => {
    for (let invariant = 1; invariant <= 14; invariant += 1) {
      expect(sql).toContain(`HXUV1-REC-${invariant}:`);
    }

    expect(sql).not.toMatch(
      /(?:provider_kind\s*=\s*'APPROVED_PROVIDER'|stripe|SET\s+worker_id|payment_creation_enabled)/iu
    );
    expect(sql).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?tasks\b/iu);
  });
});
