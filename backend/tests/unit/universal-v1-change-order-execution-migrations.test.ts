import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';

const changeOrderPath = resolve(
  process.cwd(),
  'backend/database/migrations/20260911_universal_v1_change_order_application.sql'
);
const executionPath = resolve(
  process.cwd(),
  'backend/database/migrations/20260912_universal_v1_work_order_execution_facts.sql'
);
const changeOrderSql = readFileSync(changeOrderPath, 'utf8');
const executionSql = readFileSync(executionPath, 'utf8');

describe('Universal V1 change-order and execution migration chain', () => {
  it('is one exact, ordered, runner-owned transaction tail', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(128);
    expect(REQUIRED_MIGRATION_FILES.slice(-10)).toEqual([
      {
        name: '20260911_universal_v1_change_order_application',
        fileName: '20260911_universal_v1_change_order_application.sql',
      },
      {
        name: '20260912_universal_v1_work_order_execution_facts',
        fileName: '20260912_universal_v1_work_order_execution_facts.sql',
      },
      {
        name: '20260913_universal_v1_completion_delivery_receipt',
        fileName: '20260913_universal_v1_completion_delivery_receipt.sql',
      },
      {
        name: '20260914_notification_provider_in_flight',
        fileName: '20260914_notification_provider_in_flight.sql',
      },
      {
        name: '20260915_ai_spend_attempt_ledger',
        fileName: '20260915_ai_spend_attempt_ledger.sql',
      },
      {
        name: '20260916_provider_event_inbox_v1',
        fileName: '20260916_provider_event_inbox_v1.sql',
      },
      {
        name: '20260917_financial_provider_command_journal_v1',
        fileName: '20260917_financial_provider_command_journal_v1.sql',
      },
      {
        name: '20260918_universal_v1_prepared_financial_command_v1',
        fileName: '20260918_universal_v1_prepared_financial_command_v1.sql',
      },
      {
        name: '20260919_provider_event_processing_v1',
        fileName: '20260919_provider_event_processing_v1.sql',
      },
      {
        name: '20260920_financial_provider_command_recovery_v1',
        fileName: '20260920_financial_provider_command_recovery_v1.sql',
      },
    ]);
    for (const sql of [changeOrderSql, executionSql]) {
      expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
    }
  });

  it('passes the repository migration-safety policy without blockers', () => {
    for (const [path, sql] of [
      [changeOrderPath, changeOrderSql],
      [executionPath, executionSql],
    ] as const) {
      expect(
        analyzeMigrationFile(path, sql).filter((issue) => issue.severity === 'BLOCKER')
      ).toEqual([]);
    }
  });

  it('binds a finalized amendment to exact scope, finance, actor, and execution facts', () => {
    expect(changeOrderSql).toContain('expected_financial_version INTEGER');
    expect(changeOrderSql).toContain(
      "'expectedFinancialVersion', checked_expected_financial_version"
    );
    expect(changeOrderSql).toContain(
      'adjustment.expected_version <> NEW.expected_financial_version + 1'
    );
    expect(changeOrderSql).toContain("adjustment.provider_kind <> 'FAKE'");
    expect(changeOrderSql).toContain('adjustment.recorded_by <> NEW.materialized_by');
    expect(changeOrderSql).toContain('public.business_membership_has_action(');
    expect(changeOrderSql).toContain("'APPROVE_SPEND'");
    expect(changeOrderSql).toContain('universal_work_order_amendment_guard');
  });

  it('enforces one append-only execution chain through completion and fake capture', () => {
    for (const state of [
      'MATERIALIZED',
      'ACKNOWLEDGED',
      'EN_ROUTE',
      'ARRIVED',
      'IN_PROGRESS',
      'PAUSED',
      'COMPLETION_SUBMITTED',
      'REWORK_REQUIRED',
      'COMPLETED',
    ]) {
      expect(executionSql).toContain(`'${state}'`);
    }
    expect(executionSql).toContain('task_work_order_execution_facts_immutable');
    expect(executionSql).toContain('task_work_order_execution_facts_no_truncate');
    expect(executionSql).toContain('universal_v1_amendment_execution_fact_guard');
    expect(executionSql).toContain('universal_v1_completion_execution_fact_guard');
    expect(executionSql).toContain('universal_v1_financial_execution_completion_guard');
    expect(executionSql).toContain("execution.state = 'COMPLETED'");
    expect(executionSql).toContain("task_record.automation_classification <> 'CONTROLLED_TEST'");
    expect(executionSql).toContain(
      "task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'"
    );
    expect(executionSql).toContain('NEW.recorded_at := clock_timestamp()');
  });
});
