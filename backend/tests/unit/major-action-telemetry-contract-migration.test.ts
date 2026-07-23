import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SQL = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260720_major_action_telemetry_contract.sql'),
  'utf8',
);
const RUNNER = [
  readFileSync(resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration.ts'), 'utf8'),
  readFileSync(
    resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration-files.ts'),
    'utf8',
  ),
].join('\n');
const DOCKERFILE = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');
const REPAIR = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260720_major_action_telemetry_contract_repair.sql'),
  'utf8',
);
const SOURCE_REPAIR = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260720_major_action_source_registry_repair.sql'),
  'utf8',
);
const POSTGRES_HARNESS = readFileSync(
  resolve(process.cwd(), 'backend/tests/integration/major-action-telemetry.pg.sql'),
  'utf8',
);

const ACTION_CLASSES = [
  'INTENT_SCOPE', 'PRICING_QUOTE', 'PAYMENT', 'DISPATCH', 'OFFER_ASSIGNMENT',
  'EXECUTION', 'PROOF_COMPLETION', 'SETTLEMENT', 'PAYOUT', 'DISPUTE', 'SAFETY',
  'TRUST_IDENTITY', 'BUSINESS_OPERATION', 'RECURRING_WORK', 'RECOMMENDATION',
  'AUTOMATION', 'NOTIFICATION', 'OFFLINE_SYNC', 'LIQUIDITY',
] as const;

describe('HX/OS major-action telemetry migration', () => {
  it('declares the closed 19-class action taxonomy', () => {
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS major_action_class_contracts');
    for (const actionClass of ACTION_CLASSES) {
      expect(SQL).toContain(`'${actionClass}'`);
    }
    expect(SQL).toContain('default_automation_class');
    expect(SQL).toContain('server_confirmation_required');
    expect(SQL).toContain('realized_outcome_required_when_terminal');
  });

  it('stores every supplied event-standard and HX/OS 24.4 field', () => {
    for (const field of [
      'schema_version', 'event_name', 'event_version', 'actor_role', 'actor_ref',
      'aggregate_type', 'aggregate_id', 'previous_lifecycle_state', 'lifecycle_state',
      'sync_state', 'entry_surface', 'context_source', 'policy_version',
      'policy_applicability', 'recommendation_id', 'model_version',
      'model_applicability', 'risk_class', 'correlation_id', 'causation_id',
      'idempotency_key', 'source_sequence', 'ordering_state', 'environment',
      'is_test', 'payload_hash', 'result', 'latency_ms', 'latency_class',
      'failure_reason_code', 'recovery_action_code', 'change_reason_code',
      'experiment_variant', 'experiment_applicability', 'reversible',
      'source_table', 'source_event_id', 'occurred_at', 'recorded_at',
    ]) {
      expect(SQL).toContain(field);
    }
  });

  it('is payload-free and purpose-separates sensitive source evidence', () => {
    const tableBody = SQL.match(/CREATE TABLE IF NOT EXISTS major_action_events \(([\s\S]*?)\n\);/)?.[1] ?? '';
    expect(tableBody).not.toMatch(/\bpayload\s+JSONB/i);
    expect(tableBody).not.toMatch(/\bmetadata\s+JSONB/i);
    expect(tableBody).not.toMatch(/\bmessage\b|\bdescription\b|\blatitude\b|\blongitude\b/i);
    expect(SQL).toContain('raw latitude and longitude excluded');
    expect(SQL).toContain('identity evidence and notice text excluded');
    expect(SQL).toContain('message, metadata, location, and evidence excluded');
    expect(SQL).toContain('provider payload excluded');
  });

  it('enforces replay, conflict, ordering, append-only, and outcome integrity', () => {
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION record_major_action_event');
    expect(SQL).toContain('HXOBS2: idempotency conflict');
    expect(SQL).toContain("ordering_state IN ('ROOT','IN_ORDER','STALE','GAP')");
    expect(SQL).toContain('RECONCILE_SEQUENCE_GAP');
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION record_major_action_outcome');
    expect(SQL).toContain('HXOBS4: realized-outcome replay conflict');
    expect(SQL).toContain('major_action_events_no_truncate');
    expect(SQL).toContain('major_action_outcomes_no_truncate');
  });

  it('wires real authoritative source tables instead of a synthetic-only ledger', () => {
    for (const source of [
      'task_scope_versions', 'escrow_events', 'worker_offer_events',
      'worker_counter_offer_events', 'engine_automation_events',
      'worker_cash_out_events', 'task_safety_incident_events',
      'task_safety_checkin_events', 'worker_screening_events',
      'worker_decision_appeal_events', 'business_audit_events',
      'business_service_activation_events', 'recurring_template_pause_events',
      'recurring_template_recovery_events', 'recommendation_events',
      'recommendation_outcomes', 'outbox_events', 'zone_category_cell_events',
      'task_external_bridge_events', 'stripe_events', 'task_geofence_events', 'disputes',
    ]) {
      expect(SQL).toContain(` ON ${source}`);
    }
    expect(SQL).toContain('CREATE TABLE IF NOT EXISTS major_action_source_registry');
    expect(SQL).toContain("WHEN v_event_type IN ('TASK_IN_PROGRESS') THEN 'EXECUTION'");
    expect(SQL).toContain("WHEN v_event_type IN ('PAYOUT_READY','POSTER_CONFIRMED_COMPLETION') THEN 'PROOF_COMPLETION'");
    expect(SQL).toContain("WHEN v_event_type IN ('TASK_EXPIRED_UNFILLED') THEN 'DISPATCH'");
    expect(SQL).toContain("WHEN v_event_type LIKE 'PAYMENT_%' THEN 'PAYMENT'");
    expect(SQL).toContain("WHEN v_event_type LIKE 'COMPLETION_MESSAGE_%' THEN 'NOTIFICATION'");
    expect(SOURCE_REPAIR).toContain("('PAYMENT','ENGINE','engine_automation_events'");
    expect(SOURCE_REPAIR).toContain("('NOTIFICATION','ENGINE','engine_automation_events'");
  });

  it('ships the migration through startup and the production image', () => {
    expect(RUNNER).toContain(
      "MAJOR_ACTION_TELEMETRY_CONTRACT_MIGRATION = '20260720_major_action_telemetry_contract'",
    );
    expect(RUNNER).toContain("fileName: '20260720_major_action_telemetry_contract.sql'");
    expect(DOCKERFILE).toContain(
      '/app/backend/database/migrations/20260720_major_action_telemetry_contract.sql',
    );
    expect(REPAIR).toContain("lifecycle_state ~ '^[A-Z0-9:_.-]{2,100}$'");
    expect(RUNNER).toContain("fileName: '20260720_major_action_telemetry_contract_repair.sql'");
    expect(DOCKERFILE).toContain(
      '/app/backend/database/migrations/20260720_major_action_telemetry_contract_repair.sql',
    );
    expect(RUNNER).toContain("fileName: '20260720_major_action_source_registry_repair.sql'");
    expect(DOCKERFILE).toContain(
      '/app/backend/database/migrations/20260720_major_action_source_registry_repair.sql',
    );
  });

  it('keeps the PostgreSQL contract repeatable by rolling back every fixture', () => {
    expect(POSTGRES_HARNESS).toMatch(/^\\set ON_ERROR_STOP on\s+BEGIN;/);
    expect(POSTGRES_HARNESS).toContain("SET LOCAL hustlexp.is_test = 'true'");
    expect(POSTGRES_HARNESS).toContain('MAJOR_ACTION_TELEMETRY_DATABASE_CONTRACT_OK');
    expect(POSTGRES_HARNESS.trimEnd()).toMatch(/ROLLBACK;$/);
  });
});
