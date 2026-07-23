import { createHash } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import { preparePublicClarification } from './TaskClarificationPolicy.js';
import { TaskReservationService } from './TaskReservationService.js';
import {
  listOpportunityRows,
  loadOpportunityRow,
  serviceBusinessOpportunity,
} from './ServiceBusinessOfferData.js';
import type {
  ServiceBusinessOfferReview,
  ServiceBusinessOpportunity,
  ServiceBusinessOpportunityRow,
} from './ServiceBusinessExecutionTypes.js';
import { buildWorkerOfferDecision, type WorkerOfferDecision } from './WorkerOfferDecisionPolicy.js';
import { serviceBusinessFailure } from './ServiceBusinessErrors.js';
export { quoteServiceBusinessOpportunity } from './ServiceBusinessQuoteService.js';
export {
  listServiceBusinessAssignments,
  listServiceBusinessEligibleCrew,
} from './ServiceBusinessAssignmentReadService.js';

class ServiceBusinessFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function fail(code: string, message: string): never {
  throw new ServiceBusinessFailure(code, message);
}

function failure<T>(error: unknown): ServiceResult<T> {
  if (error instanceof ServiceBusinessFailure) {
    return { success: false, error: { code: error.code, message: error.message } };
  }
  return serviceBusinessFailure(error, 'SERVICE_BUSINESS_FAILED', 'Service Business work could not be updated.');
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function linkServiceBusinessPayoutAccount(input: {
  actorId: string;
  organizationId: string;
  payoutMembershipId: string;
  idempotencyKey: string;
}): Promise<ServiceResult<{
  destinationKind: 'ORGANIZATION_ACCOUNT';
  status: 'ACTIVE';
}>> {
  try {
    const result = await db.query<{
      payout_account_id: string;
      payout_recipient_user_id: string;
      payout_status: 'ACTIVE';
    }>(
      `SELECT payout_account_id,payout_recipient_user_id,payout_status
       FROM link_business_provider_payout_account($1,$2,$3,$4)`,
      [input.organizationId,input.actorId,input.payoutMembershipId,input.idempotencyKey],
    );
    const row = result.rows[0] ?? fail('PAYOUT_ACCOUNT_LINK_FAILED', 'The provider payout account was not linked.');
    return { success: true, data: {
      destinationKind: 'ORGANIZATION_ACCOUNT',
      status: row.payout_status,
    } };
  } catch (error) { return failure(error); }
}

export async function listServiceBusinessOpportunities(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<ServiceBusinessOpportunity[]>> {
  try {
    const rows = await listOpportunityRows(db.query.bind(db), actorId, organizationId);
    return { success: true, data: rows.map(serviceBusinessOpportunity) };
  } catch (error) { return failure(error); }
}

function offerFor(row: ServiceBusinessOpportunityRow): WorkerOfferDecision {
  return buildWorkerOfferDecision({
    id: row.task_id,
    title: row.title,
    description: row.description,
    requirements: row.requirements,
    category: row.category,
    price: Number(row.customer_total_cents),
    hustler_payout_cents: Number(row.payout_cents),
    distance_range_min_miles: 0,
    distance_range_max_miles: row.maximum_travel_miles,
    distance_estimate_kind: 'SERVICE_ZONE_RANGE',
    distance_label: `Within verified ${row.maximum_travel_miles} mile service zone`,
    estimated_duration_minutes: row.estimated_duration_minutes,
    rough_location: row.rough_location,
    risk_level: row.risk_level,
    required_tools: row.required_tools,
    deadline: row.deadline,
    scope_hash: row.scope_hash,
    cancellation_policy_version: row.cancellation_policy_version,
    late_cancel_pct: row.late_cancel_pct,
    cancellation_window_hours: row.cancellation_window_hours,
    minimum_provider_net_hourly_cents: row.minimum_provider_net_hourly_cents,
    provider_earnings_policy_version: row.provider_earnings_policy_version,
  }, { matchingScore: 1, distanceScore: 1, categoryMatch: 1, timeMatch: 1, trustMatch: 1 });
}

interface AssignmentEvaluation {
  ready: boolean;
  blockers: string[];
  payout_recipient_user_id: string;
  fulfiller_user_id: string;
  fulfiller_name: string;
}

async function evaluateAssignment(query: QueryFn, input: {
  actorId: string; organizationId: string; serviceProfileId: string;
  crewAssignmentId: string; taskId: string; offerDecisionId?: string | null;
}): Promise<AssignmentEvaluation> {
  const result = await query<AssignmentEvaluation>(
    `SELECT evaluation.ready,evaluation.blockers,
            evaluation.payout_recipient_user_id,evaluation.fulfiller_user_id,
            COALESCE(NULLIF(BTRIM(fulfiller.full_name),''),'Verified crew member') AS fulfiller_name
       FROM evaluate_service_business_assignment($1,$2,$3,$4,$5,$6) evaluation
       LEFT JOIN users fulfiller ON fulfiller.id=evaluation.fulfiller_user_id`,
    [input.organizationId,input.actorId,input.serviceProfileId,input.crewAssignmentId,
      input.taskId,input.offerDecisionId ?? null],
  );
  return result.rows[0] ?? fail('SERVICE_BUSINESS_INELIGIBLE', 'Service Business readiness could not be established.');
}

export async function reviewServiceBusinessOpportunity(input: {
  actorId: string; organizationId: string; serviceProfileId: string;
  crewAssignmentId: string; taskId: string; idempotencyKey: string;
}): Promise<ServiceResult<ServiceBusinessOfferReview>> {
  const requestHash = hash(input);
  try {
    const data = await db.transaction(async (query) => {
      const replay = await query<{ request_hash: string; offer_decision_id: string; snapshot: WorkerOfferDecision; expires_at: string | Date; worker_id: string }>(
        `SELECT request.request_hash,request.offer_decision_id,offer.snapshot,offer.expires_at,offer.worker_id
         FROM business_service_offer_review_requests request
         JOIN worker_offer_decisions offer ON offer.id=request.offer_decision_id
         WHERE request.organization_id=$1 AND request.actor_id=$2 AND request.idempotency_key=$3`,
        [input.organizationId,input.actorId,input.idempotencyKey],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash!==requestHash) fail('IDEMPOTENCY_CONFLICT', 'This review key was used for another offer.');
        const current = await evaluateAssignment(query, { ...input, offerDecisionId: replay.rows[0].offer_decision_id });
        return {
          offerDecisionId: replay.rows[0].offer_decision_id,
          crewAssignmentId: input.crewAssignmentId,
          fulfillerName: current.fulfiller_name,
          payoutDestination: { kind: 'ORGANIZATION_ACCOUNT' as const, state: 'ACTIVE' as const },
          decision: replay.rows[0].snapshot,
          expiresAt: new Date(replay.rows[0].expires_at).toISOString(),
          idempotencyReplayed: true,
        };
      }
      const row = await loadOpportunityRow(query, input)
        ?? fail('OPPORTUNITY_NOT_AVAILABLE', 'This opportunity is no longer available to the service profile.');
      const evaluation = await evaluateAssignment(query, { ...input, offerDecisionId: null });
      if (!evaluation.ready) fail('SERVICE_BUSINESS_INELIGIBLE', `Resolve: ${evaluation.blockers.join(', ')}`);
      const decision = offerFor(row);
      if (!decision.decisionReady) fail('OFFER_NOT_READY', `Offer is incomplete: ${decision.blockingReasons.join(', ')}`);
      const snapshot = { ...decision, provider: {
        organizationId: input.organizationId, serviceProfileId: input.serviceProfileId,
        crewAssignmentId: input.crewAssignmentId, fulfillerUserId: evaluation.fulfiller_user_id,
        payoutRecipientUserId: evaluation.payout_recipient_user_id,
      } };
      const payloadHash = hash(snapshot);
      const inserted = await query<{ id: string; expires_at: string | Date }>(
        `INSERT INTO worker_offer_decisions(
          task_id,worker_id,policy_version,payload_hash,decision_ready,blocking_reasons,
          customer_total_cents,payout_cents,insurance_adjustment_cents,net_payout_cents,
          estimated_net_hourly_cents,minimum_net_hourly_cents,provider_earnings_policy_version,
          provider_earnings_floor_met,distance_miles,estimated_travel_time_minutes,
          travel_time_policy_version,estimated_duration_minutes,scope_hash,
          cancellation_policy_version,rank_score,rank_reasons,paid_promotion_affects_rank,
          passing_has_rank_penalty,snapshot,expires_at,provider_organization_id,
          provider_service_profile_id,provider_crew_assignment_id,reviewed_by
        ) VALUES ($1,$2,$3,$4,TRUE,'[]'::jsonb,$5,$6,$7,$8,$9,$10,$11,TRUE,NULL,$12,$13,$14,$15,$16,
          $17,$18::jsonb,FALSE,FALSE,$19::jsonb,NOW()+INTERVAL '30 minutes',$20,$21,$22,$23)
        RETURNING id,expires_at`,
        [row.task_id,evaluation.fulfiller_user_id,decision.policyVersion,payloadHash,
          decision.economics.customerTotalCents,decision.economics.payoutCents,
          decision.economics.insuranceAdjustmentCents,decision.economics.netPayoutCents,
          decision.economics.estimatedNetHourlyCents,decision.economics.minimumNetHourlyCents,
          row.provider_earnings_policy_version,decision.logistics.estimatedTravelTimeMinutes,
          decision.logistics.travelTimePolicyVersion,decision.logistics.estimatedDurationMinutes,
          decision.scope.scopeHash,decision.cancellation.policyVersion,decision.ranking.score,
          JSON.stringify(decision.ranking.reasons),JSON.stringify(snapshot),input.organizationId,
          input.serviceProfileId,input.crewAssignmentId,input.actorId],
      );
      const offer = inserted.rows[0] ?? fail('OFFER_PERSISTENCE_FAILED', 'The provider offer was not recorded.');
      await query(
        `INSERT INTO business_service_offer_review_requests(
          organization_id,actor_id,task_id,service_profile_id,crew_assignment_id,
          offer_decision_id,idempotency_key,request_hash
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [input.organizationId,input.actorId,input.taskId,input.serviceProfileId,
          input.crewAssignmentId,offer.id,input.idempotencyKey,requestHash],
      );
      return {
        offerDecisionId: offer.id,
        crewAssignmentId: input.crewAssignmentId,
        fulfillerName: evaluation.fulfiller_name,
        payoutDestination: { kind: 'ORGANIZATION_ACCOUNT' as const, state: 'ACTIVE' as const },
        decision,
        expiresAt: new Date(offer.expires_at).toISOString(),
        idempotencyReplayed: false,
      };
    });
    return { success: true, data };
  } catch (error) { return failure(error); }
}

export async function acceptServiceBusinessOpportunity(input: {
  actorId: string; organizationId: string; serviceProfileId: string;
  crewAssignmentId: string; offerDecisionId: string;
  taskId: string; idempotencyKey: string;
}): Promise<ServiceResult<{ action: 'ACCEPTED'; reservationId: string; idempotencyReplayed: boolean }>> {
  let evaluation: AssignmentEvaluation;
  try {
    evaluation = await evaluateAssignment(db.query.bind(db), {
      ...input,
      offerDecisionId: input.offerDecisionId,
    });
    if (!evaluation.ready) {
      fail(
        'SERVICE_BUSINESS_INELIGIBLE',
        `Resolve: ${evaluation.blockers.join(', ')}`,
      );
    }
  } catch (error) {
    return failure(error);
  }
  const reserved = await TaskReservationService.reserve({
    engineTaskId: input.taskId,hustlerRef: evaluation.fulfiller_user_id,
    actorId: input.actorId,idempotencyKey: input.idempotencyKey,
    serviceBusiness: {
      organizationId: input.organizationId,serviceProfileId: input.serviceProfileId,
      crewAssignmentId: input.crewAssignmentId,offerDecisionId: input.offerDecisionId,
    },
  });
  if (!reserved.success) return { success: false, error: reserved.error };
  return { success: true, data: {
    action: 'ACCEPTED',reservationId: reserved.data.reservationId,
    idempotencyReplayed: reserved.data.idempotencyReplayed,
  } };
}

async function recordResponse(query: QueryFn, input: {
  offerDecisionId: string; organizationId: string; actorId: string;
  action: 'DECLINED' | 'CLARIFICATION_REQUESTED'; idempotencyKey: string;
  requestHash: string; details: Record<string, unknown>;
}) {
  const result = await query<{ event_id: string; replayed: boolean }>(
    `SELECT event_id,replayed FROM record_business_service_offer_response($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [input.offerDecisionId,input.organizationId,input.actorId,input.action,input.idempotencyKey,
      input.requestHash,JSON.stringify(input.details)],
  );
  return result.rows[0] ?? fail('RESPONSE_PERSISTENCE_FAILED', 'The provider response was not recorded.');
}

export async function declineServiceBusinessOpportunity(input: {
  actorId: string; organizationId: string; offerDecisionId: string;
  reasonCode: string; idempotencyKey: string;
}): Promise<ServiceResult<{ action: 'DECLINED'; eventId: string; idempotencyReplayed: boolean }>> {
  const requestHash = hash(input);
  try {
    const event = await recordResponse(db.query.bind(db), {
      ...input,action:'DECLINED',requestHash,details:{ reasonCode: input.reasonCode },
    });
    return { success: true, data: { action:'DECLINED',eventId:event.event_id,idempotencyReplayed:event.replayed } };
  } catch (error) { return failure(error); }
}

export async function clarifyServiceBusinessOpportunity(input: {
  actorId: string; organizationId: string; offerDecisionId: string;
  question: string; idempotencyKey: string;
}): Promise<ServiceResult<{ action: 'CLARIFICATION_REQUESTED'; questionId: string; idempotencyReplayed: boolean }>> {
  const prepared = preparePublicClarification(input.question);
  const requestHash = hash({ ...input,question:prepared.text });
  try {
    const data = await db.transaction(async (query) => {
      const task = await query<{ id:string;poster_id:string;state:string }>(
        `WITH authority AS (SELECT business_require_action($1,$2,'ASSIGN_CREW'))
         SELECT task.id,task.poster_id,task.state FROM tasks task CROSS JOIN authority
         JOIN worker_offer_decisions offer ON offer.task_id=task.id
          AND offer.id=$3 AND offer.provider_organization_id=$1
         WHERE task.state IN ('OPEN','MATCHING') FOR UPDATE OF task`,
        [input.organizationId,input.actorId,input.offerDecisionId],
      );
      const current = task.rows[0] ?? fail('OPPORTUNITY_NOT_AVAILABLE', 'The task is no longer open for clarification.');
      const offer = await query<{ id:string;worker_id:string }>(
        `SELECT id,worker_id FROM worker_offer_decisions WHERE id=$1
          AND provider_organization_id=$2 AND decision_ready=TRUE AND expires_at>NOW() FOR SHARE`,
        [input.offerDecisionId,input.organizationId],
      );
      if (!offer.rows[0]) fail('OFFER_NOT_CURRENT', 'The reviewed offer is no longer current.');
      const inserted = await query<{ id:string;status:string }>(
        `INSERT INTO task_public_questions(task_id,asked_by,question_text,question_hash,idempotency_key)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (task_id,asked_by,idempotency_key) DO NOTHING
         RETURNING id,status`,
        [current.id,input.actorId,prepared.text,prepared.hash,input.idempotencyKey],
      );
      let question = inserted.rows[0];
      if (!question) {
        const replay = await query<{ id:string;status:string;question_hash:string }>(
          `SELECT id,status,question_hash FROM task_public_questions
            WHERE task_id=$1 AND asked_by=$2 AND idempotency_key=$3`,
          [current.id,input.actorId,input.idempotencyKey],
        );
        if (replay.rows[0]?.question_hash!==prepared.hash) fail('IDEMPOTENCY_CONFLICT', 'This clarification key was used for another question.');
        question = replay.rows[0];
      }
      await query(`UPDATE tasks SET clarification_state='QUESTION_OPEN',updated_at=NOW() WHERE id=$1`,[current.id]);
      const event = await recordResponse(query, {
        ...input,action:'CLARIFICATION_REQUESTED',requestHash,details:{ questionId:question.id },
      });
      return { questionId:question.id,idempotencyReplayed:event.replayed };
    });
    return { success:true,data:{ action:'CLARIFICATION_REQUESTED',...data } };
  } catch (error) { return failure(error); }
}
