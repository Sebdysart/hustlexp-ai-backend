import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');

describe('engine automation production container contract', () => {
  it('packages the required migration and enters through the fail-closed start command', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain(
      'COPY --from=builder /app/backend/database/migrations/20260710_engine_automation_contracts.sql ./backend/database/migrations/20260710_engine_automation_contracts.sql',
    );
    expect(dockerfile).toContain(
      'COPY --from=builder /app/backend/database/migrations/011-proof-alignment.sql ./backend/database/migrations/011-proof-alignment.sql',
    );
    expect(dockerfile).toContain(
      'COPY --from=builder /app/backend/database/migrations/expertise_supply_control.sql ./backend/database/migrations/expertise_supply_control.sql',
    );
    expect(dockerfile).toContain('CMD ["npm", "start"]');
    expect(dockerfile).toContain('20260721_ai_observability_contract.sql');
  });

  it('applies the migration before both web and worker runtimes', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toMatch(/engine-automation-migration/);
    expect(pkg.scripts.start).toContain('SERVICE_ROLE');
    expect(pkg.scripts.start).toContain('node dist/backend/src/jobs/workers.js');
    expect(pkg.scripts.start).toContain('node dist/backend/src/server.js');
    expect(pkg.scripts['start:workers']).toMatch(/engine-automation-migration.+&& node dist\/backend\/src\/jobs\/workers\.js/);

    const procfile = read('Procfile');
    expect(procfile).toContain('web: npm start');
    expect(procfile).toContain('worker: npm run start:workers');
  });

  it('keeps the API as the default role and makes worker health role-aware', () => {
    const dockerfile = read('Dockerfile');
    expect(dockerfile).toContain("process.env.SERVICE_ROLE==='worker'");
    expect(dockerfile).toContain("require('http').get('http://localhost:3000/health'");

    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.start).toContain('else node dist/backend/src/server.js');
  });

  it('pins every canonical E2-E5 persistence witness in the packaged SQL', () => {
    const sql = read('backend/database/migrations/20260710_engine_automation_contracts.sql');
    for (const table of [
      'task_create_requests',
      'task_location_vault',
      'task_reservations',
      'task_reservation_requests',
      'task_dispatch_expiry_requests',
      'task_completion_delivery_events',
      'task_unattended_completion_requests',
      'engine_automation_events',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
  });

  it('packages the pending PaymentIntent cancellation repair', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260712_dispatch_expiry_pending_payment_cancel.sql');
    expect(dockerfile).toContain('20260712_dispatch_expiry_pending_payment_cancel.sql');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS payment_intent_canceled_at');
    expect(migration).toContain("'financial_action', 'cancel_pending_payment_intent'");
    expect(migration).toContain("'dispatch-expiry-cancel:' || t.id::text");
  });

  it('packages the no-provider-payment expiry reconciliation', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260712_dispatch_expiry_no_payment_reconcile.sql');
    expect(dockerfile).toContain('20260712_dispatch_expiry_no_payment_reconcile.sql');
    expect(migration).toContain("refund_state = 'NOT_REQUIRED'");
    expect(migration).toContain("refund_blocker = 'BLOCKED_PENDING_ESCROW_CANCELLATION'");
    expect(migration).toContain('stripe_payment_intent_id IS NULL');
    expect(migration).toContain('stripe_refund_id IS NULL');
  });

  it('packages the canonical performance-index alignment', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260713_performance_indexes_alignment.sql');
    expect(dockerfile).toContain('20260713_performance_indexes_alignment.sql');
    expect(migration).toContain('ON xp_ledger(user_id, awarded_at DESC)');
    expect(migration).not.toContain('ON xp_ledger(user_id, created_at DESC)');
    expect(migration).toContain('ON notifications(user_id, read_at) WHERE read_at IS NULL');
    expect(migration).not.toContain('is_read');
  });

  it('packages the append-only fail-closed revenue audit rail', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_revenue_audit_rail.sql');
    expect(dockerfile).toContain('20260718_revenue_audit_rail.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS revenue_ledger');
    expect(migration).toContain('stripe_event_id TEXT UNIQUE');
    expect(migration).toContain('CREATE TRIGGER revenue_ledger_no_update');
    expect(migration).toContain('CREATE OR REPLACE VIEW revenue_task_contribution');
    expect(migration).toContain('ELSE NULL');
  });

  it('packages chargeback freezes and append-only card-dispute history', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/chargeback_lifecycle.sql');
    expect(dockerfile).toContain('chargeback_lifecycle.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS payment_disputes');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS payouts_locked');
    expect(migration).toContain('CREATE TRIGGER escrow_payout_freeze_guard');
    expect(migration).toContain("USING ERRCODE = 'HX811'");
  });

  it('packages the canonical quote-economics contract', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_quote_economics_contract.sql');
    expect(dockerfile).toContain('20260718_quote_economics_contract.sql');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS hustler_payout_cents INTEGER');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS platform_margin_cents INTEGER');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS platform_fee_cents INTEGER');
    expect(migration).toContain('hustler_payout_cents + platform_margin_cents = price');
  });

  it('persists gross, insurance, and net worker economics before acceptance', () => {
    const migration = read('backend/database/migrations/20260719_lifecycle_service_foundations.sql');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS insurance_adjustment_cents INTEGER');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS net_payout_cents INTEGER');
  });

  it('packages immutable scope and encrypted exact-location contracts', () => {
    const dockerfile = read('Dockerfile');
    const scope = read('backend/database/migrations/20260718_task_scope_versions.sql');
    const location = read('backend/database/migrations/20260718_task_location_encryption.sql');
    expect(dockerfile).toContain('20260718_task_scope_versions.sql');
    expect(dockerfile).toContain('20260718_task_location_encryption.sql');
    expect(scope).toContain('CREATE TABLE IF NOT EXISTS task_scope_versions');
    expect(scope).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(location).toContain('location_ciphertext TEXT');
    expect(location).toContain('CREATE TRIGGER task_location_expire_terminal');
  });

  it('packages retry-safe proof submission witnesses', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_proof_submission_atomicity.sql');
    expect(dockerfile).toContain('20260718_proof_submission_atomicity.sql');
    expect(migration).toContain('client_submission_id TEXT');
    expect(migration).toContain('submission_hash CHAR(64)');
    expect(migration).toContain('proofs_task_client_submission_uniq');
  });

  it('packages task safety cases and orthogonal contact-delivery evidence', () => {
    const dockerfile = read('Dockerfile');
    const cases = read('backend/database/migrations/20260718_task_safety_incident_cases.sql');
    const delivery = read('backend/database/migrations/20260718_task_safety_delivery_contract.sql');
    expect(dockerfile).toContain('20260718_task_safety_incident_cases.sql');
    expect(dockerfile).toContain('20260718_task_safety_delivery_contract.sql');
    expect(cases).toContain('CREATE TABLE IF NOT EXISTS task_safety_incidents');
    expect(cases).toContain('task_safety_events_no_update');
    expect(delivery).toContain('request_hash CHAR(64)');
    expect(delivery).toContain('task_safety_provider_event_uniq');
    expect(delivery).toContain("SET delivery_state = 'received'");
  });

  it('packages durable timed safety check-ins and overdue escalation evidence', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_task_safety_checkins.sql');
    expect(dockerfile).toContain('20260718_task_safety_checkins.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_safety_checkins');
    expect(migration).toContain('task_safety_checkins_one_active');
    expect(migration).toContain('task_safety_incidents_source_checkin_uniq');
    expect(migration).toContain("status IN ('active', 'confirmed', 'escalated')");
    expect(migration).toContain('task_safety_checkin_events_no_update');
    expect(migration).toContain('HX816: invalid safety check-in transition');
  });

  it('packages encrypted expiring safety location evidence and append-only access logs', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_task_safety_location_encryption.sql');
    expect(dockerfile).toContain('20260718_task_safety_location_encryption.sql');
    expect(migration).toContain('location_ciphertext TEXT');
    expect(migration).toContain('task_safety_location_evidence_ck');
    expect(migration).toContain('location_legacy_unverified = TRUE');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_safety_location_access_log');
    expect(migration).toContain('task_safety_location_access_no_update');
    expect(migration).toContain('HX818: safety location access logs are append-only');
  });

  it('packages the fail-closed zone-category liquidity authority', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_zone_category_liquidity_cells.sql');
    expect(dockerfile).toContain('20260718_zone_category_liquidity_cells.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS zone_category_cells');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS zone_category_cell_events');
    expect(migration).toContain('zone_category_cell_events_immutable');
    expect(migration).toContain('task_liquidity_cell_accept_gate');
    expect(migration).toContain('HXLC4: liquidity cell decision is stale');
    expect(migration).toContain('average_contribution_cents <= 0');
  });

  it('packages the worker offer-decision and appeal evidence contract', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_worker_offer_decision_contract.sql');
    expect(dockerfile).toContain('20260718_worker_offer_decision_contract.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS worker_offer_decisions');
    expect(migration).toContain('paid_promotion_affects_rank = FALSE');
    expect(migration).toContain('passing_has_rank_penalty = FALSE');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS worker_decision_appeals');
    expect(migration).toContain('worker_offer_events_immutable');
  });

  it('packages worker screening rights with consent and adverse-action database gates', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_worker_screening_rights_contract.sql');
    expect(dockerfile).toContain('20260718_worker_screening_rights_contract.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS background_checks');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS worker_screening_consents');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS worker_screening_disputes');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS worker_screening_appeals');
    const legacyResultRepair = migration.indexOf('ADD COLUMN IF NOT EXISTS result TEXT');
    const legacyResultBackfill = migration.indexOf(
      'result_summary = COALESCE(result_summary, result)'
    );
    expect(legacyResultRepair).toBeGreaterThanOrEqual(0);
    expect(legacyResultRepair).toBeLessThan(legacyResultBackfill);
    expect(migration).toContain('HXWS2: a new screening check requires explicit consent');
    expect(migration).toContain('HXWS5: final adverse action requires delivered report, rights notice, and elapsed review window');
    expect(migration).toContain('HXWS6: final adverse action is blocked while a dispute is open');
  });

  it('packages lifecycle service foundations required by fresh deployments', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260719_lifecycle_service_foundations.sql');
    expect(dockerfile).toContain('20260719_lifecycle_service_foundations.sql');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS is_minor');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS payouts_enabled');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS license_verifications');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS insurance_verifications');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS ai_agent_decisions');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS alpha_telemetry');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS xp_reward');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS instant_mode');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS sensitive');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS template_slug');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS matched_at');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS progress_updated_at');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS progress_by');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS surge_level');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS surge_multiplier');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS asap_bump_count');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS trust_tier_required');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS payment_method');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS trust_multiplier');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS live_mode_multiplier');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS surge_multiplier');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS worker_payout_settings');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS escrow_events');
    expect(migration).toContain('CREATE OR REPLACE FUNCTION prevent_escrow_terminal_mutation()');
    expect(migration).toContain("USING ERRCODE = 'HX002'");
    expect(migration).toContain('CREATE OR REPLACE FUNCTION prevent_escrow_amount_change()');
    expect(migration).toContain("USING ERRCODE = 'HX004'");
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS verification_earnings_ledger');
    expect(migration).toContain('NEW.user_id,NEW.cumulative_earnings_after_cents');
  });

  it('packages the immutable fail-closed region policy contract', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_region_policy_contract.sql');
    expect(dockerfile).toContain('20260718_region_policy_contract.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS region_policies');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS region_policy_events');
    expect(migration).toContain('production_enabled BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain('CREATE TRIGGER task_region_policy_binding');
    expect(migration).toContain('HXRP6: region policy binding is immutable');
  });

  it('packages transaction-linked structured review and rebook retention gates', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_completion_retention_contract.sql');
    expect(dockerfile).toContain('20260718_completion_retention_contract.sql');
    expect(migration).toContain('structured_feedback JSONB');
    expect(migration).toContain('CREATE TRIGGER task_retention_binding_gate');
    expect(migration).toContain('HXRT5: rebook cannot clone an assignment');
    expect(migration).toContain('HXRT8: rebook retention binding is immutable');
  });

  it('packages public clarification and Poster-approved repricing gates', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_task_public_clarifications.sql');
    expect(dockerfile).toContain('20260718_task_public_clarifications.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_public_questions');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS task_clarification_revisions');
    expect(migration).toContain('task_clarification_accept_gate');
    expect(migration).toContain('HXCL9: unresolved public clarification blocks acceptance');
  });

  it('packages category-specific marketplace reputation without blending local recommendations', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_marketplace_reputation_contract.sql');
    expect(dockerfile).toContain('20260718_marketplace_reputation_contract.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS local_provider_recommendations');
    expect(migration).toContain('CREATE OR REPLACE VIEW provider_reputation_public');
    expect(migration).toContain('FALSE AS blended_into_verified_score');
    expect(migration).toContain('HXREP2: active verified-local membership is required');
  });

  it('packages the versioned fail-closed recurring work contract', () => {
    const dockerfile = read('Dockerfile');
    const migration = read('backend/database/migrations/20260718_recurring_work_contract.sql');
    expect(dockerfile).toContain('20260718_recurring_work_contract.sql');
    expect(migration).toContain('CREATE TABLE IF NOT EXISTS recurring_task_template_revisions');
    expect(migration).toContain('enforce_recurring_occurrence_generation_gate');
    expect(migration).toContain('recover_recurring_template');
    expect(migration).toContain('RECENT_DISPUTE');
  });
});
