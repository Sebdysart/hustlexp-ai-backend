import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName =
  '20261008_universal_v1_work_order_task_state_containment_v1.sql';
const migrationPath = resolve(
  process.cwd(),
  'backend/database/migrations',
  fileName,
);
const migration = readFileSync(migrationPath, 'utf8');
const executableMigration = migration
  .replace(/\/\*[\s\S]*?\*\//gu, '')
  .replace(/--.*$/gmu, '');

const functionBody = (functionName: string, nextStatement: string) => {
  const start = migration.indexOf(
    `CREATE OR REPLACE FUNCTION public.${functionName}()`,
  );
  const end = migration.indexOf(nextStatement, start);
  expect(start, `${functionName} start`).toBeGreaterThanOrEqual(0);
  expect(end, `${functionName} end`).toBeGreaterThan(start);
  return migration.slice(start, end);
};

describe('Universal V1 Work Order task-state containment migration', () => {
  it('is the append-only migration 142 tail', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(REQUIRED_MIGRATION_FILES[140]).toEqual({
      name: '20261007_subscription_cancellation_recovery_v1',
      fileName: '20261007_subscription_cancellation_recovery_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES[141]).toEqual({
      name: '20261008_universal_v1_work_order_task_state_containment_v1',
      fileName,
    });
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
  });

  it('allows Work Order insertion only for an OPEN, unassigned, unbound Universal controlled-test task', () => {
    const preinsert = functionBody(
      'enforce_universal_v1_work_order_preinsert_task_v1',
      'DROP TRIGGER IF EXISTS universal_v1_work_order_preinsert_task_containment',
    );

    for (const prerequisite of [
      'task.id = NEW.task_id',
      "task.state = 'OPEN'",
      'task.worker_id IS NULL',
      'task.work_order_id IS NULL',
      'task.universal_contract_version = 1',
      "task.automation_classification = 'CONTROLLED_TEST'",
    ]) {
      expect(preinsert).toContain(prerequisite);
    }
    expect(preinsert).toContain('IF NOT EXISTS (');
    expect(preinsert).toContain('HXUV1-WO-STATE-1');
    expect(preinsert).toContain("ERRCODE = 'P0001'");
    expect(migration).toMatch(
      /CREATE TRIGGER universal_v1_work_order_preinsert_task_containment\s+BEFORE INSERT ON public\.task_work_orders\s+FOR EACH ROW EXECUTE FUNCTION public\.enforce_universal_v1_work_order_preinsert_task_v1\(\);/u,
    );
  });

  it('freezes state, worker, and Work Order identity after binding', () => {
    const freeze = functionBody(
      'freeze_universal_v1_work_order_task_projection_v1',
      'DROP TRIGGER IF EXISTS universal_v1_work_order_task_projection_containment',
    );

    expect(freeze).toMatch(
      /IF OLD\.work_order_id IS NOT NULL THEN[\s\S]*?NEW\.work_order_id IS DISTINCT FROM OLD\.work_order_id[\s\S]*?NEW\.state IS DISTINCT FROM OLD\.state[\s\S]*?NEW\.worker_id IS DISTINCT FROM OLD\.worker_id[\s\S]*?HXUV1-WO-STATE-2/iu,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER universal_v1_work_order_task_projection_containment\s+BEFORE UPDATE OF state, worker_id, work_order_id ON public\.tasks\s+FOR EACH ROW EXECUTE FUNCTION public\.freeze_universal_v1_work_order_task_projection_v1\(\);/u,
    );
  });

  it('permits the initial binding only when both task projections are OPEN and unassigned and the exact Work Order points back to the task', () => {
    const freeze = functionBody(
      'freeze_universal_v1_work_order_task_projection_v1',
      'DROP TRIGGER IF EXISTS universal_v1_work_order_task_projection_containment',
    );

    expect(freeze).toMatch(
      /IF NEW\.work_order_id IS NOT NULL THEN[\s\S]*?OLD\.state IS DISTINCT FROM 'OPEN'[\s\S]*?NEW\.state IS DISTINCT FROM 'OPEN'[\s\S]*?OLD\.worker_id IS NOT NULL[\s\S]*?NEW\.worker_id IS NOT NULL[\s\S]*?NOT EXISTS \([\s\S]*?FROM public\.task_work_orders work_order[\s\S]*?work_order\.id = NEW\.work_order_id[\s\S]*?work_order\.task_id = NEW\.id[\s\S]*?HXUV1-WO-STATE-3/iu,
    );
  });

  it('denies deletion of Work Order-bound task evidence', () => {
    const deletion = functionBody(
      'prevent_universal_v1_work_order_task_delete_v1',
      'DROP TRIGGER IF EXISTS universal_v1_work_order_task_delete_containment',
    );

    expect(deletion).toMatch(
      /IF OLD\.work_order_id IS NOT NULL THEN[\s\S]*?HXUV1-WO-STATE-4[\s\S]*?ERRCODE = 'P0001'[\s\S]*?RETURN OLD/iu,
    );
    expect(migration).toMatch(
      /CREATE TRIGGER universal_v1_work_order_task_delete_containment\s+BEFORE DELETE ON public\.tasks\s+FOR EACH ROW EXECUTE FUNCTION public\.prevent_universal_v1_work_order_task_delete_v1\(\);/u,
    );
  });

  it('keeps all three containment triggers ALWAYS enabled', () => {
    for (const trigger of [
      'universal_v1_work_order_preinsert_task_containment',
      'universal_v1_work_order_task_projection_containment',
      'universal_v1_work_order_task_delete_containment',
    ]) {
      expect(migration).toContain(`ENABLE ALWAYS TRIGGER ${trigger}`);
    }
  });

  it('revokes ambient function execution from PUBLIC, anon, and authenticated', () => {
    const functions = [
      'enforce_universal_v1_work_order_preinsert_task_v1',
      'freeze_universal_v1_work_order_task_projection_v1',
      'prevent_universal_v1_work_order_task_delete_v1',
    ];

    for (const functionName of functions) {
      expect(migration).toMatch(
        new RegExp(
          `REVOKE ALL ON FUNCTION public\\.${functionName}\\(\\)\\s+FROM PUBLIC`,
          'iu',
        ),
      );
      expect(migration).toContain(`'${functionName}()'`);
    }
    expect(migration).toContain("ARRAY['anon', 'authenticated']");
    expect(migration).toContain(
      "EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM %I', v_function, v_role)",
    );
  });

  it('adds no positive role, assignment, payment, payout, or deployment authority', () => {
    expect(executableMigration).not.toMatch(
      /\b(?:GRANT|CREATE\s+ROLE|ALTER\s+ROLE|SET\s+ROLE|SET\s+SESSION\s+AUTHORIZATION|SECURITY\s+DEFINER)\b/iu,
    );
    expect(executableMigration).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:escrows?|task_assignments?|task_financial_operations|task_financial_security_events|financial_provider_commands?|provider_payouts?)\b/iu,
    );
    expect(executableMigration).not.toMatch(
      /\b(?:payment_creation_enabled|APPROVED_PROVIDER|stripe|hard_assignment|provider_transfer_status)\b/iu,
    );
    expect(
      analyzeMigrationFile(migrationPath, migration).filter(
        (issue) => issue.severity === 'BLOCKER',
      ),
    ).toEqual([]);
  });
});
