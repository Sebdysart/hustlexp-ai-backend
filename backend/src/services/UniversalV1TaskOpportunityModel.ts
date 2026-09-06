import { createHash } from 'node:crypto';

import { TRPCError } from '@trpc/server';

import type { QueryFn } from '../db.js';
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
 * Read-only continuation authority for a recorded TaskDraft interest. It can
 * report existing facts, but cannot mint eligibility or an estimate invitation.
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

export interface BrowseUniversalV1TaskOpportunitiesInput
  extends UniversalV1TaskOpportunityProviderSelection {
  serviceCellAuthorityId: string;
  workCategoryCode?: string;
  limit: number;
  offset: number;
}

export interface ExpressUniversalV1TaskInterestInput
  extends UniversalV1TaskOpportunityProviderSelection {
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

export interface ListUniversalV1TaskInterestsForOpsInput
  extends ListUniversalV1TaskInterestsInput {
  providerClass?: UniversalV1TaskOpportunityProviderClass;
  workCategoryCode?: string;
}

export interface OpportunityDatabase {
  query: QueryFn;
  transaction: <T>(fn: (query: QueryFn) => Promise<T>) => Promise<T>;
}

export interface ProviderAuthorityRow {
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

export interface ActiveProviderIdentityRow {
  active_provider_identity: boolean;
}

export interface ProviderAuthorityReady {
  state: 'READY';
  providerClass: UniversalV1TaskOpportunityProviderClass;
  providerOrganizationId: string | null;
  businessCredentialId: string | null;
}

export interface ProviderAuthorityHeld {
  state: 'HELD';
  blockerCodes: string[];
}

export type ProviderAuthority = ProviderAuthorityReady | ProviderAuthorityHeld;

export interface OpportunityRow {
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
  standardized_quote_id: string | null;
  standardized_quote_version: number | string | null;
  standardized_quote_sha256: string | null;
  standardized_scope_artifact_kind: 'TASK_DRAFT_STANDARDIZED_SCOPE_V1' | null;
  standardized_scope_artifact_id: string | null;
  standardized_scope_artifact_version: number | string | null;
  standardized_scope_artifact_sha256: string | null;
  customer_total_cents: number | string | null;
  currency: 'usd' | null;
  fake_payment_method_ready: boolean;
  payment_method_readiness_posture:
    | 'FAKE_PAYMENT_METHOD_READY_NO_FINANCIAL_EFFECT'
    | 'NOT_APPLICABLE';
}

export interface InterestRow {
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

export interface InterestAuthoritySelectionRow {
  provider_organization_id: string | null;
  observed_trade_credential_id: string | null;
}

export interface InterestJourneyRow extends InterestRow {
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

type OpportunityFailureCode =
  | 'UNAUTHORIZED'
  | 'PRECONDITION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_SERVER_ERROR';

export function fail(code: OpportunityFailureCode, message: string): never {
  throw new TRPCError({ code, message });
}

export function actorId(context: Context): string {
  return context.user?.id ?? fail('UNAUTHORIZED', 'Authentication required.');
}

export function exactVersion(value: number | string, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fail('INTERNAL_SERVER_ERROR', `${label} returned an invalid exact version.`);
  }
  return parsed;
}

export function iso(value: Date | string): string {
  const timestamp = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    return fail('INTERNAL_SERVER_ERROR', 'Task opportunity returned an invalid timestamp.');
  }
  return timestamp.toISOString();
}

export function requestSha256(
  actor: string,
  input: ExpressUniversalV1TaskInterestInput
): string {
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

export function translateDatabaseError(error: unknown): never {
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

export const opportunityColumns = `opportunity.opportunity_id,
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
  opportunity.guaranteed_earning_authority,
  opportunity.standardized_quote_id,
  opportunity.standardized_quote_version,
  opportunity.standardized_quote_sha256,
  opportunity.standardized_scope_artifact_kind,
  opportunity.standardized_scope_artifact_id,
  opportunity.standardized_scope_artifact_version,
  opportunity.standardized_scope_artifact_sha256,
  opportunity.customer_total_cents,
  opportunity.currency,
  opportunity.fake_payment_method_ready,
  opportunity.payment_method_readiness_posture`;

export const interestColumns = `application.id AS interest_id,
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
