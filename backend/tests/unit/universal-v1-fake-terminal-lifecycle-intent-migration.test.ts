import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName = '20260922_universal_v1_fake_terminal_lifecycle_intent_v1.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);

describe('Universal V1 fake terminal lifecycle authority migration', () => {
  it('is a post-engine nonproduction fixture and never a production engine migration', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(128);
    expect(REQUIRED_MIGRATION_FILES.at(-1)).toEqual({
      name: '20260920_financial_provider_command_recovery_v1',
      fileName: '20260920_financial_provider_command_recovery_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES.some((entry) => entry.fileName === fileName)).toBe(false);
    for (const token of [
      'must never be placed in the production engine',
      "to_regclass('public.hxos_fake_financial_schema_evidence_v4') IS NULL",
      'canonical engine chain and nonproduction fake lifecycle bridge v4 must be installed first',
      'hxos_fake_financial_schema_evidence_v5',
      "migration_name = '20260922_universal_v1_fake_terminal_lifecycle_intent_v1'",
      'Production payment creation remains frozen',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('fixes the complete SETTLED and FULL_REFUND plans in immutable SQL authority', () => {
    for (const token of [
      'universal_v1_fake_terminal_plan_v1',
      'universal_v1_fake_terminal_plan_steps_v1',
      'LANGUAGE SQL',
      'IMMUTABLE',
      'STRICT',
      'PARALLEL SAFE',
      "('SETTLED'::TEXT, 1::SMALLINT, 'LIFECYCLE'::TEXT, 'CAPTURE'::TEXT, 1::SMALLINT)",
      "'SETTLE'::TEXT",
      "'FUND'::TEXT",
      "'PROVIDER_RELEASE'::TEXT",
      "'PAYOUT'::TEXT",
      "'OBSERVE_BANK_SETTLEMENT'::TEXT",
      "('SETTLED'::TEXT, 7::SMALLINT, 'RECONCILIATION'::TEXT, 'RECONCILE'::TEXT",
      "('FULL_REFUND'::TEXT, 1::SMALLINT, 'LIFECYCLE'::TEXT, 'CAPTURE'::TEXT, 1::SMALLINT)",
      "('FULL_REFUND'::TEXT, 2::SMALLINT, 'LIFECYCLE'::TEXT, 'REFUND'::TEXT, 2::SMALLINT)",
      "('FULL_REFUND'::TEXT, 3::SMALLINT, 'RECONCILIATION'::TEXT, 'RECONCILE'::TEXT",
      'derived_plan_sha256',
      'string_agg(\n               plan.step_ordinal::TEXT',
    ]) {
      expect(migration).toContain(token);
    }
    const planHelper = migration.match(
      /CREATE OR REPLACE FUNCTION public\.universal_v1_fake_terminal_plan_v1[\s\S]*?\$\$;/u
    )?.[0];
    expect(planHelper).toBeDefined();
    expect(planHelper).not.toContain('ONBOARD_PROVIDER');
    expect(planHelper).not.toContain('REFRESH_PROVIDER_ACCOUNT_STATE');
  });

  it('records one append-only intent before effects and derives its exact Work Order authority', () => {
    for (const token of [
      'universal_v1_fake_terminal_lifecycle_intents',
      'work_order_id UUID NOT NULL UNIQUE',
      'completion_fact_id UUID NOT NULL UNIQUE',
      'starting_financial_event_id UUID NOT NULL UNIQUE',
      'provider_account_fact_id UUID',
      'expected_financial_version',
      'expected_reconciliation_version',
      'completion_execution_fact_id UUID NOT NULL UNIQUE',
      'starting_financial_bridge_id UUID NOT NULL UNIQUE',
      'prior_reconciliation_fact_id UUID',
      'provider_subject_kind',
      'provider_subject_id',
      'plan_sha256',
      'authority_context_sha256',
      'validate_universal_v1_fake_terminal_lifecycle_intent',
      'task_record.universal_contract_version <> 1',
      "task_record.automation_classification <> 'CONTROLLED_TEST'",
      "task_record.universal_payment_posture <> 'PAYMENT_CREATION_FROZEN'",
      'task_record.worker_id IS NOT NULL',
      "completion.fact_kind <> 'APPROVED'",
      "fact.transition_kind = 'COMPLETION_APPROVED'",
      "fact.state = 'COMPLETED'",
      "starting_event.event_kind NOT IN ('SECURED', 'ADJUSTMENT_AUTHORIZED')",
      "starting_event.provider_kind <> 'FAKE'",
      'current_reconciliation_version <> NEW.expected_reconciliation_version',
      "(terminal_path = 'SETTLED') = (provider_account_fact_id IS NOT NULL)",
      "provider_account.account_state <> 'ENABLED'",
      'provider_account.payouts_enabled IS NOT TRUE',
      'provider_account.provider_subject_kind IS DISTINCT FROM (CASE',
      "crew_membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')",
      'newer.account_version > provider_account.account_version',
      'SETTLED intent requires the latest exact enabled provider-authored account fact before terminal execution',
      'FULL_REFUND intent cannot claim provider-account authority',
      'NEW.starting_financial_bridge_id := starting_bridge.bridge_id',
      'HUSTLEXP_UNIVERSAL_V1_FAKE_TERMINAL_INTENT_V1',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toContain('task_record.task_draft_id');
  });

  it('establishes discriminated provider-subject account readiness before terminal execution', () => {
    for (const token of [
      'universal_v1_fake_provider_account_facts',
      'provider_subject_kind TEXT NOT NULL',
      "provider_subject_kind IN ('USER', 'ORGANIZATION')",
      'provider_user_id UUID REFERENCES public.users',
      'provider_organization_id UUID',
      'account_version BIGINT NOT NULL',
      'supersedes_fact_id UUID',
      'onboard_command_id UUID NOT NULL',
      'onboard_dispatch_attempt_id UUID NOT NULL',
      'onboard_outcome_fact_id UUID NOT NULL',
      'onboard_fake_event_id UUID NOT NULL',
      'refresh_command_id UUID NOT NULL UNIQUE',
      'refresh_dispatch_attempt_id UUID NOT NULL UNIQUE',
      'refresh_outcome_fact_id UUID NOT NULL UNIQUE',
      'refresh_fake_event_id UUID NOT NULL UNIQUE',
      'provider_account_reference_sha256',
      "account_state IN ('PENDING', 'ENABLED', 'RESTRICTED', 'FAILED')",
      'charges_enabled BOOLEAN NOT NULL',
      'payouts_enabled BOOLEAN NOT NULL',
      'requirements_due_sha256',
      'recorded_by UUID NOT NULL',
      'recorded_at TIMESTAMPTZ NOT NULL',
      'materialized_at TIMESTAMPTZ NOT NULL',
      'fact_sha256 CHAR(64)',
      'authority_sha256 CHAR(64)',
      'UNIQUE NULLS NOT DISTINCT',
      'provider_subject_kind, provider_user_id, provider_organization_id, account_version',
      'universal_v1_fake_provider_account_subject_shape_chk',
      "NEW.provider_subject_kind || ':' || provider_subject_id::TEXT",
      'validate_universal_v1_fake_provider_account_fact',
      "onboard_requested.operation_kind <> 'ONBOARD_PROVIDER'",
      "refresh_requested.operation_kind <> 'REFRESH_PROVIDER_ACCOUNT_STATE'",
      "onboard_requested.provider_kind <> 'FAKE'",
      "refresh_requested.provider_kind <> 'FAKE'",
      "onboard_requested.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT'",
      "refresh_requested.recorded_actor_kind IS DISTINCT FROM 'PARTICIPANT'",
      'onboard_requested.task_draft_id',
      'onboard_requested.work_order_id',
      'refresh_requested.task_draft_id',
      'refresh_requested.work_order_id',
      "NEW.provider_subject_kind = 'USER'",
      'NEW.recorded_by IS DISTINCT FROM NEW.provider_user_id',
      "NEW.provider_subject_kind = 'ORGANIZATION'",
      "membership.role IN ('OWNER', 'ADMIN')",
      "onboard_event.metadata->>'providerId' IS DISTINCT FROM provider_subject_id::TEXT",
      "refresh_event.metadata->>'providerAccountReference'",
      'onboarding and refresh must name the same exact provider and account reference',
      'refresh_requested.recorded_at <= onboard_outcome.recorded_at',
      'provider-account refresh must be causally downstream',
      'onboard_request_without_scenario',
      'refresh_request_without_scenario',
      'provider-account commands must bind the exact subject and onboarding-created account reference',
      'derived_account_version := COALESCE(prior_fact.account_version, 0) + 1',
      'refresh_attempted.attempted_at <= prior_refresh_outcome.recorded_at',
      'provider-account refresh dispatch must be causally downstream of the latest account observation',
      'NEW.recorded_at := refresh_outcome.recorded_at',
      'caller-supplied provider-account version or current-state claim conflicts',
      'HUSTLEXP_UNIVERSAL_V1_FAKE_PROVIDER_ACCOUNT_FACT_V1',
      'HUSTLEXP_UNIVERSAL_V1_FAKE_PROVIDER_ACCOUNT_AUTHORITY_V1',
    ]) {
      expect(migration).toContain(token);
    }

    const providerAccountTable = migration.match(
      /CREATE TABLE IF NOT EXISTS public\.universal_v1_fake_provider_account_facts[\s\S]*?\n\);/u
    )?.[0];
    expect(providerAccountTable).toBeDefined();
    expect(providerAccountTable).not.toContain('terminal_intent_id');
    expect(providerAccountTable).not.toContain('operation_kind TEXT');
    expect(providerAccountTable).not.toMatch(/\bprovider_account_reference\s+TEXT\b/iu);
    expect(providerAccountTable).not.toMatch(/\bprovider_id\s+TEXT\b/iu);
    expect(providerAccountTable).not.toMatch(/onboard_[a-z_]+_id UUID NOT NULL UNIQUE/iu);
  });

  it('rejects unplanned post-Work-Order commands and rechecks both terminal paths before provider I/O', () => {
    for (const token of [
      'universal_v1_fake_terminal_operation_id_v1',
      'validate_universal_v1_fake_terminal_prepared_command',
      'zz_universal_v1_fake_terminal_prepared_command_guard',
      'BEFORE INSERT ON public.universal_v1_prepared_financial_commands',
      'controlled-test post-Work-Order provider preparation requires one exact terminal intent',
      "operation_label := 'full-refund'",
      "idempotency_suffix := ':refund'",
      "operation_label := 'bank-settlement'",
      "idempotency_suffix := ':bank-settlement'",
      'intent.starting_financial_version + expected_version_offset',
      'SETTLED preparation requires current incident, provider, and latest enabled account authority',
      'terminal preparation request digest does not match the immutable intent step',
      ',"scenario":"SUCCESS"}',
      ',"providerAccountReference":',
      ',"originalAmountCents":',
      'universal_v1_invited_provider_authority_is_current',
      'universal_v1_fake_terminal_reconciliation_snapshot_sha256_v1',
      ',"reconciliationSnapshotSha256":',
      'validate_universal_v1_fake_terminal_reconcile_command',
      'zz_universal_v1_fake_terminal_reconcile_command_guard',
      'controlled-test reconciliation requires one exact terminal intent before provider I/O',
      "intent.idempotency_key || ':reconciliation'",
      'validate_universal_v1_fake_terminal_dispatch_attempt',
      'zz_universal_v1_fake_terminal_dispatch_attempt_guard',
      'BEFORE INSERT ON public.financial_provider_command_dispatch_attempts',
      'terminal dispatch does not retain the exact PREPARED, REQUESTED, and intent authority chain',
      'terminal dispatch requires current frozen, unassigned, incident-free task and eligibility authority',
      'SETTLED dispatch requires current provider, payout, and latest enabled account authority',
      'FOR UPDATE;',
      'lock_universal_v1_estimate_authority',
      'eligibility.processor_payment_eligible IS NOT FALSE',
      'eligibility.payout_funding_eligible IS NOT FALSE',
    ]) {
      expect(migration).toContain(token);
    }

    const dispatchGuard = migration.match(
      /CREATE OR REPLACE FUNCTION public\.validate_universal_v1_fake_terminal_dispatch_attempt\(\)[\s\S]*?\n\$\$;/u
    )?.[0];
    expect(dispatchGuard).toBeDefined();
    expect(dispatchGuard?.match(/task_record\.universal_payment_posture/gu)).toHaveLength(1);
    expect(dispatchGuard?.match(/task_safety_incidents/gu)).toHaveLength(1);
    expect(dispatchGuard?.match(/eligibility\.task_eligible/gu)).toHaveLength(1);
    expect(dispatchGuard?.indexOf('terminal dispatch requires current frozen')).toBeLessThan(
      dispatchGuard?.indexOf('lock_universal_v1_estimate_authority') ?? -1
    );
  });

  it('bridges the exact provider outcome to canonical reconciliation without a synthetic intent row', () => {
    for (const token of [
      'universal_v1_fake_reconciliation_bridges',
      'terminal_intent_id UUID NOT NULL UNIQUE',
      'reconciliation_fact_id UUID NOT NULL UNIQUE',
      'provider_account_fact_id UUID',
      'terminal_lifecycle_event_id UUID NOT NULL',
      'validate_universal_v1_fake_reconciliation_bridge',
      "requested.operation_kind <> 'RECONCILE'",
      "requested.provider_kind <> 'FAKE'",
      'requested.related_operation_id IS DISTINCT FROM terminal_operation_id',
      "outcome.outcome_kind <> 'OUTCOME_OBSERVED'",
      "outcome.provider_state <> 'MATCHED'",
      "fake_event.operation_kind <> 'RECONCILE'",
      "reconciliation.evidence->>'providerState' IS DISTINCT FROM 'MATCHED'",
      "intent.terminal_path = 'SETTLED'",
      "reconciliation.reconciliation_state <> 'MATCHED'",
      "reconciliation.reconciliation_state <> 'CLOSED'",
      'SETTLED reconciliation requires the fixed exact lifecycle and enabled provider-account authority',
      'FULL_REFUND reconciliation requires the fixed exact capture/refund plan and zero ledgers',
      'universal_v1_reconciliation_snapshot_sha256_v1',
      'Keys are lexical, absent optional UUIDs are',
      "string_agg(to_jsonb(code)::TEXT, ',' ORDER BY ordinal)",
      '\'"bankSettlementEventId":\'',
      '\'"workOrderId":\'',
      "reconciliation.evidence->>'reconciliationSnapshotSha256'",
      "fake_event.metadata->>'reconciliationSnapshotSha256'",
      'IS DISTINCT FROM reconciliation_snapshot_sha256',
      'CREATE CONSTRAINT TRIGGER universal_v1_fake_reconciliation_bridge_required',
      'DEFERRABLE INITIALLY DEFERRED',
      'requires its exact terminal intent and fake bridge in the same transaction',
      'It never inserts or repurposes a task_reconciliation_facts row',
      'HUSTLEXP_UNIVERSAL_V1_FAKE_RECONCILIATION_BRIDGE_V1',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?task_reconciliation_facts/iu);
    expect(migration).not.toMatch(/UPDATE\s+(?:public\.)?task_reconciliation_facts\s+SET/iu);
  });

  it('keeps every new authority table append-only and private', () => {
    for (const token of [
      'fake terminal authority evidence is append-only',
      'universal_v1_fake_terminal_intent_no_update_delete',
      'universal_v1_fake_terminal_intent_no_truncate',
      'universal_v1_fake_provider_account_fact_no_update_delete',
      'universal_v1_fake_provider_account_fact_no_truncate',
      'universal_v1_fake_reconciliation_bridge_no_update_delete',
      'universal_v1_fake_reconciliation_bridge_no_truncate',
      'BEFORE UPDATE OR DELETE',
      'BEFORE TRUNCATE',
      'REVOKE ALL ON TABLE public.universal_v1_fake_terminal_lifecycle_intents FROM PUBLIC',
      'REVOKE ALL ON TABLE public.universal_v1_fake_provider_account_facts FROM PUBLIC',
      'REVOKE ALL ON TABLE public.universal_v1_fake_reconciliation_bridges FROM PUBLIC',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('contains no approved-provider, raw financial secret, or production capability path', () => {
    expect(migration).toContain('APPROVED_PROVIDER remains deliberately unsupported');
    expect(migration).not.toMatch(/provider_kind\s*=\s*'APPROVED_PROVIDER'/iu);
    expect(migration).not.toMatch(/\bpayment_method_reference\s+(?:BYTEA|JSONB|TEXT)\b/iu);
    expect(migration).not.toMatch(/\bprovider_payload\s+(?:BYTEA|JSONB|TEXT)\b/iu);
    expect(migration).not.toMatch(/\brequest_payload\s+(?:BYTEA|JSONB|TEXT)\b/iu);
    expect(migration).not.toMatch(/release_environment\s*=\s*'production'/iu);
  });
});
