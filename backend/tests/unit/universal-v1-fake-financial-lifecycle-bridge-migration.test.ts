import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';

const fileName = '20260921_universal_v1_fake_financial_lifecycle_bridge_v1.sql';
const migration = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations', fileName),
  'utf8'
);

describe('Universal V1 fake financial lifecycle bridge migration', () => {
  it('is a separate post-engine nonproduction fixture, never a production engine migration', () => {
    expect(REQUIRED_MIGRATION_FILES).toHaveLength(128);
    expect(REQUIRED_MIGRATION_FILES.at(-1)).toEqual({
      name: '20260920_financial_provider_command_recovery_v1',
      fileName: '20260920_financial_provider_command_recovery_v1.sql',
    });
    expect(REQUIRED_MIGRATION_FILES.some((entry) => entry.fileName === fileName)).toBe(false);
    for (const token of [
      'belongs after both the',
      'ordered engine migration chain and fake-provider v3',
      'must never be placed',
      'in the production engine registry',
      "to_regclass('public.hxos_fake_financial_schema_evidence_v3') IS NULL",
      'canonical engine chain and nonproduction fake-provider v3 must be installed first',
      'hxos_fake_financial_schema_evidence_v4',
      "migration_name = '20260921_universal_v1_fake_financial_lifecycle_bridge_v1'",
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('makes the existing Work Order witness a single-winner Phase-A claim', () => {
    for (const token of [
      'task_work_order_command_requests_task_single_winner_uidx',
      'ON public.task_work_order_command_requests(task_id)',
      'task_work_order_command_requests_hold_single_winner_uidx',
      'ON public.task_work_order_command_requests(conditional_hold_id)',
      'existing Work Order task claims are not single-winner',
      'existing Work Order hold claims are not single-winner',
      'Phase-A Work Order claim',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('joins each immutable authority fact exactly once', () => {
    for (const token of [
      'universal_v1_fake_financial_lifecycle_bridges',
      'prepared_command_id UUID NOT NULL UNIQUE',
      'command_id UUID NOT NULL UNIQUE',
      'dispatch_attempt_id UUID NOT NULL UNIQUE',
      'outcome_fact_id UUID NOT NULL UNIQUE',
      'fake_operation_event_id UUID NOT NULL UNIQUE',
      'task_financial_security_event_id UUID NOT NULL UNIQUE',
      'universal_v1_prepared_financial_commands(prepared_command_id)',
      'financial_provider_command_journal(command_id)',
      'financial_provider_command_dispatch_attempts(dispatch_attempt_id)',
      'financial_provider_command_outcome_facts(outcome_fact_id)',
      'hxos_fake_financial_operation_events_v1(event_id)',
      'task_financial_security_events(id)',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('requires the complete committed fake-only authority chain', () => {
    for (const token of [
      "prepared.command_state <> 'PREPARED'",
      "requested.command_state <> 'REQUESTED'",
      "prepared.provider_kind <> 'FAKE'",
      "requested.provider_kind <> 'FAKE'",
      'requested.prepared_financial_command_id IS DISTINCT FROM prepared.prepared_command_id',
      'requested.prepared_authority_sha256 IS DISTINCT FROM prepared.authority_context_sha256',
      'attempted.request_sha256 IS DISTINCT FROM requested.request_sha256',
      'lifecycle bridge requires the latest dispatch attempt',
      "outcome.outcome_kind <> 'OUTCOME_OBSERVED'",
      'outcome.retryable IS TRUE',
      'one terminal exact OUTCOME_OBSERVED fact',
      'fake_event.provider_request_sha256 IS DISTINCT FROM requested.request_sha256',
      'fake_event.identity_sha256 IS DISTINCT FROM fake_operation.identity_sha256',
      'outcome.provider_result_sha256 IS DISTINCT FROM expected_provider_result_sha256',
      'raw fake-provider event is not the exact terminal command result',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('binds exact operation, version, value, related-operation, and lifecycle identity', () => {
    for (const token of [
      'fake_operation_id',
      'fake_operation_kind',
      'fake_event_version',
      'fake_provider_state',
      'lifecycle_event_kind',
      'lifecycle_status',
      'provider_expected_version',
      'lifecycle_expected_version',
      'fake_event.event_version IS DISTINCT FROM requested.provider_expected_version + 1',
      'outcome.provider_result_version IS DISTINCT FROM fake_event.event_version',
      'fake_event.amount_cents IS DISTINCT FROM prepared.amount_cents',
      'upper(fake_event.currency) IS DISTINCT FROM prepared.currency',
      'fake_event.related_operation_id IS DISTINCT FROM prepared.related_operation_id',
      'lifecycle.operation_id IS DISTINCT FROM prepared.operation_id::TEXT',
      'lifecycle.expected_version IS DISTINCT FROM prepared.lifecycle_expected_version',
      'related operation is not the exact lifecycle predecessor',
    ]) {
      expect(migration).toContain(token);
    }
  });

  it('derives and preserves exact safe hashes without raw request or provider secrets', () => {
    for (const token of [
      'prepared_authority_sha256',
      'provider_request_sha256',
      'command_identity_sha256',
      'dispatch_attempt_identity_sha256',
      'outcome_identity_sha256',
      'fake_operation_identity_sha256',
      'fake_event_request_sha256',
      'fake_event_response_sha256',
      'external_reference_sha256',
      'lifecycle_event_identity_sha256',
      'authority_chain_sha256',
      'HUSTLEXP_UNIVERSAL_V1_FAKE_FINANCIAL_LIFECYCLE_BRIDGE_V1',
      'zero digest cannot establish lifecycle authority',
      'ADD COLUMN IF NOT EXISTS provider_request_sha256 CHAR(64)',
      'The original fake-event request_sha256 is the adapter\'s expanded internal',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(/\brequest_payload\s+(?:BYTEA|JSONB|TEXT)\b/iu);
    expect(migration).not.toMatch(/\bprovider_payload\s+(?:BYTEA|JSONB|TEXT)\b/iu);
    expect(migration).not.toMatch(/\bpayment_method_reference\s+/iu);
    expect(migration).not.toMatch(/\bprovider_account_reference\s+/iu);
  });

  it('requires bridge materialization in the lifecycle transaction without backfilling history', () => {
    for (const token of [
      'CREATE CONSTRAINT TRIGGER universal_v1_controlled_fake_lifecycle_bridge_required',
      'AFTER INSERT ON public.task_financial_security_events',
      'DEFERRABLE INITIALLY DEFERRED',
      "NEW.provider_kind <> 'FAKE'",
      "task.automation_classification = 'CONTROLLED_TEST'",
      'bridge.task_financial_security_event_id = NEW.id',
      'requires its exact bridge in the same transaction',
      'applies only to lifecycle rows inserted after this migration; historical',
      'evidence is not rewritten or retrospectively required to have a bridge',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(
      /INSERT\s+INTO\s+public\.universal_v1_fake_financial_lifecycle_bridges\s+SELECT/iu
    );
    expect(migration).not.toMatch(/UPDATE\s+public\.task_financial_security_events\s+SET/iu);
  });

  it('is append-only, controlled-test-only, and grants no approved-provider path', () => {
    for (const token of [
      'fake financial lifecycle bridges are append-only',
      'BEFORE UPDATE OR DELETE',
      'BEFORE TRUNCATE',
      "task.universal_contract_version = 1",
      "task.automation_classification = 'CONTROLLED_TEST'",
      'task.worker_id IS NULL',
      'APPROVED_PROVIDER remains deliberately unsupported',
      'grants no provider, payment, assignment, deployment, or',
      'REVOKE ALL ON TABLE public.universal_v1_fake_financial_lifecycle_bridges FROM PUBLIC',
    ]) {
      expect(migration).toContain(token);
    }
    expect(migration).not.toMatch(/provider_kind\s*=\s*'APPROVED_PROVIDER'/iu);
  });
});
