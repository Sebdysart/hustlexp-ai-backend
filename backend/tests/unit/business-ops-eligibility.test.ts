import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
const mocks=vi.hoisted(()=>({query:vi.fn(),summaries:vi.fn(),activate:vi.fn()}));
vi.mock('../../src/services/BusinessQuoteActivationService.js',()=>({activatePendingBusinessQuotesInTransaction:mocks.activate}));
vi.mock('../../src/db.js',()=>({db:{query:mocks.query,transaction:(fn:(q:unknown)=>unknown)=>fn(mocks.query)}}));
vi.mock('../../src/services/BusinessTaskEligibilityService.js',async(original)=>({...await original<typeof import('../../src/services/BusinessTaskEligibilityService.js')>(),listBusinessServiceEligibility:mocks.summaries}));
import { categoryCorrectionInput,categoryPolicyInput,correctTaskDraftCategory,setServiceCategoryPolicy,reviewBusinessService,recheckBusinessQuoteEligibility } from '../../src/routers/web/opsBusinessEligibility.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
const id='123e4567-e89b-42d3-a456-426614174000';
const rows=(value:unknown[])=>({rows:value,rowCount:value.length});
let draft={category:'other',task_id:null as string|null,has_business_quote:false};
let previous:Record<string,unknown>|null;
beforeEach(()=>{
 vi.resetAllMocks(); draft={category:'other',task_id:null,has_business_quote:false}; previous={id:'policy-v1',policy_version:1,effective_from:new Date(0),effective_to:null};
 mocks.query.mockImplementation(async(sql:string,values:unknown[]=[])=>{
  if(sql.includes('FROM admin_roles')) return rows([{allowed:true}]);
  if(sql.includes('FROM task_drafts d')) return rows([draft]);
  if(sql.startsWith('UPDATE task_drafts')) {draft.category=values[1] as string;return rows([]);}
  if(sql.includes('FROM service_categories')) return rows([{id:'category'}]);
  if(sql.includes('FROM credential_types')) return rows((values[0] as string[]).map(id=>({id})));
  if(sql.includes('FROM service_category_policies')) return rows(previous?[previous]:[]);
  if(sql.includes('INSERT INTO service_category_policies')) return rows([{id:'policy-v2'}]);
  if(sql.includes('FROM business_organizations')) return rows([{id:'org'}]);
  return rows([]);
 });
 mocks.summaries.mockResolvedValue([{category:'cleaning',selected:true,serviceProfileId:'profile',policy:{id:'policy-v1',status:'MANUAL_REVIEW_REQUIRED'}}]);
 mocks.activate.mockResolvedValue(2);
});

describe('Ops recheck of legacy pending business quotes',()=>{
 it('uses the same transaction and org lock, rechecks current eligibility through activation, and audits',async()=>{
  expect(await recheckBusinessQuoteEligibility('ops',id)).toEqual({activated:2});
  expect(mocks.activate).toHaveBeenCalledWith(mocks.query,id);
  const org=mocks.query.mock.calls.find(([sql])=>sql.includes('FROM business_organizations'));
  expect(org?.[0]).toContain('FOR UPDATE');
  expect(org?.[0]).toContain("verification_status='VERIFIED'");
  expect(org?.[0]).toContain('provider_enabled');
  expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO ops_action_audit'))).toBe(true);
 });
 it('denies a removed Ops capability without publishing',async()=>{
  mocks.query.mockResolvedValue(rows([]));
  await expect(recheckBusinessQuoteEligibility('removed-ops',id)).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(mocks.activate).not.toHaveBeenCalled();
 });
 it('does not bypass organization verification, suspension, or provider disablement',async()=>{
  const base=mocks.query.getMockImplementation()!;
  mocks.query.mockImplementation(async(sql,params)=>sql.includes('FROM business_organizations')?rows([]):base(sql,params));
  await expect(recheckBusinessQuoteEligibility('ops',id)).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  expect(mocks.activate).not.toHaveBeenCalled();
 });
 it('propagates required audit failures so quote publication rolls back',async()=>{
  const base=mocks.query.getMockImplementation()!;
  mocks.query.mockImplementation(async(sql,params)=>{if(sql.includes('INSERT INTO ops_action_audit'))throw new Error('audit failed');return base(sql,params);});
  await expect(recheckBusinessQuoteEligibility('ops',id)).rejects.toThrow('audit failed');
 });
});
describe('audited Ops primary category correction',()=>{
 it('updates primary category and immutable reason audit without rewriting NLP',async()=>{
  const result=await correctTaskDraftCategory('ops',{taskDraftId:id,category:'cleaning',reason:'Reviewed scope with customer'});
  expect(result.category).toBe('cleaning');
  const update=mocks.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE task_drafts'));
  expect(update?.[1]).toEqual([id,'cleaning']); expect(update?.[0]).not.toContain('structured');
  const audit=mocks.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO task_draft_category_corrections'));
  expect(audit?.[1]).toEqual([id,'other','cleaning','ops','Reviewed scope with customer']);
  expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO ops_action_audit'))).toBe(true);
 });
 it.each(['quote','task'])('blocks correction once %s has fixed category evidence',async(kind)=>{
  if(kind==='quote') draft.has_business_quote=true;else draft.task_id='task';
  await expect(correctTaskDraftCategory('ops',{taskDraftId:id,category:'cleaning',reason:'Changed'})).rejects.toMatchObject({code:'PRECONDITION_FAILED'});
  expect(mocks.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE task_drafts'))).toBe(false);
 });
 it('rejects invalid categories and reason at API boundary',()=>{
  for(const patch of [{category:'CLEANING'},{category:'unlisted'},{reason:' '},{taskDraftId:'invalid'}]) expect(categoryCorrectionInput.safeParse({taskDraftId:id,category:'cleaning',reason:'Changed',...patch}).success).toBe(false);
 });
 it('current Ops capability denial prevents writes',async()=>{
  mocks.query.mockResolvedValue(rows([]));
  await expect(correctTaskDraftCategory('member',{taskDraftId:id,category:'cleaning',reason:'Changed'})).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(mocks.query).toHaveBeenCalledTimes(1);
 });
 it('required audit failure propagates for transaction rollback',async()=>{
  const base=mocks.query.getMockImplementation()!;
  mocks.query.mockImplementation(async(sql,params)=>{if(sql.includes('INSERT INTO ops_action_audit')) throw new Error('audit unavailable');return base(sql,params);});
  await expect(correctTaskDraftCategory('ops',{taskDraftId:id,category:'cleaning',reason:'Changed'})).rejects.toThrow('audit unavailable');
 });
});
describe('versioned category policy and manual review',()=>{
 const input=()=>({category:'cleaning' as const,jurisdictionCode:'US-WA',status:'UNRESTRICTED' as const,manualReviewRequired:false,requiredCredentialTypeIds:[],reason:'Approved configuration',effectiveFrom:new Date().toISOString()});
 it('closes previous interval and records new version rather than mutating policy',async()=>{
  const result=await setServiceCategoryPolicy('ops',input());expect(result).toEqual({id:'policy-v2'});
  expect(mocks.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE service_category_policies'))?.[0]).toBe('UPDATE service_category_policies SET effective_to=$2 WHERE id=$1');
  expect(mocks.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO service_category_policies'))?.[1][3]).toBe(2);
  expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO ops_action_audit'))).toBe(true);
 });
 it('writes all required normalized type relations',async()=>{
  await setServiceCategoryPolicy('ops',{...input(),status:'CREDENTIAL_REQUIRED',requiredCredentialTypeIds:[id]});
  expect(mocks.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO service_credential_requirements'))?.[1]).toEqual(['policy-v2',id]);
 });
 it('does not invent absent credentials or allow other unrestricted',async()=>{
  await expect(setServiceCategoryPolicy('ops',{...input(),status:'CREDENTIAL_REQUIRED'})).rejects.toMatchObject({code:'BAD_REQUEST'});
  await expect(setServiceCategoryPolicy('ops',{...input(),category:'other'})).rejects.toMatchObject({code:'BAD_REQUEST'});
  expect(categoryPolicyInput.safeParse({...input(),category:'unknown'}).success).toBe(false);
 });
 it('serializes publication and rejects overlapping scheduled versions',async()=>{
  previous={...previous,effective_from:new Date(Date.now()+86_400_000)};
  await expect(setServiceCategoryPolicy('ops',input())).rejects.toMatchObject({code:'CONFLICT'});
  expect(mocks.query.mock.calls.find(([sql])=>sql.includes('FROM service_categories'))?.[0]).toContain('FOR UPDATE');
  expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO service_category_policies'))).toBe(false);
 });
 it('review binds exact policy and requires audit; does not self-verify credentials',async()=>{
  await reviewBusinessService('ops',{organizationId:id,expectedPolicyId:'policy-v1',category:'cleaning',jurisdictionCode:'US-WA',decision:'APPROVE',reason:'Review accepted'});
  const update=mocks.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE business_service_profiles'));
  expect(update?.[1]).toEqual(['profile','ELIGIBLE','Review accepted','ops','policy-v1']);
  expect(mocks.query.mock.calls.some(([sql])=>sql.includes('UPDATE business_credentials'))).toBe(false);
  expect(mocks.query.mock.calls.some(([sql])=>sql.includes('INSERT INTO business_audit_events'))).toBe(true);
 });
 it.each(['other','disabled','stale'])('blocks %s policy approval bypass',async(kind)=>{
  mocks.summaries.mockResolvedValue([{category:kind==='other'?'other':'cleaning',selected:true,serviceProfileId:'profile',policy:{id:kind==='stale'?'new-policy':'policy-v1',status:kind==='disabled'?'DISABLED':'MANUAL_REVIEW_REQUIRED'}}]);
  await expect(reviewBusinessService('ops',{organizationId:id,expectedPolicyId:'policy-v1',category:kind==='other'?'other':'cleaning',jurisdictionCode:'US-WA',decision:'APPROVE',reason:'Review accepted'})).rejects.toBeDefined();
  expect(mocks.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE business_service_profiles'))).toBe(false);
 });
});
it('registers forward migrations in dependency order with immutable/scope backstops',()=>{
 const names=REQUIRED_MIGRATION_FILES.map(m=>m.name as string);
 const category=names.indexOf('20261007_business_service_category_policy'); const credential=names.indexOf('20261007_business_credentials_evidence');const quote=names.indexOf('20261008_business_quote_eligibility');
 expect(category).toBeGreaterThan(names.indexOf('20261006_outbox_dispatch_lease'));expect(credential).toBeGreaterThan(category);expect(quote).toBeGreaterThan(credential);
 const sql=readFileSync('backend/database/migrations/20260922_business_quote_eligibility.sql','utf8');
 expect(sql).toContain('BEFORE UPDATE OR DELETE ON business_quote_eligibility_decisions');expect(sql).toContain('quote_id UUID NOT NULL UNIQUE');
 expect(sql).toContain('d.category=NEW.primary_category');expect(sql).toContain('q.business_organization_id=NEW.business_organization_id');
 expect(sql).toContain('BEFORE UPDATE OF category ON task_drafts');
 expect(sql).toContain("ARRAY['business_quote_eligibility_decisions','task_draft_category_corrections','business_credential_review_signals']");
 expect(sql).toContain('ENABLE ROW LEVEL SECURITY');expect(sql).toContain('REVOKE ALL ON TABLE %I FROM authenticated');
});
