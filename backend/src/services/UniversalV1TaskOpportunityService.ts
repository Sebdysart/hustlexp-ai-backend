import { createHash } from 'node:crypto';

import { TRPCError } from '@trpc/server';

import { db, type QueryFn } from '../db.js';
import type { Context } from '../trpc-context.js';

export const universalV1TaskOpportunityProviderClasses = [
  'GENERAL_SERVICE_PROVIDER',
  'VERIFIED_TRADE_BUSINESS',
] as const;
export type UniversalV1TaskOpportunityProviderClass =
  (typeof universalV1TaskOpportunityProviderClasses)[number];

/**
 * This is deliberately an observation-only actor contract. The API binds the
 * verified application identity to hustler_id, but the shared runtime database
 * login cannot independently attest that UUID as its physical caller. Nothing
 * in this service grants eligibility, assignment, private-data, or money power.
 */
export const universalV1TaskOpportunityAuthority = {
  contractVersion: 'HX_UNIVERSAL_V1_TASK_OPPORTUNITY_AUTHORITY_V1',
  applicationAuthenticatedIdentityRequired: true,
  databaseCallerIdentityAttested: false,
  directDatabaseInvocation: 'HELD_PENDING_DEDICATED_COMMAND_ROLE',
  selectedServiceCellAuthority: 'BROWSE_FILTER_ONLY',
  eligibilityAuthority: 'HELD_PENDING_TASK_SPECIFIC_EVALUATION',
  assignmentAuthority: 'NONE',
  addressContactAuthority: 'NONE',
  financialAuthority: 'NONE',
  payableAuthority: 'NONE',
  guaranteedEarningAuthority: 'NONE',
} as const;

/**
 * Read-only continuation authority for a recorded TaskDraft interest.  It is
 * intentionally explicit about the missing PostgreSQL actor-attestation
 * boundary: this projection can report existing facts, but it cannot mint the
 * initial eligibility decision or estimate invitation.
 */
export const universalV1TaskOpportunityPreEstimateJourneyAuthority = {
  contractVersion: 'HX_UNIVERSAL_V1_TASK_OPPORTUNITY_PRE_ESTIMATE_JOURNEY_READ_V1',
  readModelOnly: true,
  databaseCallerIdentityAttested: false,
  initialEligibilityCommand: 'HELD_PENDING_APPROVED_ACTOR_ATTESTATION',
  mutationAuthority: 'NONE',
  assignmentAuthority: 'NONE',
  addressContactAuthority: 'NONE',
  financialAuthority: 'NONE',
} as const;

export interface UniversalV1TaskOpportunityProviderSelection {
  providerOrganizationId?: string;
  businessCredentialId?: string;
}

export interface BrowseUniversalV1TaskOpportunitiesInput extends UniversalV1TaskOpportunityProviderSelection {
  serviceCellAuthorityId: string;
  workCategoryCode?: string;
  limit: number;
  offset: number;
}

export interface ExpressUniversalV1TaskInterestInput extends UniversalV1TaskOpportunityProviderSelection {
  opportunityId: string;
  expectedOpportunityVersion: number;
  idempotencyKey: string;
}

export interface ListUniversalV1TaskInterestsInput {
  limit: number;
  offset: number;
}

export interface GetUniversalV1TaskInterestJourneyInput {
  interestId: string;
}

export interface ListUniversalV1TaskInterestsForOpsInput extends ListUniversalV1TaskInterestsInput {
  providerClass?: UniversalV1TaskOpportunityProviderClass;
  workCategoryCode?: string;
}

interface OpportunityDatabase {
  query: QueryFn;
  transaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>;
}

interface ProviderAuthorityRow {
  account_status: string;
  is_minor: boolean | null;
  is_banned: boolean | null;
  profile_provider_class: string | null;
  profile_updated_at: Date | string | null;
  organization_provider_class: string | null;
  organization_status: string | null;
  organization_verification_status: string | null;
  organization_provider_enabled: boolean | null;
  active_membership: boolean;
  current_trade_credential: boolean;
}

interface ActiveProviderIdentityRow {
  active_provider_identity: boolean;
}

interface ProviderAuthorityReady {
  state: 'READY';
  providerClass: UniversalV1TaskOpportunityProviderClass;
  providerOrganizationId: string | null;
  businessCredentialId: string | null;
}

interface ProviderAuthorityHeld {
  state: 'HELD';
  blockerCodes: string[];
}

type ProviderAuthority = ProviderAuthorityReady | ProviderAuthorityHeld;

interface OpportunityRow {
  opportunity_id: string;
  opportunity_version: number | string;
  task_draft_id: string;
  routing_decision_id: string;
  routing_decision_version: number | string;
  routing_policy_version: string;
  relationship_origin_id: string;
  relationship_origin_version: number | string;
  relationship_origin_kind: 'MARKETPLACE';
  relationship_origin_policy_version: number | string;
  scope_artifact_kind: 'TASK_DRAFT_ROUTE_CONTEXT_V1';
  scope_artifact_id: string;
  scope_artifact_version: number | string;
  scope_artifact_sha256: string;
  public_scope: Record<string, unknown>;
  work_category_code: string;
  service_cell_authority_id: string;
  service_cell_authority_version: number | string;
  service_cell_evidence_sha256: string;
  region_code: string;
  rough_location: string;
  risk_level: string;
  requires_proof: boolean;
  routing_outcome: 'FULFILLMENT_CANDIDATE' | 'ESTIMATE_REQUIRED';
  routed_at: Date | string;
  privacy_posture: 'ROUTE_CONTEXT_ALLOWLIST_ONLY';
  eligibility_posture: 'HELD_PENDING_TASK_SPECIFIC_EVALUATION';
  assignment_authority: 'NONE';
  address_contact_authority: 'NONE';
  financial_authority: 'NONE';
  guaranteed_earning_authority: 'NONE';
}

interface InterestRow {
  interest_id: string;
  opportunity_id: string;
  opportunity_version: number | string;
  task_draft_id: string;
  routing_decision_id: string;
  routing_decision_version: number | string;
  routing_policy_version: string;
  relationship_origin_id: string;
  relationship_origin_version: number | string;
  scope_artifact_kind: 'TASK_DRAFT_ROUTE_CONTEXT_V1';
  scope_artifact_id: string;
  scope_artifact_version: number | string;
  scope_artifact_sha256: string;
  provider_class: UniversalV1TaskOpportunityProviderClass;
  provider_binding_sha256: string;
  provider_capability_sha256: string;
  trade_qualification_sha256: string | null;
  work_category_code: string;
  service_cell_authority_id: string;
  service_cell_authority_version: number | string;
  region_code: string;
  rough_location: string;
  risk_level: string;
  requires_proof: boolean;
  routing_outcome: 'FULFILLMENT_CANDIDATE' | 'ESTIMATE_REQUIRED';
  status: 'pending';
  created_at: Date | string;
  idempotency_key: string;
  request_sha256: string;
}

interface InterestAuthoritySelectionRow {
  provider_organization_id: string | null;
  observed_trade_credential_id: string | null;
}

interface InterestJourneyRow extends InterestRow {
  opportunity_is_current: boolean;
  task_specific_provider_observation_current: boolean;
  eligibility_decision_id: string | null;
  eligibility_decision_version: number | string | null;
  eligibility_task_eligible: boolean | null;
  processor_payment_eligible: boolean | null;
  payout_funding_eligible: boolean | null;
  eligibility_valid_until: Date | string | null;
  eligibility_is_current: boolean;
  invitation_id: string | null;
  invitation_quote_id: string | null;
  invitation_valid_until: Date | string | null;
  invitation_is_current: boolean;
  expected_quote_version: number | string | null;
}

function fail(
  code: 'UNAUTHORIZED' | 'PRECONDITION_FAILED' | 'NOT_FOUND' | 'CONFLICT' | 'INTERNAL_SERVER_ERROR',
  message: string
): never {
  throw new TRPCError({ code, message });
}

function actorId(context: Context): string {
  return context.user?.id ?? fail('UNAUTHORIZED', 'Authentication required.');
}

function exactVersion(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fail('INTERNAL_SERVER_ERROR', `${label} returned an invalid exact version.`);
  }
  return parsed;
}

function iso(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return fail('INTERNAL_SERVER_ERROR', 'Task opportunity returned an invalid timestamp.');
  }
  return timestamp.toISOString();
}

function requestSha256(actor: string, input: ExpressUniversalV1TaskInterestInput): string {
  return createHash('sha256')
    .update(
      [
        'HX_UNIVERSAL_V1_EXPRESS_INTEREST_V1',
        actor,
        input.opportunityId,
        String(input.expectedOpportunityVersion),
        input.providerOrganizationId ?? '',
        input.businessCredentialId ?? '',
        input.idempotencyKey,
      ].join('|')
    )
    .digest('hex');
}

function translateDatabaseError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  if (/HXUV1-OPPORTUNITY-(?:4|5|6|7|8|9|10|11):/u.test(message)) {
    return fail(
      'PRECONDITION_FAILED',
      'Current provider capability, business, or credential observations are insufficient.'
    );
  }
  if (/HXUV1-OPPORTUNITY-(?:2|3):/u.test(message)) {
    return fail('CONFLICT', 'The exact Task Opportunity route, origin, or scope version changed.');
  }
  if (/HXUV1-OPPORTUNITY-|HXUV1-INTEREST-/u.test(message)) {
    return fail(
      'PRECONDITION_FAILED',
      'EXPRESS_INTEREST is outside its observation-only contract.'
    );
  }
  if ((error as { code?: unknown })?.code === '23505') {
    return fail('CONFLICT', 'The idempotency key or provider opportunity interest already exists.');
  }
  throw error;
}

function opportunityResult(row: OpportunityRow) {
  return {
    opportunityId: row.opportunity_id,
    opportunityVersion: exactVersion(row.opportunity_version, 'Task Opportunity'),
    taskDraftId: row.task_draft_id,
    routing: {
      decisionId: row.routing_decision_id,
      decisionVersion: exactVersion(row.routing_decision_version, 'Routing decision'),
      policyVersion: row.routing_policy_version,
      outcome: row.routing_outcome,
    },
    relationshipOrigin: {
      id: row.relationship_origin_id,
      version: exactVersion(row.relationship_origin_version, 'Relationship origin'),
      kind: row.relationship_origin_kind,
      policyVersion: exactVersion(
        row.relationship_origin_policy_version,
        'Relationship origin policy'
      ),
    },
    scopeArtifact: {
      kind: row.scope_artifact_kind,
      id: row.scope_artifact_id,
      version: exactVersion(row.scope_artifact_version, 'Scope artifact'),
      sha256: row.scope_artifact_sha256.trim(),
    },
    publicScope: row.public_scope,
    serviceCell: {
      authorityId: row.service_cell_authority_id,
      authorityVersion: exactVersion(row.service_cell_authority_version, 'Service cell authority'),
      evidenceSha256: row.service_cell_evidence_sha256.trim(),
      regionCode: row.region_code,
    },
    workCategoryCode: row.work_category_code,
    roughLocation: row.rough_location,
    riskLevel: row.risk_level,
    requiresProof: row.requires_proof,
    routedAt: iso(row.routed_at),
    privacyPosture: row.privacy_posture,
    eligibilityStatus: 'PENDING' as const,
    eligibilityPosture: row.eligibility_posture,
    assignmentStatus: 'PENDING' as const,
    assignmentAuthority: row.assignment_authority,
    addressContactAuthority: row.address_contact_authority,
    financialAuthority: row.financial_authority,
    guaranteedEarningAuthority: row.guaranteed_earning_authority,
  };
}

function interestResult(row: InterestRow, idempotencyReplayed: boolean) {
  return {
    interestId: row.interest_id,
    opportunityId: row.opportunity_id,
    opportunityVersion: exactVersion(row.opportunity_version, 'Task Opportunity'),
    taskDraftId: row.task_draft_id,
    providerClass: row.provider_class,
    providerBindingSha256: row.provider_binding_sha256.trim(),
    providerCapabilitySha256: row.provider_capability_sha256.trim(),
    tradeQualificationSha256: row.trade_qualification_sha256?.trim() ?? null,
    routing: {
      decisionId: row.routing_decision_id,
      decisionVersion: exactVersion(row.routing_decision_version, 'Routing decision'),
      policyVersion: row.routing_policy_version,
      outcome: row.routing_outcome,
    },
    relationshipOrigin: {
      id: row.relationship_origin_id,
      version: exactVersion(row.relationship_origin_version, 'Relationship origin'),
    },
    scopeArtifact: {
      kind: row.scope_artifact_kind,
      id: row.scope_artifact_id,
      version: exactVersion(row.scope_artifact_version, 'Scope artifact'),
      sha256: row.scope_artifact_sha256.trim(),
    },
    serviceCell: {
      authorityId: row.service_cell_authority_id,
      authorityVersion: exactVersion(row.service_cell_authority_version, 'Service cell authority'),
      regionCode: row.region_code,
    },
    workCategoryCode: row.work_category_code,
    roughLocation: row.rough_location,
    riskLevel: row.risk_level,
    requiresProof: row.requires_proof,
    status: row.status,
    expressedAt: iso(row.created_at),
    idempotencyKey: row.idempotency_key,
    requestSha256: row.request_sha256.trim(),
    idempotencyReplayed,
    eligibilityStatus: 'PENDING' as const,
    assignmentStatus: 'PENDING' as const,
    reservationCreated: false as const,
    eligibilityDecisionCreated: false as const,
    assignmentCreated: false as const,
    addressContactAccessGranted: false as const,
    financialEventCreated: false as const,
    payableCreated: false as const,
    guaranteedEarning: false as const,
    authority: universalV1TaskOpportunityAuthority,
  };
}

function nullableIso(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function nullableExactVersion(
  value: number | string | null,
  label: string
): number | null {
  return value === null ? null : exactVersion(value, label);
}

function nullableNonnegativeExactVersion(
  value: number | string | null,
  label: string
): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return fail('INTERNAL_SERVER_ERROR', `${label} returned an invalid exact version.`);
  }
  return parsed;
}

function interestJourneyResult(row: InterestJourneyRow) {
  const eligibilityCurrent = row.eligibility_is_current === true
    && row.opportunity_is_current === true
    && row.task_specific_provider_observation_current === true;
  const taskEligibilityState = row.eligibility_decision_id === null
    ? 'NOT_DECIDED'
    : !eligibilityCurrent
      ? 'STALE'
      : row.eligibility_task_eligible === true
        ? 'CURRENT_ELIGIBLE'
        : 'CURRENT_INELIGIBLE';

  let estimateInvitationState:
    | 'BLOCKED_BY_TASK_ELIGIBILITY'
    | 'HELD_PENDING_AUTHORIZED_INVITATION_COMMAND'
    | 'ISSUED'
    | 'EXPIRED_OR_STALE';
  if (taskEligibilityState !== 'CURRENT_ELIGIBLE') {
    estimateInvitationState = 'BLOCKED_BY_TASK_ELIGIBILITY';
  } else if (row.invitation_id === null) {
    estimateInvitationState = 'HELD_PENDING_AUTHORIZED_INVITATION_COMMAND';
  } else if (row.invitation_is_current === true) {
    estimateInvitationState = 'ISSUED';
  } else {
    estimateInvitationState = 'EXPIRED_OR_STALE';
  }

  let nextStep:
    | 'INTEREST_CLOSED'
    | 'RECORD_NEW_INTEREST_FOR_CURRENT_OPPORTUNITY'
    | 'AWAIT_APPROVED_INITIAL_ELIGIBILITY_COMMAND'
    | 'AWAIT_APPROVED_QUOTE_AND_ELIGIBILITY_COMMAND'
    | 'NO_ESTIMATE_INVITATION_FOR_INELIGIBLE_PROVIDER'
    | 'AWAIT_AUTHORIZED_ESTIMATE_INVITATION'
    | 'SUBMIT_PROVIDER_ESTIMATE';
  const blockerCodes: string[] = [];
  if (row.status !== 'pending') {
    nextStep = 'INTEREST_CLOSED';
  } else if (
    row.opportunity_is_current !== true
    || row.task_specific_provider_observation_current !== true
    || taskEligibilityState === 'STALE'
  ) {
    nextStep = 'RECORD_NEW_INTEREST_FOR_CURRENT_OPPORTUNITY';
    blockerCodes.push(
      row.opportunity_is_current === true
        ? 'PROVIDER_OR_ELIGIBILITY_OBSERVATION_CHANGED'
        : 'OPPORTUNITY_VERSION_CHANGED'
    );
  } else if (taskEligibilityState === 'NOT_DECIDED') {
    nextStep = row.routing_outcome === 'ESTIMATE_REQUIRED'
      ? 'AWAIT_APPROVED_INITIAL_ELIGIBILITY_COMMAND'
      : 'AWAIT_APPROVED_QUOTE_AND_ELIGIBILITY_COMMAND';
    blockerCodes.push('ACTOR_ATTESTATION_DECISION_REQUIRED');
    if (row.routing_outcome === 'FULFILLMENT_CANDIDATE') {
      blockerCodes.push('STANDARDIZED_QUOTE_COMMAND_NOT_IMPLEMENTED');
    }
  } else if (taskEligibilityState === 'CURRENT_INELIGIBLE') {
    nextStep = 'NO_ESTIMATE_INVITATION_FOR_INELIGIBLE_PROVIDER';
    blockerCodes.push('TASK_ELIGIBILITY_NOT_MET');
  } else if (estimateInvitationState !== 'ISSUED') {
    nextStep = 'AWAIT_AUTHORIZED_ESTIMATE_INVITATION';
    blockerCodes.push('ACTOR_ATTESTATION_DECISION_REQUIRED');
  } else {
    nextStep = 'SUBMIT_PROVIDER_ESTIMATE';
  }

  return {
    interest: interestResult(row, false),
    interestStatus: row.status,
    opportunityCurrent: row.opportunity_is_current,
    providerObservationCurrent: row.task_specific_provider_observation_current,
    taskEligibility: {
      state: taskEligibilityState,
      decisionId: row.eligibility_decision_id,
      decisionVersion: nullableExactVersion(
        row.eligibility_decision_version,
        'Task eligibility decision'
      ),
      taskEligible: row.eligibility_task_eligible,
      validUntil: nullableIso(row.eligibility_valid_until),
      current: eligibilityCurrent,
    },
    processorEligibility: {
      decisionPresent: row.eligibility_decision_id !== null,
      paymentEligibleObservation: row.processor_payment_eligible ?? false,
      payoutFundingEligibleObservation: row.payout_funding_eligible ?? false,
      positiveAuthority: 'NONE' as const,
    },
    estimateInvitation: {
      state: estimateInvitationState,
      invitationId: row.invitation_is_current ? row.invitation_id : null,
      quoteId: row.invitation_is_current ? row.invitation_quote_id : null,
      expectedQuoteVersion: row.invitation_is_current
        ? nullableNonnegativeExactVersion(
            row.expected_quote_version,
            'Provider estimate quote'
          )
        : null,
      validUntil: row.invitation_is_current
        ? nullableIso(row.invitation_valid_until)
        : null,
    },
    nextStep,
    blockerCodes,
    commandMutationPerformed: false as const,
    authority: universalV1TaskOpportunityPreEstimateJourneyAuthority,
  };
}

async function resolveProviderAuthority(
  query: QueryFn,
  providerUserId: string,
  selection: UniversalV1TaskOpportunityProviderSelection
): Promise<ProviderAuthority> {
  const providerOrganizationId = selection.providerOrganizationId ?? null;
  const businessCredentialId = selection.businessCredentialId ?? null;
  const result = await query<ProviderAuthorityRow>(
    `SELECT actor.account_status,
            actor.is_minor,
            COALESCE(actor.is_banned, FALSE) AS is_banned,
            profile.provider_class AS profile_provider_class,
            profile.updated_at AS profile_updated_at,
            organization.provider_class AS organization_provider_class,
            organization.status AS organization_status,
            organization.verification_status AS organization_verification_status,
            organization.provider_enabled AS organization_provider_enabled,
            EXISTS (
              SELECT 1
              FROM public.business_memberships membership
              WHERE membership.organization_id = $2::UUID
                AND membership.user_id = actor.id
                AND membership.status = 'ACTIVE'
                AND membership.role IN ('OWNER', 'ADMIN', 'DISPATCHER', 'CREW')
            ) AS active_membership,
            EXISTS (
              SELECT 1
              FROM public.current_verified_trade_qualifications qualification
              WHERE qualification.provider_user_id = actor.id
                AND qualification.organization_id = $2::UUID
                AND qualification.business_credential_id = $3::UUID
            ) AS current_trade_credential
     FROM public.users actor
     LEFT JOIN public.capability_profiles profile ON profile.user_id = actor.id
     LEFT JOIN public.business_organizations organization ON organization.id = $2::UUID
     WHERE actor.id = $1::UUID
     LIMIT 1`,
    [providerUserId, providerOrganizationId, businessCredentialId]
  );
  const row = result.rows[0];
  if (!row || row.account_status !== 'ACTIVE' || row.is_minor !== false || row.is_banned === true) {
    return { state: 'HELD', blockerCodes: ['PROVIDER_IDENTITY_UNAVAILABLE'] };
  }
  if (
    !row.profile_updated_at ||
    !universalV1TaskOpportunityProviderClasses.includes(
      row.profile_provider_class as UniversalV1TaskOpportunityProviderClass
    )
  ) {
    return { state: 'HELD', blockerCodes: ['PROVIDER_CAPABILITY_UNRESOLVED'] };
  }
  if (!providerOrganizationId) {
    if (businessCredentialId) {
      return { state: 'HELD', blockerCodes: ['ORGANIZATION_REQUIRED_FOR_TRADE_CREDENTIAL'] };
    }
    if (row.profile_provider_class !== 'GENERAL_SERVICE_PROVIDER') {
      return { state: 'HELD', blockerCodes: ['VERIFIED_TRADE_BUSINESS_SELECTION_REQUIRED'] };
    }
    return {
      state: 'READY',
      providerClass: 'GENERAL_SERVICE_PROVIDER',
      providerOrganizationId: null,
      businessCredentialId: null,
    };
  }
  if (
    row.organization_status !== 'ACTIVE' ||
    row.organization_verification_status !== 'VERIFIED' ||
    row.organization_provider_enabled !== true ||
    row.active_membership !== true
  ) {
    return { state: 'HELD', blockerCodes: ['PROVIDER_BUSINESS_AUTHORITY_UNRESOLVED'] };
  }
  if (row.organization_provider_class === 'GENERAL_SERVICE_PROVIDER') {
    if (businessCredentialId || row.profile_provider_class !== 'GENERAL_SERVICE_PROVIDER') {
      return { state: 'HELD', blockerCodes: ['GENERAL_PROVIDER_BUSINESS_SELECTION_INCONSISTENT'] };
    }
    return {
      state: 'READY',
      providerClass: 'GENERAL_SERVICE_PROVIDER',
      providerOrganizationId,
      businessCredentialId: null,
    };
  }
  if (row.organization_provider_class === 'VERIFIED_TRADE_BUSINESS') {
    if (
      !businessCredentialId ||
      row.profile_provider_class !== 'VERIFIED_TRADE_BUSINESS' ||
      row.current_trade_credential !== true
    ) {
      return { state: 'HELD', blockerCodes: ['CURRENT_TRADE_QUALIFICATION_UNRESOLVED'] };
    }
    return {
      state: 'READY',
      providerClass: 'VERIFIED_TRADE_BUSINESS',
      providerOrganizationId,
      businessCredentialId,
    };
  }
  return { state: 'HELD', blockerCodes: ['PROVIDER_BUSINESS_CLASS_UNRESOLVED'] };
}

async function assertActiveProviderIdentity(query: QueryFn, providerUserId: string): Promise<void> {
  const result = await query<ActiveProviderIdentityRow>(
    `SELECT EXISTS (
       SELECT 1
       FROM public.users actor
       WHERE actor.id = $1::UUID
         AND actor.account_status = 'ACTIVE'
         AND actor.is_minor IS FALSE
         AND COALESCE(actor.is_banned, FALSE) IS FALSE
     ) AS active_provider_identity`,
    [providerUserId]
  );
  if (result.rows[0]?.active_provider_identity !== true) {
    return fail('PRECONDITION_FAILED', 'Current active adult provider identity is required.');
  }
}

const opportunityColumns = `opportunity.opportunity_id,
  opportunity.opportunity_version,
  opportunity.task_draft_id,
  opportunity.routing_decision_id,
  opportunity.routing_decision_version,
  opportunity.routing_policy_version,
  opportunity.relationship_origin_id,
  opportunity.relationship_origin_version,
  opportunity.relationship_origin_kind,
  opportunity.relationship_origin_policy_version,
  opportunity.scope_artifact_kind,
  opportunity.scope_artifact_id,
  opportunity.scope_artifact_version,
  opportunity.scope_artifact_sha256,
  opportunity.public_scope,
  opportunity.work_category_code,
  opportunity.service_cell_authority_id,
  opportunity.service_cell_authority_version,
  opportunity.service_cell_evidence_sha256,
  opportunity.region_code,
  opportunity.rough_location,
  opportunity.risk_level,
  opportunity.requires_proof,
  opportunity.routing_outcome,
  opportunity.routed_at,
  opportunity.privacy_posture,
  opportunity.eligibility_posture,
  opportunity.assignment_authority,
  opportunity.address_contact_authority,
  opportunity.financial_authority,
  opportunity.guaranteed_earning_authority`;

const interestColumns = `application.id AS interest_id,
  application.opportunity_id,
  application.opportunity_version,
  application.task_draft_id,
  application.interest_routing_decision_id AS routing_decision_id,
  application.interest_routing_decision_version AS routing_decision_version,
  routing.policy_version AS routing_policy_version,
  application.interest_relationship_origin_id AS relationship_origin_id,
  application.interest_relationship_origin_version AS relationship_origin_version,
  application.interest_scope_artifact_kind AS scope_artifact_kind,
  application.interest_scope_artifact_id AS scope_artifact_id,
  application.interest_scope_artifact_version AS scope_artifact_version,
  application.interest_scope_artifact_sha256 AS scope_artifact_sha256,
  application.provider_class_snapshot AS provider_class,
  application.provider_binding_sha256,
  application.provider_capability_sha256,
  application.trade_qualification_sha256,
  routing.category_snapshot AS work_category_code,
  routing.service_cell_authority_id,
  cell.authority_version AS service_cell_authority_version,
  routing.service_cell_snapshot AS region_code,
  routing.evidence ->> 'rough_location' AS rough_location,
  routing.evidence ->> 'risk_level' AS risk_level,
  routing.evidence -> 'requires_proof' = 'true'::JSONB AS requires_proof,
  routing.outcome AS routing_outcome,
  application.status,
  application.created_at,
  application.idempotency_key,
  application.request_sha256`;

export class UniversalV1TaskOpportunityService {
  constructor(private readonly database: OpportunityDatabase = db) {}

  async browse(context: Context, input: BrowseUniversalV1TaskOpportunitiesInput) {
    const providerUserId = actorId(context);
    const authority = await resolveProviderAuthority(this.database.query, providerUserId, input);
    if (authority.state === 'HELD') {
      return {
        state: authority.state,
        blockerCodes: authority.blockerCodes,
        opportunities: [],
        authority: universalV1TaskOpportunityAuthority,
      };
    }
    const result = await this.database.query<OpportunityRow>(
      `SELECT ${opportunityColumns}
       FROM public.current_universal_v1_task_opportunities_v1 opportunity
       WHERE opportunity.service_cell_authority_id = $1::UUID
         AND ($2::TEXT IS NULL OR opportunity.work_category_code = $2::TEXT)
         AND (
           $3::TEXT = 'GENERAL_SERVICE_PROVIDER'
           OR EXISTS (
             SELECT 1
             FROM public.current_verified_trade_qualifications qualification
             CROSS JOIN LATERAL unnest(qualification.permitted_work_categories) permitted(category)
             WHERE qualification.provider_user_id = $4::UUID
               AND qualification.organization_id = $5::UUID
               AND qualification.business_credential_id = $6::UUID
               AND qualification.jurisdiction_code = opportunity.region_code
               AND lower(permitted.category) = opportunity.work_category_code
           )
         )
       ORDER BY opportunity.routed_at ASC, opportunity.opportunity_id ASC
       LIMIT $7 OFFSET $8`,
      [
        input.serviceCellAuthorityId,
        input.workCategoryCode ?? null,
        authority.providerClass,
        providerUserId,
        authority.providerOrganizationId,
        authority.businessCredentialId,
        input.limit,
        input.offset,
      ]
    );
    return {
      state: 'READY' as const,
      providerClass: authority.providerClass,
      selectedServiceCellAuthority: 'BROWSE_FILTER_ONLY' as const,
      opportunities: result.rows.map(opportunityResult),
      authority: universalV1TaskOpportunityAuthority,
    };
  }

  async expressInterest(context: Context, input: ExpressUniversalV1TaskInterestInput) {
    const providerUserId = actorId(context);
    const requestDigest = requestSha256(providerUserId, input);
    try {
      return await this.database.transaction(async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `task-opportunity-interest:${providerUserId}:${input.idempotencyKey}`,
        ]);
        await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `task-opportunity-provider:${providerUserId}:${input.providerOrganizationId ?? ''}:${input.opportunityId}`,
        ]);
        await assertActiveProviderIdentity(query, providerUserId);

        const replay = await query<InterestRow>(
          `SELECT ${interestColumns}
           FROM public.task_applications application
           JOIN public.task_routing_decisions routing
             ON routing.id = application.interest_routing_decision_id
           JOIN public.universal_v1_service_cell_authorities cell
             ON cell.id = routing.service_cell_authority_id
           WHERE application.hustler_id = $1::UUID
             AND application.idempotency_key = $2
             AND application.universal_contract_version = 1
           LIMIT 1`,
          [providerUserId, input.idempotencyKey]
        );
        if (replay.rows[0]) {
          if (replay.rows[0].request_sha256.trim() !== requestDigest) {
            return fail('CONFLICT', 'The idempotency key is bound to a different request.');
          }
          return interestResult(replay.rows[0], true);
        }

        const authority = await resolveProviderAuthority(query, providerUserId, input);
        if (authority.state === 'HELD') {
          return fail(
            'PRECONDITION_FAILED',
            `Provider observation held: ${authority.blockerCodes.join(',')}.`
          );
        }
        const opportunity = await query<OpportunityRow>(
          `SELECT ${opportunityColumns}
           FROM public.current_universal_v1_task_opportunities_v1 opportunity
           WHERE opportunity.opportunity_id = $1::UUID
             AND opportunity.opportunity_version = $2
           LIMIT 1`,
          [input.opportunityId, input.expectedOpportunityVersion]
        );
        const currentOpportunity = opportunity.rows[0];
        if (!currentOpportunity) {
          return fail(
            'CONFLICT',
            'The exact current open Task Opportunity version is unavailable.'
          );
        }
        if (authority.providerClass === 'VERIFIED_TRADE_BUSINESS') {
          const qualification = await query(
            `SELECT 1
             FROM public.current_verified_trade_qualifications current_qualification
             CROSS JOIN LATERAL unnest(current_qualification.permitted_work_categories)
               permitted(category)
             WHERE current_qualification.provider_user_id = $1::UUID
               AND current_qualification.organization_id = $2::UUID
               AND current_qualification.business_credential_id = $3::UUID
               AND current_qualification.jurisdiction_code = $4
               AND lower(permitted.category) = $5
             LIMIT 1`,
            [
              providerUserId,
              authority.providerOrganizationId,
              authority.businessCredentialId,
              currentOpportunity.region_code,
              currentOpportunity.work_category_code,
            ]
          );
          if (qualification.rowCount !== 1) {
            return fail(
              'PRECONDITION_FAILED',
              'Current trade credential does not cover this category and jurisdiction.'
            );
          }
        }

        const existing = await query<InterestRow>(
          `SELECT ${interestColumns}
           FROM public.task_applications application
           JOIN public.task_routing_decisions routing
             ON routing.id = application.interest_routing_decision_id
           JOIN public.universal_v1_service_cell_authorities cell
             ON cell.id = routing.service_cell_authority_id
           WHERE application.opportunity_contract_version = 1
             AND application.opportunity_id = $1::UUID
             AND application.hustler_id = $2::UUID
             AND application.provider_organization_id IS NOT DISTINCT FROM $3::UUID
           LIMIT 1`,
          [input.opportunityId, providerUserId, authority.providerOrganizationId]
        );
        if (existing.rows[0]) {
          return fail(
            'CONFLICT',
            'This provider already expressed interest in the Task Opportunity under a different idempotency key.'
          );
        }

        const inserted = await query<InterestRow>(
          `WITH inserted AS (
             INSERT INTO public.task_applications(
               task_id,
               hustler_id,
               message,
               status,
               counter_offer_round,
               rejection_reason,
               universal_contract_version,
               authority,
               provider_organization_id,
               interest_scope_version_id,
               idempotency_key,
               request_sha256,
               opportunity_contract_version,
               opportunity_id,
               opportunity_version,
               observed_trade_credential_id
             ) VALUES (
               NULL, $1::UUID, NULL, 'pending', 0, NULL,
               1, 'EXPRESS_INTEREST', $2::UUID, NULL, $3, $4,
               1, $5::UUID, $6, $7::UUID
             )
             RETURNING *
           )
           SELECT ${interestColumns}
           FROM inserted application
           JOIN public.task_routing_decisions routing
             ON routing.id = application.interest_routing_decision_id
           JOIN public.universal_v1_service_cell_authorities cell
             ON cell.id = routing.service_cell_authority_id`,
          [
            providerUserId,
            authority.providerOrganizationId,
            input.idempotencyKey,
            requestDigest,
            input.opportunityId,
            input.expectedOpportunityVersion,
            authority.businessCredentialId,
          ]
        );
        const row = inserted.rows[0];
        if (!row) return fail('INTERNAL_SERVER_ERROR', 'EXPRESS_INTEREST returned no record.');
        return interestResult(row, false);
      });
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  async getMyPreEstimateJourneyState(
    context: Context,
    input: GetUniversalV1TaskInterestJourneyInput
  ) {
    const providerUserId = actorId(context);
    return this.database.transaction(async (query) => {
      const selection = await query<InterestAuthoritySelectionRow>(
        `SELECT application.provider_organization_id,
                application.observed_trade_credential_id
         FROM public.task_applications application
         WHERE application.id = $1::UUID
           AND application.hustler_id = $2::UUID
           AND application.opportunity_contract_version = 1
           AND application.universal_contract_version = 1
           AND application.authority = 'EXPRESS_INTEREST'
         LIMIT 1`,
        [input.interestId, providerUserId]
      );
      const selected = selection.rows[0];
      if (!selected) {
        return fail('NOT_FOUND', 'The Task Opportunity interest is unavailable.');
      }

      const authority = await resolveProviderAuthority(query, providerUserId, {
        providerOrganizationId: selected.provider_organization_id ?? undefined,
        businessCredentialId: selected.observed_trade_credential_id ?? undefined,
      });
      if (authority.state === 'HELD') {
        return fail(
          'PRECONDITION_FAILED',
          `Provider observation held: ${authority.blockerCodes.join(',')}.`
        );
      }

      const result = await query<InterestJourneyRow>(
        `SELECT ${interestColumns},
                current_opportunity.opportunity_id IS NOT NULL
                  AS opportunity_is_current,
                CASE
                  WHEN application.provider_class_snapshot = 'GENERAL_SERVICE_PROVIDER'
                    THEN application.observed_trade_credential_id IS NULL
                  WHEN application.provider_class_snapshot = 'VERIFIED_TRADE_BUSINESS'
                    THEN EXISTS (
                      SELECT 1
                      FROM public.current_verified_trade_qualifications qualification
                      CROSS JOIN LATERAL unnest(qualification.permitted_work_categories)
                        permitted(category)
                      WHERE qualification.provider_user_id = application.hustler_id
                        AND qualification.organization_id = application.provider_organization_id
                        AND qualification.business_credential_id =
                            application.observed_trade_credential_id
                        AND qualification.jurisdiction_code = routing.service_cell_snapshot
                        AND lower(permitted.category) = routing.category_snapshot
                    )
                  ELSE FALSE
                END AS task_specific_provider_observation_current,
                eligibility.id AS eligibility_decision_id,
                eligibility.decision_version AS eligibility_decision_version,
                eligibility.task_eligible AS eligibility_task_eligible,
                eligibility.processor_payment_eligible,
                eligibility.payout_funding_eligible,
                eligibility.valid_until AS eligibility_valid_until,
                (
                  eligibility.id IS NOT NULL
                  AND eligibility.evaluated_at <= clock_timestamp()
                  AND eligibility.valid_until > clock_timestamp()
                ) AS eligibility_is_current,
                invitation.id AS invitation_id,
                invitation.quote_id AS invitation_quote_id,
                invitation.valid_until AS invitation_valid_until,
                (
                  invitation.id IS NOT NULL
                  AND invitation.valid_until > clock_timestamp()
                ) AS invitation_is_current,
                CASE
                  WHEN invitation.id IS NULL THEN NULL
                  ELSE COALESCE(active_quote_version.expected_quote_version, 0)
                END AS expected_quote_version
         FROM public.task_applications application
         JOIN public.task_routing_decisions routing
           ON routing.id = application.interest_routing_decision_id
         JOIN public.universal_v1_service_cell_authorities cell
           ON cell.id = routing.service_cell_authority_id
         LEFT JOIN public.current_universal_v1_task_opportunities_v1 current_opportunity
           ON current_opportunity.opportunity_id = application.opportunity_id
          AND current_opportunity.opportunity_version = application.opportunity_version
          AND current_opportunity.task_draft_id = application.task_draft_id
          AND current_opportunity.routing_decision_id =
              application.interest_routing_decision_id
         LEFT JOIN LATERAL (
           SELECT candidate.*
           FROM public.task_provider_eligibility_decisions candidate
           WHERE candidate.interest_application_id = application.id
             AND candidate.task_draft_id = application.task_draft_id
             AND candidate.task_id IS NULL
             AND candidate.scope_version_id IS NULL
             AND candidate.routing_decision_id = application.interest_routing_decision_id
             AND candidate.provider_user_id = application.hustler_id
             AND candidate.provider_organization_id IS NOT DISTINCT FROM
                 application.provider_organization_id
           ORDER BY candidate.decision_version DESC, candidate.evaluated_at DESC,
                    candidate.id DESC
           LIMIT 1
         ) eligibility ON TRUE
         LEFT JOIN public.task_provider_estimate_invitations invitation
           ON invitation.eligibility_decision_id = eligibility.id
         LEFT JOIN public.quotes quote
           ON quote.id = invitation.quote_id
          AND quote.task_draft_id = application.task_draft_id
          AND quote.provider_user_id = application.hustler_id
          AND quote.provider_organization_id IS NOT DISTINCT FROM
              application.provider_organization_id
         LEFT JOIN public.quote_versions active_quote_version
           ON active_quote_version.id = quote.active_version_id
          AND active_quote_version.quote_id = quote.id
         WHERE application.id = $1::UUID
           AND application.hustler_id = $2::UUID
           AND application.opportunity_contract_version = 1
           AND application.universal_contract_version = 1
           AND application.authority = 'EXPRESS_INTEREST'
         LIMIT 1`,
        [input.interestId, providerUserId]
      );
      const row = result.rows[0];
      if (!row) {
        return fail('NOT_FOUND', 'The Task Opportunity interest is unavailable.');
      }
      return interestJourneyResult(row);
    });
  }

  async listMine(context: Context, input: ListUniversalV1TaskInterestsInput) {
    const providerUserId = actorId(context);
    await assertActiveProviderIdentity(this.database.query, providerUserId);
    const result = await this.database.query<InterestRow>(
      `SELECT ${interestColumns}
       FROM public.task_applications application
       JOIN public.task_routing_decisions routing
         ON routing.id = application.interest_routing_decision_id
       JOIN public.universal_v1_service_cell_authorities cell
         ON cell.id = routing.service_cell_authority_id
       WHERE application.opportunity_contract_version = 1
         AND application.hustler_id = $1::UUID
         AND EXISTS (
           SELECT 1
           FROM public.users actor
           WHERE actor.id = application.hustler_id
             AND actor.account_status = 'ACTIVE'
             AND actor.is_minor IS FALSE
             AND COALESCE(actor.is_banned, FALSE) IS FALSE
         )
       ORDER BY application.created_at DESC, application.id DESC
       LIMIT $2 OFFSET $3`,
      [providerUserId, input.limit, input.offset]
    );
    return {
      interests: result.rows.map((row) => interestResult(row, false)),
      authority: universalV1TaskOpportunityAuthority,
    };
  }

  async listForOps(_context: Context, input: ListUniversalV1TaskInterestsForOpsInput) {
    const result = await this.database.query<InterestRow>(
      `SELECT ${interestColumns}
       FROM public.task_applications application
       JOIN public.task_routing_decisions routing
         ON routing.id = application.interest_routing_decision_id
       JOIN public.universal_v1_service_cell_authorities cell
         ON cell.id = routing.service_cell_authority_id
       WHERE application.opportunity_contract_version = 1
         AND ($1::TEXT IS NULL OR application.provider_class_snapshot = $1)
         AND ($2::TEXT IS NULL OR routing.category_snapshot = $2)
       ORDER BY application.created_at DESC, application.id DESC
       LIMIT $3 OFFSET $4`,
      [input.providerClass ?? null, input.workCategoryCode ?? null, input.limit, input.offset]
    );
    return {
      interests: result.rows.map((row) => interestResult(row, false)),
      redaction: {
        customerIdentity: 'OMITTED',
        providerIdentity: 'DIGEST_ONLY',
        exactAddress: 'OMITTED',
        contact: 'OMITTED',
        freeFormScope: 'OMITTED',
      } as const,
      authority: universalV1TaskOpportunityAuthority,
    };
  }
}

export const universalV1TaskOpportunityService = new UniversalV1TaskOpportunityService();
