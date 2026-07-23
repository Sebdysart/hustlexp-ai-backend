import type { QueryFn } from '../db.js';
import type {
  ServiceBusinessOpportunity,
  ServiceBusinessOpportunityRow,
} from './ServiceBusinessExecutionTypes.js';

const serviceBusinessOpportunityColumns = `
  SELECT task.id AS task_id,task.title,task.description,task.requirements,task.category,
         task.price AS customer_total_cents,task.hustler_payout_cents AS payout_cents,
         task.platform_margin_cents,task.estimated_duration_minutes,task.required_tools,
         task.rough_location,task.risk_level,task.scope_hash,task.cancellation_policy_version,
         task.late_cancel_pct,task.cancellation_window_hours,task.deadline,
         profile.id AS service_profile_id,profile.service_name,profile.maximum_travel_miles,
         cell.minimum_provider_net_hourly_cents,cell.provider_earnings_policy_version,
         crew_inventory.eligible_crew_count`;

const serviceBusinessOpportunityFrom = `
    FROM tasks task
    JOIN escrows escrow ON escrow.task_id=task.id AND escrow.state='FUNDED'
    JOIN business_organizations provider_org
      ON provider_org.id=$1 AND provider_org.status='ACTIVE'
     AND provider_org.provider_enabled=TRUE
     AND provider_org.verification_status='VERIFIED'
    JOIN business_locations location ON location.id=task.business_location_id AND location.status='ACTIVE'
    JOIN business_service_profiles profile
      ON profile.organization_id=$1 AND profile.status='ACTIVE'
     AND lower(profile.service_code)=lower(task.category)
     AND location.postal_code=ANY(profile.coverage_postal_codes)
    JOIN LATERAL (
      SELECT COUNT(*) AS eligible_crew_count
        FROM business_service_crew_assignments crew
        JOIN business_memberships membership ON membership.id=crew.membership_id
        JOIN users fulfiller ON fulfiller.id=membership.user_id
        JOIN capability_profiles capability ON capability.user_id=fulfiller.id
       WHERE crew.organization_id=$1 AND crew.service_profile_id=profile.id AND crew.eligible=TRUE
         AND membership.status='ACTIVE' AND membership.role IN ('CREW','DISPATCHER','ADMIN','OWNER')
         AND fulfiller.default_mode='worker' AND fulfiller.account_status='ACTIVE'
         AND fulfiller.is_minor=FALSE AND COALESCE(fulfiller.is_banned,FALSE)=FALSE
         AND fulfiller.is_verified=TRUE AND NULLIF(BTRIM(fulfiller.phone),'') IS NOT NULL
         AND identity_verification_is_current_v1(fulfiller.id,'PRODUCTION')
         AND NOT (fulfiller.trust_hold AND (
           fulfiller.trust_hold_until IS NULL OR fulfiller.trust_hold_until>NOW()))
         AND capability.trust_tier=fulfiller.trust_tier
         AND task.risk_level<>'IN_HOME'
         AND lower(task.risk_level)=ANY(capability.risk_clearance)
         AND fulfiller.trust_tier>=COALESCE(task.trust_tier_required,1)
         AND task.price<=CASE WHEN fulfiller.trust_tier=1 THEN 5000
           WHEN fulfiller.trust_tier=2 THEN 20000 ELSE 9999900 END
         AND (task.risk_level<>'HIGH' OR fulfiller.plan='pro' OR EXISTS (
           SELECT 1 FROM plan_entitlements entitlement
            WHERE entitlement.user_id=fulfiller.id
              AND (entitlement.task_id IS NULL OR entitlement.task_id=task.id)
              AND entitlement.risk_level='HIGH' AND entitlement.expires_at>NOW()))
         AND NOT EXISTS (
           SELECT 1 FROM disputes dispute WHERE dispute.worker_id=fulfiller.id
             AND dispute.state IN ('OPEN','EVIDENCE_REQUESTED','ESCALATED'))
         AND 5>(SELECT COUNT(*) FROM tasks active
           WHERE active.worker_id=fulfiller.id AND active.id<>task.id
             AND active.state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED'))
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(profile.credential_requirements) requirement
            WHERE NOT EXISTS (
              SELECT 1 FROM business_credentials credential
               WHERE credential.organization_id=$1
                 AND (credential.membership_id=membership.id OR credential.membership_id IS NULL)
                 AND credential.credential_type=requirement AND credential.status='ACTIVE'
                 AND (credential.expires_at IS NULL OR credential.expires_at>NOW())))
         AND (task.license_required IS NOT TRUE OR EXISTS (
           SELECT 1 FROM license_verifications license WHERE license.user_id=fulfiller.id
             AND license.trade_type=task.trade_type AND license.issuing_state=task.location_state
             AND lower(license.status) IN ('approved','verified')
             AND (license.expiration_date IS NULL OR license.expiration_date>=CURRENT_DATE)))
         AND (task.insurance_required IS NOT TRUE OR EXISTS (
           SELECT 1 FROM insurance_verifications insurance WHERE insurance.user_id=fulfiller.id
             AND lower(insurance.status) IN ('approved','verified')
             AND (insurance.expiration_date IS NULL OR insurance.expiration_date>=CURRENT_DATE)))
         AND (task.background_check_required IS NOT TRUE OR (
           capability.background_check_valid=TRUE
           AND capability.background_check_source_id IS NOT NULL
           AND capability.background_check_environment='PRODUCTION'
           AND capability.background_check_is_test=FALSE
           AND (capability.background_check_expires_at IS NULL
             OR capability.background_check_expires_at>NOW())
           AND EXISTS (
             SELECT 1 FROM background_checks screening
              WHERE screening.id=capability.background_check_source_id
                AND screening.user_id=fulfiller.id AND screening.status='CLEAR'
                AND screening.provider_environment='PRODUCTION' AND screening.is_test=FALSE
                AND (screening.expires_at IS NULL OR screening.expires_at>NOW()))))
    ) crew_inventory ON crew_inventory.eligible_crew_count>0
    JOIN zone_category_cells cell ON cell.id=task.liquidity_cell_id
     AND cell.environment='PRODUCTION' AND cell.is_test=FALSE
     AND cell.launch_cell_enabled=TRUE AND cell.dispatch_allowed=TRUE
     AND cell.state IN ('LIMITED','OPEN','DENSE')
     AND cell.metrics_computed_at>=NOW()-INTERVAL '15 minutes'
     AND cell.evaluated_at>=NOW()-INTERVAL '15 minutes'`;

const serviceBusinessOpportunityWhere = `
   WHERE task.state IN ('OPEN','MATCHING') AND task.worker_id IS NULL
     AND task.automation_classification='PRODUCTION'
     AND COALESCE(task.clarification_state,'READY')='READY'
     AND profile.weekly_capacity_slots>(
       SELECT COUNT(*) FROM tasks active
        WHERE active.provider_organization_id=$1
          AND active.provider_service_profile_id=profile.id
          AND active.id<>task.id
          AND active.state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED'))
     AND EXISTS (
       SELECT 1 FROM business_provider_payout_accounts payout
       JOIN users payee ON payee.id=payout.payout_recipient_user_id
       WHERE payout.organization_id=$1 AND payout.status='ACTIVE'
         AND payee.account_status='ACTIVE' AND payee.stripe_connect_id IS NOT NULL
         AND payee.payouts_enabled=TRUE
     )`;

export const serviceBusinessOpportunitySelect = `${serviceBusinessOpportunityColumns}
  ${serviceBusinessOpportunityFrom}
  ${serviceBusinessOpportunityWhere}`;

export async function listOpportunityRows(
  query: QueryFn,
  actorId: string,
  organizationId: string,
): Promise<ServiceBusinessOpportunityRow[]> {
  const result = await query<ServiceBusinessOpportunityRow>(
    `WITH authority AS (SELECT business_require_action($1,$2,'READ_WORKSPACE'))
     ${serviceBusinessOpportunityColumns}
     ${serviceBusinessOpportunityFrom}
     CROSS JOIN authority
     ${serviceBusinessOpportunityWhere}
     ORDER BY task.deadline ASC NULLS LAST,task.created_at ASC LIMIT 100`,
    [organizationId, actorId],
  );
  return result.rows;
}

export async function loadOpportunityRow(
  query: QueryFn,
  input: { actorId: string; organizationId: string; taskId: string; serviceProfileId: string },
): Promise<ServiceBusinessOpportunityRow | null> {
  const result = await query<ServiceBusinessOpportunityRow>(
    `WITH authority AS (SELECT business_require_action($1,$2,'ASSIGN_CREW'))
     ${serviceBusinessOpportunityColumns}
     ${serviceBusinessOpportunityFrom}
     CROSS JOIN authority
     ${serviceBusinessOpportunityWhere}
     AND task.id=$3 AND profile.id=$4
     LIMIT 1 FOR SHARE OF task,profile`,
    [input.organizationId, input.actorId, input.taskId, input.serviceProfileId],
  );
  return result.rows[0] ?? null;
}

export function serviceBusinessOpportunity(row: ServiceBusinessOpportunityRow): ServiceBusinessOpportunity {
  return {
    taskId: row.task_id,
    serviceProfileId: row.service_profile_id,
    serviceName: row.service_name,
    title: row.title,
    category: row.category,
    roughLocation: row.rough_location,
    customerTotalCents: Number(row.customer_total_cents),
    payoutCents: Number(row.payout_cents),
    estimatedDurationMinutes: row.estimated_duration_minutes,
    requiredTools: row.required_tools,
    riskLevel: row.risk_level,
    travel: {
      minimumMiles: 0,
      maximumMiles: row.maximum_travel_miles,
      estimateKind: 'SERVICE_ZONE_RANGE',
    },
    rankReasons: ['Service category match', 'Verified coverage match', 'Current capacity available'],
    eligibleCrewCount: Number(row.eligible_crew_count),
  };
}
