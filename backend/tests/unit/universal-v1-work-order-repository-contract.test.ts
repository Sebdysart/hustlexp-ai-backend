import { readFileSync } from 'node:fs';
import { describe,expect,it } from 'vitest';

const source=readFileSync(new URL('../../src/services/UniversalV1WorkOrderPostgresRepository.ts',import.meta.url),'utf8');
describe('Universal V1 Work Order repository transaction contract',()=>{
 it('uses the 20260907 fixed authority lock before each revalidation',()=>{
  expect(source.match(/lock_universal_v1_estimate_authority/g)).toHaveLength(3);
  for(const method of ['async express','async hold','async materialize']){const body=source.slice(source.indexOf(method));expect(body.indexOf('lock_universal_v1_estimate_authority')).toBeLessThan(body.indexOf('universal_v1_invited_provider_authority_is_current'));}
 });
 it('keeps finance and terminal facts in the outer serializable transaction and fails missed closures',()=>{
  expect(source).toContain('financeFor(transactionBoundDatabase(q,this.database))');
  expect(source).toContain("operationKind:'PREPARE_PAYMENT_METHOD'");
  expect(source).toContain("operationKind:'AUTHORIZE'");
  expect(source).toContain("operationKind:'SECURE'");
  expect(source).toContain('released.rowCount!==1');
  expect(source).toContain('closed.rowCount!==1');
 });
 it('uses typed errors for every repository Work Order failure',()=>{expect(source).not.toMatch(/throw new Error\(['"](?:WORK_ORDER_|HARD_ASSIGNMENT)/);expect(source).toContain("'WORK_ORDER_HARD_ASSIGNMENT_FORBIDDEN'");});
});
