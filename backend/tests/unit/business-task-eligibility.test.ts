import { describe, it, expect, vi } from 'vitest';
import { evaluateServiceEligibility, evaluateBusinessTaskEligibility, persistBusinessQuoteEligibilityDecision, type EligibilityContext } from '../../src/services/BusinessTaskEligibilityService.js';
import type { QueryFn } from '../../src/db.js';

const now = new Date('2026-10-01T12:00:00Z');
function context(): EligibilityContext {
  return {
    categories: [{ id: 'category', code: 'cleaning', display_name: 'Cleaning', status: 'ACTIVE' }],
    profiles: [{ id: 'profile', service_code: 'cleaning', service_category_id: 'category', selected_by_business: true,
      eligibility_status: 'PENDING_REVIEW', eligibility_reviewed_policy_id: null, eligibility_reviewed_at: null, eligibility_reviewed_by: null }],
    policies: [{ id: 'policy', service_category_id: 'category', jurisdiction_code: 'US-WA', policy_status: 'UNRESTRICTED',
      policy_version: 2, effective_from: '2026-09-01T00:00:00Z', effective_to: null, manual_review_required: false }],
    requirements: [], credentials: [], evaluatedAt: now,
  };
}
function credentialContext(): EligibilityContext {
  const value = context(); value.policies[0].policy_status = 'CREDENTIAL_REQUIRED';
  value.requirements = [{ id:'requirement', service_category_policy_id:'policy', credential_type_id:'type', required:true,
    code:'TEST_CERTIFICATE', display_name:'Test credential', status:'ACTIVE', jurisdiction_code:'US-WA',
    requires_number:true, requires_evidence:true, supports_expiration:true }];
  value.credentials = [{ id:'credential', credential_type_id:'type', membership_id:null, status:'ACTIVE',
    current_version_id:'version', expires_at:'2026-10-03T00:00:00Z', verified_at:'2026-09-01T00:00:00Z', verified_by:'ops',
    issued_at:'2026-08-01', jurisdiction_code:'US-WA', credential_number:'TEST-1', evidence_count:1,
    version_snapshot:{ evidence:[{uploadReceiptId:'receipt'}] } }];
  return value;
}
const evaluate = (ctx = context(), category = 'cleaning', jurisdiction: string | null = 'US-WA') => evaluateServiceEligibility(ctx,category,jurisdiction);

describe('canonical business service eligibility', () => {
  it('allows selected unrestricted service independently of old operational activation', () => {
    const result = evaluate(); expect(result.eligible).toBe(true); expect(result.eligibilityStatus).toBe('ELIGIBLE');
  });
  it('keeps eligible cleaning available while another selected service lacks required credentials', () => {
    const ctx = context();
    ctx.categories.push({id:'plumbing-category',code:'plumbing',display_name:'Plumbing',status:'ACTIVE'});
    ctx.profiles.push({...ctx.profiles[0],id:'plumbing-profile',service_code:'plumbing',service_category_id:'plumbing-category'});
    ctx.policies.push({...ctx.policies[0],id:'plumbing-policy',service_category_id:'plumbing-category',policy_status:'CREDENTIAL_REQUIRED'});
    ctx.requirements.push({...credentialContext().requirements[0],service_category_policy_id:'plumbing-policy'});
    expect(evaluate(ctx,'plumbing').reasons.map(reason=>reason.code)).toContain('REQUIRED_CREDENTIAL_MISSING');
    expect(evaluate(ctx,'cleaning').eligible).toBe(true);
    expect(evaluate(ctx,'cleaning').requirements).toEqual([]);
  });
  it('blocks unselected/unknown services', () => {
    const ctx=context(); ctx.profiles[0].selected_by_business=false;
    expect(evaluate(ctx).reasons[0].code).toBe('SERVICE_NOT_OFFERED');
    expect(evaluate(ctx,'unknown').eligible).toBe(false);
  });
  it('fails closed for absent, ambiguous, retired or wrong-jurisdiction policy', () => {
    for(const jurisdiction of [null,'US-OR']) expect(evaluate(context(),'cleaning',jurisdiction).eligible).toBe(false);
    const ctx=context(); ctx.policies.push({...ctx.policies[0],id:'overlap'});
    expect(evaluate(ctx).reasons.some(r=>r.code==='CATEGORY_POLICY_MISSING')).toBe(true);
    ctx.policies.pop(); ctx.categories[0].status='RETIRED'; expect(evaluate(ctx).eligible).toBe(false);
  });
  it('selects exact effective policy interval/version', () => {
    const ctx=context(); ctx.policies.push({...ctx.policies[0],id:'old',policy_version:1,effective_from:'2025-01-01',effective_to:'2026-09-01T00:00:00Z'});
    expect(evaluate(ctx).policy?.version).toBe(2);
    ctx.evaluatedAt=new Date('2026-08-01'); expect(evaluate(ctx).policy?.version).toBe(1);
  });
  it('manual policy requires a review of that exact policy version', () => {
    const ctx=context(); ctx.policies[0].policy_status='MANUAL_REVIEW_REQUIRED';
    expect(evaluate(ctx).eligible).toBe(false);
    Object.assign(ctx.profiles[0],{eligibility_status:'ELIGIBLE',eligibility_reviewed_policy_id:'policy',eligibility_reviewed_at:'2026-09-20',eligibility_reviewed_by:'ops'});
    expect(evaluate(ctx).eligible).toBe(true);
    ctx.profiles[0].eligibility_reviewed_policy_id='old'; expect(evaluate(ctx).eligible).toBe(false);
  });
  it('disabled and unresolved other cannot be approved around', () => {
    const ctx=context(); ctx.policies[0].policy_status='DISABLED'; expect(evaluate(ctx).eligible).toBe(false);
    ctx.categories[0].code='other'; ctx.profiles[0].service_code='other'; ctx.policies[0].policy_status='UNRESTRICTED';
    expect(evaluate(ctx,'other').reasons.some(r=>r.code==='MANUAL_REVIEW_REQUIRED')).toBe(true);
  });
  it('requires configured requirements and verified organization-level versioned evidence', () => {
    const ctx=credentialContext(); expect(evaluate(ctx).eligible).toBe(true);
    expect(evaluate(ctx).credentialEvidence[0]).toMatchObject({credentialId:'credential',credentialVersionId:'version',status:'ACTIVE',expiresAt:'2026-10-03T00:00:00.000Z'});
    ctx.requirements=[]; expect(evaluate(ctx).eligible).toBe(false);
  });
  it.each([
    ['PENDING','CREDENTIAL_PENDING_VERIFICATION'],['REJECTED','CREDENTIAL_REJECTED'],['REVOKED','CREDENTIAL_REVOKED'],['EXPIRED','CREDENTIAL_EXPIRED'],
  ])('blocks %s credential with a stable reason', (status,code) => {
    const ctx=credentialContext(); ctx.credentials[0].status=status;
    expect(evaluate(ctx).reasons.some(r=>r.code===code)).toBe(true);
  });
  it('blocks missing/member-only/unversioned/unverified/future-issued/evidenceless credentials', () => {
    for(const patch of [{membership_id:'member'},{current_version_id:null},{verified_at:null},{issued_at:'2027-01-01'},{evidence_count:0},{jurisdiction_code:'US-OR'}]) {
      const ctx=credentialContext(); Object.assign(ctx.credentials[0],patch); expect(evaluate(ctx).eligible).toBe(false);
    }
    const ctx=credentialContext(); ctx.credentials=[]; expect(evaluate(ctx).reasons[0].code).toBe('REQUIRED_CREDENTIAL_MISSING');
  });
  it('new quotes expire dynamically without mutating historical decisions', async () => {
    const ctx=credentialContext(); const allowed=evaluate(ctx); const query=vi.fn(async()=>({rows:[{id:'decision'}],rowCount:1}));
    await persistBusinessQuoteEligibilityDecision(query as QueryFn,allowed,{organizationId:'org',taskDraftId:'draft',quoteId:'quote',quoteVersionId:'quote-version'});
    const snapshot=JSON.parse(query.mock.calls[0][1][11] as string);
    ctx.evaluatedAt=new Date('2026-10-04'); expect(evaluate(ctx).eligible).toBe(false);
    expect(snapshot[0].status).toBe('ACTIVE'); expect(snapshot[0].credentialVersionId).toBe('version');
    expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][0]).toContain('INSERT INTO business_quote_eligibility_decisions');
    expect(query.mock.calls[0][0]).toContain("'ALLOW'");
  });
  it('loads authoritative primary category and region; never secondary intent authority', async () => {
    const ctx=context();
    const query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM task_drafts')?[{category:'cleaning',region_code:'US-WA',structured:{secondary_intents:['plumbing']}}]:
      sql.includes('FROM service_categories')?ctx.categories:sql.includes('FROM business_service_profiles')?ctx.profiles:
      sql.includes('FROM service_category_policies')?ctx.policies:sql.includes('FROM service_credential_requirements')?ctx.requirements:ctx.credentials,rowCount:1}));
    expect((await evaluateBusinessTaskEligibility(query as QueryFn,{organizationId:'org',taskDraftId:'draft',action:'SUBMIT_QUOTE'})).eligible).toBe(true);
    expect(query.mock.calls.find(([sql])=>sql.includes('FROM task_drafts'))?.[0]).toContain('FOR UPDATE');
  });
});
