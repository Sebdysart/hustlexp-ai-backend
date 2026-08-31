import { readFileSync } from 'node:fs';
import { describe,expect,it,vi } from 'vitest';
import type { ProviderInterestContext } from '../../src/services/UniversalV1WorkOrderContracts.js';
import { PostgresUniversalV1WorkOrderRepository } from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';

const source=readFileSync(new URL('../../src/services/UniversalV1WorkOrderPostgresRepository.ts',import.meta.url),'utf8');
const applicationSource=readFileSync(new URL('../../src/services/UniversalV1WorkOrderApplication.ts',import.meta.url),'utf8');
const publicFactsSource=readFileSync(new URL('../../src/services/UniversalV1WorkOrderPublicFacts.ts',import.meta.url),'utf8');

function methodBody(name:string,next:string):string {
 const start=source.indexOf(`async ${name}`),end=source.indexOf(`async ${next}`,start+1);
 expect(start).toBeGreaterThanOrEqual(0);
 expect(end).toBeGreaterThan(start);
 return source.slice(start,end);
}

const ids={
 draft:'20000000-0000-4000-8000-000000000001',
 task:'20000000-0000-4000-8000-000000000002',
 scope:'20000000-0000-4000-8000-000000000003',
 route:'20000000-0000-4000-8000-000000000004',
 provider:'20000000-0000-4000-8000-000000000005',
 predecessor:'20000000-0000-4000-8000-000000000006',
 interest:'20000000-0000-4000-8000-000000000007',
 eligibility:'20000000-0000-4000-8000-000000000008',
};
const interestContext:ProviderInterestContext={
 task_id:ids.task,task_draft_id:ids.draft,scope_version_id:ids.scope,scope_version:1,
 routing_decision_id:ids.route,provider_user_id:ids.provider,provider_organization_id:null,
 provider_class:'GENERAL_SERVICE_PROVIDER',trade_credential_id:null,
 predecessor_eligibility_id:ids.predecessor,predecessor_eligibility_version:1,
 predecessor_valid_until:new Date(Date.now()+60_000).toISOString(),
};

describe('Universal V1 Work Order repository transaction contract',()=>{
 it('uses the 20260907 fixed authority lock before each revalidation',()=>{
  expect(source.match(/lock_universal_v1_estimate_authority/g)).toHaveLength(4);
  const bodies=[
   methodBody('express','hold'),
   methodBody('hold','prepareMaterialization'),
   methodBody('prepareMaterialization','finalizeMaterialization'),
   source.slice(source.indexOf('async finalizeMaterialization'),source.indexOf('export function deterministicUuid')),
  ];
  for(const body of bodies){
   expect(body.indexOf('lock_universal_v1_estimate_authority')).toBeGreaterThanOrEqual(0);
   expect(body.indexOf('lock_universal_v1_estimate_authority')).toBeLessThan(body.indexOf('universal_v1_invited_provider_authority_is_current'));
  }
 });
 it('commits the witness before independent finance and verifies exact bridge proof before terminal facts',()=>{
  const prepare=applicationSource.indexOf('prepareMaterialization');
  const paymentMethod=applicationSource.indexOf("operationKind:'PREPARE_PAYMENT_METHOD'",prepare);
  const authorize=applicationSource.indexOf("operationKind:'AUTHORIZE'",paymentMethod);
  const secure=applicationSource.indexOf("operationKind:'SECURE'",authorize);
  const finalize=applicationSource.indexOf('finalizeMaterialization',secure);
  expect(prepare).toBeGreaterThanOrEqual(0);
  expect(paymentMethod).toBeGreaterThan(prepare);
  expect(authorize).toBeGreaterThan(paymentMethod);
  expect(secure).toBeGreaterThan(authorize);
  expect(finalize).toBeGreaterThan(secure);
  expect(source).toContain('universal_v1_fake_financial_lifecycle_bridges');
  expect(source).toContain("bridge.fake_operation_kind='SECURE'");
  expect(source).toContain('event.operation_id=bridge.fake_operation_id::text');
  expect(source).toContain("outcome.outcome_kind='OUTCOME_OBSERVED'");
  expect(source).toContain('outcome.retryable=FALSE');
  expect(source).toContain('released.rowCount!==1');
  expect(source).toContain('closed.rowCount!==1');
 });
 it('uses typed errors for every repository Work Order failure',()=>{expect(source).not.toMatch(/throw new Error\(['"](?:WORK_ORDER_|HARD_ASSIGNMENT)/);expect(source).toContain("'WORK_ORDER_HARD_ASSIGNMENT_FORBIDDEN'");});
 it('lets the public fact reader recover only the exact committed post-estimate successor for replay',()=>{
  expect(publicFactsSource).toContain('AND NOT (n.supersedes_decision_id=e.id');
  expect(publicFactsSource).toContain('n.decision_version=e.decision_version+1');
  expect(publicFactsSource).toContain('n.task_id=t.id AND n.scope_version_id=s.id');
  expect(publicFactsSource).toContain('n.routing_decision_id=r.id AND n.interest_application_id IS NOT NULL');
  expect(publicFactsSource).toContain("n.policy_version='universal-v1-post-estimate-1.2.0'");
 });
 it('revalidates the complete locked post-estimate chain and copies the seven eligibility dimensions',async()=>{
  const query=vi.fn()
   .mockResolvedValueOnce({rows:[],rowCount:1})
   .mockResolvedValueOnce({rows:[],rowCount:0})
   .mockResolvedValueOnce({rows:[{id:ids.predecessor,decision_version:7,valid_until:new Date(Date.now()+60_000)}],rowCount:1})
   .mockResolvedValueOnce({rows:[{id:ids.interest}],rowCount:1})
   .mockResolvedValueOnce({rows:[{id:ids.eligibility}],rowCount:1});
  const database={serializableTransaction:vi.fn(async(run:(q:typeof query)=>Promise<unknown>)=>run(query))};
  const repository=new PostgresUniversalV1WorkOrderRepository(database as never);
  await expect(repository.express(interestContext,ids.provider,'interest:authority:0001','a'.repeat(64))).resolves.toEqual({
   interest_application_id:ids.interest,eligibility_decision_id:ids.eligibility,eligibility_version:8,replayed:false,
  });

  const authoritySql=String(query.mock.calls[2]![0]);
  expect(authoritySql).toContain('m.resulting_routing_decision_id=r.id');
  expect(authoritySql).toContain('e.routing_decision_id=m.prior_routing_decision_id');
  expect(authoritySql).toContain('r.supersedes_decision_id=e.routing_decision_id');
  expect(authoritySql).toContain('predecessor_route.service_cell_authority_id=r.service_cell_authority_id');
  expect(authoritySql).toContain("cell.routing_availability='ACTIVE'");
  expect(authoritySql).toContain('successor.supersedes_authority_id=cell.id');
  expect(authoritySql).toContain('p.scope_hash=s.scope_hash');
  expect(authoritySql).toContain("e.evidence->>'work_category_code'=t.category");
  expect(authoritySql).toContain("e.evidence->>'region_code'=t.region_code");
  expect(authoritySql).toContain('profile.provider_class=e.provider_class');
  expect(authoritySql).toContain('organization.provider_class=e.provider_class');
  expect(authoritySql).toContain("provider.account_status='ACTIVE'");
  expect(authoritySql).toContain('provider.is_minor IS FALSE');
  expect(authoritySql).toContain('COALESCE(provider.is_banned,false)=false');
  expect(authoritySql).toContain('COALESCE(provider.trust_hold,false)');
  expect(authoritySql).toContain('universal_v1_invited_provider_authority_is_current');
  expect(authoritySql).toContain('n.decision_version>e.decision_version');
  expect(query.mock.calls[2]![1]).toEqual([
   ids.predecessor,ids.task,ids.scope,ids.route,ids.provider,ids.provider,null,
   'GENERAL_SERVICE_PROVIDER',null,
  ]);

  const eligibilitySql=String(query.mock.calls[4]![0]);
  const eligibilityParameters=query.mock.calls[4]![1] as unknown[];
  expect(eligibilityParameters[5]).toBe(8);
  for(const dimension of ['profile','identity','category','credential','geography','availability'] as const){
   expect(eligibilitySql).toContain(`source.${dimension}_eligible`);
  }
  expect(eligibilitySql).toContain('source.restriction_clear');
  expect(eligibilitySql).toContain('false,false,source.trust_tier,source.blocker_codes');
  expect(eligibilitySql).toContain("'final_availability_confirmation_required',true");
  expect(eligibilitySql).toContain("'interest_is_not_assignment',true");
  expect(eligibilitySql).not.toContain("'SERVER_DERIVED',ARRAY[]::text[]");
  expect(methodBody('express','hold')).not.toMatch(/UPDATE\s+tasks[\s\S]*worker_id/iu);
 });
 it('returns the exact committed interest before predecessor freshness rejects a second write',async()=>{
  const requestSha256='c'.repeat(64);
  const query=vi.fn()
   .mockResolvedValueOnce({rows:[],rowCount:1})
   .mockResolvedValueOnce({rows:[{
    interest_application_id:ids.interest,
    eligibility_decision_id:ids.eligibility,
    eligibility_version:2,
    request_sha256:requestSha256,
   }],rowCount:1});
  const database={serializableTransaction:vi.fn(async(run:(q:typeof query)=>Promise<unknown>)=>run(query))};
  const repository=new PostgresUniversalV1WorkOrderRepository(database as never);
  await expect(repository.express(interestContext,ids.provider,'interest:authority:replay',requestSha256)).resolves.toEqual({
   interest_application_id:ids.interest,
   eligibility_decision_id:ids.eligibility,
   eligibility_version:2,
   replayed:true,
  });
  expect(query).toHaveBeenCalledTimes(2);
  expect(String(query.mock.calls[1]![0])).toContain("e.policy_version='universal-v1-post-estimate-1.2.0'");
 });
 it('fails closed before interest insertion when current predecessor authority is unavailable',async()=>{
  const query=vi.fn()
   .mockResolvedValueOnce({rows:[],rowCount:1})
   .mockResolvedValueOnce({rows:[],rowCount:0})
   .mockResolvedValueOnce({rows:[],rowCount:0});
  const database={serializableTransaction:vi.fn(async(run:(q:typeof query)=>Promise<unknown>)=>run(query))};
  const repository=new PostgresUniversalV1WorkOrderRepository(database as never);
  await expect(repository.express(interestContext,ids.provider,'interest:authority:0002','b'.repeat(64))).rejects.toMatchObject({
   code:'WORK_ORDER_AUTHORITY_REVOKED',
  });
  expect(query.mock.calls.some(([sql])=>/^INSERT\s+/iu.test(String(sql).trim()))).toBe(false);
 });
});
