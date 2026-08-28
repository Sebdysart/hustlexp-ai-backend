import { createHash } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { buildTaskScopeHash } from './TaskServiceShared.js';
import type { ServiceBusinessQuoteResult } from './ServiceBusinessExecutionTypes.js';
import { serviceBusinessFailure } from './ServiceBusinessErrors.js';
import {
  evaluateWorkerCounter,
  WORKER_COUNTER_LIMITS,
  WORKER_COUNTER_POLICY_VERSION,
} from './WorkerCounterOfferPolicy.js';

class QuoteFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function fail(code: string, message: string): never { throw new QuoteFailure(code,message); }
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function normalized(value: string): string { return value.trim().replace(/\s+/gu,' '); }

function failure(error: unknown): ServiceResult<ServiceBusinessQuoteResult> {
  return error instanceof QuoteFailure
    ? { success:false,error:{ code:error.code,message:error.message } }
    : serviceBusinessFailure(error,'SERVICE_BUSINESS_QUOTE_FAILED','The Service Business quote was not recorded.');
}

interface QuoteTask {
  id:string; poster_id:string; state:string; title:string; description:string;
  requirements:string|null; price:number; hustler_payout_cents:number;
  platform_margin_cents:number; scope_hash:string; active_scope_version_id:string;
  clarification_state:string;
}
interface QuoteOffer {
  id:string; worker_id:string; provider_organization_id:string;
  provider_service_profile_id:string; provider_crew_assignment_id:string;
  customer_total_cents:number; payout_cents:number; scope_hash:string;
  expires_at:string|Date;
}
interface QuoteCounter {
  id:string; task_id:string; worker_id:string; status:string;
  current_customer_total_cents:number; current_payout_cents:number;
  platform_margin_cents:number; minimum_counter_payout_cents:number;
  maximum_counter_payout_cents:number; customer_maximum_cents:number;
  margin_floor_bps:number; proposed_payout_cents:number;
  proposed_customer_total_cents:number; reason:string; replacement_task_id:string|null;
  expires_at:string|Date;
}
interface QuoteInput {
  actorId:string; organizationId:string; offerDecisionId:string;
  proposedPayoutCents:number; reason:string; idempotencyKey:string;
}

function result(row: QuoteCounter,replayed:boolean): ServiceBusinessQuoteResult {
  return {
    action:'QUOTED',counterOfferId:row.id,
    proposedCustomerTotalCents:Number(row.proposed_customer_total_cents),
    proposedPayoutCents:Number(row.proposed_payout_cents),
    requiresPaymentReauthorization:['APPROVED_REAUTH_REQUIRED','MATERIALIZED'].includes(row.status),
    idempotencyReplayed:replayed,
  };
}

function requireQuoteTaskReady(task:QuoteTask):void {
  if (!task.active_scope_version_id) fail('QUOTE_NOT_READY','The current scope version is unavailable.');
  if (!task.scope_hash) fail('QUOTE_NOT_READY','The current scope hash is unavailable.');
  if (task.clarification_state!=='READY') {
    fail('QUOTE_NOT_READY','Resolve task clarification before quoting.');
  }
}

async function appendResponse(query:QueryFn,input:{
  offerDecisionId:string;organizationId:string;actorId:string;idempotencyKey:string;
  requestHash:string;counterId:string;
}) {
  await query(
    `SELECT event_id,replayed FROM record_business_service_offer_response(
      $1,$2,$3,'QUOTED',$4,$5,$6::jsonb)`,
    [input.offerDecisionId,input.organizationId,input.actorId,input.idempotencyKey,
      input.requestHash,JSON.stringify({ counterOfferId:input.counterId })],
  );
}

async function restoreQuoteReplay(
  query:QueryFn,
  input:QuoteInput,
  requestHash:string,
):Promise<ServiceBusinessQuoteResult|null> {
  const prior=await query<{event_type:string|null;request_hash:string|null}>(
    `SELECT event_type,request_hash FROM worker_counter_offer_events
      WHERE actor_id=$1 AND idempotency_key=$2`,[input.actorId,input.idempotencyKey],
  );
  if (!prior.rows[0]?.event_type) return null;
  if (prior.rows[0].request_hash!==requestHash) {
    fail('IDEMPOTENCY_CONFLICT','This quote key was used for another proposal.');
  }
  const replay=await query<QuoteCounter>(
    `SELECT counter.* FROM worker_counter_offers counter
      JOIN worker_counter_offer_events event ON event.counter_offer_id=counter.id
     WHERE event.actor_id=$1 AND event.idempotency_key=$2`,[input.actorId,input.idempotencyKey],
  );
  return result(replay.rows[0]??fail('QUOTE_REPLAY_MISSING','The prior quote could not be restored.'),true);
}

export async function quoteServiceBusinessOpportunity(
  input:QuoteInput,
):Promise<ServiceResult<ServiceBusinessQuoteResult>> {
  const reason=normalized(input.reason);
  if (!Number.isInteger(input.proposedPayoutCents) || reason.length<10 || reason.length>500) {
    return { success:false,error:{ code:'INVALID_INPUT',message:'A bounded payout and reason are required.' } };
  }
  const requestHash=hash({ ...input,reason });
  try {
    const data=await db.transaction(async(query)=>{
      const replay=await restoreQuoteReplay(query,input,requestHash);
      if (replay) return replay;
      const taskResult=await query<QuoteTask>(
        `WITH authority AS (SELECT business_require_action($1,$2,'ASSIGN_CREW'))
         SELECT task.id,task.poster_id,task.state,task.title,task.description,task.requirements,
                task.price,task.hustler_payout_cents,task.platform_margin_cents,task.scope_hash,
                task.active_scope_version_id,task.clarification_state
           FROM tasks task CROSS JOIN authority
           JOIN worker_offer_decisions offer ON offer.task_id=task.id AND offer.id=$3
             AND offer.provider_organization_id=$1
          WHERE task.state IN ('OPEN','MATCHING') FOR UPDATE OF task`,
        [input.organizationId,input.actorId,input.offerDecisionId],
      );
      const task=taskResult.rows[0]??fail('OPPORTUNITY_NOT_AVAILABLE','The task is no longer open for a quote.');
      requireQuoteTaskReady(task);
      const escrow=await query<{state:string}>(
        `SELECT state FROM escrows WHERE task_id=$1 FOR SHARE`,[task.id],
      );
      if (escrow.rows[0]?.state!=='FUNDED') fail('TASK_NOT_FUNDED','A provider quote requires funded customer terms.');
      const offerResult=await query<QuoteOffer>(
        `SELECT id,worker_id,provider_organization_id,provider_service_profile_id,
                provider_crew_assignment_id,customer_total_cents,payout_cents,scope_hash,expires_at
           FROM worker_offer_decisions WHERE id=$1 AND provider_organization_id=$2
            AND decision_ready=TRUE AND expires_at>NOW() AND customer_total_cents=$3
            AND payout_cents=$4 AND scope_hash=$5 FOR UPDATE`,
        [input.offerDecisionId,input.organizationId,task.price,task.hustler_payout_cents,task.scope_hash],
      );
      const offer=offerResult.rows[0]??fail('OFFER_NOT_CURRENT','The reviewed provider offer is no longer current.');
      const scope=await query<{id:string;checklist:string[]}>(
        `SELECT id,checklist FROM task_scope_versions WHERE id=$1 AND task_id=$2 FOR SHARE`,
        [task.active_scope_version_id,task.id],
      );
      const currentScope=scope.rows[0]??fail('QUOTE_NOT_READY','The current scope version is unavailable.');
      const decision=evaluateWorkerCounter({
        customerTotalCents:Number(task.price),payoutCents:Number(task.hustler_payout_cents),
        platformMarginCents:Number(task.platform_margin_cents),proposedPayoutCents:input.proposedPayoutCents,
      });
      if (!decision.accepted) fail('QUOTE_OUT_OF_BOUNDS','The proposed payout is outside the deterministic corridor.');
      const proposedScopeHash=buildTaskScopeHash({
        title:task.title,description:task.description,requirements:task.requirements,
        checklist:currentScope.checklist,customerTotalCents:decision.proposedCustomerTotalCents,
        hustlerPayoutCents:input.proposedPayoutCents,
      });
      const expiresAt=new Date(Math.min(new Date(offer.expires_at).getTime(),Date.now()+WORKER_COUNTER_LIMITS.expiresMinutes*60_000));
      const inserted=await query<QuoteCounter>(
        `INSERT INTO worker_counter_offers(
          task_id,worker_id,offer_decision_id,source_scope_version_id,proposed_scope_hash,
          policy_version,request_hash,idempotency_key,status,current_customer_total_cents,
          current_payout_cents,platform_margin_cents,minimum_counter_payout_cents,
          maximum_counter_payout_cents,customer_maximum_cents,margin_floor_bps,
          proposed_payout_cents,proposed_customer_total_cents,reason,expires_at,
          provider_organization_id,provider_service_profile_id,provider_crew_assignment_id,requested_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PENDING_POSTER',$9,$10,$11,$12,$13,$14,$15,
          $16,$17,$18,$19,$20,$21,$22,$23) RETURNING *`,
        [task.id,offer.worker_id,offer.id,currentScope.id,proposedScopeHash,
          WORKER_COUNTER_POLICY_VERSION,requestHash,input.idempotencyKey,
          decision.currentCustomerTotalCents,decision.currentPayoutCents,decision.platformMarginCents,
          decision.minimumCounterPayoutCents,decision.maximumCounterPayoutCents,
          decision.customerMaximumCents,decision.marginFloorBps,input.proposedPayoutCents,
          decision.proposedCustomerTotalCents,reason,expiresAt.toISOString(),input.organizationId,
          offer.provider_service_profile_id,offer.provider_crew_assignment_id,input.actorId],
      );
      const counter=inserted.rows[0]??fail('QUOTE_PERSISTENCE_FAILED','The provider quote was not recorded.');
      await query(
        `INSERT INTO worker_counter_offer_events(
          counter_offer_id,event_type,actor_id,idempotency_key,request_hash,details
        ) VALUES ($1,'SUBMITTED',$2,$3,$4,$5::jsonb)`,
        [counter.id,input.actorId,input.idempotencyKey,requestHash,
          JSON.stringify({ proposedPayoutCents:input.proposedPayoutCents,providerOrganizationId:input.organizationId })],
      );
      await appendResponse(query,{...input,requestHash,counterId:counter.id});
      return result(counter,false);
    });
    return {success:true,data};
  } catch(error){ return failure(error); }
}
