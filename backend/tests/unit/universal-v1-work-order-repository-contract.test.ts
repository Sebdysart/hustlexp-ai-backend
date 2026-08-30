import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';

const source=readFileSync(new URL('../../src/services/UniversalV1WorkOrderPostgresRepository.ts',import.meta.url),'utf8');
const applicationSource=readFileSync(new URL('../../src/services/UniversalV1WorkOrderApplication.ts',import.meta.url),'utf8');

function methodBody(name:string,next:string):string {
 const start=source.indexOf(`async ${name}`),end=source.indexOf(`async ${next}`,start+1);
 expect(start).toBeGreaterThanOrEqual(0);
 expect(end).toBeGreaterThan(start);
 return source.slice(start,end);
}

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
});
