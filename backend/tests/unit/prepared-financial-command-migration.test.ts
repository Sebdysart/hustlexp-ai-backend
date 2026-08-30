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
    resolve(
      process.cwd(),
      'backend/database/migrations/20260919_provider_event_processing_v1.sql'
    ),
    'utf8'
  ),
  readFileSync(
    resolve(
      process.cwd(),
      'backend/database/migrations/20260920_financial_provider_command_recovery_v1.sql'
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
  resolve(
    process.cwd(),
    'backend/src/services/payment/UniversalV1FinancialApplicationService.ts'
  ),
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
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(128);
    expect(journalIndex).toBeGreaterThanOrEqual(0);
    expect(preparationIndex).toBe(journalIndex + 1);
    expect(processingIndex).toBe(preparationIndex + 1);
    expect(recoveryIndex).toBe(processingIndex + 1);
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
    ]);
    expect(
      REQUIRED_MIGRATION_FILES.some(
        ({ name }) => name === '20260921_universal_v1_fake_financial_lifecycle_bridge_v1'
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
      'clean-install baselines intentionally stop before the dependency-bound registered `20260918`-`20260920` tail'
    );
    expect(migrationDocs).toContain(
      'ordered 128-entry migration runner applies that exact three-migration tail after its engine prerequisites'
    );
    expect(migrationDocs).toContain(
      '`20260921` remains outside both foundational baselines and `REQUIRED_MIGRATION_FILES`'
    );
  });

  it('documents the narrow three-phase Work Order path and keeps every other caller-owned path held', () => {
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
      'full fulfillment lifecycle therefore remains held before adapter entry',
    ]) {
      expect(migrationDocs).toContain(token);
    }
  });
});
