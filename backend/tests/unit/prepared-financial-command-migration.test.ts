import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName = '20260918_universal_v1_prepared_financial_command_v1.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);
const registeredPostBaselineTailMigrations = [
  migration,
  readFileSync(
    resolve(process.cwd(), 'backend/database/migrations/20260919_provider_event_processing_v1.sql'),
    'utf8'
  ),
  readFileSync(
    resolve(
      process.cwd(),
      'backend/database/migrations/20260920_financial_provider_command_recovery_v1.sql'
    ),
    'utf8'
  ),
  readFileSync(
    resolve(
      process.cwd(),
      'backend/database/migrations/20260923_legacy_escrow_insert_containment_v1.sql'
    ),
    'utf8'
  ),
  readFileSync(
    resolve(
      process.cwd(),
      'backend/database/migrations/20261006_stage1_legacy_authority_containment_v1.sql'
    ),
    'utf8'
  ),
] as const;
const nonproductionPostEngineFixture = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20260921_universal_v1_fake_financial_lifecycle_bridge_v1.sql'
  ),
  'utf8'
);
const constitutional = readFileSync(
  resolve(process.cwd(), 'backend/database/constitutional-schema.sql'),
  'utf8'
);
const launch = readFileSync(resolve(process.cwd(), 'backend/database/launch-schema.sql'), 'utf8');
const migrationDocs = readFileSync(resolve(process.cwd(), 'docs/MIGRATIONS.md'), 'utf8');
const financialApplicationSource = readFileSync(
  resolve(process.cwd(), 'backend/src/services/payment/UniversalV1FinancialApplicationService.ts'),
  'utf8'
);

describe('Universal V1 prepared financial command migration', () => {
  it('is the exact ordered successor to the command journal', () => {
    const journalIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260917_financial_provider_command_journal_v1'
    );
    const preparationIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260918_universal_v1_prepared_financial_command_v1'
    );
    const processingIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260919_provider_event_processing_v1'
    );
    const recoveryIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260920_financial_provider_command_recovery_v1'
    );
    const containmentIndex = REQUIRED_MIGRATION_FILES.findIndex(
      ({ name }) => name === '20260923_legacy_escrow_insert_containment_v1'
    );
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(146);
    expect(journalIndex).toBeGreaterThanOrEqual(0);
    expect(preparationIndex).toBe(journalIndex + 1);
    expect(processingIndex).toBe(preparationIndex + 1);
    expect(recoveryIndex).toBe(processingIndex + 1);
    expect(containmentIndex).toBe(recoveryIndex + 1);
    expect(REQUIRED_MIGRATION_FILES[preparationIndex]).toEqual({
      name: '20260918_universal_v1_prepared_financial_command_v1',
      fileName,
    });
    expect(REQUIRED_MIGRATION_FILES.slice(preparationIndex)).toEqual([
      {
        name: '20260918_universal_v1_prepared_financial_command_v1',
        fileName,
      },
      {
        name: '20260919_provider_event_processing_v1',
        fileName: '20260919_provider_event_processing_v1.sql',
      },
      {
        name: '20260920_financial_provider_command_recovery_v1',
        fileName: '20260920_financial_provider_command_recovery_v1.sql',
      },
      {
        name: '20260923_legacy_escrow_insert_containment_v1',
        fileName: '20260923_legacy_escrow_insert_containment_v1.sql',
      },
      {
        name: '20260924_universal_v1_task_draft_route_context_v1',
        fileName: '20260924_universal_v1_task_draft_route_context_v1.sql',
      },
      {
        name: '20260925_universal_v1_work_order_compensation_v1',
        fileName: '20260925_universal_v1_work_order_compensation_v1.sql',
      },
      {
        name: '20260928_provider_observation_normalization_v1',
        fileName: '20260928_provider_observation_normalization_v1.sql',
      },
      {
        name: '20260929_universal_v1_double_entry_ledger_v1',
        fileName: '20260929_universal_v1_double_entry_ledger_v1.sql',
      },
      {
        name: '20260930_universal_v1_ops_cases_v1',
        fileName: '20260930_universal_v1_ops_cases_v1.sql',
      },
      {
        name: '20261001_universal_v1_relationship_origin_v1',
        fileName: '20261001_universal_v1_relationship_origin_v1.sql',
      },
      {
        name: '20261002_universal_v1_dispute_recovery_v1',
        fileName: '20261002_universal_v1_dispute_recovery_v1.sql',
      },
      {
        name: '20261003_universal_v1_task_opportunities_v1',
        fileName: '20261003_universal_v1_task_opportunities_v1.sql',
      },
      {
        name: '20261004_universal_v1_completion_notice_dispatch_v1',
        fileName: '20261004_universal_v1_completion_notice_dispatch_v1.sql',
      },
      {
        name: '20261005_universal_v1_occurrence_access_audit_v1',
        fileName: '20261005_universal_v1_occurrence_access_audit_v1.sql',
      },
      {
        name: '20261006_stage1_legacy_authority_containment_v1',
        fileName: '20261006_stage1_legacy_authority_containment_v1.sql',
      },
      {
        name: '20261007_subscription_cancellation_recovery_v1',
        fileName: '20261007_subscription_cancellation_recovery_v1.sql',
      },
      {
        name: '20261008_universal_v1_work_order_task_state_containment_v1',
        fileName: '20261008_universal_v1_work_order_task_state_containment_v1.sql',
      },
      {
        name: '20261009_universal_v1_standardized_quote_readiness_v1',
        fileName: '20261009_universal_v1_standardized_quote_readiness_v1.sql',
      },
      {
        name: '20261010_universal_v1_financial_security_event_expiry_v1',
        fileName: '20261010_universal_v1_financial_security_event_expiry_v1.sql',
      },
      {
        name: '20261012_universal_v1_work_order_command_authority_v2',
        fileName: '20261012_universal_v1_work_order_command_authority_v2.sql',
      },
      {
        name: '20261014_universal_v1_work_order_command_ports_v1',
        fileName: '20261014_universal_v1_work_order_command_ports_v1.sql',
      },
    ]);
    expect(
      REQUIRED_MIGRATION_FILES.some(
        ({ name }) => String(name) === '20260921_universal_v1_fake_financial_lifecycle_bridge_v1'
      )
    ).toBe(false);
  });

  it('binds exact lifecycle versions and every applicable authoritative fact', () => {
    for (const token of [
      'universal_v1_prepared_financial_commands',
      "command_state = 'PREPARED'",
      'provider_expected_version',
      'lifecycle_expected_version',
      'provider_request_sha256',
      'eligibility_decision_version',
      'eligibility_valid_until',
      'scope_version',
      'scope_hash',
      'work_order_materialization_version',
      'change_order_version',
      'completion_version',
      'predecessor_operation_id',
      'predecessor_event_kind',
      'predecessor_status',
      'related_operation_id',
      'authority_context_sha256',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('validates under ordered transaction and canonical row locks before insertion', () => {
    for (const token of [
      'pg_advisory_xact_lock',
      'ORDER BY candidate',
      'FOR SHARE',
      'exact Universal V1 Task Draft authority is required',
      'exact latest financial predecessor and unused lifecycle version are required',
      'capture requires exact current approved completion',
      'prepared cumulative refunds cannot exceed successful capture',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('is append-only, fake-only, and required by lifecycle journal inserts', () => {
    for (const token of [
      "provider_kind TEXT NOT NULL CHECK (provider_kind = 'FAKE')",
      'approved-provider preparation remains sealed',
      'BEFORE UPDATE OR DELETE',
      'BEFORE TRUNCATE',
      'PREPARED financial command authority is append-only',
      'prepared_financial_command_id',
      'financial_provider_command_prepared_authority_guard',
      'provider command requires its exact committed PREPARED lifecycle authority',
      'Grants no real-money or production capability',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('uses DB time, binds REQUESTED request and safe evidence, and grants no lifecycle DML', () => {
    for (const token of [
      'occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()',
      'NEW.occurred_at := clock_timestamp()',
      'prepared.provider_request_sha256 <> NEW.request_sha256',
      'prepared.task_draft_id IS DISTINCT FROM NEW.task_draft_id',
      'prepared.task_id IS DISTINCT FROM NEW.task_id',
      'prepared.work_order_id IS DISTINCT FROM NEW.work_order_id',
      'prepared.related_operation_id IS DISTINCT FROM NEW.related_operation_id',
      'prepared.amount_cents IS DISTINCT FROM NEW.amount_cents',
      'prepared.currency IS DISTINCT FROM NEW.currency',
      "'NAMED_OPERATOR', 'SERVICE_PRINCIPAL', 'PARTICIPANT'",
      'prepared.recorded_by IS DISTINCT FROM NEW.recorded_actor_id',
      "NEW.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT'",
      'PREPARED and REQUESTED do not authorize provider I/O or lifecycle DML',
      'DISPATCH_ATTEMPTED',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toContain(
      'CREATE TRIGGER task_financial_security_events_prepared_authority_guard'
    );
  });

  it('keeps the dependency-bound tail runner-owned and out of foundational baselines', () => {
    for (const baseline of [constitutional, launch]) {
      for (const postBaselineSql of [
        ...registeredPostBaselineTailMigrations,
        nonproductionPostEngineFixture,
      ]) {
        expect(baseline).not.toContain(postBaselineSql.trim());
      }
      expect(baseline).not.toContain('universal_v1_prepared_financial_commands');
      expect(baseline).not.toContain('provider_event_processing_state');
      expect(baseline).not.toContain('financial_provider_command_recovery_leases');
    }
    expect(migrationDocs).toContain(
      'clean-install baselines intentionally stop before the dependency-bound registered `20260918`-`20261008` tail'
    );
    expect(migrationDocs).toContain(
      'ordered 142-entry migration runner applies that exact seventeen-migration tail after its engine prerequisites'
    );
    expect(migrationDocs).toContain(
      '`20260921_universal_v1_fake_financial_lifecycle_bridge_v1`, `20260922_universal_v1_fake_terminal_lifecycle_intent_v1`, `20260926_universal_v1_change_order_three_phase_v1`, `20260927_universal_v1_change_order_recovery_v1`, and `20261002_universal_v1_dispute_fake_release_gate_v8` remain outside both foundational baselines and `REQUIRED_MIGRATION_FILES`'
    );
  });

  it('documents the Work Order and fake post-completion paths while preserving exact holds', () => {
    expect(financialApplicationSource).toContain(
      'UNIVERSAL_FINANCE_CALLER_OWNED_TRANSACTION_PREPARED_AUTHORITY_REFUSED'
    );
    for (const token of [
      'UniversalV1WorkOrderApplication',
      'UniversalV1ChangeOrderApplication',
      'UniversalV1FulfillmentApplication',
      'commits one single-winner command witness',
      'Crash replay reads the exact durable event and outcome',
      'proves the exact secured-event bridge',
      'exercises both `SETTLED` and `FULL_REFUND` terminal paths',
      'Fixture v6 gives `PRICE_AND_SCOPE` a commit-before-I/O sequence',
      'exact compensating `REVERSAL`',
      'Generic `INGEST_WEBHOOK` is not a canonical causal provider observation',
      'canonical append-only double-entry ledger',
      'No approved real-provider adapter exists',
    ]) {
      expect(migrationDocs).toContain(token);
    }
  });
});
