import { createHash } from 'node:crypto';
import { db } from '../db.js';
import {
  buildWorkerOfferDecision,
  type WorkerOfferDecision,
} from './WorkerOfferDecisionPolicy.js';
import { generateExplanation } from './TaskDiscoveryScoring.js';
import type { TaskFeedItem, TaskFeedRow } from './TaskDiscoveryTypes.js';

function workerOfferDecision(row: TaskFeedRow): WorkerOfferDecision {
  return buildWorkerOfferDecision(
    { ...row, distance_miles: row.distance_miles },
    {
      matchingScore: row.matching_score,
      distanceScore: Math.max(0, Math.min(1, 1 - row.distance_miles / 10)),
      categoryMatch: row.category ? 1 : 0,
    },
  );
}

async function persistWorkerOfferDecision(
  workerId: string,
  row: TaskFeedRow,
  decision: WorkerOfferDecision,
): Promise<void> {
  const snapshot = JSON.stringify(decision);
  const payloadHash = createHash('sha256').update(snapshot).digest('hex');
  await db.query(
    `INSERT INTO worker_offer_decisions (
       task_id, worker_id, policy_version, payload_hash, decision_ready, blocking_reasons,
       customer_total_cents, payout_cents, insurance_adjustment_cents, net_payout_cents,
       estimated_net_hourly_cents, minimum_net_hourly_cents,
       provider_earnings_policy_version, provider_earnings_floor_met,
       distance_miles, estimated_travel_time_minutes, travel_time_policy_version,
       estimated_duration_minutes, scope_hash, cancellation_policy_version, rank_score,
       rank_reasons, paid_promotion_affects_rank, passing_has_rank_penalty, snapshot, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,FALSE,FALSE,$23::jsonb,NOW() + INTERVAL '30 minutes')
     ON CONFLICT (task_id, worker_id, policy_version, payload_hash) DO NOTHING`,
    [
      row.id,
      workerId,
      decision.policyVersion,
      payloadHash,
      decision.decisionReady,
      JSON.stringify(decision.blockingReasons),
      decision.economics.customerTotalCents,
      decision.economics.payoutCents,
      decision.economics.insuranceAdjustmentCents,
      decision.economics.netPayoutCents,
      decision.economics.estimatedNetHourlyCents,
      decision.economics.minimumNetHourlyCents,
      row.provider_earnings_policy_version ?? null,
      decision.economics.providerEarningsFloorMet,
      decision.logistics.distanceMiles,
      decision.logistics.estimatedTravelTimeMinutes,
      decision.logistics.travelTimePolicyVersion,
      decision.logistics.estimatedDurationMinutes,
      decision.scope.scopeHash,
      decision.cancellation.policyVersion,
      decision.ranking.score,
      JSON.stringify(decision.ranking.reasons),
      snapshot,
    ],
  );
}

export async function feedItemForRow(
  hustlerId: string,
  row: TaskFeedRow,
): Promise<TaskFeedItem> {
  const decision = workerOfferDecision(row);
  await persistWorkerOfferDecision(hustlerId, row, decision);
  return {
    task: row,
    matching_score: row.matching_score,
    relevance_score: row.relevance_score,
    distance_miles: row.distance_miles,
    explanation: generateExplanation({
      matching_score: row.matching_score,
      distance_miles: row.distance_miles,
      category: row.category as string,
      price: row.price,
    }),
    offer_decision: decision,
  };
}

export function feedItemsForRows(
  hustlerId: string,
  rows: TaskFeedRow[],
): Promise<TaskFeedItem[]> {
  return Promise.all(rows.map((row) => feedItemForRow(hustlerId, row)));
}
