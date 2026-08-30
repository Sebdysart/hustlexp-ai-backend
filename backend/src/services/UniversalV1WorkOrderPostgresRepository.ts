import { createHash } from 'node:crypto';
import { db, type Database, type QueryFn } from '../db.js';
import { commandHash, type HoldContext, type ProviderInterestContext, UniversalV1WorkOrderError, type WorkOrderContext } from './UniversalV1WorkOrderContracts.js';

export interface InterestResult { interest_application_id:string; eligibility_decision_id:string; eligibility_version:number; replayed:boolean }
export interface HoldResult { conditional_hold_id:string; expires_at:string; replayed:boolean }
export interface WorkOrderResult { work_order_id:string; financial_security_event_id:string; replayed:boolean; hard_assignment_created:false; payment_creation_performed:false }
interface CurrentRow { id:string; decision_version?:number; valid_until?:string }
interface InterestReplay extends InterestResult { request_sha256:string }
interface HoldReplay extends HoldResult { request_hash:string }
interface InsertedHold { id:string; expires_at:string|Date }
interface InsertedWorkOrder { id:string; materialized_at:string|Date }
interface AssignmentRow { worker_id:string|null }
interface WitnessRow { idempotency_key:string; request_sha256:string; work_order_id:string|null; financial_security_event_id:string|null }
export type WorkOrderMaterializationPhase = {completed:true;result:WorkOrderResult}|{completed:false;context:WorkOrderContext;idempotencyKey:string;requestSha256:string;occurredAt:string};

export function transactionBoundDatabase(query: QueryFn, outer: Database): Database {
  return { ...outer, query, readQuery:query, transaction:fn=>fn(query), serializableTransaction:fn=>fn(query) };
}

export class PostgresUniversalV1WorkOrderRepository {
  constructor(private readonly database: Database = db) {}
  async express(c: ProviderInterestContext, actor:string, key:string, hash:string): Promise<InterestResult> {
    return this.database.serializableTransaction(async q => {
      await q('SELECT public.lock_universal_v1_estimate_authority($1,$2,$3,$4,$5)',[c.task_draft_id,c.provider_user_id,c.provider_organization_id,c.trade_credential_id,actor]);
      const current=await q<CurrentRow>(`SELECT e.id,e.decision_version,e.valid_until FROM task_provider_eligibility_decisions e
        JOIN task_drafts d ON d.id=e.task_draft_id JOIN tasks t ON t.id=d.task_id JOIN task_scope_versions s ON s.id=t.active_scope_version_id
        JOIN task_routing_decisions r ON r.id=d.active_routing_decision_id JOIN task_estimate_acceptance_materializations m ON m.task_id=t.id AND m.scope_version_id=s.id
        JOIN provider_estimate_submissions p ON p.id=m.provider_estimate_submission_id AND p.provider_user_id=e.provider_user_id AND p.provider_organization_id IS NOT DISTINCT FROM e.provider_organization_id
        JOIN users provider ON provider.id=e.provider_user_id
        WHERE e.id=$1 AND t.id=$2 AND s.id=$3 AND r.id=$4 AND r.outcome='FULFILLMENT_CANDIDATE' AND t.worker_id IS NULL
        AND t.automation_classification='CONTROLLED_TEST' AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE AND COALESCE(provider.is_banned,false)=false
        AND e.task_eligible AND e.valid_until>clock_timestamp() AND universal_v1_invited_provider_authority_is_current(e.provider_user_id,e.provider_organization_id,e.provider_class,e.trade_credential_id,t.category,t.region_code)
        AND (e.provider_organization_id IS NULL AND e.provider_user_id=$5 OR EXISTS(SELECT 1 FROM business_memberships bm WHERE bm.organization_id=e.provider_organization_id AND bm.user_id=$5 AND bm.status='ACTIVE' AND bm.role IN('OWNER','ADMIN')))
        AND NOT EXISTS(SELECT 1 FROM task_provider_eligibility_decisions n WHERE n.task_draft_id=e.task_draft_id AND n.provider_user_id=e.provider_user_id AND n.provider_organization_id IS NOT DISTINCT FROM e.provider_organization_id AND n.decision_version>e.decision_version)
        FOR UPDATE OF e,d,t,s,r,m,p,provider`,[c.predecessor_eligibility_id,c.task_id,c.scope_version_id,c.routing_decision_id,actor]);
      if(!current.rows[0])throw new UniversalV1WorkOrderError('WORK_ORDER_AUTHORITY_REVOKED','Provider interest authority was revoked.');
      const replay=await q<InterestReplay>('SELECT a.id interest_application_id,e.id eligibility_decision_id,e.decision_version eligibility_version,a.request_sha256 FROM task_applications a JOIN task_provider_eligibility_decisions e ON e.interest_application_id=a.id WHERE a.hustler_id=$1 AND a.idempotency_key=$2',[c.provider_user_id,key]);
      if(replay.rows[0]) { if(replay.rows[0].request_sha256!==hash) throw new UniversalV1WorkOrderError('WORK_ORDER_IDEMPOTENCY_CONFLICT','Provider interest request changed.'); return {...replay.rows[0],replayed:true}; }
      const a=await q<{id:string}>('INSERT INTO task_applications(task_id,hustler_id,status,universal_contract_version,authority,provider_organization_id,interest_scope_version_id,idempotency_key,request_sha256) VALUES($1,$2,\'pending\',1,\'EXPRESS_INTEREST\',$3,$4,$5,$6) RETURNING id',[c.task_id,c.provider_user_id,c.provider_organization_id,c.scope_version_id,key,hash]);
      const version=c.predecessor_eligibility_version+1;
      const e=await q<{id:string}>(`INSERT INTO task_provider_eligibility_decisions(task_draft_id,task_id,scope_version_id,interest_application_id,routing_decision_id,decision_version,supersedes_decision_id,provider_user_id,provider_organization_id,provider_class,trade_credential_id,profile_eligible,identity_eligible,category_eligible,credential_eligible,geography_eligible,availability_eligible,restriction_clear,task_eligible,processor_payment_eligible,payout_funding_eligible,trust_tier,blocker_codes,policy_version,evidence,decided_by,idempotency_key,evaluated_at,valid_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,true,true,true,true,true,true,true,false,false,'SERVER_DERIVED',ARRAY[]::text[],'universal-v1-post-estimate-1.1.0',jsonb_build_object('payment_creation_frozen',true,'source_eligibility_id',$7::uuid),$12,$13,clock_timestamp(),LEAST($14::timestamptz,clock_timestamp()+interval '15 minutes')) RETURNING id`,[c.task_draft_id,c.task_id,c.scope_version_id,a.rows[0]!.id,c.routing_decision_id,version,c.predecessor_eligibility_id,c.provider_user_id,c.provider_organization_id,c.provider_class,c.trade_credential_id,actor,`${key}:elig`,c.predecessor_valid_until]);
      return {interest_application_id:a.rows[0]!.id,eligibility_decision_id:e.rows[0]!.id,eligibility_version:version,replayed:false};
    });
  }
  async hold(c:HoldContext,key:string,hash:string):Promise<HoldResult>{
    return this.database.serializableTransaction(async q=>{
      await q('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`hold:${c.task_id}`]);
      await q('SELECT public.lock_universal_v1_estimate_authority($1,$2,$3,$4,$5)',[c.task_draft_id,c.provider_user_id,c.provider_organization_id,c.trade_credential_id,c.poster_user_id]);
      const current=await q<CurrentRow>(`SELECT e.id FROM task_provider_eligibility_decisions e JOIN task_applications a ON a.id=e.interest_application_id
        JOIN tasks t ON t.id=e.task_id JOIN task_drafts d ON d.task_id=t.id JOIN task_scope_versions s ON s.id=t.active_scope_version_id
        JOIN task_routing_decisions r ON r.id=d.active_routing_decision_id JOIN users poster ON poster.id=t.poster_id JOIN users provider ON provider.id=e.provider_user_id
        WHERE e.id=$1 AND a.id=$2 AND t.poster_id=$3 AND a.status='pending' AND s.id=e.scope_version_id AND r.id=e.routing_decision_id
        AND poster.account_status='ACTIVE' AND poster.is_minor IS FALSE AND COALESCE(poster.is_banned,false)=false
        AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE AND COALESCE(provider.is_banned,false)=false
        AND e.task_eligible AND e.valid_until>clock_timestamp() AND universal_v1_invited_provider_authority_is_current(e.provider_user_id,e.provider_organization_id,e.provider_class,e.trade_credential_id,t.category,t.region_code)
        AND NOT EXISTS(SELECT 1 FROM task_provider_eligibility_decisions n WHERE n.task_draft_id=e.task_draft_id AND n.provider_user_id=e.provider_user_id AND n.provider_organization_id IS NOT DISTINCT FROM e.provider_organization_id AND n.decision_version>e.decision_version)
        FOR UPDATE OF e,a,t,d,s,r,poster,provider`,[c.eligibility_decision_id,c.interest_application_id,c.poster_user_id]);
      if(!current.rows[0])throw new UniversalV1WorkOrderError('WORK_ORDER_AUTHORITY_REVOKED','Conditional hold authority was revoked.');
      const replay=await q<HoldReplay>('SELECT r.id conditional_hold_id,r.expires_at,w.request_hash FROM task_reservation_requests w JOIN task_reservations r ON r.id=w.reservation_id WHERE w.idempotency_key=$1',[key]);
      if(replay.rows[0]){if(replay.rows[0].request_hash!==hash)throw new UniversalV1WorkOrderError('WORK_ORDER_IDEMPOTENCY_CONFLICT','Conditional hold request changed.');return {...replay.rows[0],replayed:true};}
      await q("UPDATE task_reservations SET status='EXPIRED' WHERE task_id=$1 AND universal_contract_version=1 AND status='ACTIVE' AND expires_at<=clock_timestamp()",[c.task_id]);
      const inserted=await q<InsertedHold>(`INSERT INTO task_reservations(task_id,hustler_id,reserved_by,status,universal_contract_version,hold_kind,interest_application_id,eligibility_decision_id,expires_at) VALUES($1,$2,$3,'ACTIVE',1,'CONDITIONAL_HOLD',$4,$5,LEAST($6::timestamptz,clock_timestamp()+interval '5 minutes')) RETURNING id,expires_at`,[c.task_id,c.provider_user_id,c.poster_user_id,c.interest_application_id,c.eligibility_decision_id,c.eligibility_valid_until]);
      await q('INSERT INTO task_reservation_requests(reservation_id,idempotency_key,request_hash,task_id,hustler_id,requested_by) VALUES($1,$2,$3,$4,$5,$6)',[inserted.rows[0].id,key,hash,c.task_id,c.provider_user_id,c.poster_user_id]);
      return {conditional_hold_id:inserted.rows[0].id,expires_at:new Date(inserted.rows[0].expires_at).toISOString(),replayed:false};
    });
  }
  async prepareMaterialization(c:WorkOrderContext,key:string,actor:string):Promise<WorkOrderMaterializationPhase>{
    return this.database.serializableTransaction(async q=>{
      await q('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`work-order:${c.task_id}`]);
      await q('SELECT public.lock_universal_v1_estimate_authority($1,$2,$3,$4,$5)',[c.task_draft_id,c.provider_user_id,c.provider_organization_id,c.trade_credential_id,actor]);
      const authoritativeHash=commandHash({actor,hold:c.conditional_hold_id,task:c.task_id,draft:c.task_draft_id,estimate:c.provider_estimate_submission_id,route:c.routing_decision_id,scope:c.scope_version_id,provider:c.provider_user_id,organization:c.provider_organization_id,eligibility:c.eligibility_decision_id,eligibility_version:c.eligibility_version,amount:Number(c.customer_total_cents),currency:c.currency});
      const prior=await q<WitnessRow>(`SELECT request.idempotency_key,request.request_sha256,
        work_order.id work_order_id,work_order.financial_security_event_id
        FROM task_work_order_command_requests request
        LEFT JOIN task_work_orders work_order ON work_order.idempotency_key=request.idempotency_key
        WHERE request.idempotency_key=$1 OR request.task_id=$2 OR request.conditional_hold_id=$3
        ORDER BY (request.idempotency_key=$1) DESC
        LIMIT 1 FOR UPDATE OF request`,[key,c.task_id,c.conditional_hold_id]);
      if(prior.rows[0]) {
        if(prior.rows[0].idempotency_key!==key||prior.rows[0].request_sha256!==authoritativeHash) throw new UniversalV1WorkOrderError('WORK_ORDER_IDEMPOTENCY_CONFLICT','Work Order command context changed.');
        if(prior.rows[0].work_order_id&&prior.rows[0].financial_security_event_id)return {completed:true,result:{work_order_id:prior.rows[0].work_order_id,financial_security_event_id:prior.rows[0].financial_security_event_id,replayed:true,hard_assignment_created:false,payment_creation_performed:false}};
      }
      const locked=await q<WorkOrderContext>(`SELECT t.id task_id,d.id task_draft_id,s.id scope_version_id,s.version scope_version,r.id routing_decision_id,
        p.provider_user_id,p.provider_organization_id,e.provider_class,e.trade_credential_id,e.id predecessor_eligibility_id,e.decision_version predecessor_eligibility_version,e.valid_until predecessor_valid_until,
        t.poster_id poster_user_id,a.id interest_application_id,e.id eligibility_decision_id,e.decision_version eligibility_version,e.valid_until eligibility_valid_until,
        h.id conditional_hold_id,h.reserved_at hold_reserved_at,h.expires_at hold_expires_at,m.provider_estimate_submission_id,s.customer_total_cents,s.currency
        FROM tasks t JOIN task_drafts d ON d.task_id=t.id JOIN task_scope_versions s ON s.id=t.active_scope_version_id
        JOIN task_routing_decisions r ON r.id=d.active_routing_decision_id JOIN task_estimate_acceptance_materializations m ON m.task_id=t.id AND m.scope_version_id=s.id
        JOIN provider_estimate_submissions p ON p.id=m.provider_estimate_submission_id JOIN task_provider_eligibility_decisions e ON e.id=$2
        JOIN task_applications a ON a.id=e.interest_application_id JOIN task_reservations h ON h.id=$3 AND h.eligibility_decision_id=e.id
        JOIN users poster ON poster.id=t.poster_id JOIN users provider ON provider.id=e.provider_user_id
        WHERE t.id=$1 AND t.poster_id=$4 AND t.universal_contract_version=1 AND t.automation_classification='CONTROLLED_TEST' AND t.worker_id IS NULL
        AND poster.account_status='ACTIVE' AND poster.is_minor IS FALSE AND COALESCE(poster.is_banned,false)=false
        AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE AND COALESCE(provider.is_banned,false)=false
        AND r.outcome='FULFILLMENT_CANDIDATE' AND e.task_eligible AND e.processor_payment_eligible=false AND e.payout_funding_eligible=false
        AND e.valid_until>clock_timestamp() AND a.status='pending' AND h.status='ACTIVE' AND h.expires_at>clock_timestamp()
        AND universal_v1_invited_provider_authority_is_current(e.provider_user_id,e.provider_organization_id,e.provider_class,e.trade_credential_id,t.category,t.region_code)
        AND NOT EXISTS(SELECT 1 FROM task_provider_eligibility_decisions n WHERE n.task_draft_id=e.task_draft_id AND n.provider_user_id=e.provider_user_id AND n.provider_organization_id IS NOT DISTINCT FROM e.provider_organization_id AND n.decision_version>e.decision_version)
        FOR UPDATE OF t,d,s,r,m,p,e,a,h,poster,provider`,[c.task_id,c.eligibility_decision_id,c.conditional_hold_id,actor]);
      const live=locked.rows[0];
      if(!live)throw new UniversalV1WorkOrderError('WORK_ORDER_AUTHORITY_REVOKED','Current Work Order authority is unavailable.');
      const liveHash=commandHash({actor,hold:live.conditional_hold_id,task:live.task_id,draft:live.task_draft_id,estimate:live.provider_estimate_submission_id,route:live.routing_decision_id,scope:live.scope_version_id,provider:live.provider_user_id,organization:live.provider_organization_id,eligibility:live.eligibility_decision_id,eligibility_version:live.eligibility_version,amount:Number(live.customer_total_cents),currency:live.currency});
      if(liveHash!==authoritativeHash)throw new UniversalV1WorkOrderError('WORK_ORDER_IDEMPOTENCY_CONFLICT','Locked Work Order context changed.');
      if(!prior.rows[0])await q(`INSERT INTO task_work_order_command_requests(idempotency_key,request_sha256,actor_user_id,conditional_hold_id,task_id,task_draft_id,provider_estimate_submission_id,routing_decision_id,scope_version_id,provider_user_id,provider_organization_id,eligibility_decision_id,eligibility_version,amount_cents,currency) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[key,liveHash,actor,live.conditional_hold_id,live.task_id,live.task_draft_id,live.provider_estimate_submission_id,live.routing_decision_id,live.scope_version_id,live.provider_user_id,live.provider_organization_id,live.eligibility_decision_id,live.eligibility_version,live.customer_total_cents,live.currency]);
      return {completed:false,context:live,idempotencyKey:key,requestSha256:liveHash,occurredAt:new Date(live.hold_reserved_at).toISOString()};
    });
  }
  async finalizeMaterialization(phase:Extract<WorkOrderMaterializationPhase,{completed:false}>,securedEventId:string,actor:string):Promise<WorkOrderResult>{
    return this.database.serializableTransaction(async q=>{
      const live=phase.context,key=phase.idempotencyKey;
      await q('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`work-order:${live.task_id}`]);
      await q('SELECT public.lock_universal_v1_estimate_authority($1,$2,$3,$4,$5)',[live.task_draft_id,live.provider_user_id,live.provider_organization_id,live.trade_credential_id,actor]);
      const witness=await q<WitnessRow>('SELECT request.idempotency_key,request.request_sha256,work_order.id work_order_id,work_order.financial_security_event_id FROM task_work_order_command_requests request LEFT JOIN task_work_orders work_order ON work_order.idempotency_key=request.idempotency_key WHERE request.idempotency_key=$1 FOR UPDATE OF request',[key]);
      if(witness.rows[0]?.work_order_id&&witness.rows[0].financial_security_event_id)return {work_order_id:witness.rows[0].work_order_id,financial_security_event_id:witness.rows[0].financial_security_event_id,replayed:true,hard_assignment_created:false,payment_creation_performed:false};
      if(witness.rows[0]?.request_sha256!==phase.requestSha256)throw new UniversalV1WorkOrderError('WORK_ORDER_IDEMPOTENCY_CONFLICT','Work Order witness changed.');
      const authority=await q<WorkOrderContext>(`SELECT t.id task_id,d.id task_draft_id,s.id scope_version_id,s.version scope_version,r.id routing_decision_id,
        p.provider_user_id,p.provider_organization_id,e.provider_class,e.trade_credential_id,e.id predecessor_eligibility_id,e.decision_version predecessor_eligibility_version,e.valid_until predecessor_valid_until,
        t.poster_id poster_user_id,a.id interest_application_id,e.id eligibility_decision_id,e.decision_version eligibility_version,e.valid_until eligibility_valid_until,
        h.id conditional_hold_id,h.reserved_at hold_reserved_at,h.expires_at hold_expires_at,m.provider_estimate_submission_id,s.customer_total_cents,s.currency
        FROM tasks t JOIN task_drafts d ON d.task_id=t.id JOIN task_scope_versions s ON s.id=t.active_scope_version_id
        JOIN task_routing_decisions r ON r.id=d.active_routing_decision_id JOIN task_estimate_acceptance_materializations m ON m.task_id=t.id AND m.scope_version_id=s.id
        JOIN provider_estimate_submissions p ON p.id=m.provider_estimate_submission_id JOIN task_provider_eligibility_decisions e ON e.id=$2
        JOIN task_applications a ON a.id=e.interest_application_id JOIN task_reservations h ON h.id=$3 AND h.eligibility_decision_id=e.id
        JOIN users poster ON poster.id=t.poster_id JOIN users provider ON provider.id=e.provider_user_id
        WHERE t.id=$1 AND t.poster_id=$4 AND t.universal_contract_version=1 AND t.automation_classification='CONTROLLED_TEST' AND t.worker_id IS NULL
        AND poster.account_status='ACTIVE' AND poster.is_minor IS FALSE AND COALESCE(poster.is_banned,false)=false
        AND provider.account_status='ACTIVE' AND provider.is_minor IS FALSE AND COALESCE(provider.is_banned,false)=false
        AND r.outcome='FULFILLMENT_CANDIDATE' AND e.task_eligible AND e.processor_payment_eligible=false AND e.payout_funding_eligible=false
        AND e.valid_until>clock_timestamp() AND a.status='pending' AND h.status='ACTIVE' AND h.expires_at>clock_timestamp()
        AND universal_v1_invited_provider_authority_is_current(e.provider_user_id,e.provider_organization_id,e.provider_class,e.trade_credential_id,t.category,t.region_code)
        AND NOT EXISTS(SELECT 1 FROM task_provider_eligibility_decisions n WHERE n.task_draft_id=e.task_draft_id AND n.provider_user_id=e.provider_user_id AND n.provider_organization_id IS NOT DISTINCT FROM e.provider_organization_id AND n.decision_version>e.decision_version)
        FOR UPDATE OF t,d,s,r,m,p,e,a,h,poster,provider`,[live.task_id,live.eligibility_decision_id,live.conditional_hold_id,actor]);
      const current=authority.rows[0];
      if(!current)throw new UniversalV1WorkOrderError('WORK_ORDER_AUTHORITY_REVOKED','Current Work Order authority is unavailable.');
      const currentHash=commandHash({actor,hold:current.conditional_hold_id,task:current.task_id,draft:current.task_draft_id,estimate:current.provider_estimate_submission_id,route:current.routing_decision_id,scope:current.scope_version_id,provider:current.provider_user_id,organization:current.provider_organization_id,eligibility:current.eligibility_decision_id,eligibility_version:current.eligibility_version,amount:Number(current.customer_total_cents),currency:current.currency});
      if(currentHash!==phase.requestSha256)throw new UniversalV1WorkOrderError('WORK_ORDER_AUTHORITY_REVOKED','Work Order authority changed after financial dispatch.');
      const secured=await q<{ok:boolean}>(`SELECT EXISTS(
        SELECT 1
        FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
        JOIN task_financial_security_events event
          ON event.id=bridge.task_financial_security_event_id
        JOIN financial_provider_command_journal command
          ON command.command_id=bridge.command_id
        JOIN financial_provider_command_outcome_facts outcome
          ON outcome.outcome_fact_id=bridge.outcome_fact_id
        WHERE bridge.task_financial_security_event_id=$1
          AND bridge.fake_operation_id=$2::uuid
          AND bridge.fake_operation_kind='SECURE'
          AND bridge.lifecycle_event_kind='SECURED'
          AND bridge.lifecycle_status='SUCCEEDED'
          AND command.operation_id=bridge.fake_operation_id
          AND command.operation_kind='SECURE'
          AND command.provider_kind='FAKE'
          AND command.provider_expected_version=0
          AND outcome.command_id=command.command_id
          AND outcome.outcome_kind='OUTCOME_OBSERVED'
          AND outcome.retryable=FALSE
          AND event.id=$1
          AND event.operation_id=bridge.fake_operation_id::text
          AND event.event_kind='SECURED'
          AND event.status='SUCCEEDED'
          AND event.provider_kind='FAKE'
          AND event.expected_version=2
          AND event.task_draft_id=$3
          AND event.task_id=$4
          AND event.eligibility_decision_id=$5
          AND event.scope_version_id=$6
          AND event.amount_cents=$7
          AND event.currency=$8
          AND outcome.provider_state=(event.evidence->>'providerState')
          AND outcome.provider_result_version=(event.evidence->>'providerOperationVersion')::INTEGER
      ) AS ok`,[securedEventId,deterministicUuid(key,'secure'),live.task_draft_id,live.task_id,live.eligibility_decision_id,live.scope_version_id,live.customer_total_cents,live.currency]);
      if(!secured.rows[0]?.ok)throw new UniversalV1WorkOrderError('WORK_ORDER_MATERIALIZATION_FAILED','Exact secured event is unavailable.');
      await q("SELECT set_config('hustlexp.work_order_command_sha256',$1,true)",[phase.requestSha256]);
      const w=await q<InsertedWorkOrder>(`INSERT INTO task_work_orders(task_draft_id,task_id,scope_version_id,routing_decision_id,provider_estimate_submission_id,interest_application_id,eligibility_decision_id,conditional_hold_id,financial_security_event_id,provider_user_id,provider_organization_id,materialization_version,idempotency_key,materialized_by,execution_contract_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,$12,$13,1) RETURNING id,materialized_at`,[live.task_draft_id,live.task_id,live.scope_version_id,live.routing_decision_id,live.provider_estimate_submission_id,live.interest_application_id,live.eligibility_decision_id,live.conditional_hold_id,securedEventId,live.provider_user_id,live.provider_organization_id,key,actor]);
      const executionKey=`${key}:execution:materialized`;
      await q(`INSERT INTO task_work_order_execution_facts(
        work_order_id,task_id,scope_version_id,execution_version,supersedes_fact_id,
        state,transition_kind,completion_fact_id,work_order_amendment_id,
        actor_role,actor_user_id,reason,idempotency_key,request_sha256,
        client_occurred_at,policy_version,recorded_at
      ) SELECT work_order.id,work_order.task_id,work_order.scope_version_id,1,NULL,
        'MATERIALIZED','MATERIALIZED',NULL,NULL,'CUSTOMER',work_order.materialized_by,
        NULL,$2,public.universal_v1_execution_internal_request_sha256(
          work_order.materialized_by,work_order.id,'MATERIALIZED','MATERIALIZED',0,
          work_order.scope_version_id,NULL,NULL,$2,work_order.materialized_at,NULL
        ),work_order.materialized_at,'universal-v1-work-order-execution-1.0.0',work_order.materialized_at
      FROM task_work_orders work_order WHERE work_order.id=$1`,[w.rows[0].id,executionKey]);
      const released=await q("UPDATE task_reservations SET status='RELEASED' WHERE id=$1 AND status='ACTIVE'",[live.conditional_hold_id]);
      if(released.rowCount!==1)throw new UniversalV1WorkOrderError('WORK_ORDER_AUTHORITY_REVOKED','Conditional hold was not released exactly once.');
      const closed=await q("UPDATE task_applications SET status='expired' WHERE id=$1 AND status='pending'",[live.interest_application_id]);
      if(closed.rowCount!==1)throw new UniversalV1WorkOrderError('WORK_ORDER_AUTHORITY_REVOKED','Provider interest was not closed exactly once.');
      const check=await q<AssignmentRow>('SELECT worker_id FROM tasks WHERE id=$1',[live.task_id]);
      if(check.rows[0]?.worker_id)throw new UniversalV1WorkOrderError('WORK_ORDER_HARD_ASSIGNMENT_FORBIDDEN','Universal V1 Work Orders cannot create hard assignment.');
      return {work_order_id:w.rows[0].id,financial_security_event_id:securedEventId,replayed:false,hard_assignment_created:false,payment_creation_performed:false};
    });
  }
}

export function deterministicUuid(key:string,label:string):string { const h=createHash('sha256').update(`${key}:${label}`).digest('hex').slice(0,32).split(''); h[12]='4';h[16]=((parseInt(h[16]!,16)&3)|8).toString(16);const s=h.join('');return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`; }
