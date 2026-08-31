import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { analyzeMigrationFile } from '../../../scripts/analyze-migration-safety.js';

const fileName = '20260926_universal_v1_change_order_three_phase_v1.sql';
const migrationPath = resolve(process.cwd(), 'backend/database/migrations', fileName);
const migration = readFileSync(migrationPath, 'utf8');

describe('Universal V1 change-order three-phase migration', () => {
  it('commits one immutable Phase-A witness without granting production money', () => {
    for (const token of [
      'CREATE TABLE IF NOT EXISTS public.universal_v1_change_order_materialization_commands',
      'universal_v1_change_order_materialization_request_sha256',
      'universal_v1_change_order_materialization_command_immutable',
      'universal_v1_change_order_materialization_command_no_truncate',
      'hxos_fake_financial_schema_evidence_v5',
      'hxos_fake_financial_schema_evidence_v6',
      'hxos_fake_financial_schema_evidence_append_only_v6',
      'BEFORE UPDATE OR DELETE',
      'BEFORE TRUNCATE',
      'REVOKE ALL ON TABLE public.hxos_fake_financial_schema_evidence_v6 FROM PUBLIC',
      'REVOKE ALL ON TABLE public.universal_v1_change_order_materialization_commands FROM PUBLIC',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
    expect(migration).not.toMatch(/\b(?:stripe|payment_intent|APPROVED_PROVIDER)\b/iu);
  });

  it('admits ADJUST only from the exact current fake-only authority chain', () => {
    for (const token of [
      'enforce_universal_v1_prepared_adjustment_witness',
      "NEW.operation_kind <> 'ADJUST'",
      "command.idempotency_key || ':adjust' = NEW.idempotency_key",
      'command.adjustment_operation_id = NEW.operation_id',
      "NEW.provider_kind = 'FAKE'",
      'NEW.provider_expected_version = 0',
      "actor.account_status = 'ACTIVE'",
      'actor.is_minor IS FALSE',
      'COALESCE(actor.is_banned, FALSE) IS FALSE',
      "customer_approval_actor.account_status = 'ACTIVE'",
      'customer_approval_actor.is_minor IS FALSE',
      'COALESCE(customer_approval_actor.is_banned, FALSE) IS FALSE',
      "provider_approval_actor.account_status = 'ACTIVE'",
      'provider_approval_actor.is_minor IS FALSE',
      'COALESCE(provider_approval_actor.is_banned, FALSE) IS FALSE',
      "customer_approval.actor_id = task.poster_id",
      "customer_approval.actor_id, 'APPROVE_SPEND'",
      "provider_approval.actor_id,",
      "'APPROVE_SPEND'",
      'newer_financial.expected_version > predecessor.expected_version',
      'newer_execution.execution_version > execution.execution_version',
      'task_completion_facts',
      'task_reconciliation_facts',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('permits task-economics projection only for the exact successful bridged adjustment', () => {
    for (const token of [
      'CREATE OR REPLACE FUNCTION public.enforce_task_region_policy_binding()',
      'command.base_scope_version_id = OLD.active_scope_version_id',
      'command.replacement_scope_version_id = NEW.active_scope_version_id',
      'replacement.customer_total_cents = NEW.price',
      'replacement.hustler_payout_cents = NEW.hustler_payout_cents',
      "bridge.fake_operation_kind = 'ADJUST'",
      "bridge.fake_provider_state = 'SUCCEEDED'",
      "bridge.lifecycle_event_kind = 'ADJUSTMENT_AUTHORIZED'",
      "bridge.lifecycle_status = 'SUCCEEDED'",
      'HXRP6: region policy binding is immutable',
      'HXRP13: task economics violate region policy',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('serializes execution and proposal races behind the WorkOrder authority lock', () => {
    expect(migration).toContain(
      "pg_advisory_xact_lock(hashtextextended('fulfillment:' || NEW.work_order_id::TEXT, 0))"
    );
    expect(migration).toContain(
      "hashtextextended('fulfillment:' || checked_work_order_id::TEXT, 0)"
    );
    expect(migration).toContain(
      'HXUV1-CHANGE-3P-6: execution is held until the prepared amendment finalizes or compensates'
    );
    expect(migration).toContain(
      'HXUV1-CHANGE-3P-7: a prepared amendment already owns this Work Order transition'
    );
  });

  it('has no blocker under the repository migration-safety policy', () => {
    expect(
      analyzeMigrationFile(migrationPath, migration).filter(
        (issue) => issue.severity === 'BLOCKER'
      )
    ).toEqual([]);
  });
});
