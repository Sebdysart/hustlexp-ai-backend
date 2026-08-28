import { createHash } from 'node:crypto';
import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { operationFailure } from './BusinessOperationsErrors.js';
import type { BusinessPricingMode } from './BusinessOperationsPolicy.js';
import type {
  BusinessApprovalSummary,
  BusinessBudgetPolicySummary,
  BusinessServiceProfileSummary,
} from './BusinessOperationsTypes.js';

export type {
  BusinessApprovalSummary,
  BusinessBudgetPolicySummary,
  BusinessServiceProfileSummary,
} from './BusinessOperationsTypes.js';

export async function upsertBusinessBudgetPolicy(input: {
  actorId: string;
  organizationId: string;
  locationId: string | null;
  serviceCategory: string;
  perTaskCapCents: number;
  monthlyCapCents: number;
  autoApproveLimitCents: number;
  poRequired: boolean;
  costCenterRequired: boolean;
}): Promise<ServiceResult<{ id: string; revision: number }>> {
  try {
    const result = await db.query<{ policy_id: string; policy_revision: number }>(
      `SELECT policy_id,policy_revision
       FROM upsert_business_budget_policy($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.organizationId, input.actorId, input.locationId, input.serviceCategory,
        input.perTaskCapCents, input.monthlyCapCents, input.autoApproveLimitCents,
        input.poRequired, input.costCenterRequired,
      ],
    );
    const row = result.rows[0];
    if (!row) return operationFailure(null, 'BUSINESS_BUDGET_FAILED', 'The budget policy was not saved.');
    return { success: true, data: { id: row.policy_id, revision: row.policy_revision } };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_BUDGET_FAILED', 'The budget policy was not saved.');
  }
}

export async function listBusinessBudgetPolicies(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessBudgetPolicySummary[]>> {
  try {
    const result = await db.query<{
      id: string; location_id: string | null; service_category: string;
      per_task_cap_cents: number | string; monthly_cap_cents: number | string;
      auto_approve_limit_cents: number | string; po_required: boolean;
      cost_center_required: boolean; revision: number;
    }>(
      `WITH authority AS (SELECT business_require_action($1,$2,'VIEW_BILLING'))
       SELECT policy.id,policy.location_id,policy.service_category,policy.per_task_cap_cents,
              policy.monthly_cap_cents,policy.auto_approve_limit_cents,policy.po_required,
              policy.cost_center_required,policy.revision
       FROM business_budget_policies policy CROSS JOIN authority
       WHERE policy.organization_id=$1 AND policy.active=TRUE
       ORDER BY policy.updated_at DESC`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id,
      locationId: row.location_id,
      serviceCategory: row.service_category,
      perTaskCapCents: Number(row.per_task_cap_cents),
      monthlyCapCents: Number(row.monthly_cap_cents),
      autoApproveLimitCents: Number(row.auto_approve_limit_cents),
      poRequired: row.po_required,
      costCenterRequired: row.cost_center_required,
      revision: row.revision,
    })) };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_BUDGET_LIST_FAILED', 'Budget policies could not be loaded.');
  }
}

export async function requestBusinessSpend(input: {
  actorId: string;
  organizationId: string;
  locationId: string | null;
  serviceCategory: string;
  amountCents: number;
  poNumber: string | null;
  costCenter: string | null;
  idempotencyKey: string;
}): Promise<ServiceResult<{ id: string; status: BusinessApprovalSummary['status']; blockers: string[] }>> {
  try {
    const result = await db.query<{
      approval_request_id: string; approval_status: BusinessApprovalSummary['status'];
      approval_blockers: string[];
    }>(
      `SELECT approval_request_id,approval_status,approval_blockers
       FROM request_business_spend($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        input.organizationId, input.actorId, input.locationId, input.serviceCategory,
        input.amountCents, input.poNumber, input.costCenter, input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) return operationFailure(null, 'BUSINESS_SPEND_FAILED', 'The spend request was not created.');
    return { success: true, data: {
      id: row.approval_request_id, status: row.approval_status,
      blockers: row.approval_blockers,
    } };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_SPEND_FAILED', 'The spend request was not created.');
  }
}

export async function listBusinessApprovalQueue(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessApprovalSummary[]>> {
  try {
    const result = await db.query<{
      id: string; canonical_task_id: string | null; requester_name: string; location_id: string | null; location_name: string | null;
      service_category: string; amount_cents: number | string; po_number: string | null;
      cost_center: string | null; status: BusinessApprovalSummary['status']; blockers: string[];
      created_at: Date | string;
    }>(
      `WITH authority AS (SELECT business_require_action($1,$2,'APPROVE_SPEND'))
       SELECT request.id,request.canonical_task_id,account.full_name AS requester_name,request.location_id,
              location.name AS location_name,request.service_category,request.amount_cents,
              request.po_number,request.cost_center,request.status,request.blockers,request.created_at
       FROM business_approval_requests request
       JOIN users account ON account.id=request.requester_id
       LEFT JOIN business_locations location ON location.id=request.location_id
       CROSS JOIN authority
       WHERE request.organization_id=$1
       ORDER BY (request.status='PENDING_APPROVAL') DESC,request.created_at DESC
       LIMIT 100`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id,
      canonicalTaskId: row.canonical_task_id,
      requesterName: row.requester_name,
      locationId: row.location_id,
      locationName: row.location_name,
      serviceCategory: row.service_category,
      amountCents: Number(row.amount_cents),
      poNumber: row.po_number,
      costCenter: row.cost_center,
      status: row.status,
      blockers: row.blockers,
      createdAt: new Date(row.created_at).toISOString(),
    })) };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_APPROVAL_LIST_FAILED', 'Approval requests could not be loaded.');
  }
}

export async function listMyBusinessSpendRequests(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessApprovalSummary[]>> {
  try {
    const result = await db.query<{
      id: string; canonical_task_id: string | null; requester_name: string; location_id: string | null; location_name: string | null;
      service_category: string; amount_cents: number | string; po_number: string | null;
      cost_center: string | null; status: BusinessApprovalSummary['status']; blockers: string[];
      created_at: Date | string;
    }>(
      `WITH authority AS (SELECT business_require_action($1,$2,'CREATE_WORK_ORDER'))
       SELECT request.id,request.canonical_task_id,account.full_name AS requester_name,request.location_id,
              location.name AS location_name,request.service_category,request.amount_cents,
              request.po_number,request.cost_center,request.status,request.blockers,request.created_at
       FROM business_approval_requests request
       JOIN users account ON account.id=request.requester_id
       LEFT JOIN business_locations location ON location.id=request.location_id
       CROSS JOIN authority
       WHERE request.organization_id=$1 AND request.requester_id=$2
       ORDER BY request.created_at DESC LIMIT 100`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id,
      canonicalTaskId: row.canonical_task_id,
      requesterName: row.requester_name,
      locationId: row.location_id,
      locationName: row.location_name,
      serviceCategory: row.service_category,
      amountCents: Number(row.amount_cents),
      poNumber: row.po_number,
      costCenter: row.cost_center,
      status: row.status,
      blockers: row.blockers,
      createdAt: new Date(row.created_at).toISOString(),
    })) };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_SPEND_LIST_FAILED', 'Your spend requests could not be loaded.');
  }
}

export async function decideBusinessApproval(input: {
  actorId: string;
  organizationId: string;
  approvalRequestId: string;
  decision: 'APPROVED' | 'REJECTED';
  reason: string;
}): Promise<ServiceResult<{ id: string; status: 'APPROVED' | 'REJECTED' }>> {
  try {
    const result = await db.query<{
      approval_request_id: string; approval_status: 'APPROVED' | 'REJECTED';
    }>(
      `SELECT approval_request_id,approval_status
       FROM decide_business_approval($1,$2,$3,$4,$5)`,
      [input.organizationId, input.actorId, input.approvalRequestId, input.decision, input.reason],
    );
    const row = result.rows[0];
    if (!row) return operationFailure(null, 'BUSINESS_APPROVAL_FAILED', 'The approval decision was not recorded.');
    return { success: true, data: { id: row.approval_request_id, status: row.approval_status } };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_APPROVAL_FAILED', 'The approval decision was not recorded.');
  }
}

export async function createBusinessServiceProfile(input: {
  actorId: string;
  organizationId: string;
  serviceCode: string;
  serviceName: string;
  serviceDescription: string;
  serviceExclusions: string[];
  bookingQuestions: string[];
  coveragePostalCodes: string[];
  maximumTravelMiles: number;
  weeklyCapacitySlots: number;
  blackoutDates: string[];
  pricingMode: BusinessPricingMode;
  corridorMinimumCents: number | null;
  corridorMaximumCents: number | null;
  responseMode: BusinessServiceProfileSummary['responseMode'];
  proofChecklist: string[];
  credentialRequirements: string[];
  idempotencyKey: string;
}): Promise<ServiceResult<{ id: string; status: 'DRAFT' }>> {
  try {
    const result = await db.query<{ service_profile_id: string; profile_status: 'DRAFT' }>(
      `SELECT service_profile_id,profile_status FROM create_business_service_profile(
        $1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18
       )`,
      [
        input.organizationId, input.actorId, input.serviceCode, input.serviceName,
        input.serviceDescription, input.serviceExclusions, JSON.stringify(input.bookingQuestions),
        input.coveragePostalCodes, input.maximumTravelMiles, input.weeklyCapacitySlots,
        input.blackoutDates, input.pricingMode, input.corridorMinimumCents,
        input.corridorMaximumCents, input.responseMode, JSON.stringify(input.proofChecklist),
        JSON.stringify(input.credentialRequirements), input.idempotencyKey,
      ],
    );
    const row = result.rows[0];
    if (!row) return operationFailure(null, 'BUSINESS_SERVICE_FAILED', 'The service profile was not created.');
    return { success: true, data: { id: row.service_profile_id, status: row.profile_status } };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_SERVICE_FAILED', 'The service profile was not created.');
  }
}

export async function listBusinessServiceProfiles(
  actorId: string,
  organizationId: string,
): Promise<ServiceResult<BusinessServiceProfileSummary[]>> {
  try {
    const result = await db.query<{
      id: string; service_code: string; service_name: string; service_description: string;
      service_exclusions: string[]; booking_questions: string[]; coverage_postal_codes: string[];
      maximum_travel_miles: number; weekly_capacity_slots: number; blackout_dates: string[];
      pricing_mode: BusinessPricingMode; corridor_minimum_cents: number | string | null;
      corridor_maximum_cents: number | string | null; response_mode: BusinessServiceProfileSummary['responseMode'];
      proof_checklist: string[]; credential_requirements: string[];
      status: BusinessServiceProfileSummary['status']; assigned_crew_count: number | string;
      last_activation_blockers: string[];
    }>(
      `WITH authority AS (SELECT business_require_action($1,$2,'READ_WORKSPACE'))
       SELECT profile.id,profile.service_code,profile.service_name,profile.service_description,
              profile.service_exclusions,profile.booking_questions,profile.coverage_postal_codes,
              profile.maximum_travel_miles,profile.weekly_capacity_slots,profile.blackout_dates,
              profile.pricing_mode,profile.corridor_minimum_cents,profile.corridor_maximum_cents,
              profile.response_mode,profile.proof_checklist,profile.credential_requirements,
              profile.status,
              (SELECT COUNT(*) FROM business_service_crew_assignments assignment
               WHERE assignment.service_profile_id=profile.id) AS assigned_crew_count,
              COALESCE((SELECT event.blockers FROM business_service_activation_events event
               WHERE event.service_profile_id=profile.id ORDER BY event.created_at DESC LIMIT 1),
               ARRAY[]::TEXT[]) AS last_activation_blockers
       FROM business_service_profiles profile CROSS JOIN authority
       WHERE profile.organization_id=$1 AND profile.status<>'RETIRED'
       ORDER BY profile.created_at DESC`,
      [organizationId, actorId],
    );
    return { success: true, data: result.rows.map((row) => ({
      id: row.id,
      serviceCode: row.service_code,
      serviceName: row.service_name,
      serviceDescription: row.service_description,
      serviceExclusions: row.service_exclusions,
      bookingQuestions: row.booking_questions,
      coveragePostalCodes: row.coverage_postal_codes,
      maximumTravelMiles: row.maximum_travel_miles,
      weeklyCapacitySlots: row.weekly_capacity_slots,
      blackoutDates: row.blackout_dates,
      pricingMode: row.pricing_mode,
      corridorMinimumCents: row.corridor_minimum_cents === null ? null : Number(row.corridor_minimum_cents),
      corridorMaximumCents: row.corridor_maximum_cents === null ? null : Number(row.corridor_maximum_cents),
      responseMode: row.response_mode,
      proofChecklist: row.proof_checklist,
      credentialRequirements: row.credential_requirements,
      status: row.status,
      assignedCrewCount: Number(row.assigned_crew_count),
      lastActivationBlockers: row.last_activation_blockers,
    })) };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_SERVICE_LIST_FAILED', 'Business services could not be loaded.');
  }
}

export async function submitBusinessCredential(input: {
  actorId: string;
  organizationId: string;
  membershipId: string;
  credentialType: string;
  evidenceReference: string;
}): Promise<ServiceResult<{ id: string; status: 'PENDING' }>> {
  try {
    const evidenceHash = createHash('sha256')
      .update(`hustlexp:business-credential:v1:${input.evidenceReference}`, 'utf8')
      .digest('hex');
    const result = await db.query<{ credential_id: string; credential_status: 'PENDING' }>(
      `SELECT credential_id,credential_status
       FROM submit_business_credential($1,$2,$3,$4,$5)`,
      [input.organizationId, input.actorId, input.membershipId, input.credentialType, evidenceHash],
    );
    const row = result.rows[0];
    if (!row) return operationFailure(null, 'BUSINESS_CREDENTIAL_FAILED', 'The credential was not submitted.');
    return { success: true, data: { id: row.credential_id, status: row.credential_status } };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_CREDENTIAL_FAILED', 'The credential was not submitted.');
  }
}

export async function assignBusinessServiceCrew(input: {
  actorId: string;
  organizationId: string;
  serviceProfileId: string;
  membershipId: string;
}): Promise<ServiceResult<{ id: string; eligible: boolean }>> {
  try {
    const result = await db.query<{ crew_assignment_id: string; crew_eligible: boolean }>(
      `SELECT crew_assignment_id,crew_eligible
       FROM assign_business_service_crew($1,$2,$3,$4)`,
      [input.organizationId, input.actorId, input.serviceProfileId, input.membershipId],
    );
    const row = result.rows[0];
    if (!row) return operationFailure(null, 'BUSINESS_CREW_FAILED', 'The crew assignment was not saved.');
    return { success: true, data: { id: row.crew_assignment_id, eligible: row.crew_eligible } };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_CREW_FAILED', 'The crew assignment was not saved.');
  }
}

export async function activateBusinessServiceProfile(input: {
  actorId: string;
  organizationId: string;
  serviceProfileId: string;
}): Promise<ServiceResult<{ id: string; ready: boolean; blockers: string[] }>> {
  try {
    const result = await db.query<{
      service_profile_id: string; ready: boolean; blockers: string[];
    }>(
      `SELECT service_profile_id,ready,blockers
       FROM activate_business_service_profile($1,$2,$3)`,
      [input.organizationId, input.actorId, input.serviceProfileId],
    );
    const row = result.rows[0];
    if (!row) return operationFailure(null, 'BUSINESS_ACTIVATION_FAILED', 'Service readiness could not be evaluated.');
    return { success: true, data: {
      id: row.service_profile_id, ready: row.ready, blockers: row.blockers,
    } };
  } catch (error) {
    return operationFailure(error, 'BUSINESS_ACTIVATION_FAILED', 'Service readiness could not be evaluated.');
  }
}
