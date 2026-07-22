import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONTROLLED_TEST_RETAKE_ACCEPTANCE_REPAIR_MIGRATION,
  CONTROLLED_TEST_RETAKE_LIQUIDITY_REPAIR_MIGRATION,
  CONTROLLED_TEST_RETAKE_GUARD_CONVERGENCE_MIGRATION,
  SAME_WORKER_RETAKE_ASSIGNMENT_GUARD_REPAIR_MIGRATION,
  productionMigrationRuntime,
} from '../../src/jobs/engine-automation-migration.js';

const migrationFile = '20260721_controlled_test_retake_acceptance_repair.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', migrationFile),
  'utf8'
);
const liquidityMigrationFile = '20260721_controlled_test_retake_liquidity_repair.sql';
const liquidityMigration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', liquidityMigrationFile),
  'utf8'
);
const convergenceMigrationFile = '20260721_controlled_test_retake_guard_convergence.sql';
const convergenceMigration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', convergenceMigrationFile),
  'utf8'
);
const assignmentMigrationFile = '20260721_same_worker_retake_assignment_guard_repair.sql';
const assignmentMigration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', assignmentMigrationFile),
  'utf8'
);

describe('controlled TEST retake acceptance repair', () => {
  it('exempts only a same-worker PROOF_SUBMITTED to ACCEPTED continuation', () => {
    for (const sql of [migration, liquidityMigration]) {
      expect(sql).toContain("OLD.state='PROOF_SUBMITTED'");
      expect(sql).toContain("NEW.state='ACCEPTED'");
      expect(sql).toContain('OLD.worker_id IS NOT NULL');
      expect(sql).toContain('OLD.worker_id IS NOT DISTINCT FROM NEW.worker_id');
    }
    expect(migration).toContain("action.action_type='ACCEPTED'");
    expect(migration).toContain('HXOR9: controlled TEST task acceptance lacks current explicit worker acceptance');
    expect(liquidityMigration).toContain('hxos_local_test_liquidity_witness_current_v2');
    expect(liquidityMigration).toContain('HXPC5: controlled TEST acceptance lacks capability-bound liquidity');
    expect(convergenceMigration.match(/hxos_same_worker_proof_retake_continuation\(/g)).toHaveLength(5);
    expect(convergenceMigration).toContain('enforce_task_liquidity_cell_on_accept');
    expect(convergenceMigration).toContain('HXLQ9: TEST liquidity cannot authorize production work');
    for (const trigger of [
      'task_region_policy_accept_gate',
      'task_worker_eligibility_accept_gate',
      'task_template_policy_accept_gate',
      'task_clarification_accept_gate',
    ]) expect(assignmentMigration).toContain(trigger);
    expect(assignmentMigration.match(/NOT hxos_same_worker_proof_retake_continuation\(/g)).toHaveLength(4);
  });

  it('registers and packages the forward migration', () => {
    const spec = productionMigrationRuntime().migrationSpecs.find(
      (candidate) => candidate.name === SAME_WORKER_RETAKE_ASSIGNMENT_GUARD_REPAIR_MIGRATION
    );
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');

    expect(CONTROLLED_TEST_RETAKE_ACCEPTANCE_REPAIR_MIGRATION).toBe('20260721_controlled_test_retake_acceptance_repair');
    expect(CONTROLLED_TEST_RETAKE_LIQUIDITY_REPAIR_MIGRATION).toBe('20260721_controlled_test_retake_liquidity_repair');
    expect(CONTROLLED_TEST_RETAKE_GUARD_CONVERGENCE_MIGRATION).toBe('20260721_controlled_test_retake_guard_convergence');
    expect(SAME_WORKER_RETAKE_ASSIGNMENT_GUARD_REPAIR_MIGRATION).toBe('20260721_same_worker_retake_assignment_guard_repair');
    expect(spec?.name).toBe(SAME_WORKER_RETAKE_ASSIGNMENT_GUARD_REPAIR_MIGRATION);
    expect(spec?.candidatePaths[0]).toContain(assignmentMigrationFile);
    expect(dockerfile).toContain(`/app/backend/database/migrations/${migrationFile}`);
    expect(dockerfile).toContain(`/app/backend/database/migrations/${liquidityMigrationFile}`);
    expect(dockerfile).toContain(`/app/backend/database/migrations/${convergenceMigrationFile}`);
    expect(dockerfile).toContain(`/app/backend/database/migrations/${assignmentMigrationFile}`);
  });
});
