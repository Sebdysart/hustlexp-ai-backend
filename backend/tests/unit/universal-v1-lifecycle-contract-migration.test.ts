import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrationPath = resolve(
  process.cwd(),
  'backend/database/migrations/20260827_universal_v1_lifecycle_contract.sql',
);
const sql = readFileSync(migrationPath, 'utf8');
const migrationRegistry = readFileSync(
  resolve(process.cwd(), 'backend/src/jobs/engine-automation-migration-files.ts'),
  'utf8',
);

describe('Universal V1 lifecycle database contract', () => {
  it('registers the lifecycle before later authority rails and leaves transaction ownership to the runner', () => {
    expect(migrationRegistry).toContain("name: '20260827_universal_v1_lifecycle_contract'");
    expect(migrationRegistry).toContain(
      "fileName: '20260827_universal_v1_lifecycle_contract.sql'",
    );
    expect(migrationRegistry.indexOf("name: '20260827_universal_v1_lifecycle_contract'"))
      .toBeLessThan(migrationRegistry.indexOf("name: '20260828_operator_authority_contract'"));
    expect(sql).not.toMatch(/^\s*(?:BEGIN|COMMIT);\s*$/gimu);
  });

  it('version-gates legacy rows and makes official trade qualification authoritative', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS provider_class TEXT;');
    expect(sql).not.toContain(
      "provider_class TEXT NOT NULL DEFAULT 'GENERAL_SERVICE_PROVIDER'",
    );
    expect(sql).toContain('(universal_contract_version = 0 AND provider_class IS NULL)');
    for (const field of [
      'issuing_authority',
      'jurisdiction_code',
      'license_scope',
      'status AS license_status',
      'expires_at',
      'evidence_hash',
      'credential_evidence',
      'verified_at',
      'official_source_checked_at',
      'permitted_work_categories',
    ]) {
      expect(sql).toContain(field);
    }
    expect(sql).toContain("organization.verification_status = 'VERIFIED'");
    expect(sql).toContain("organization.status = 'ACTIVE'");
    expect(sql).toContain("membership.status = 'ACTIVE'");
    expect(sql).toContain('enforce_verified_trade_projection');
    expect(sql).toContain('qualification.jurisdiction_code = task.region_code');
    expect(sql).toContain('credential-required work must use a verified trade business');
    expect(sql).toContain('Work Order materialization requires current provider membership');
    expect(sql).toContain('Universal V1 credential authority cannot be downgraded');
    expect(sql).toContain('verified trade projection authority cannot be downgraded');
  });

  it('records exactly the six Charter routing outcomes on versioned Task Drafts', () => {
    const routingBlock = sql.match(
      /CREATE TABLE IF NOT EXISTS task_routing_decisions[\s\S]*?CREATE INDEX/u,
    )?.[0];
    expect(routingBlock).toBeDefined();
    const outcomeCheck = routingBlock?.match(
      /outcome TEXT NOT NULL CHECK \(outcome IN \(([\s\S]*?)\)\),/u,
    )?.[1];
    expect(
      [...(outcomeCheck?.matchAll(/'([A-Z_]+)'/gu) ?? [])].map((match) => match[1]),
    ).toEqual([
      'FULFILLMENT_CANDIDATE',
      'ESTIMATE_REQUIRED',
      'MANUAL_SOURCING',
      'REFERRAL',
      'WAITLIST',
      'DECLINE',
    ]);
    expect(sql).toContain('routing authority requires a Universal V1 Task Draft');
    expect(sql).toContain('routing revisions must form one exact Task Draft chain');
    expect(sql).toContain('routing decision did not advance the active version');
    expect(sql).toContain('named routing decisions require scoped operations authority');
    expect(sql).toContain('operator.can_manage_operations IS TRUE');
    expect(sql).toContain(
      'Universal V1 Task Draft promotion must begin without inherited routing authority',
    );
    expect(sql).toContain(
      'BEFORE INSERT OR UPDATE OF universal_contract_version, active_routing_decision_id',
    );
  });

  it('stores a neutral immutable estimate without trusting legacy Stripe quote columns', () => {
    const estimateBlock = sql.match(
      /CREATE TABLE IF NOT EXISTS provider_estimate_submissions[\s\S]*?-- -+/u,
    )?.[0];
    expect(estimateBlock).toBeDefined();
    for (const field of [
      'scope_snapshot',
      'scope_hash',
      'line_items',
      'customer_total_cents',
      'provider_payout_cents',
      'currency',
      'payload_hash',
    ]) {
      expect(estimateBlock).toContain(field);
    }
    expect(estimateBlock).not.toMatch(/stripe_/iu);
    expect(sql).toContain('draft.active_routing_decision_id = routing.id');
    expect(sql).toContain('immutable estimate scope or payload digest mismatch');
    expect(sql).toContain('estimate submitter lacks provider authority');
  });

  it('separates interest, current eligibility, holds, Work Orders, and amendments', () => {
    expect(sql).toContain('(universal_contract_version = 0 AND authority IS NULL)');
    expect(sql).toContain("authority = 'EXPRESS_INTEREST'");
    expect(sql).toContain('eligibility revisions must form one exact provider chain');
    expect(sql).toContain('conditional hold requires current exact interest');
    expect(sql).toContain('conditional-hold identity and authority bindings are immutable');
    expect(sql).toContain('only transition once from active to released or cancelled');
    expect(sql).toContain('Universal V1 conditional hold authority cannot be downgraded');
    expect(sql).toContain('task_work_order_amendments');
    expect(sql).toContain('both parties and the exact immutable replacement scope');
    expect(sql).toContain('amendment must advance the exact prior Work Order scope by one version');
    expect(sql).toContain('Universal V1 change-order authority cannot be downgraded');
    expect(sql).toContain('price amendment requires exact successful adjustment authorization');
    expect(sql).toContain('Work Order requires the active fulfillment route');
    expect(sql).toContain('estimate-required work must bind the accepted immutable provider estimate');
    expect(sql).toContain('task.universal_contract_version = 1');
  });

  it('enforces provider-neutral money transitions and keeps payout distinct', () => {
    for (const kind of [
      'PAYMENT_METHOD_PREPARED',
      'AUTHORIZED',
      'SECURED',
      'VOIDED',
      'ADJUSTMENT_AUTHORIZED',
      'CAPTURED',
      'REFUNDED',
      'REVERSED',
      'SETTLEMENT_OBSERVED',
      'FUNDING_OBSERVED',
      'PROVIDER_RELEASED',
      'PAYOUT_OBSERVED',
      'BANK_SETTLEMENT_OBSERVED',
    ]) {
      expect(sql).toContain(`'${kind}'`);
    }
    expect(sql).toContain('financial event kind has no authorized predecessor transition');
    expect(sql).toContain('financial event chain cannot change currency');
    expect(sql).toContain('cumulative refunds cannot exceed the successful capture');
    expect(sql).toContain('retry or outcome must preserve the exact requested financial effect');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS task_financial_operations');
    expect(sql).toContain('task_financial_operation_history_idx');
    expect(sql).toContain('retry or outcome does not match its immutable operation authority');
    expect(sql).toContain('financial event must bind exact draft, task, eligibility, and authorized scope');
    expect(sql).toContain(
      'NEW.completion_fact_id IS DISTINCT FROM predecessor.completion_fact_id',
    );
    expect(sql).toContain(
      'operation.completion_fact_id IS NOT DISTINCT FROM NEW.completion_fact_id',
    );
    expect(sql).toContain('task_financial_operation_external_effect_unique');
    expect(sql).toContain('task_financial_external_effect_history_idx');
    expect(sql).toContain('task_financial_preparation_shape_check');
    expect(sql).toContain('task_financial_operation_preparation_shape_check');
    expect(sql).toContain('financial operation authority is created only with its first event');
    expect(sql).toContain("predecessor.event_kind = 'PAYMENT_METHOD_PREPARED'");
    expect(sql).toContain("NEW.event_kind = 'AUTHORIZED'");
    expect(sql).toContain('void and reversal must equal the exact authority they terminate');
    expect(sql).toContain('current approved completion, amount, safety, and delivery facts');
    expect(sql).toContain('UNIQUE (task_draft_id, expected_version)');
    expect(sql).toContain("proposal.change_order_kind = 'PRICE_AND_SCOPE'");
    expect(sql).toContain('proposal.financial_adjustment_required IS TRUE');
    expect(sql).toContain('proposal.proposed_customer_total_cents = NEW.amount_cents');
  });

  it('chains completion and reconciliation to exact current evidence and amounts', () => {
    expect(sql).toContain('completion facts must form one exact Work Order chain');
    expect(sql).toContain('a completion chain must begin with provider submission');
    expect(sql).toContain('universal_proof_snapshot_hash');
    expect(sql).toContain('proof_snapshot_hash');
    expect(sql).toContain("proof.state IN ('SUBMITTED','ACCEPTED')");
    expect(sql).toContain("proof.state = 'REJECTED'");
    expect(sql).toContain('task_completion_delivery_events delivery');
    expect(sql).toContain("incident.status NOT IN ('resolved','closed')");
    expect(sql).toContain('reconciliation revisions must form one exact Work Order chain');
    expect(sql).toContain('payout_event_id');
    expect(sql).toContain('payout_state');
    expect(sql).toContain('customer_ledger_amount_cents');
    expect(sql).toContain('provider_ledger_amount_cents');
    expect(sql).toContain('matched reconciliation amounts must equal');
    expect(sql).toContain('closed negative path must reconcile exact zero-value ledgers');
    expect(sql).toContain('event.task_draft_id IS DISTINCT FROM work_order.task_draft_id');
    expect(sql).toContain('event.task_draft_id = work_order.task_draft_id');
    expect(sql).toContain('WITH RECURSIVE authority_chain(event_id)');
    expect(sql).toContain('successor.predecessor_event_id = predecessor.event_id');
    expect(sql).toContain('void_event_id');
    expect(sql).toContain('void_state');
    expect(sql).toContain("payout_state = 'PAID'");
    expect(sql).toContain("bank_settlement_state = 'SETTLED'");
  });

  it('holds Universal V1 hard assignment and grants no money or deployment capability', () => {
    expect(sql).toContain('hard assignment remains held pending separate protected capability approval');
    expect(sql).toContain('hard assignment is denied outside the exact disposable CI database identity');
    expect(sql).toContain("current_user = 'hx_ci_runner'");
    expect(sql).toContain('BEFORE INSERT ON squad_task_workers');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF status ON squad_task_assignments');
    expect(sql).toContain('BEFORE INSERT OR UPDATE ON tasks');
    expect(sql).not.toContain(
      'BEFORE INSERT OR UPDATE OF universal_contract_version, worker_id ON tasks',
    );
    expect(sql).not.toMatch(/stripe_/iu);
    expect(sql).not.toMatch(/GRANT\s+/iu);
    expect(sql).not.toMatch(/customerMoneyCreation\s*=\s*true/iu);
    expect(sql).not.toMatch(/PRODUCTION_PAYMENT_CREATION\s*=\s*(?:true|enabled)/iu);
  });

  it('makes every new decision and lifecycle fact append-only', () => {
    for (const fact of [
      'task_scope_versions',
      'task_routing_decisions',
      'provider_estimate_submissions',
      'task_scope_change_approvals',
      'task_provider_eligibility_decisions',
      'task_financial_operations',
      'task_financial_security_events',
      'task_work_orders',
      'task_work_order_amendments',
      'task_completion_facts',
      'task_reconciliation_facts',
    ]) {
      expect(sql).toContain(`'${fact}'`);
    }
    expect(sql).toContain('BEFORE UPDATE OR DELETE');
    expect(sql).toContain('BEFORE TRUNCATE');
    expect(sql).toContain('REVOKE ALL ON TABLE');
    expect(sql).toContain('universal_active_scope_transition_guard');
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('active scope transition requires the exact dual-approved change order');
    expect(sql).toContain('submitted completion proof media is immutable');
    expect(sql).toContain('REVOKE ALL ON FUNCTION enforce_universal_task_draft_authority()');
  });
});
