import { createHash, createHmac, randomUUID } from 'node:crypto';
import { db, type QueryFn } from '../db.js';
import type { ServiceResult } from '../types.js';
import {
  buildWorkerOfferDecision,
  type WorkerOfferDecision,
} from './WorkerOfferDecisionPolicy.js';
import {
  CONTROLLED_TEST_MINIMUM_PROVIDER_NET_HOURLY_CENTS,
  CONTROLLED_TEST_PROVIDER_EARNINGS_POLICY_VERSION,
} from './ControlledTestLiquidityService.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;
type OfferAction = 'VIEWED' | 'ACCEPTED';

interface OfferContext {
  id: string;
  title: string;
  description: string;
  requirements: string | null;
  category: string;
  price: number;
  hustler_payout_cents: number | null;
  estimated_duration_minutes: number | null;
  rough_location: string | null;
  risk_level: string;
  required_tools: string[];
  deadline: string | Date | null;
  scope_hash: string | null;
  cancellation_policy_version: string | null;
  late_cancel_pct: number | null;
  cancellation_window_hours: number | null;
  automation_classification: string | null;
  region_code: string | null;
  state: string;
  worker_id: string | null;
  poster_id: string;
  duration_evidence_id: string | null;
  duration_min_minutes: number | null;
  duration_expected_minutes: number | null;
  duration_max_minutes: number | null;
  duration_policy_version: string | null;
  capability_evidence_id: string | null;
  service_city: string | null;
  service_state: string | null;
  service_radius_miles: number | null;
  provider_tools: string[];
  liquidity_cell_id: string | null;
  liquidity_witness_id: string | null;
  liquidity_ready: boolean;
  minimum_provider_net_hourly_cents: number | null;
  provider_earnings_policy_version: string | null;
  provider_earnings_policy_state: string | null;
}

interface ActionReplayRow {
  action_type: OfferAction;
  task_id: string;
  worker_id: string;
  offer_decision_id: string;
  request_hash: string;
  snapshot: ControlledTestOfferSnapshot;
}

interface ControlledTestOfferSnapshot extends WorkerOfferDecision {
  evidence: {
    reviewActionId: string;
    durationEvidenceId: string;
    providerCapabilityEvidenceId: string;
    liquidityWitnessId: string;
  };
  issuedAt: string;
  expiresAt: string;
}

interface AcceptanceContext {
  offer_decision_id: string;
  task_id: string;
  worker_id: string;
  decision_ready: boolean;
  expires_at: string | Date;
  snapshot: ControlledTestOfferSnapshot;
  review_action_id: string;
  duration_evidence_id: string;
  provider_capability_evidence_id: string;
  liquidity_witness_id: string;
  task_state: string;
  task_worker_id: string | null;
  automation_classification: string;
  liquidity_ready: boolean;
  exact_evidence_current: boolean;
  offer_current: boolean;
}

export interface ReviewControlledTestOfferParams {
  taskId: string;
  workerId: string;
  idempotencyKey: string;
}

export interface AcceptControlledTestOfferParams extends ReviewControlledTestOfferParams {
  offerDecisionId: string;
}

function failure(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function secret(env: Environment): string {
  return env.HXOS_LOCAL_TEST_OFFER_REVIEW_SECRET?.trim() ?? '';
}

export function controlledTestOfferReviewEnabled(env: Environment = process.env): boolean {
  return env.NODE_ENV !== 'production'
    && env.HXOS_ALLOW_LOCAL_TEST_OFFER_REVIEW === 'true'
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && secret(env).length >= 32;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function validKey(value: string): boolean {
  return value.length >= 8 && value.length <= 200 && /^[A-Za-z0-9:_-]+$/.test(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function attestation(hash: string, env: Environment = process.env): string {
  return createHmac('sha256', secret(env)).update(hash).digest('hex');
}

async function replay(
  query: QueryFn,
  workerId: string,
  idempotencyKey: string,
): Promise<ActionReplayRow | undefined> {
  const result = await query<ActionReplayRow>(
    `SELECT action.action_type,action.task_id,action.worker_id,action.offer_decision_id,
            action.request_hash,offer.snapshot
       FROM hxos_local_test_offer_actions action
       JOIN worker_offer_decisions offer ON offer.id=action.offer_decision_id
      WHERE action.worker_id=$1 AND action.idempotency_key=$2 FOR SHARE OF action,offer`,
    [workerId, idempotencyKey],
  );
  return result.rows[0];
}

function reviewContextReady(context: OfferContext, workerId: string): boolean {
  const normalizedProviderTools = new Set(context.provider_tools.map((tool) => tool.trim().toLowerCase()));
  return context.automation_classification === 'CONTROLLED_TEST'
    && ['OPEN', 'MATCHING'].includes(context.state)
    && context.worker_id === null
    && context.poster_id !== workerId
    && Boolean(context.duration_evidence_id)
    && Number.isInteger(context.duration_min_minutes)
    && Number.isInteger(context.estimated_duration_minutes)
    && Number.isInteger(context.duration_expected_minutes)
    && Number.isInteger(context.duration_max_minutes)
    && context.estimated_duration_minutes === context.duration_expected_minutes
    && context.duration_min_minutes! <= context.estimated_duration_minutes!
    && context.estimated_duration_minutes! <= context.duration_max_minutes!
    && context.duration_policy_version === 'price-book-duration-v1'
    && Boolean(context.capability_evidence_id)
    && Boolean(context.service_city)
    && /^[A-Z]{2}$/.test(context.service_state ?? '')
    && context.region_code === `US-${context.service_state}`
    && Number.isInteger(context.service_radius_miles)
    && context.service_radius_miles! > 0
    && context.service_radius_miles! <= 100
    && context.required_tools.every((tool) => normalizedProviderTools.has(tool.trim().toLowerCase()))
    && Boolean(context.liquidity_cell_id)
    && Boolean(context.liquidity_witness_id)
    && context.liquidity_ready === true
    && context.minimum_provider_net_hourly_cents
      === CONTROLLED_TEST_MINIMUM_PROVIDER_NET_HOURLY_CENTS
    && context.provider_earnings_policy_version
      === CONTROLLED_TEST_PROVIDER_EARNINGS_POLICY_VERSION
    && context.provider_earnings_policy_state === 'TEST_HYPOTHESIS';
}

function decisionFor(context: OfferContext): WorkerOfferDecision {
  return buildWorkerOfferDecision({
    ...context,
    distance_miles: null,
    distance_range_min_miles: 0,
    distance_range_max_miles: context.service_radius_miles,
    distance_estimate_kind: 'SERVICE_ZONE_RANGE',
    distance_label: `Within your ${context.service_radius_miles}-mile ${context.service_city} service zone`,
    duration_range_min_minutes: context.duration_min_minutes,
    duration_range_max_minutes: context.duration_max_minutes,
    duration_policy_version: context.duration_policy_version,
    minimum_provider_net_hourly_cents: context.minimum_provider_net_hourly_cents,
    provider_earnings_policy_version: context.provider_earnings_policy_version,
  }, {
    distanceScore: 1,
    categoryMatch: 1,
    trustMatch: 1,
  });
}

function snapshotFor(
  decision: WorkerOfferDecision,
  context: OfferContext,
  reviewActionId: string,
  issuedAt: string,
  expiresAt: string,
): ControlledTestOfferSnapshot {
  return {
    ...decision,
    evidence: {
      reviewActionId,
      durationEvidenceId: context.duration_evidence_id!,
      providerCapabilityEvidenceId: context.capability_evidence_id!,
      liquidityWitnessId: context.liquidity_witness_id!,
    },
    issuedAt,
    expiresAt,
  };
}

async function loadReviewContext(query: QueryFn, taskId: string, workerId: string): Promise<OfferContext | undefined> {
  const result = await query<OfferContext>(
    `SELECT task.id,task.title,task.description,task.requirements,task.category,task.price,
            task.hustler_payout_cents,task.estimated_duration_minutes,task.rough_location,
            task.risk_level,task.required_tools,task.deadline,task.scope_hash,
            task.cancellation_policy_version,task.late_cancel_pct,task.cancellation_window_hours,
            task.automation_classification,task.region_code,task.state,task.worker_id,task.poster_id,
            duration_evidence.id AS duration_evidence_id,
            duration_evidence.duration_min_minutes,duration_evidence.duration_expected_minutes,
            duration_evidence.duration_max_minutes,
            duration_evidence.policy_version AS duration_policy_version,
            capability_evidence.id AS capability_evidence_id,capability_evidence.service_city,
            capability_evidence.service_state,capability_evidence.service_radius_miles,
            capability_evidence.tools AS provider_tools,task.liquidity_cell_id,
            liquidity_witness.id AS liquidity_witness_id,
            liquidity_cell.minimum_provider_net_hourly_cents,
            liquidity_cell.provider_earnings_policy_version,
            liquidity_cell.provider_earnings_policy_state,
            hxos_local_test_liquidity_witness_current_v2(task.id,$2,task.liquidity_cell_id) AS liquidity_ready
       FROM tasks task
       JOIN users worker ON worker.id=$2 AND worker.default_mode='worker'
         AND worker.account_status='ACTIVE' AND worker.is_minor IS FALSE
         AND COALESCE(worker.is_banned,FALSE) IS FALSE
       JOIN hxos_local_test_duration_evidence duration_evidence ON duration_evidence.task_id=task.id
       JOIN hxos_local_test_provider_capability_evidence capability_evidence
         ON capability_evidence.task_id=task.id AND capability_evidence.worker_id=worker.id
         AND capability_evidence.expires_at>NOW()
       JOIN zone_category_cells liquidity_cell ON liquidity_cell.id=task.liquidity_cell_id
         AND liquidity_cell.environment='CONTROLLED_TEST' AND liquidity_cell.is_test IS TRUE
       JOIN LATERAL (
         SELECT witness.id FROM hxos_local_test_liquidity_witnesses witness
         WHERE witness.task_id=task.id AND witness.worker_id=worker.id
           AND witness.cell_id=task.liquidity_cell_id
           AND witness.provider_capability_evidence_id=capability_evidence.id
           AND witness.created_at>=NOW()-INTERVAL '15 minutes'
         ORDER BY witness.created_at DESC LIMIT 1
       ) liquidity_witness ON TRUE
      WHERE task.id=$1 FOR SHARE OF task,worker,duration_evidence,capability_evidence,liquidity_witness`,
    [taskId, workerId],
  );
  return result.rows[0];
}

function response(
  action: OfferAction,
  taskId: string,
  workerId: string,
  offerDecisionId: string,
  decision: ControlledTestOfferSnapshot,
  replayed: boolean,
) {
  return {
    taskId,
    workerId,
    offerDecisionId,
    eventType: action,
    decision,
    isTest: true as const,
    idempotencyReplayed: replayed,
  };
}

export const ControlledTestOfferReviewService = {
  review: async (params: ReviewControlledTestOfferParams) => {
    if (!controlledTestOfferReviewEnabled()) return failure('LOCAL_TEST_OFFER_REVIEW_DISABLED', 'Controlled TEST offer review is disabled.');
    if (!uuid(params.taskId) || !uuid(params.workerId) || !validKey(params.idempotencyKey)) {
      return failure('LOCAL_TEST_OFFER_REVIEW_INVALID', 'Controlled TEST offer review input is invalid.');
    }
    const requestHash = digest({ action: 'VIEWED', taskId: params.taskId, workerId: params.workerId });
    try {
      return await db.transaction(async (query) => {
        await query(`SELECT pg_advisory_xact_lock(hashtext('local-test-offer-review'),hashtext($1))`, [params.idempotencyKey]);
        const prior = await replay(query, params.workerId, params.idempotencyKey);
        if (prior) {
          return prior.action_type === 'VIEWED' && prior.task_id === params.taskId && prior.request_hash === requestHash
            ? { success: true as const, data: response('VIEWED', prior.task_id, prior.worker_id, prior.offer_decision_id, prior.snapshot, true) }
            : failure('LOCAL_TEST_OFFER_IDEMPOTENCY_CONFLICT', 'Offer review idempotency conflict.');
        }
        const context = await loadReviewContext(query, params.taskId, params.workerId);
        if (!context || !reviewContextReady(context, params.workerId)) {
          return failure('LOCAL_TEST_OFFER_NOT_READY', 'The controlled TEST offer lacks current decision evidence.');
        }
        const decision = decisionFor(context);
        if (!decision.decisionReady) {
          return failure('LOCAL_TEST_OFFER_NOT_READY', `Offer is incomplete: ${decision.blockingReasons.join(',')}`);
        }
        await query(`SELECT set_config('hustlexp.local_test_offer_review_enabled','true',true)`);
        const reviewActionId = randomUUID();
        const issuedAt = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
        const decisionSnapshot = snapshotFor(decision, context, reviewActionId, issuedAt, expiresAt);
        const snapshot = JSON.stringify(decisionSnapshot);
        const payloadHash = digest(decisionSnapshot);
        const inserted = await query<{ id: string }>(
          `INSERT INTO worker_offer_decisions(
             task_id,worker_id,policy_version,payload_hash,decision_ready,blocking_reasons,
             customer_total_cents,payout_cents,insurance_adjustment_cents,net_payout_cents,
             estimated_net_hourly_cents,minimum_net_hourly_cents,
             provider_earnings_policy_version,provider_earnings_floor_met,
             distance_miles,estimated_travel_time_minutes,travel_time_policy_version,
             estimated_duration_minutes,scope_hash,
             cancellation_policy_version,rank_score,rank_reasons,paid_promotion_affects_rank,
             passing_has_rank_penalty,snapshot,expires_at
           ) VALUES ($1,$2,$3,$4,TRUE,'[]'::jsonb,$5,$6,$7,$8,$9,$10,$11,TRUE,$12,$13,$14,$15,$16,$17,$18,$19::jsonb,FALSE,FALSE,$20::jsonb,$21)
           RETURNING id`,
          [context.id, params.workerId, decision.policyVersion, payloadHash,
            decision.economics.customerTotalCents, decision.economics.payoutCents,
            decision.economics.insuranceAdjustmentCents, decision.economics.netPayoutCents,
            decision.economics.estimatedNetHourlyCents,
            decision.economics.minimumNetHourlyCents,
            context.provider_earnings_policy_version,
            decision.logistics.distanceMiles, decision.logistics.estimatedTravelTimeMinutes,
            decision.logistics.travelTimePolicyVersion,
            decision.logistics.estimatedDurationMinutes, decision.scope.scopeHash,
            decision.cancellation.policyVersion, decision.ranking.score,
            JSON.stringify(decision.ranking.reasons), snapshot, expiresAt],
        );
        const offerDecisionId = inserted.rows[0]?.id;
        if (!offerDecisionId) return failure('LOCAL_TEST_OFFER_PERSISTENCE_FAILED', 'Offer decision was not recorded.');
        await query(
          `INSERT INTO worker_offer_events(offer_decision_id,event_type,idempotency_key,request_hash,public_note)
           VALUES($1,'VIEWED',$2,$3,'Controlled TEST worker reviewed the complete offer.') RETURNING id`,
          [offerDecisionId, params.idempotencyKey, requestHash],
        );
        await query(
          `INSERT INTO hxos_local_test_offer_actions(
             id,action_type,task_id,worker_id,offer_decision_id,duration_evidence_id,
             provider_capability_evidence_id,liquidity_witness_id,review_action_id,
             request_hash,attestation_hash,idempotency_key,actor_id,environment,is_test
           ) VALUES($1,'VIEWED',$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$3,'CONTROLLED_TEST',TRUE)
           RETURNING id`,
          [reviewActionId, context.id, params.workerId, offerDecisionId, context.duration_evidence_id,
            context.capability_evidence_id, context.liquidity_witness_id, requestHash,
            attestation(requestHash), params.idempotencyKey],
        );
        return { success: true as const, data: response('VIEWED', context.id, params.workerId, offerDecisionId, decisionSnapshot, false) };
      });
    } catch {
      return failure('DB_ERROR', 'Controlled TEST offer review failed.');
    }
  },

  accept: async (params: AcceptControlledTestOfferParams) => {
    if (!controlledTestOfferReviewEnabled()) return failure('LOCAL_TEST_OFFER_REVIEW_DISABLED', 'Controlled TEST offer review is disabled.');
    if (!uuid(params.taskId) || !uuid(params.workerId) || !uuid(params.offerDecisionId) || !validKey(params.idempotencyKey)) {
      return failure('LOCAL_TEST_OFFER_ACCEPT_INVALID', 'Controlled TEST offer acceptance input is invalid.');
    }
    const requestHash = digest({
      action: 'ACCEPTED', taskId: params.taskId, workerId: params.workerId,
      offerDecisionId: params.offerDecisionId,
    });
    try {
      return await db.transaction(async (query) => {
        await query(`SELECT pg_advisory_xact_lock(hashtext('local-test-offer-accept'),hashtext($1))`, [params.idempotencyKey]);
        const prior = await replay(query, params.workerId, params.idempotencyKey);
        if (prior) {
          return prior.action_type === 'ACCEPTED' && prior.task_id === params.taskId
            && prior.offer_decision_id === params.offerDecisionId && prior.request_hash === requestHash
            ? { success: true as const, data: response('ACCEPTED', prior.task_id, prior.worker_id, prior.offer_decision_id, prior.snapshot, true) }
            : failure('LOCAL_TEST_OFFER_IDEMPOTENCY_CONFLICT', 'Offer acceptance idempotency conflict.');
        }
        const loaded = await query<AcceptanceContext>(
          `SELECT offer.id AS offer_decision_id,offer.task_id,offer.worker_id,offer.decision_ready,
                  offer.expires_at,offer.snapshot,review.id AS review_action_id,
                  review.duration_evidence_id,review.provider_capability_evidence_id,
                  review.liquidity_witness_id,task.state AS task_state,
                  task.worker_id AS task_worker_id,task.automation_classification,
                  hxos_local_test_liquidity_witness_current_v2(task.id,$3,task.liquidity_cell_id) AS liquidity_ready,
                  (
                    duration.id=review.duration_evidence_id
                    AND duration.duration_expected_minutes=task.estimated_duration_minutes
                    AND capability.id=review.provider_capability_evidence_id
                    AND hxos_local_test_provider_capability_current(task.id,$3,capability.id)
                    AND witness.id=review.liquidity_witness_id
                    AND witness.task_id=task.id AND witness.worker_id=$3
                    AND witness.cell_id=task.liquidity_cell_id
                    AND witness.provider_capability_evidence_id=capability.id
                    AND witness.created_at>=NOW()-INTERVAL '15 minutes'
                  ) AS exact_evidence_current,
                  (
                    offer.customer_total_cents=task.price
                    AND offer.payout_cents IS NOT DISTINCT FROM task.hustler_payout_cents
                    AND offer.scope_hash IS NOT DISTINCT FROM task.scope_hash
                    AND offer.cancellation_policy_version IS NOT DISTINCT FROM task.cancellation_policy_version
                    AND offer.estimated_duration_minutes IS NOT DISTINCT FROM task.estimated_duration_minutes
                    AND offer.net_payout_cents=task.hustler_payout_cents-ROUND(task.price*0.02)
                    AND offer.estimated_travel_time_minutes>0
                    AND NULLIF(BTRIM(offer.travel_time_policy_version),'') IS NOT NULL
                    AND offer.provider_earnings_floor_met=TRUE
                    AND offer.minimum_net_hourly_cents=liquidity_cell.minimum_provider_net_hourly_cents
                    AND offer.provider_earnings_policy_version=liquidity_cell.provider_earnings_policy_version
                    AND liquidity_cell.provider_earnings_policy_state='TEST_HYPOTHESIS'
                  ) AS offer_current
             FROM worker_offer_decisions offer
             JOIN hxos_local_test_offer_actions review ON review.offer_decision_id=offer.id
               AND review.action_type='VIEWED'
             JOIN tasks task ON task.id=offer.task_id
             JOIN zone_category_cells liquidity_cell ON liquidity_cell.id=task.liquidity_cell_id
             JOIN hxos_local_test_duration_evidence duration ON duration.id=review.duration_evidence_id
             JOIN hxos_local_test_provider_capability_evidence capability
               ON capability.id=review.provider_capability_evidence_id
             JOIN hxos_local_test_liquidity_witnesses witness ON witness.id=review.liquidity_witness_id
            WHERE offer.id=$1 AND offer.task_id=$2 AND offer.worker_id=$3
            ORDER BY review.created_at DESC LIMIT 1 FOR SHARE OF offer,review,task`,
          [params.offerDecisionId, params.taskId, params.workerId],
        );
        const context = loaded.rows[0];
        if (!context || !context.decision_ready || new Date(context.expires_at).getTime() <= Date.now()
          || context.automation_classification !== 'CONTROLLED_TEST'
          || !['OPEN', 'MATCHING'].includes(context.task_state)
          || context.task_worker_id !== null || context.liquidity_ready !== true
          || context.exact_evidence_current !== true || context.offer_current !== true) {
          return failure('LOCAL_TEST_OFFER_ACCEPT_NOT_READY', 'The reviewed offer is no longer current.');
        }
        await query(`SELECT set_config('hustlexp.local_test_offer_review_enabled','true',true)`);
        await query(
          `INSERT INTO worker_offer_events(offer_decision_id,event_type,idempotency_key,request_hash,public_note)
           VALUES($1,'ACCEPTED',$2,$3,'Controlled TEST worker explicitly accepted the reviewed offer.') RETURNING id`,
          [params.offerDecisionId, params.idempotencyKey, requestHash],
        );
        await query(
          `INSERT INTO hxos_local_test_offer_actions(
             id,action_type,task_id,worker_id,offer_decision_id,duration_evidence_id,
             provider_capability_evidence_id,liquidity_witness_id,review_action_id,
             request_hash,attestation_hash,idempotency_key,actor_id,environment,is_test
           ) VALUES($1,'ACCEPTED',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$3,'CONTROLLED_TEST',TRUE)
           RETURNING id`,
          [randomUUID(), params.taskId, params.workerId, params.offerDecisionId,
            context.duration_evidence_id, context.provider_capability_evidence_id,
            context.liquidity_witness_id, context.review_action_id, requestHash,
            attestation(requestHash), params.idempotencyKey],
        );
        return { success: true as const, data: response('ACCEPTED', params.taskId, params.workerId, params.offerDecisionId, context.snapshot, false) };
      });
    } catch {
      return failure('DB_ERROR', 'Controlled TEST offer acceptance failed.');
    }
  },
};
