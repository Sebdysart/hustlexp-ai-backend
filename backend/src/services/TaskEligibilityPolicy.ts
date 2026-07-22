/**
 * Canonical task eligibility SQL shared by discovery and mutation paths.
 *
 * Every expression in this module is backed by authoritative database state.
 * Caller-supplied profile, trust, and credential claims are deliberately not
 * accepted as inputs.
 */

import { TRPCError } from '@trpc/server';
import type { QueryFn } from '../db.js';

export interface TaskEligibilityAliases {
  task: string;
  worker: string;
  profile: string;
  escrow: string;
}

export interface TaskEligibilityOptions {
  excludeActiveApplication?: boolean;
  requireCurrentOffer?: boolean;
  requireDecisionCompleteness?: boolean;
  allowControlledTest?: boolean;
}

const DEFAULT_ALIASES: TaskEligibilityAliases = {
  task: 't',
  worker: 'feed_worker',
  profile: 'cp',
  escrow: 'feed_escrow',
};

export function taskEligibilityJoins(
  workerParameter: string,
  aliases: TaskEligibilityAliases = DEFAULT_ALIASES,
): string {
  return `
      JOIN users ${aliases.worker} ON ${aliases.worker}.id = ${workerParameter}
      JOIN capability_profiles ${aliases.profile} ON ${aliases.profile}.user_id = ${aliases.worker}.id
      JOIN escrows ${aliases.escrow} ON ${aliases.escrow}.task_id = ${aliases.task}.id AND ${aliases.escrow}.state = 'FUNDED'`;
}

export function taskEligibilityPredicates(
  aliases: TaskEligibilityAliases = DEFAULT_ALIASES,
  options: TaskEligibilityOptions = {},
): string {
  const { task, worker, profile } = aliases;
  const excludeActiveApplication = options.excludeActiveApplication ?? true;
  const requireCurrentOffer = options.requireCurrentOffer ?? false;
  const requireDecisionCompleteness = options.requireDecisionCompleteness ?? true;

  const predicates = [
    `${task}.worker_id IS NULL`,
    `${task}.poster_id <> ${worker}.id`,
    `${worker}.default_mode = 'worker'`,
    `${worker}.account_status = 'ACTIVE'`,
    `${worker}.is_minor = FALSE`,
    `${worker}.is_banned = FALSE`,
    `${worker}.trust_tier >= 1`,
    `${worker}.is_verified = TRUE`,
    `identity_verification_is_current_v1(${worker}.id, 'PRODUCTION')`,
    `NULLIF(BTRIM(${worker}.phone), '') IS NOT NULL`,
    `NOT (${worker}.trust_hold AND (${worker}.trust_hold_until IS NULL OR ${worker}.trust_hold_until > NOW()))`,
    `${worker}.stripe_connect_id IS NOT NULL`,
    `${worker}.payouts_enabled = TRUE`,
    `${task}.automation_classification = 'PRODUCTION'`,
    `${profile}.trust_tier = ${worker}.trust_tier`,
    `lower(${task}.risk_level) = ANY(${profile}.risk_clearance)`,
    `${task}.risk_level <> 'IN_HOME'`,
    `${worker}.trust_tier >= COALESCE(${task}.trust_tier_required, 1)`,
    `${task}.price <= CASE
      WHEN ${worker}.trust_tier = 1 THEN 5000
      WHEN ${worker}.trust_tier = 2 THEN 20000
      ELSE 9999900
    END`,
    `COALESCE(${task}.clarification_state, 'READY') = 'READY'`,
    `NOT EXISTS (
      SELECT 1 FROM worker_counter_offers counter_offer
      WHERE counter_offer.task_id = ${task}.id
        AND (
          counter_offer.status = 'APPROVED_REAUTH_REQUIRED'
          OR (counter_offer.worker_id = ${worker}.id AND counter_offer.status = 'PENDING_POSTER')
        )
    )`,
    `(
      ${task}.risk_level <> 'HIGH'
      OR ${worker}.plan = 'pro'
      OR EXISTS (
        SELECT 1 FROM plan_entitlements entitlement
        WHERE entitlement.user_id = ${worker}.id
          AND (entitlement.task_id IS NULL OR entitlement.task_id = ${task}.id)
          AND entitlement.risk_level = 'HIGH'
          AND entitlement.expires_at > NOW()
      )
    )`,
    `(
      NOT ${task}.license_required OR EXISTS (
        SELECT 1 FROM license_verifications license
        WHERE license.user_id = ${worker}.id
          AND license.trade_type = ${task}.trade_type
          AND license.issuing_state = ${task}.location_state
          AND lower(license.status) IN ('approved', 'verified')
          AND (license.expiration_date IS NULL OR license.expiration_date >= CURRENT_DATE)
      )
    )`,
    `(
      NOT ${task}.insurance_required OR EXISTS (
        SELECT 1 FROM insurance_verifications insurance
        WHERE insurance.user_id = ${worker}.id
          AND lower(insurance.status) IN ('approved', 'verified')
          AND (insurance.expiration_date IS NULL OR insurance.expiration_date >= CURRENT_DATE)
      )
    )`,
    `(
      NOT ${task}.background_check_required OR EXISTS (
        SELECT 1 FROM background_checks screening
        WHERE screening.user_id = ${worker}.id
          AND upper(screening.status) = 'CLEAR'
          AND (screening.expires_at IS NULL OR screening.expires_at > NOW())
      )
    )`,
    `NOT EXISTS (
      SELECT 1 FROM disputes dispute
      WHERE dispute.worker_id = ${worker}.id
        AND dispute.state IN ('OPEN', 'EVIDENCE_REQUESTED', 'ESCALATED')
    )`,
    `(
      SELECT COUNT(*) FROM tasks active_task
      WHERE active_task.worker_id = ${worker}.id
        AND active_task.state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED')
    ) < 5`,
    `EXISTS (
      SELECT 1 FROM zone_category_cells cell
      WHERE cell.id = ${task}.liquidity_cell_id
        AND cell.geo_zone = ${task}.geo_zone
        AND cell.category = ${task}.category
        AND cell.state IN ('LIMITED', 'OPEN', 'DENSE')
        AND cell.launch_cell_enabled = TRUE
        AND cell.environment = 'PRODUCTION'
        AND cell.is_test IS FALSE
        AND cell.dispatch_allowed = TRUE
        AND cell.metrics_computed_at >= NOW() - INTERVAL '15 minutes'
        AND cell.evaluated_at >= NOW() - INTERVAL '15 minutes'
        AND cell.average_contribution_cents > 0
        AND cell.minimum_provider_net_hourly_cents > 0
        AND NULLIF(BTRIM(cell.provider_earnings_policy_version), '') IS NOT NULL
        AND cell.provider_earnings_policy_state = 'APPROVED'
        AND (
          cell.paid_tasks_30d < 30
          OR (
            cell.provider_earnings_sample_size >= 30
            AND cell.average_provider_net_hourly_cents >= cell.minimum_provider_net_hourly_cents
          )
        )
        AND cell.max_concurrent_dispatches > (
          SELECT COUNT(*) FROM tasks cell_active_task
          WHERE cell_active_task.liquidity_cell_id = cell.id
            AND cell_active_task.id <> ${task}.id
            AND cell_active_task.state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED')
        )
        AND (
          SELECT COUNT(DISTINCT green_cell.category)
          FROM zone_category_cells green_cell
          WHERE green_cell.geo_zone = cell.geo_zone
            AND green_cell.launch_cell_enabled = TRUE
            AND green_cell.green_category = TRUE
            AND green_cell.environment = 'PRODUCTION'
            AND green_cell.is_test IS FALSE
        ) BETWEEN 2 AND 3
    )`,
  ];

  if (excludeActiveApplication) {
    predicates.push(`NOT EXISTS (
      SELECT 1 FROM task_applications application
      WHERE application.task_id = ${task}.id
        AND application.hustler_id = ${worker}.id
        AND application.status NOT IN ('rejected', 'counter_rejected', 'withdrawn', 'expired')
    )`);
  }

  if (requireDecisionCompleteness) {
    predicates.push(
      `${task}.hustler_payout_cents > ROUND(${task}.hustler_payout_cents * 0.02)`,
      `${task}.estimated_duration_minutes > 0`,
      `${task}.scope_hash ~ '^[a-fA-F0-9]{64}$'`,
      `NULLIF(BTRIM(${task}.rough_location), '') IS NOT NULL`,
    `NULLIF(BTRIM(${task}.cancellation_policy_version), '') IS NOT NULL`,
    `${task}.cancellation_policy_version LIKE 'task-template-v2:%'`,
    );
  }

  if (requireCurrentOffer) {
    predicates.push(`EXISTS (
      SELECT 1 FROM worker_offer_decisions offer
      WHERE offer.task_id = ${task}.id
        AND offer.worker_id = ${worker}.id
        AND offer.decision_ready = TRUE
        AND offer.expires_at > NOW()
        AND offer.customer_total_cents = ${task}.price
        AND offer.payout_cents IS NOT DISTINCT FROM ${task}.hustler_payout_cents
        AND offer.scope_hash IS NOT DISTINCT FROM ${task}.scope_hash
        AND offer.cancellation_policy_version IS NOT DISTINCT FROM ${task}.cancellation_policy_version
        AND offer.estimated_duration_minutes IS NOT DISTINCT FROM ${task}.estimated_duration_minutes
        AND offer.net_payout_cents = ${task}.hustler_payout_cents - ROUND(${task}.price * 0.02)
        AND offer.estimated_travel_time_minutes > 0
        AND NULLIF(BTRIM(offer.travel_time_policy_version), '') IS NOT NULL
        AND offer.provider_earnings_floor_met = TRUE
        AND EXISTS (
          SELECT 1 FROM zone_category_cells offer_cell
           WHERE offer_cell.id = ${task}.liquidity_cell_id
             AND offer.minimum_net_hourly_cents = offer_cell.minimum_provider_net_hourly_cents
             AND offer.provider_earnings_policy_version = offer_cell.provider_earnings_policy_version
        )
    )`);
  }

  return predicates.map(predicate => `        AND ${predicate}`).join('\n');
}

export async function assertTaskMutationEligibility(
  query: QueryFn,
  taskId: string,
  workerId: string,
  options: Pick<TaskEligibilityOptions, 'requireCurrentOffer' | 'allowControlledTest'> = {},
): Promise<void> {
  const aliases: TaskEligibilityAliases = {
    task: 't',
    worker: 'mutation_worker',
    profile: 'mutation_profile',
    escrow: 'mutation_escrow',
  };
  const result = await query<{ id: string }>(
    `SELECT t.id
       FROM tasks t
       ${taskEligibilityJoins('$2', aliases)}
      WHERE t.id = $1
        AND t.state IN ('OPEN', 'MATCHING')
        ${taskEligibilityPredicates(aliases, {
          excludeActiveApplication: false,
          requireCurrentOffer: options.requireCurrentOffer,
          requireDecisionCompleteness: true,
        })}
      LIMIT 1`,
    [taskId, workerId],
  );
  if (result.rows[0]) return;

  if (options.allowControlledTest) {
    const controlledTest = await query<{ id: string }>(
      `SELECT t.id
         FROM tasks t
         JOIN users mutation_worker ON mutation_worker.id=$2
         JOIN capability_profiles mutation_profile ON mutation_profile.user_id=mutation_worker.id
         JOIN escrows mutation_escrow ON mutation_escrow.task_id=t.id AND mutation_escrow.state='FUNDED'
        WHERE t.id=$1
          AND t.state IN ('OPEN','MATCHING')
          AND t.worker_id IS NULL
          AND t.poster_id<>mutation_worker.id
          AND t.automation_classification='CONTROLLED_TEST'
          AND mutation_worker.default_mode='worker'
          AND mutation_worker.account_status='ACTIVE'
          AND mutation_worker.is_minor IS FALSE
          AND COALESCE(mutation_worker.is_banned,FALSE) IS FALSE
          AND mutation_worker.trust_tier>=COALESCE(t.trust_tier_required,1)
          AND mutation_worker.is_verified IS TRUE
          AND identity_verification_is_current_v1(mutation_worker.id,'CONTROLLED_TEST')
          AND NULLIF(BTRIM(mutation_worker.phone),'') IS NOT NULL
          AND NOT (mutation_worker.trust_hold AND (
            mutation_worker.trust_hold_until IS NULL OR mutation_worker.trust_hold_until>NOW()
          ))
          AND mutation_profile.trust_tier=mutation_worker.trust_tier
          AND lower(t.risk_level)=ANY(mutation_profile.risk_clearance)
          AND t.risk_level<>'IN_HOME'
          AND t.price<=CASE
            WHEN mutation_worker.trust_tier=1 THEN 5000
            WHEN mutation_worker.trust_tier=2 THEN 20000
            ELSE 9999900
          END
          AND COALESCE(t.clarification_state,'READY')='READY'
          AND NOT EXISTS (
            SELECT 1 FROM worker_counter_offers counter_offer
             WHERE counter_offer.task_id=t.id
               AND (counter_offer.status='APPROVED_REAUTH_REQUIRED'
                 OR (counter_offer.worker_id=mutation_worker.id AND counter_offer.status='PENDING_POSTER'))
          )
          AND (t.risk_level<>'HIGH' OR mutation_worker.plan='pro' OR EXISTS (
            SELECT 1 FROM plan_entitlements entitlement
             WHERE entitlement.user_id=mutation_worker.id
               AND (entitlement.task_id IS NULL OR entitlement.task_id=t.id)
               AND entitlement.risk_level='HIGH' AND entitlement.expires_at>NOW()
          ))
          AND (NOT t.license_required OR EXISTS (
            SELECT 1 FROM license_verifications license
             WHERE license.user_id=mutation_worker.id AND license.trade_type=t.trade_type
               AND license.issuing_state=t.location_state
               AND lower(license.status) IN ('approved','verified')
               AND (license.expiration_date IS NULL OR license.expiration_date>=CURRENT_DATE)
          ))
          AND (NOT t.insurance_required OR EXISTS (
            SELECT 1 FROM insurance_verifications insurance
             WHERE insurance.user_id=mutation_worker.id
               AND lower(insurance.status) IN ('approved','verified')
               AND (insurance.expiration_date IS NULL OR insurance.expiration_date>=CURRENT_DATE)
          ))
          AND (NOT t.background_check_required OR EXISTS (
            SELECT 1 FROM background_checks screening
             WHERE screening.user_id=mutation_worker.id AND upper(screening.status)='CLEAR'
               AND screening.provider_environment='CONTROLLED_TEST' AND screening.is_test IS TRUE
               AND (screening.expires_at IS NULL OR screening.expires_at>NOW())
          ))
          AND NOT EXISTS (
            SELECT 1 FROM disputes dispute WHERE dispute.worker_id=mutation_worker.id
              AND dispute.state IN ('OPEN','EVIDENCE_REQUESTED','ESCALATED')
          )
          AND (SELECT COUNT(*) FROM tasks active_task
                WHERE active_task.worker_id=mutation_worker.id
                  AND active_task.state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED'))<5
          AND t.hustler_payout_cents>ROUND(t.hustler_payout_cents*0.02)
          AND t.estimated_duration_minutes>0
          AND t.scope_hash~'^[a-fA-F0-9]{64}$'
          AND NULLIF(BTRIM(t.rough_location),'') IS NOT NULL
          AND NULLIF(BTRIM(t.cancellation_policy_version),'') IS NOT NULL
          AND t.cancellation_policy_version LIKE 'task-template-v2:%'
          AND hxos_local_test_liquidity_witness_current_v2(t.id,mutation_worker.id,t.liquidity_cell_id)
          ${options.requireCurrentOffer ? `AND EXISTS (
            SELECT 1 FROM worker_offer_decisions offer
             WHERE offer.task_id=t.id AND offer.worker_id=mutation_worker.id
               AND offer.decision_ready=TRUE AND offer.expires_at>NOW()
               AND offer.customer_total_cents=t.price
               AND offer.payout_cents IS NOT DISTINCT FROM t.hustler_payout_cents
               AND offer.scope_hash IS NOT DISTINCT FROM t.scope_hash
               AND offer.cancellation_policy_version IS NOT DISTINCT FROM t.cancellation_policy_version
               AND offer.estimated_duration_minutes IS NOT DISTINCT FROM t.estimated_duration_minutes
               AND offer.net_payout_cents=t.hustler_payout_cents-ROUND(t.price*0.02)
               AND offer.estimated_travel_time_minutes>0
               AND NULLIF(BTRIM(offer.travel_time_policy_version),'') IS NOT NULL
               AND offer.provider_earnings_floor_met=TRUE
               AND EXISTS (
                 SELECT 1 FROM zone_category_cells offer_cell
                  WHERE offer_cell.id=t.liquidity_cell_id
                    AND offer_cell.environment='CONTROLLED_TEST'
                    AND offer_cell.is_test IS TRUE
                    AND offer_cell.provider_earnings_policy_state='TEST_HYPOTHESIS'
                    AND offer.minimum_net_hourly_cents=offer_cell.minimum_provider_net_hourly_cents
                    AND offer.provider_earnings_policy_version=offer_cell.provider_earnings_policy_version
               )
          )` : ''}
        LIMIT 1`,
      [taskId, workerId],
    );
    if (controlledTest.rows[0]) return;
  }

  throw new TRPCError({
    code: 'FORBIDDEN',
    message: 'This task is not currently eligible for this worker.',
  });
}
