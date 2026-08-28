import { createHash, randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import { encryptTaskLocation } from './TaskLocationCrypto.js';
import { recurringInvalid } from './RecurringWorkErrors.js';
import type { ControlledRecurringTemplateInput } from './RecurringWorkTypes.js';

const log = logger.child({ service: 'RecurringTemplateCreationService' });

type ValidationFailure = ServiceResult<never> | null;

function principalFailure(
  input: ControlledRecurringTemplateInput,
  organizationAuthorized: boolean,
): ValidationFailure {
  if (input.clientPrincipalType === 'ORGANIZATION') {
    const valid = [
      organizationAuthorized,
      Boolean(input.businessOrganizationId),
      Boolean(input.businessLocationId),
      input.clientPrincipalId === input.businessOrganizationId,
    ].every(Boolean);
    return valid ? null : recurringInvalid(
      'Organization recurring work requires a membership-backed Business workspace.',
      'ORGANIZATION_WORKSPACE_REQUIRED',
    );
  }
  const valid = [
    input.clientPrincipalId === input.posterId,
    input.approverId === input.posterId,
    !input.businessOrganizationId,
    !input.businessLocationId,
  ].every(Boolean);
  return valid
    ? null
    : recurringInvalid('A household template must be owned and approved by the authenticated Poster.');
}

function economicsFailure(input: ControlledRecurringTemplateInput): ValidationFailure {
  if (input.providerPayoutCents + input.platformMarginCents !== input.customerTotalCents) {
    return recurringInvalid('Provider payout and platform margin must reconcile to the customer total.');
  }
  const invalidCorridor = [
    input.customerTotalCents < input.corridorMinimumCents,
    input.customerTotalCents > input.corridorMaximumCents,
    input.maximumAdjustmentCents > input.corridorMaximumCents - input.corridorMinimumCents,
    input.budgetCapCents < input.customerTotalCents,
  ].some(Boolean);
  return invalidCorridor ? recurringInvalid('Recurring price corridor or budget is invalid.') : null;
}

function scheduleFailure(input: ControlledRecurringTemplateInput): ValidationFailure {
  if (input.serviceWindowEnd <= input.serviceWindowStart) {
    return recurringInvalid('Service window end must be later than its start.');
  }
  const timeInsideWindow = input.timeOfDay >= input.serviceWindowStart
    && input.timeOfDay < input.serviceWindowEnd;
  if (!timeInsideWindow) return recurringInvalid('Scheduled time must fall inside the service window.');
  const weekly = input.pattern === 'weekly' || input.pattern === 'biweekly';
  if (weekly && !input.dayOfWeek) return recurringInvalid('Weekly recurrence requires a day of week.');
  if (input.pattern === 'monthly' && !input.dayOfMonth) {
    return recurringInvalid('Monthly recurrence requires a day of month.');
  }
  return null;
}

function fulfillmentFailure(input: ControlledRecurringTemplateInput): ValidationFailure {
  if (input.completionChecklist.length === 0) {
    return recurringInvalid('Completion proof checklist is required.');
  }
  const providers = [input.preferredWorkerId, ...input.backupWorkerIds].filter(Boolean);
  const providersValid = new Set(providers).size === providers.length
    && !providers.includes(input.posterId);
  return providersValid
    ? null
    : recurringInvalid('Preferred and backup providers must be distinct from each other and the Poster.');
}

function validateControlledInput(
  input: ControlledRecurringTemplateInput,
  organizationAuthorized: boolean,
): ValidationFailure {
  const checks = [
    principalFailure(input, organizationAuthorized),
    economicsFailure(input),
    scheduleFailure(input),
    fulfillmentFailure(input),
  ];
  return checks.find((failure) => failure !== null) ?? null;
}

function revisionSnapshot(
  input: ControlledRecurringTemplateInput,
  privateFingerprints: { location: string; access: string },
): Record<string, unknown> {
  return {
    contractVersion: 2,
    clientPrincipalType: input.clientPrincipalType,
    clientPrincipalId: input.clientPrincipalId,
    title: input.title,
    description: input.description,
    category: input.category,
    taskRecipe: input.taskRecipe,
    roughLocation: input.roughLocation,
    locationFingerprint: privateFingerprints.location,
    accessFingerprint: privateFingerprints.access,
    regionCode: input.regionCode,
    riskLevel: input.riskLevel,
    pattern: input.pattern,
    dayOfWeek: input.dayOfWeek,
    dayOfMonth: input.dayOfMonth,
    timeOfDay: input.timeOfDay,
    startDate: input.startDate,
    endDate: input.endDate,
    timezone: input.timezone,
    serviceWindowStart: input.serviceWindowStart,
    serviceWindowEnd: input.serviceWindowEnd,
    expectedDurationMinutes: input.expectedDurationMinutes,
    customerTotalCents: input.customerTotalCents,
    providerPayoutCents: input.providerPayoutCents,
    platformMarginCents: input.platformMarginCents,
    corridorMinimumCents: input.corridorMinimumCents,
    corridorMaximumCents: input.corridorMaximumCents,
    maximumAdjustmentCents: input.maximumAdjustmentCents,
    requiredTrustTier: input.requiredTrustTier,
    licenseRequirements: input.licenseRequirements,
    insuranceRequirements: input.insuranceRequirements,
    credentialsValidUntil: input.credentialsValidUntil,
    requiredTools: input.requiredTools,
    requiredVehicle: input.requiredVehicle,
    completionChecklist: input.completionChecklist,
    preferredWorkerId: input.preferredWorkerId,
    backupWorkerIds: input.backupWorkerIds,
    cancellationRules: input.cancellationRules,
    holidayRules: input.holidayRules,
    budgetCapCents: input.budgetCapCents,
    approverId: input.approverId,
    escalationRules: input.escalationRules,
    invoiceGrouping: input.invoiceGrouping,
    nextReviewDate: input.nextReviewDate,
    businessOrganizationId: input.businessOrganizationId ?? null,
    businessLocationId: input.businessLocationId ?? null,
    purchaseOrderPresent: Boolean(input.recurringPoNumber),
    costCenterPresent: Boolean(input.recurringCostCenter),
    autoApproveLimitCents: input.businessAutoApproveLimitCents ?? null,
  };
}

function bind(values: unknown[], value: unknown, cast = ''): string {
  values.push(value);
  return `$${values.length}${cast}`;
}

export async function createRecurringTemplateAuthorized(
  input: ControlledRecurringTemplateInput,
  organizationAuthorized: boolean,
): Promise<ServiceResult<{ id: string; status: 'active'; revisionId: string }>> {
  const validation = validateControlledInput(input, organizationAuthorized);
  if (validation) return validation;
  const id = randomUUID();
  const revisionId = randomUUID();
  const lineageId = randomUUID();
  try {
    const location = encryptTaskLocation(id, input.exactLocation);
    const access = encryptTaskLocation(`${id}:access`, input.accessProcedure);
    const snapshot = revisionSnapshot(input, {
      location: location.fingerprint,
      access: access.fingerprint,
    });
    const snapshotText = JSON.stringify(snapshot);
    const snapshotHash = createHash('sha256').update(snapshotText).digest('hex');

    return await db.transaction(async (query) => {
      const values: unknown[] = [];
      const p = (value: unknown, cast = '') => bind(values, value, cast);
      const idP = p(id); const posterP = p(input.posterId); const patternP = p(input.pattern);
      const dayOfWeekP = p(input.dayOfWeek); const dayOfMonthP = p(input.dayOfMonth);
      const timeP = p(input.timeOfDay); const startP = p(input.startDate); const endP = p(input.endDate);
      const titleP = p(input.title); const descriptionP = p(input.description);
      const totalP = p(input.customerTotalCents); const roughP = p(input.roughLocation);
      const categoryP = p(input.category); const durationLabelP = p(`${input.expectedDurationMinutes} minutes`);
      const tierP = p(input.requiredTrustTier); const principalTypeP = p(input.clientPrincipalType);
      const principalIdP = p(input.clientPrincipalId); const lineageP = p(lineageId);
      const regionP = p(input.regionCode); const riskP = p(input.riskLevel);
      const locationCipherP = p(location.ciphertext); const locationNonceP = p(location.nonce);
      const locationTagP = p(location.authTag); const locationKeyP = p(location.keyId);
      const locationFingerP = p(location.fingerprint); const accessCipherP = p(access.ciphertext);
      const accessNonceP = p(access.nonce); const accessTagP = p(access.authTag);
      const accessKeyP = p(access.keyId); const accessFingerP = p(access.fingerprint);
      const recipeP = p(JSON.stringify(input.taskRecipe), '::jsonb'); const timezoneP = p(input.timezone);
      const windowStartP = p(input.serviceWindowStart); const windowEndP = p(input.serviceWindowEnd);
      const durationP = p(input.expectedDurationMinutes); const corridorMinP = p(input.corridorMinimumCents);
      const corridorMaxP = p(input.corridorMaximumCents); const adjustmentP = p(input.maximumAdjustmentCents);
      const payoutP = p(input.providerPayoutCents); const marginP = p(input.platformMarginCents);
      const licenseP = p(JSON.stringify(input.licenseRequirements), '::jsonb');
      const insuranceP = p(JSON.stringify(input.insuranceRequirements), '::jsonb');
      const credentialP = p(input.credentialsValidUntil); const toolsP = p(input.requiredTools);
      const vehicleP = p(input.requiredVehicle); const checklistP = p(JSON.stringify(input.completionChecklist), '::jsonb');
      const preferredP = p(input.preferredWorkerId); const backupsP = p(input.backupWorkerIds);
      const cancellationP = p(JSON.stringify(input.cancellationRules), '::jsonb');
      const holidayP = p(JSON.stringify(input.holidayRules), '::jsonb'); const budgetP = p(input.budgetCapCents);
      const approverP = p(input.approverId); const escalationP = p(JSON.stringify(input.escalationRules), '::jsonb');
      const invoiceP = p(JSON.stringify(input.invoiceGrouping), '::jsonb'); const reviewP = p(input.nextReviewDate);
      const businessOrgP = p(input.businessOrganizationId ?? null);
      const businessLocationP = p(input.businessLocationId ?? null);
      const recurringPoP = p(input.recurringPoNumber ?? null);
      const recurringCostCenterP = p(input.recurringCostCenter ?? null);

      await query(
        `INSERT INTO recurring_task_series (
           id,poster_id,pattern,day_of_week,day_of_month,time_of_day,start_date,end_date,
           title,description,payment_cents,location,category,estimated_duration,required_tier,
           status,next_occurrence_at,contract_version,client_principal_type,client_principal_id,
           template_lineage_id,region_code,risk_level,rough_location,location_ciphertext,location_nonce,
           location_auth_tag,location_key_id,location_fingerprint,access_ciphertext,access_nonce,
           access_auth_tag,access_key_id,access_fingerprint,task_recipe,timezone,service_window_start,
           service_window_end,expected_duration_minutes,corridor_minimum_cents,corridor_maximum_cents,
           maximum_adjustment_cents,provider_payout_cents,platform_margin_cents,license_requirements,
           insurance_requirements,credentials_valid_until,required_tools,required_vehicle,
           completion_checklist,preferred_worker_id,backup_worker_ids,cancellation_rules,holiday_rules,
           budget_cap_cents,approver_id,escalation_rules,invoice_grouping,next_review_date,pause_code,
           business_organization_id,business_location_id,recurring_po_number,recurring_cost_center
         ) VALUES (
           ${idP},${posterP},${patternP},${dayOfWeekP},${dayOfMonthP},${timeP},${startP},${endP},
           ${titleP},${descriptionP},${totalP},${roughP},${categoryP},${durationLabelP},${tierP},
           'paused',((${startP}::date + ${timeP}::time) AT TIME ZONE ${timezoneP}),2,
           ${principalTypeP},${principalIdP},${lineageP},${regionP},${riskP},${roughP},${locationCipherP},
           ${locationNonceP},${locationTagP},${locationKeyP},${locationFingerP},${accessCipherP},
           ${accessNonceP},${accessTagP},${accessKeyP},${accessFingerP},${recipeP},${timezoneP},
           ${windowStartP},${windowEndP},${durationP},${corridorMinP},${corridorMaxP},${adjustmentP},
           ${payoutP},${marginP},${licenseP},${insuranceP},${credentialP},${toolsP},${vehicleP},
           ${checklistP},${preferredP},${backupsP},${cancellationP},${holidayP},${budgetP},${approverP},
           ${escalationP},${invoiceP},${reviewP},'ACTIVATION_PENDING',${businessOrgP},
           ${businessLocationP},${recurringPoP},${recurringCostCenterP}
         ) RETURNING id`,
        values,
      );
      await query(
        `INSERT INTO recurring_task_template_revisions (
           id,template_id,version,snapshot,snapshot_hash,change_reason,created_by
         ) VALUES ($1,$2,1,$3::jsonb,$4,'Initial approved recurring template',$5) RETURNING id`,
        [revisionId, id, snapshotText, snapshotHash, input.posterId],
      );
      const activated = await query<{ id: string; status: 'active'; current_revision_id: string }>(
        `UPDATE recurring_task_series SET current_revision_id=$1,status='active',pause_code=NULL,updated_at=NOW()
         WHERE id=$2 AND status='paused' AND pause_code='ACTIVATION_PENDING'
         RETURNING id,status,current_revision_id`,
        [revisionId, id],
      );
      if (!activated.rows[0]) throw new Error('Controlled recurring template activation failed');
      return { success: true, data: { id, status: 'active', revisionId } };
    });
  } catch (error) {
    log.error({ err: error, posterId: input.posterId }, 'controlled recurring template create failed');
    return {
      success: false,
      error: {
        code: 'RECURRING_TEMPLATE_CREATE_FAILED',
        message: 'The recurring template was not created.',
      },
    };
  }
}
