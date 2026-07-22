import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260718_recurring_work_contract.sql'),
  'utf8',
);

describe('recurring work database contract', () => {
  it('stores the complete versioned template contract', () => {
    for (const field of [
      'client_principal_type', 'client_principal_id', 'template_lineage_id',
      'current_revision_id', 'region_code', 'service_window_start',
      'service_window_end', 'expected_duration_minutes', 'corridor_minimum_cents',
      'corridor_maximum_cents', 'maximum_adjustment_cents', 'license_requirements',
      'insurance_requirements', 'required_tools', 'required_vehicle',
      'completion_checklist', 'backup_worker_ids', 'cancellation_rules',
      'holiday_rules', 'budget_cap_cents', 'approver_id', 'escalation_rules',
      'invoice_grouping', 'next_review_date',
    ]) expect(sql).toContain(field);
    expect(sql).toContain('recurring_task_template_revisions');
    expect(sql).toMatch(/UNIQUE\s*\(template_id, version\)/i);
  });

  it('makes every occurrence a distinct canonical task and money boundary', () => {
    expect(sql).toMatch(/task_id UUID[^;]+REFERENCES tasks\(id\)/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]+recurring_task_occurrences\(task_id\)/i);
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]+recurring_task_occurrences\(series_id, scheduled_date\)/i);
    expect(sql).toContain('template_revision_id');
    expect(sql).toContain('customer_total_cents');
    expect(sql).toContain('provider_payout_cents');
    expect(sql).toContain('platform_margin_cents');
  });

  it('encodes every mandatory pause reason and blocks generation while paused', () => {
    for (const reason of [
      'PRICE_CORRIDOR_REPEATED', 'PROVIDER_FAILURE_REPEATED', 'BUDGET_WOULD_EXCEED',
      'CREDENTIAL_EXPIRED', 'LOCATION_CLOSED', 'RECENT_DISPUTE',
      'MATERIAL_SCOPE_CHANGE', 'FULFILLMENT_ATTEMPTS_EXHAUSTED',
    ]) expect(sql).toContain(reason);
    expect(sql).toContain('evaluate_recurring_template_safeguards');
    expect(sql).toContain('enforce_recurring_occurrence_generation_gate');
    expect(sql).toContain('recurring_template_pause_events');
  });

  it('requires authorized recovery evidence and keeps audit events append-only', () => {
    expect(sql).toContain('recover_recurring_template');
    expect(sql).toContain('recovery_revision');
    expect(sql).toContain('prevent_recurring_audit_mutation');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.recover_recurring_template/i);
  });

  it('keeps blackout and end-date schedule exceptions immutable', () => {
    expect(sql).toContain('recurring_schedule_exceptions');
    expect(sql).toContain("reason IN ('BLACKOUT_DATE','END_DATE_REACHED')");
    expect(sql).toContain('recurring_schedule_exception_immutable');
    expect(sql).toContain('generation_key TEXT NOT NULL UNIQUE');
  });

  it('encrypts exact location and access instructions instead of storing them publicly', () => {
    for (const field of [
      'location_ciphertext', 'location_nonce', 'location_auth_tag', 'location_key_id',
      'access_ciphertext', 'access_nonce', 'access_auth_tag', 'access_key_id',
    ]) expect(sql).toContain(field);
  });
});
