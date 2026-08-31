import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(resolve(process.cwd(), path), 'utf8');
const engine = read(
  'backend/database/migrations/20261002_universal_v1_dispute_recovery_v1.sql',
);
const fixture = read(
  'backend/database/migrations/20261002_universal_v1_dispute_fake_release_gate_v8.sql',
);
const service = read('backend/src/services/UniversalV1DisputeRecoveryService.ts');
const readModel = read('backend/src/services/UniversalV1DisputeReadModel.ts');
const router = read('backend/src/routers/universalV1DisputeRecovery.ts');

describe('Universal V1 dispute/recovery authority', () => {
  it('binds intake to exact current Task, Work Order, routing, completion, and execution versions', () => {
    for (const token of [
      'task_version BIGINT NOT NULL',
      'routing_decision_version INTEGER NOT NULL',
      'work_order_materialization_version INTEGER NOT NULL',
      'completion_version INTEGER NOT NULL',
      'execution_version INTEGER NOT NULL',
      'checked_expected_task_version',
      'checked_expected_work_order_version',
      'checked_expected_completion_version',
      'checked_expected_execution_version',
      'exact latest completion/execution authority mismatched',
    ]) {
      expect(engine).toContain(token);
    }
    for (const outcome of [
      'FULFILLMENT_CANDIDATE',
      'ESTIMATE_REQUIRED',
      'MANUAL_SOURCING',
      'REFERRAL',
      'WAITLIST',
      'DECLINE',
    ]) {
      expect(engine).toContain(`'${outcome}'`);
    }
    expect(engine).toContain('fact.completion_fact_id = checked_completion_fact_id');
  });

  it('keeps incident, evidence, timeline, recovery, and approval facts append-only and private', () => {
    for (const table of [
      'universal_v1_dispute_incidents',
      'universal_v1_dispute_evidence_facts',
      'universal_v1_dispute_recovery_intents',
      'universal_v1_dispute_recovery_approval_facts',
      'universal_v1_dispute_timeline_events',
    ]) {
      expect(engine).toContain(`'${table}'`);
      expect(engine).toContain('REVOKE ALL ON TABLE public.%I FROM PUBLIC');
    }
    expect(engine).toContain('prevent_universal_v1_fact_mutation()');
    expect(engine).not.toMatch(/\b(?:description|raw_input|exact_address|storage_key)\b/iu);
    expect(readModel).not.toMatch(/\b(?:raw_input|exact_address|storage_key|email)\b/iu);
    expect(readModel).toContain('rawNarrativeReturned: false');
    expect(readModel).toContain('otherPartyIdentityReturned: false');
  });

  it('enforces the bounded state machine and holds every terminal transition', () => {
    for (const state of [
      'OPEN',
      'UNDER_REVIEW',
      'RESOLUTION_PROPOSED',
      'RESOLVED',
      'DISMISSED',
    ]) {
      expect(engine).toContain(`'${state}'`);
    }
    expect(engine).toContain("prior.to_state <> 'OPEN' OR NEW.to_state <> 'UNDER_REVIEW'");
    expect(engine).toContain("prior.to_state <> 'UNDER_REVIEW'");
    expect(engine).toContain("NEW.to_state IN ('RESOLVED', 'DISMISSED')");
    expect(engine).toContain('terminal dispute authority is held pending caller-attested');
    expect(service).toContain(
      "terminalTransitions: 'HELD_PENDING_DEDICATED_CALLER_ATTESTED_COMMAND_ROLE'",
    );
    expect(router).not.toMatch(/\b(?:resolve|dismiss|executeRecovery)\s*:/u);
  });

  it('represents provider-neutral recovery only as typed held intents', () => {
    for (const kind of ['REFUND', 'REVERSAL', 'REWORK', 'REPLACEMENT', 'CANCEL', 'NO_EFFECT']) {
      expect(engine).toContain(`'${kind}'`);
    }
    expect(engine).toContain('HELD_TWO_PERSON_DATABASE_CALLER_UNATTESTED');
    expect(engine).toContain('recovery.proposed_by_user_id = NEW.actor_user_id');
    expect(engine).toContain('recovery.proposed_by_user_id = checked_actor_user_id');
    expect(service).toContain('effectCreated: false as const');
    expect(service).toContain('terminalTransitionCreated: false as const');
  });

  it('structurally blocks closure and every canonical release/payout authority edge', () => {
    for (const table of [
      'task_completion_facts',
      'task_work_order_execution_facts',
      'task_reconciliation_facts',
      'universal_v1_prepared_financial_commands',
      'financial_provider_command_journal',
      'task_financial_security_events',
    ]) {
      expect(engine).toContain(`ON public.${table}`);
    }
    expect(engine).toContain("NEW.reconciliation_state IN ('MATCHED', 'CLOSED')");
    expect(engine).toContain("NEW.operation_kind NOT IN ('PROVIDER_RELEASE', 'PAYOUT')");
    expect(engine).toContain("NEW.event_kind NOT IN ('PROVIDER_RELEASED', 'PAYOUT_OBSERVED')");
    expect(engine).toContain('work_order.id = task.work_order_id');
    expect(engine).toContain('work_order.task_draft_id = NEW.task_draft_id');
    expect(engine).toContain('pg_advisory_xact_lock');
    expect(engine).toContain('universal_v1_has_open_material_dispute_v1');
  });

  it('installs engine before fake fixtures and attaches the fake terminal gate only in v8', () => {
    expect(engine).not.toMatch(
      /(?:CREATE|DROP)\s+TRIGGER[\s\S]{0,160}ON public\.universal_v1_fake_terminal_lifecycle_intents/iu,
    );
    expect(engine).not.toMatch(
      /REFERENCES\s+public\.universal_v1_fake_terminal_lifecycle_intents/iu,
    );
    expect(fixture).toContain('hxos_fake_financial_schema_evidence_v7');
    expect(fixture).toContain('hxos_fake_financial_schema_evidence_v8');
    expect(fixture).toContain('aa_universal_v1_dispute_terminal_intent_gate');
    expect(fixture).toContain('enforce_universal_v1_dispute_release_gate_v1');
  });

  it('serializes idempotency before rechecking every command', () => {
    expect(engine.match(/universal_v1_dispute_idempotency_lock_v1\(/gu)?.length).toBeGreaterThanOrEqual(7);
    expect(engine).toContain('second read is authoritative');
    expect(engine.match(/idempotency key was reused across dispute commands/gu)?.length)
      .toBeGreaterThanOrEqual(4);
    expect(engine).toContain('idempotency_replayed BOOLEAN');
    expect(engine.match(/event\.event_kind = 'OPENED'/gu)?.length).toBe(2);
    expect(engine.match(/event\.event_kind = 'EVIDENCE_ADDED'/gu)?.length).toBe(2);
    expect(engine.match(/assert_universal_v1_dispute_participant_v1\(/gu)?.length)
      .toBeGreaterThanOrEqual(8);
    expect(engine).not.toContain(
      'SELECT prior.dispute_id, current_state.dispute_state',
    );
  });

  it('hardens SECURITY DEFINER lookup and revokes every callable authority function', () => {
    const definerBlocks = [...engine.matchAll(
      /LANGUAGE\s+(?:plpgsql|sql)[^$]*SECURITY DEFINER\s+SET search_path = ([^\n]+)/giu,
    )];
    expect(definerBlocks.length).toBeGreaterThanOrEqual(8);
    for (const block of definerBlocks) expect(block[1]).toBe('pg_catalog, public AS $$');
    expect(engine).toContain("pg_catalog.encode(public.digest(pg_catalog.concat_ws(':',");
    expect(engine).toContain('CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public');
    for (const name of [
      'assert_universal_v1_dispute_participant_v1',
      'assert_universal_v1_dispute_operator_v1',
      'open_universal_v1_dispute_v1',
      'add_universal_v1_dispute_evidence_v1',
      'begin_universal_v1_dispute_review_v1',
      'propose_universal_v1_dispute_recovery_v1',
      'record_universal_v1_recovery_approval_v1',
      'universal_v1_has_open_material_dispute_v1',
      'validate_universal_v1_dispute_timeline_v1',
      'enforce_universal_v1_dispute_closure_gate_v1',
      'enforce_universal_v1_dispute_release_gate_v1',
    ]) {
      expect(engine).toContain(`FUNCTION public.${name}`);
    }
    expect(engine.match(/FROM PUBLIC;/gu)?.length).toBeGreaterThanOrEqual(13);
  });

  it('requires active-adult current participant authority for point and set reads', () => {
    expect(readModel).toContain("user.account_status !== 'ACTIVE'");
    expect(readModel).toContain('user.is_minor !== false');
    expect(service).toContain("user.account_status !== 'ACTIVE'");
    expect(service).toContain('user.is_minor !== false');
    expect(readModel).toContain("viewer.account_status = 'ACTIVE'");
    expect(readModel).toContain('viewer.is_minor IS FALSE');
    expect(readModel).toContain("membership.status = 'ACTIVE'");
    expect(readModel).toContain('assert_universal_v1_dispute_participant_v1');
    expect(readModel).toContain('assert_universal_v1_dispute_operator_v1($2)');
  });

  it('binds authenticated participant and fresh-MFA operator API surfaces without an effect route', () => {
    expect(router).toContain('open: protectedProcedure');
    expect(router).toContain('addEvidence: protectedProcedure');
    expect(router).toContain('beginReview: operationsAdminProcedure');
    expect(router).toContain('proposeRecovery: operationsAdminProcedure');
    expect(router).toContain('recordIndependentApproval: operationsAdminProcedure');
    expect(service).toContain('requireFreshOperatorIdentity(context)');
    expect(service).toContain('participantRoleRecheckedByDatabase: true');
    expect(service).toContain('databaseCallerIdentityAttested: false');
  });
});
