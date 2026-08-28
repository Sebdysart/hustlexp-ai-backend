import { db } from '../db.js';
import type {
  HustlerCategoryPerformance,
  PreferredWorkOpportunity,
} from './HustlerWalletTypes.js';

interface CategoryPerformanceRow {
  category: string;
  region_code: string;
  verified_assignments: string | number;
  verified_completions: string | number;
  completion_rate: string | number | null;
  proof_completeness_rate: string | number | null;
  dispute_rate: string | number | null;
  repeat_customer_count: string | number;
  transaction_review_count: string | number;
  weighted_overall_rating: string | number | null;
  experience_band: 'BUILDING_HISTORY' | 'ESTABLISHED';
}

interface PreferredOpportunityRow {
  opportunity_id: string;
  opportunity_kind: 'PREFERRED_REBOOK' | 'RECURRING_ROUTE';
  task_id: string;
  title: string;
  category: string | null;
  payout_cents: number | null;
  scheduled_for: Date | string | null;
  offered_at: Date | string;
  expires_at: Date | string | null;
  opportunity_state: 'OPEN' | 'MATCHING' | 'RESERVATION_PENDING';
}

function integer(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function decimal(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function percent(value: string | number | null): number | null {
  const parsed = decimal(value);
  return parsed === null ? null : Math.round(Math.max(0, Math.min(1, parsed)) * 1000) / 10;
}

function iso(value: Date | string | null): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function categoryPerformance(row: CategoryPerformanceRow): HustlerCategoryPerformance {
  return {
    category: row.category,
    regionCode: row.region_code,
    verifiedAssignments: integer(row.verified_assignments),
    verifiedCompletions: integer(row.verified_completions),
    completionRatePercent: percent(row.completion_rate),
    proofCompletenessPercent: percent(row.proof_completeness_rate),
    disputeRatePercent: percent(row.dispute_rate),
    repeatCustomerCount: integer(row.repeat_customer_count),
    transactionReviewCount: integer(row.transaction_review_count),
    weightedOverallRating: decimal(row.weighted_overall_rating),
    experienceBand: row.experience_band === 'ESTABLISHED' ? 'established' : 'building_history',
    evidenceLabel: 'verified_production_transactions',
  };
}

function opportunityReason(kind: PreferredOpportunityRow['opportunity_kind']): string {
  return kind === 'RECURRING_ROUTE'
    ? 'A controlled recurring template reserved this work for you; it is not assigned until accepted.'
    : 'A previous customer selected you as the preferred provider; it is not assigned until accepted and funded.';
}

function preferredOpportunity(row: PreferredOpportunityRow): PreferredWorkOpportunity {
  return {
    id: `${row.opportunity_kind.toLowerCase()}:${row.opportunity_id}`,
    kind: row.opportunity_kind === 'RECURRING_ROUTE' ? 'recurring_route' : 'preferred_rebook',
    taskId: row.task_id,
    taskTitle: row.title,
    category: row.category,
    payoutCents: row.payout_cents,
    scheduledFor: iso(row.scheduled_for),
    offeredAt: iso(row.offered_at)!,
    expiresAt: iso(row.expires_at),
    state: row.opportunity_state.toLowerCase() as PreferredWorkOpportunity['state'],
    reason: opportunityReason(row.opportunity_kind),
  };
}

export async function loadCategoryPerformance(
  workerId: string,
): Promise<HustlerCategoryPerformance[]> {
  const result = await db.query<CategoryPerformanceRow>(
    `SELECT category,region_code,verified_assignments,verified_completions,
            completion_rate,proof_completeness_rate,dispute_rate,
            repeat_customer_count,transaction_review_count,
            weighted_overall_rating,experience_band
       FROM provider_reputation_public
      WHERE provider_user_id=$1
      ORDER BY verified_completions DESC,category,region_code
      LIMIT 25`,
    [workerId],
  );
  return result.rows.map(categoryPerformance);
}

export async function loadPreferredWorkOpportunities(
  workerId: string,
): Promise<PreferredWorkOpportunity[]> {
  const result = await db.query<PreferredOpportunityRow>(
    `SELECT * FROM (
       SELECT task.id AS opportunity_id,'PREFERRED_REBOOK'::TEXT AS opportunity_kind,
              task.id AS task_id,task.title,task.category,
              task.hustler_payout_cents AS payout_cents,task.deadline AS scheduled_for,
              task.created_at AS offered_at,NULL::TIMESTAMPTZ AS expires_at,
              task.state::TEXT AS opportunity_state
         FROM tasks task
        WHERE task.preferred_worker_id=$1 AND task.worker_id IS NULL
          AND task.state IN ('OPEN','MATCHING')
          AND task.repeat_source_task_id IS NOT NULL
          AND task.automation_classification='PRODUCTION'
       UNION ALL
       SELECT reservation.id,'RECURRING_ROUTE'::TEXT,task.id,task.title,task.category,
              occurrence.provider_payout_cents,occurrence.scheduled_start,
              reservation.offered_at,reservation.expires_at,
              'RESERVATION_PENDING'::TEXT
         FROM recurring_provider_reservations reservation
         JOIN recurring_task_occurrences occurrence ON occurrence.id=reservation.occurrence_id
         JOIN tasks task ON task.id=occurrence.task_id
        WHERE reservation.worker_id=$1 AND reservation.status='PENDING'
          AND reservation.expires_at>NOW() AND occurrence.status='posted'
     ) opportunity
     ORDER BY offered_at DESC,opportunity_id
     LIMIT 20`,
    [workerId],
  );
  return result.rows.map(preferredOpportunity);
}
