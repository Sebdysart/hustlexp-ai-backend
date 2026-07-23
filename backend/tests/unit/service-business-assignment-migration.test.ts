import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  resolve(process.cwd(), 'backend/database/migrations/20260722_service_business_assignment_contract.sql'),
  'utf8',
);

describe('Service Business assignment database contract', () => {
  it('separates provider principal, verified fulfiller, and provider-backed payee', () => {
    for (const token of [
      'business_provider_payout_accounts',
      'business_provider_payout_link_requests',
      'business_service_task_assignments',
      'provider_organization_id',
      'provider_service_profile_id',
      'provider_assignment_id',
      'payout_recipient_user_id',
      'fulfiller_user_id',
      'offer_decision_id',
    ]) expect(sql).toContain(token);
    expect(sql).toContain('enforce_service_business_task_assignment');
    expect(sql).toContain('prevent_service_business_assignment_mutation');
  });

  it('derives payout readiness from an authorized member and live provider evidence', () => {
    expect(sql).toContain('link_business_provider_payout_account');
    expect(sql).toMatch(/business_require_action\([^;]+MANAGE_BILLING/is);
    expect(sql).toMatch(/stripe_connect_id\s+IS\s+NOT\s+NULL/i);
    expect(sql).toMatch(/payouts_enabled\s+IS\s+TRUE/i);
    expect(sql).toMatch(/v_membership\.role\s+NOT\s+IN\s+\('OWNER','ADMIN'\)/i);
    expect(sql).toContain('provider_account_fingerprint');
    expect(sql).toContain('restrict_business_payout_on_provider_change');
    expect(sql).toContain("HXSB4: prior payout link is no longer active");
    expect(sql).toMatch(/OLD\.stripe_connect_id\s+IS\s+NOT\s+DISTINCT\s+FROM\s+NEW\.stripe_connect_id/i);
    expect(sql).toMatch(/v_request\.payout_membership_id<>p_payout_membership_id[\s\S]+idempotency key payload conflict/i);
    expect(sql).toMatch(/v_account\.payout_membership_id=p_payout_membership_id[\s\S]+INSERT INTO business_provider_payout_link_requests[\s\S]+RETURN QUERY SELECT v_account\.id/i);
    expect(sql).toMatch(/event_type,evidence[\s\S]+PROVIDER_PAYOUT_REPLACED/i);
  });

  it('fails closed on inactive organizations, stale credentials, capacity, coverage, and unfunded work', () => {
    expect(sql).toContain('evaluate_service_business_assignment');
    for (const blocker of [
      'PROVIDER_ORGANIZATION_INACTIVE',
      'PROVIDER_ORGANIZATION_UNVERIFIED',
      'PAYOUT_ACCOUNT_NOT_READY',
      'SERVICE_PROFILE_INACTIVE',
      'CREW_NOT_ELIGIBLE',
      'CREW_CAPABILITY_STALE',
      'CREW_CREDENTIAL_EXPIRED',
      'CREW_ACTIVE_DISPUTE',
      'CREW_CAPACITY_UNAVAILABLE',
      'SERVICE_CAPACITY_UNAVAILABLE',
      'SERVICE_COVERAGE_MISMATCH',
      'TASK_NOT_FUNDED',
      'OFFER_NOT_CURRENT',
    ]) expect(sql).toContain(blocker);
  });

  it('keeps actual-fulfiller eligibility separate from the organization payout recipient', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION enforce_task_worker_eligibility_on_accept()');
    expect(sql).toMatch(/NEW\.provider_organization_id\s+IS\s+NULL[\s\S]+v_worker\.stripe_connect_id\s+IS\s+NULL/i);
    expect(sql).toMatch(/NEW\.provider_organization_id\s+IS\s+NOT\s+NULL[\s\S]+NOT\s+v_business_payout_ready/i);
    expect(sql).toMatch(/business_service_task_assignments\s+assignment[\s\S]+business_provider_payout_accounts\s+payout/is);
    for (const guard of [
      'identity_verification_is_current_v1',
      'CREW_CAPABILITY_STALE',
      'background_check_source_id',
      'HXWE13: worker has an active dispute',
      'HXWE14: worker active-task capacity is exhausted',
    ]) expect(sql).toContain(guard);
  });

  it('attributes business review, clarification, quote, and acceptance without weakening individual offers', () => {
    for (const column of [
      'provider_organization_id', 'provider_service_profile_id',
      'provider_crew_assignment_id', 'reviewed_by',
    ]) expect(sql).toContain(column);
    expect(sql).toContain('business_service_offer_response_events');
    expect(sql).toContain("'DECLINED','CLARIFICATION_REQUESTED','QUOTED','ACCEPTED'");
    expect(sql).toContain('enforce_public_question_lifecycle');
    expect(sql).toContain('enforce_worker_offer_decision_on_accept');
  });

  it('repairs falsely active provider state and revokes public authority-changing functions', () => {
    expect(sql).toMatch(/UPDATE\s+business_service_profiles[\s\S]+SET\s+status='PAUSED'/i);
    expect(sql).toMatch(/UPDATE\s+business_organizations[\s\S]+SET\s+payout_status='RESTRICTED'/i);
    for (const fn of [
      'link_business_provider_payout_account',
      'evaluate_service_business_assignment',
    ]) expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}`, 'i'));
  });
});
