import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260718_business_operations_contract.sql'),
  'utf8',
);

describe('business operations database contract', () => {
  it('models enforceable budget, purchase, approval, and spend evidence', () => {
    for (const object of [
      'business_budget_policies', 'business_approval_requests',
      'business_approval_decisions', 'business_spend_ledger',
    ]) expect(sql).toContain(object);
    for (const field of [
      'per_task_cap_cents', 'monthly_cap_cents', 'auto_approve_limit_cents',
      'po_required', 'cost_center_required', 'policy_snapshot',
    ]) expect(sql).toContain(field);
    expect(sql).toContain('request_business_spend');
    expect(sql).toContain('decide_business_approval');
  });

  it('models provider catalog, coverage, capacity, crew, credentials, and proof recipes', () => {
    for (const object of [
      'business_service_profiles', 'business_service_crew_assignments', 'business_credentials',
    ]) expect(sql).toContain(object);
    for (const field of [
      'service_exclusions', 'booking_questions', 'coverage_postal_codes',
      'weekly_capacity_slots', 'blackout_dates', 'pricing_mode', 'response_mode',
      'proof_checklist',
    ]) expect(sql).toContain(field);
  });

  it('keeps provider activation server-derived and fail-closed', () => {
    expect(sql).toContain('activate_business_service_profile');
    for (const blocker of [
      'PROVIDER_MODE_DISABLED', 'LEGAL_ENTITY_NOT_VERIFIED', 'PAYOUT_NOT_ACTIVE',
      'COVERAGE_REQUIRED', 'CAPACITY_REQUIRED', 'ELIGIBLE_CREW_REQUIRED',
      'INVALID_PRICE_CORRIDOR', 'PROOF_RECIPE_REQUIRED', 'CREDENTIALS_NOT_MET',
    ]) expect(sql).toContain(blocker);
  });

  it('makes approvals, spend, and activation witnesses append-only', () => {
    expect(sql).toContain('prevent_business_operations_audit_mutation');
    expect(sql).toContain('business_approval_decision_immutable');
    expect(sql).toContain('business_spend_ledger_immutable');
    expect(sql).toContain('business_service_activation_events');
  });

  it('revokes public execution of every authority-changing function', () => {
    for (const fn of [
      'upsert_business_budget_policy', 'request_business_spend',
      'decide_business_approval', 'create_business_service_profile',
      'activate_business_service_profile',
    ]) expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}`, 'i'));
  });
});
