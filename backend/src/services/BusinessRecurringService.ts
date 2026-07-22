import { db } from '../db.js';
import { computePlatformFeeCents } from '../lib/money.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import {
  createAuthorizedOrganizationRecurringTemplate,
  type RecurringPattern,
} from './RecurringWorkService.js';
import {
  businessRecurringPolicyFailure,
  evaluateBusinessRecurringSafety,
  type BusinessRecurringRiskLevel,
} from './BusinessRecurringPolicy.js';
import type {
  BusinessRecurringSource,
  BusinessRecurringTemplateSummary,
  CreateBusinessRecurringTemplateInput,
} from './BusinessRecurringTypes.js';
import { decryptTaskLocation } from './TaskLocationCrypto.js';

export type {
  BusinessRecurringTemplateSummary,
  CreateBusinessRecurringTemplateInput,
} from './BusinessRecurringTypes.js';

const log = logger.child({ service: 'BusinessRecurringService' });

function fail(code: string, message: string): ServiceResult<never> {
  return { success: false, error: { code, message } };
}

function mapFailure(error: unknown): ServiceResult<never> {
  const message = error instanceof Error ? error.message : '';
  if (/HXBUS(?:REC1|2)(?:\D|$)/.test(message)) {
    return fail('BUSINESS_PERMISSION_DENIED', 'This Business recurring action is not permitted.');
  }
  log.error({ err: message || 'unknown' }, 'Business recurring operation failed');
  return fail('BUSINESS_RECURRING_FAILED', 'Business recurring work could not be updated.');
}

async function loadBusinessRecurringSource(input: {
  actorId: string;
  organizationId: string;
  locationId: string;
  category: string;
}): Promise<BusinessRecurringSource | null> {
  const result = await db.query<BusinessRecurringSource>(
    `WITH authority AS (
       SELECT business_require_action($1,$2,'CREATE_WORK_ORDER')
     ), selected_policy AS (
       SELECT policy.*
       FROM business_budget_policies policy
       WHERE policy.organization_id=$1 AND policy.active=TRUE
         AND (policy.location_id IS NULL OR policy.location_id=$3)
         AND (policy.service_category='*' OR lower(policy.service_category)=lower($4))
       ORDER BY (policy.location_id IS NOT NULL)::INTEGER DESC,
                (policy.service_category<>'*')::INTEGER DESC,
                policy.revision DESC
       LIMIT 1
     )
     SELECT location.id AS location_id,location.rough_location,location.region_code,
            location.timezone,location.exact_address_ciphertext,location.exact_address_nonce,
            location.exact_address_auth_tag,location.exact_address_key_id,
            location.access_ciphertext,location.access_nonce,location.access_auth_tag,
            location.access_key_id,policy.per_task_cap_cents,policy.monthly_cap_cents,
            policy.auto_approve_limit_cents,policy.po_required,policy.cost_center_required,
            (
              SELECT preference.provider_worker_id
              FROM business_provider_preferences preference
              WHERE preference.organization_id=$1 AND preference.active=TRUE
                AND preference.priority='PRIMARY'
                AND (preference.location_id IS NULL OR preference.location_id=$3)
                AND (preference.service_category='*' OR lower(preference.service_category)=lower($4))
              ORDER BY (preference.location_id IS NOT NULL)::INTEGER DESC,
                       (preference.service_category<>'*')::INTEGER DESC,
                       preference.updated_at DESC
              LIMIT 1
            ) AS preferred_worker_id,
            COALESCE((
              SELECT array_agg(preference.provider_worker_id ORDER BY preference.updated_at DESC)
              FROM business_provider_preferences preference
              WHERE preference.organization_id=$1 AND preference.active=TRUE
                AND preference.priority='BACKUP'
                AND (preference.location_id IS NULL OR preference.location_id=$3)
                AND (preference.service_category='*' OR lower(preference.service_category)=lower($4))
            ),ARRAY[]::UUID[]) AS backup_worker_ids
     FROM business_locations location
     JOIN business_organizations organization ON organization.id=location.organization_id
     CROSS JOIN authority
     LEFT JOIN selected_policy policy ON TRUE
     WHERE location.id=$3 AND location.organization_id=$1 AND location.status='ACTIVE'
       AND organization.status='ACTIVE' AND organization.client_enabled=TRUE`,
    [input.organizationId, input.actorId, input.locationId, input.category.trim().toLowerCase()],
  );
  return result.rows[0] ?? null;
}

function decryptBusinessLocation(source: BusinessRecurringSource): {
  exactAddress: string;
  accessProcedure: string;
} {
  return {
    exactAddress: decryptTaskLocation(source.location_id, {
      location_ciphertext: source.exact_address_ciphertext,
      location_nonce: source.exact_address_nonce,
      location_auth_tag: source.exact_address_auth_tag,
      location_key_id: source.exact_address_key_id,
    }),
    accessProcedure: decryptTaskLocation(`${source.location_id}:access`, {
      location_ciphertext: source.access_ciphertext,
      location_nonce: source.access_nonce,
      location_auth_tag: source.access_auth_tag,
      location_key_id: source.access_key_id,
    }),
  };
}

function requiredTrustTier(riskLevel: BusinessRecurringRiskLevel): 1 | 2 | 3 {
  if (riskLevel === 'HIGH') return 3;
  return riskLevel === 'MEDIUM' ? 2 : 1;
}

function authorizedRecurringInput(
  input: CreateBusinessRecurringTemplateInput,
  source: BusinessRecurringSource,
  riskLevel: BusinessRecurringRiskLevel,
) {
  const { exactAddress, accessProcedure } = decryptBusinessLocation(source);
  const platformMarginCents = computePlatformFeeCents(input.amountCents);
  return {
    posterId: input.actorId,
    clientPrincipalType: 'ORGANIZATION' as const,
    clientPrincipalId: input.organizationId,
    title: input.title,
    description: input.description,
    category: input.category,
    taskRecipe: { version: 1, proofChecklist: input.proofChecklist },
    exactLocation: exactAddress,
    roughLocation: source.rough_location,
    accessProcedure,
    regionCode: source.region_code,
    riskLevel,
    pattern: input.pattern,
    dayOfWeek: input.dayOfWeek,
    dayOfMonth: input.dayOfMonth,
    timeOfDay: input.timeOfDay,
    startDate: input.startDate,
    endDate: input.endDate,
    timezone: source.timezone,
    serviceWindowStart: input.serviceWindowStart,
    serviceWindowEnd: input.serviceWindowEnd,
    expectedDurationMinutes: input.expectedDurationMinutes,
    customerTotalCents: input.amountCents,
    providerPayoutCents: input.amountCents - platformMarginCents,
    platformMarginCents,
    corridorMinimumCents: input.amountCents,
    corridorMaximumCents: input.amountCents,
    maximumAdjustmentCents: 0,
    requiredTrustTier: requiredTrustTier(riskLevel),
    licenseRequirements: {},
    insuranceRequirements: {},
    credentialsValidUntil: null,
    requiredTools: input.requiredTools,
    requiredVehicle: null,
    completionChecklist: input.proofChecklist,
    preferredWorkerId: source.preferred_worker_id,
    backupWorkerIds: source.backup_worker_ids.filter((id) => id !== source.preferred_worker_id),
    cancellationRules: { noticeHours: input.cancellationNoticeHours },
    holidayRules: { blackoutDates: input.blackoutDates },
    budgetCapCents: input.templateBudgetCapCents,
    approverId: input.actorId,
    escalationRules: { onApprovalRequired: 'hold_occurrence', onPolicyBlock: 'pause_template' },
    invoiceGrouping: { groupBy: 'monthly', source: 'settled_business_transactions' },
    nextReviewDate: input.nextReviewDate,
    businessOrganizationId: input.organizationId,
    businessLocationId: input.locationId,
    recurringPoNumber: input.poNumber,
    recurringCostCenter: input.costCenter,
    businessAutoApproveLimitCents: Number(source.auto_approve_limit_cents ?? 0),
  };
}

export async function createBusinessRecurringTemplate(
  input: CreateBusinessRecurringTemplateInput,
): Promise<ServiceResult<{ id: string; status: 'active'; revisionId: string }>> {
  try {
    const safety = await evaluateBusinessRecurringSafety(input);
    if (!safety.success) return safety;
    const source = await loadBusinessRecurringSource(input);
    if (!source) return fail(
      'BUSINESS_RECURRING_SCOPE_INVALID',
      'The Business location is not active or is outside your authority.',
    );
    const policyFailure = businessRecurringPolicyFailure(source, input);
    if (policyFailure) return fail(policyFailure.code, policyFailure.message);
    return createAuthorizedOrganizationRecurringTemplate(
      authorizedRecurringInput(input, source, safety.data.riskLevel),
    );
  } catch (error) {
    return mapFailure(error);
  }
}

export async function listBusinessRecurringTemplates(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessRecurringTemplateSummary[]>> {
  try {
    const result = await db.query<{
      id: string; title: string; category: string; rough_location: string;
      status: BusinessRecurringTemplateSummary['status']; pause_code: string | null;
      current_revision_id: string; next_occurrence_at: string; pattern: RecurringPattern;
      service_window_start: string; service_window_end: string; timezone: string;
      budget_cap_cents: number | string; budget_spend_cents: number | string;
      preferred_worker_id: string | null; backup_provider_count: number | string;
      occurrence_count: number; completed_count: number; automation_mode: string;
      business_location_id: string; auto_approve_limit_cents: number | string;
      payment_cents: number | string;
    }>(
      `WITH authority AS (SELECT business_require_action($1,$2,'READ_WORKSPACE'))
       SELECT series.id,series.title,series.category,series.rough_location,series.status,
              series.pause_code,series.current_revision_id,series.next_occurrence_at,series.pattern,
              series.service_window_start,series.service_window_end,series.timezone,
              series.budget_cap_cents,series.budget_spend_cents,series.preferred_worker_id,
              cardinality(series.backup_worker_ids) AS backup_provider_count,
              series.occurrence_count,series.completed_count,series.automation_mode,
              series.business_location_id,series.payment_cents,
              COALESCE((series_snapshot.snapshot->>'autoApproveLimitCents')::BIGINT,0)
                AS auto_approve_limit_cents
       FROM recurring_task_series series
       JOIN recurring_task_template_revisions series_snapshot
         ON series_snapshot.id=series.current_revision_id
       CROSS JOIN authority
       WHERE series.business_organization_id=$1
         AND series.client_principal_type='ORGANIZATION' AND series.contract_version>=2
       ORDER BY series.created_at DESC`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      roughLocation: row.rough_location,
      status: row.status,
      pauseCode: row.pause_code,
      currentRevisionId: row.current_revision_id,
      nextOccurrenceAt: new Date(row.next_occurrence_at).toISOString(),
      pattern: row.pattern,
      serviceWindowStart: row.service_window_start,
      serviceWindowEnd: row.service_window_end,
      timezone: row.timezone,
      budgetCapCents: Number(row.budget_cap_cents),
      budgetSpendCents: Number(row.budget_spend_cents),
      preferredWorkerId: row.preferred_worker_id,
      backupProviderCount: Number(row.backup_provider_count),
      occurrenceCount: row.occurrence_count,
      completedCount: row.completed_count,
      automationMode: row.automation_mode,
      locationId: row.business_location_id,
      approvalMode: Number(row.payment_cents) <= Number(row.auto_approve_limit_cents)
        ? 'AUTO_ELIGIBLE' : 'PER_OCCURRENCE_APPROVAL',
    })) };
  } catch (error) {
    return mapFailure(error);
  }
}
