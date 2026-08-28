import { commandHash, type ExpressInterestPublic, type MaterializeWorkOrderPublic, type PlaceHoldPublic, UniversalV1WorkOrderError } from './UniversalV1WorkOrderContracts.js';
import { PostgresUniversalV1WorkOrderRepository } from './UniversalV1WorkOrderPostgresRepository.js';
import { PostgresUniversalV1WorkOrderPublicFactReader } from './UniversalV1WorkOrderPublicFacts.js';
import { authorizeUniversalV1FakeFinancialTransaction, type UniversalV1FakeFinancialApplicationService } from './payment/UniversalV1FinancialApplicationService.js';
import type { Database } from '../db.js';

function current(ts:string){const d=Date.parse(ts),n=Date.now();if(!Number.isFinite(d)||Math.abs(n-d)>5*60_000)throw new UniversalV1WorkOrderError('WORK_ORDER_REQUEST_STALE','Request timestamp is stale.');}
export class UniversalV1WorkOrderApplication {
  constructor(private readonly facts=new PostgresUniversalV1WorkOrderPublicFactReader(),private readonly repo=new PostgresUniversalV1WorkOrderRepository(),private readonly authorizeFinance:()=>((database:Database)=>UniversalV1FakeFinancialApplicationService)=()=>authorizeUniversalV1FakeFinancialTransaction()){}
  async expressProviderInterest(actor:string,input:ExpressInterestPublic){current(input.client_ts);const c=await this.facts.interest(actor,input.task_id);if(!c)throw new UniversalV1WorkOrderError('WORK_ORDER_CONTEXT_UNAVAILABLE','Interest context unavailable.');if(c.scope_version!==input.expected_scope_version)throw new UniversalV1WorkOrderError('WORK_ORDER_VERSION_CONFLICT','Scope version changed.');return this.repo.express(c,actor,input.idempotency_key,commandHash(input));}
  async placeConditionalHold(actor:string,input:PlaceHoldPublic){current(input.client_ts);const c=await this.facts.hold(actor,input.interest_application_id);if(!c)throw new UniversalV1WorkOrderError('WORK_ORDER_CONTEXT_UNAVAILABLE','Hold context unavailable.');if(c.eligibility_version!==input.expected_eligibility_version)throw new UniversalV1WorkOrderError('WORK_ORDER_VERSION_CONFLICT','Eligibility version changed.');return this.repo.hold(c,input.idempotency_key,commandHash(input));}
  async secureAndMaterializeFakeWorkOrder(actor:string,input:MaterializeWorkOrderPublic){current(input.client_ts);const c=await this.facts.workOrder(actor,input.conditional_hold_id);if(!c)throw new UniversalV1WorkOrderError('WORK_ORDER_CONTEXT_UNAVAILABLE','Work Order context unavailable.');if(c.eligibility_version!==input.expected_eligibility_version)throw new UniversalV1WorkOrderError('WORK_ORDER_VERSION_CONFLICT','Eligibility version changed.');const financeFor=this.authorizeFinance();
    return this.repo.materialize(c,input.idempotency_key,actor,financeFor);
  }
}
