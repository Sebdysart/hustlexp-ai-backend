import { randomUUID } from 'node:crypto';

import { db, type Database, type QueryFn } from '../db.js';
import {
  evaluateTaskAgainstRegionPolicy,
  type RegionPolicyRow,
  type RegionPolicyTaskSnapshot,
} from './RegionPolicyService.js';
import type {
  AcceptUniversalV1ProviderEstimate,
  AcceptedUniversalV1ProviderEstimate,
  IssuedUniversalV1ProviderEstimateInvitation,
  IssueUniversalV1ProviderEstimateInvitation,
  SubmitUniversalV1ProviderEstimate,
  SubmittedUniversalV1ProviderEstimate,
} from './UniversalV1EstimateContracts.js';
import {
  SubmitUniversalV1ProviderEstimateSchema,
  universalV1EstimateSubmissionRequestSha256,
} from './UniversalV1EstimateContracts.js';
import {
  UniversalV1EstimateError,
  type UniversalV1EstimateErrorCode,
  type UniversalV1EstimateRepository,
} from './UniversalV1EstimateService.js';

const ESTIMATE_ACCEPTANCE_POLICY_VERSION = 'universal-v1-estimate-acceptance-1.1.0';
const ESTIMATE_INVITATION_AUTHORITY_POLICY_VERSION =
  'universal-v1-estimate-invitation-named-operator-1.1.0';
const ESTIMATE_ROUTE_REASON = 'CUSTOMER_ACCEPTED_PROVIDER_ESTIMATE';
const TRADE_ROUTE_REASON = 'CREDENTIALED_TRADE_REVIEW_REQUIRED';

function fail(code: UniversalV1EstimateErrorCode, message: string): never {
  throw new UniversalV1EstimateError(code, message);
}

interface EstimateReplayRow {
  id: string;
  quote_id: string;
  quote_version_id: string;
  routing_decision_id: string;
  provider_user_id: string;
  provider_organization_id: string | null;
  submitted_by: string;
  expected_quote_version: number;
  scope_snapshot: SubmitUniversalV1ProviderEstimate['scope'];
  scope_hash: string;
  line_items: SubmitUniversalV1ProviderEstimate['line_items'];
  customer_total_cents: number | string;
  provider_payout_cents: number | string;
  currency: string;
  idempotency_key: string;
  task_draft_id: string;
  decision_version: number;
}

interface EstimateInvitationReplayRow {
  id: string;
  quote_id: string;
  task_draft_id: string;
  routing_decision_id: string;
  eligibility_decision_id: string;
  routing_decision_version: number | string;
  eligibility_decision_version: number | string;
  valid_until: Date | string;
  request_sha256: string;
  operator_authorized: boolean;
}

interface EstimateInvitationContextRow {
  task_draft_id: string;
  routing_decision_id: string;
  provider_user_id: string;
  provider_organization_id: string | null;
  eligibility_decision_version: number | string;
  eligibility_valid_until: Date | string;
  routing_decision_version: number | string;
  existing_invitation_id: string | null;
  operator_authorized: boolean;
  provider_self_selection_clear: boolean;
  provider_authority_current: boolean;
  route_context_current: boolean;
  eligibility_context_current: boolean;
  eligibility_expired: boolean;
  eligibility_snapshot_valid: boolean;
}

interface ActiveEstimateRouteRow {
  task_draft_id: string;
  decision_version: number;
  outcome: string;
  reason_codes: string[];
  category_snapshot: string;
  universal_contract_version: number;
}

interface QuoteAggregateRow {
  id: string;
  task_draft_id: string | null;
  task_id: string | null;
  quote_kind: string;
  provider_user_id: string | null;
  provider_organization_id: string | null;
  routing_decision_id: string | null;
  active_version_id: string | null;
  active_expected_quote_version: number | null;
  invitation_id: string | null;
  invitation_task_draft_id: string | null;
  invitation_routing_decision_id: string | null;
  invitation_provider_user_id: string | null;
  invitation_provider_organization_id: string | null;
  invitation_work_category_code: string | null;
  invitation_valid_until: string | Date | null;
}

interface ProviderOrganizationAuthorityRow {
  provider_class: string | null;
  organization_authorized: boolean;
  actor_membership_authorized: boolean;
  provider_membership_authorized: boolean;
  trade_qualification_authorized: boolean;
}

interface AcceptanceReplayRow {
  id: string;
  task_draft_id: string;
  provider_estimate_submission_id: string;
  quote_id: string;
  quote_version_id: string;
  poster_user_id: string;
  prior_routing_decision_id: string;
  resulting_routing_decision_id: string;
  task_id: string;
  scope_version_id: string;
  expected_draft_version: number;
  idempotency_key: string;
  request_sha256: string;
  materialization_version: number;
  resulting_draft_version: number;
}

interface EstimateAcceptanceContextRow {
  task_draft_id: string;
  poster_user_id: string | null;
  task_id: string | null;
  ingress_origin: string;
  draft_status: string;
  draft_quote_id: string | null;
  universal_contract_version: number;
  prior_routing_decision_id: string;
  decision_version: number;
  route_outcome: string;
  provider_estimate_submission_id: string;
  quote_id: string;
  quote_version_id: string;
  quote_kind: string;
  active_version_id: string | null;
  provider_user_id: string;
  provider_organization_id: string | null;
  work_category_code: string;
  scope_snapshot: SubmitUniversalV1ProviderEstimate['scope'];
  scope_hash: string;
  customer_total_cents: number | string;
  provider_payout_cents: number | string;
  currency: string;
}

function sameNullable(left: string | null, right: string | null): boolean {
  return left === right;
}

function exactPositiveVersion(
  value: number | string,
  label: string,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    fail('ESTIMATE_INVITATION_CONTEXT_INVALID', `${label} is not canonical.`);
  }
  return parsed;
}

function exactIsoTimestamp(value: Date | string, label: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    fail('ESTIMATE_INVITATION_CONTEXT_INVALID', `${label} is not canonical.`);
  }
  return parsed.toISOString();
}

function issuedEstimateInvitation(
  row: EstimateInvitationReplayRow,
  replayed: boolean,
): IssuedUniversalV1ProviderEstimateInvitation {
  return {
    invitation_id: row.id,
    quote_id: row.quote_id,
    task_draft_id: row.task_draft_id,
    routing_decision_id: row.routing_decision_id,
    eligibility_decision_id: row.eligibility_decision_id,
    expected_draft_version: exactPositiveVersion(
      row.routing_decision_version,
      'Invitation route version',
    ),
    expected_eligibility_version: exactPositiveVersion(
      row.eligibility_decision_version,
      'Invitation eligibility version',
    ),
    valid_until: exactIsoTimestamp(row.valid_until, 'Invitation validity'),
    request_sha256: row.request_sha256,
    replayed,
    payment_creation_performed: false,
    financial_security_event_created: false,
    conditional_hold_created: false,
    hard_assignment_created: false,
    work_order_created: false,
    universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
  };
}

async function loadEstimateInvitationReplay(
  query: QueryFn,
  command: IssueUniversalV1ProviderEstimateInvitation,
): Promise<EstimateInvitationReplayRow | undefined> {
  const result = await query<EstimateInvitationReplayRow>(
    `SELECT invitation.id, invitation.quote_id, invitation.task_draft_id,
            invitation.routing_decision_id, invitation.eligibility_decision_id,
            invitation.routing_decision_version,
            invitation.eligibility_decision_version, invitation.valid_until,
            invitation.request_sha256,
            EXISTS (
              SELECT 1
                FROM users operator
                JOIN admin_roles operator_role ON operator_role.user_id = operator.id
               WHERE operator.id = $1
                 AND operator.account_status = 'ACTIVE'
                 AND operator.is_minor IS FALSE
                 AND COALESCE(operator.is_banned, FALSE) IS FALSE
                 AND operator_role.can_manage_operations IS TRUE
            ) AS operator_authorized
       FROM task_provider_estimate_invitations invitation
      WHERE invitation.decision_authority = 'NAMED_OPERATOR'
        AND invitation.decided_by = $1
        AND invitation.idempotency_key = $2
      LIMIT 1`,
    [command.actor_user_id, command.idempotency_key],
  );
  return result.rows[0];
}

function assertExactInvitationReplay(
  row: EstimateInvitationReplayRow,
  command: IssueUniversalV1ProviderEstimateInvitation,
): void {
  if (row.operator_authorized !== true) {
    fail(
      'ESTIMATE_INVITATION_OPERATOR_NOT_AUTHORIZED',
      'Current Operations authority is required to replay an estimate invitation.',
    );
  }
  if (
    row.eligibility_decision_id !== command.eligibility_decision_id
    || exactPositiveVersion(row.routing_decision_version, 'Invitation route version')
      !== command.expected_draft_version
    || exactPositiveVersion(row.eligibility_decision_version, 'Invitation eligibility version')
      !== command.expected_eligibility_version
  ) {
    fail(
      'ESTIMATE_INVITATION_IDEMPOTENCY_CONFLICT',
      'The invitation key was used with different input.',
    );
  }
}

async function loadEstimateInvitationContext(
  query: QueryFn,
  command: IssueUniversalV1ProviderEstimateInvitation,
): Promise<EstimateInvitationContextRow | undefined> {
  const result = await query<EstimateInvitationContextRow>(
    `SELECT eligibility.task_draft_id,
            eligibility.routing_decision_id,
            eligibility.provider_user_id,
            eligibility.provider_organization_id,
            eligibility.decision_version AS eligibility_decision_version,
            eligibility.valid_until AS eligibility_valid_until,
            public.lock_universal_v1_estimate_authority(
              eligibility.task_draft_id, eligibility.provider_user_id,
              eligibility.provider_organization_id, eligibility.trade_credential_id, $2
            ) AS authority_lock,
            route.decision_version AS routing_decision_version,
            existing_invitation.id AS existing_invitation_id,
            EXISTS (
              SELECT 1
                FROM users operator
                JOIN admin_roles operator_role ON operator_role.user_id = operator.id
               WHERE operator.id = $2
                 AND operator.account_status = 'ACTIVE'
                 AND operator.is_minor IS FALSE
                 AND COALESCE(operator.is_banned, FALSE) IS FALSE
                 AND operator_role.can_manage_operations IS TRUE
            ) AS operator_authorized,
            (
              eligibility.provider_user_id IS DISTINCT FROM $2::UUID
              AND NOT EXISTS (
                SELECT 1
                  FROM business_memberships operator_membership
                 WHERE operator_membership.organization_id =
                       eligibility.provider_organization_id
                   AND operator_membership.user_id = $2
                   AND operator_membership.status = 'ACTIVE'
              )
            ) AS provider_self_selection_clear,
            public.universal_v1_invited_provider_authority_is_current(
              eligibility.provider_user_id,
              eligibility.provider_organization_id,
              eligibility.provider_class,
              eligibility.trade_credential_id,
              eligibility.evidence->>'work_category_code',
              eligibility.evidence->>'region_code'
            ) AS provider_authority_current,
            (
              draft.universal_contract_version = 1
              AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
              AND draft.status = 'account_claimed'
              AND draft.task_id IS NULL
              AND draft.active_routing_decision_id = route.id
              AND route.task_draft_id = draft.id
              AND route.outcome = 'ESTIMATE_REQUIRED'
            ) AS route_context_current,
            (
              eligibility.task_id IS NULL
              AND eligibility.scope_version_id IS NULL
              AND eligibility.task_eligible IS TRUE
              AND eligibility.evaluated_at <= clock_timestamp()
              AND eligibility.valid_until > clock_timestamp()
              AND NOT EXISTS (
                SELECT 1
                  FROM task_provider_eligibility_decisions newer
                 WHERE newer.task_draft_id = eligibility.task_draft_id
                   AND newer.provider_user_id IS NOT DISTINCT FROM
                       eligibility.provider_user_id
                   AND newer.provider_organization_id IS NOT DISTINCT FROM
                       eligibility.provider_organization_id
                   AND newer.decision_version > eligibility.decision_version
              )
            ) AS eligibility_context_current,
            eligibility.valid_until <= clock_timestamp() AS eligibility_expired,
            (
              jsonb_typeof(eligibility.evidence) = 'object'
              AND jsonb_typeof(eligibility.evidence->'work_category_code') = 'string'
              AND eligibility.evidence->>'work_category_code' = route.category_snapshot
              AND eligibility.evidence->>'work_category_code'
                    ~ '^[a-z][a-z0-9_]{1,63}$'
              AND jsonb_typeof(eligibility.evidence->'region_code') = 'string'
              AND eligibility.evidence->>'region_code' ~ '^US-[A-Z]{2}$'
              AND jsonb_typeof(eligibility.evidence->'risk_level') = 'string'
              AND eligibility.evidence->>'risk_level'
                    IN ('LOW','MEDIUM','HIGH','IN_HOME')
              AND jsonb_typeof(eligibility.evidence->'requires_proof') = 'boolean'
              AND jsonb_typeof(eligibility.evidence->'rough_location') = 'string'
              AND char_length(btrim(eligibility.evidence->>'rough_location'))
                    BETWEEN 2 AND 120
            ) AS eligibility_snapshot_valid
       FROM task_provider_eligibility_decisions eligibility
       JOIN task_drafts draft ON draft.id = eligibility.task_draft_id
       JOIN task_routing_decisions route ON route.id = eligibility.routing_decision_id
       LEFT JOIN task_provider_estimate_invitations existing_invitation
         ON existing_invitation.eligibility_decision_id = eligibility.id
      WHERE eligibility.id = $1
      FOR UPDATE OF eligibility, draft, route`,
    [command.eligibility_decision_id, command.actor_user_id],
  );
  return result.rows[0];
}

function assertEstimateInvitationContext(
  context: EstimateInvitationContextRow | undefined,
  command: IssueUniversalV1ProviderEstimateInvitation,
): asserts context is EstimateInvitationContextRow {
  if (!context) {
    fail('ESTIMATE_INVITATION_NOT_FOUND', 'The eligibility fact is unavailable.');
  }
  if (context.operator_authorized !== true) {
    fail(
      'ESTIMATE_INVITATION_OPERATOR_NOT_AUTHORIZED',
      'Current Operations authority is required to issue an estimate invitation.',
    );
  }
  if (
    exactPositiveVersion(context.routing_decision_version, 'Invitation route version')
      !== command.expected_draft_version
    || exactPositiveVersion(
      context.eligibility_decision_version,
      'Invitation eligibility version',
    ) !== command.expected_eligibility_version
  ) {
    fail(
      'ESTIMATE_INVITATION_VERSION_CONFLICT',
      'The route or eligibility fact changed before invitation issuance.',
    );
  }
  if (context.existing_invitation_id) {
    fail(
      'ESTIMATE_INVITATION_ALREADY_ISSUED',
      'The eligibility fact already has an estimate invitation.',
    );
  }
  if (context.route_context_current !== true || context.eligibility_context_current !== true) {
    if (context.eligibility_expired === true) {
      fail('ESTIMATE_INVITATION_EXPIRED', 'The eligibility fact has expired.');
    }
    fail(
      'ESTIMATE_INVITATION_NOT_ALLOWED',
      'The eligibility fact does not bind the active estimate-required route.',
    );
  }
  if (
    context.provider_self_selection_clear !== true
    || context.provider_authority_current !== true
    || context.eligibility_snapshot_valid !== true
  ) {
    fail(
      'ESTIMATE_INVITATION_NOT_ALLOWED',
      'Current independent provider, credential, and policy authority is required.',
    );
  }
}

async function insertEstimateInvitationQuoteShell(
  query: QueryFn,
  context: EstimateInvitationContextRow,
  command: IssueUniversalV1ProviderEstimateInvitation,
  quoteId: string,
): Promise<void> {
  const result = await query<{ id: string }>(
    `INSERT INTO quotes(
       id, task_draft_id, title, status, created_by, quote_kind,
       provider_user_id, provider_organization_id, routing_decision_id
     ) VALUES (
       $1, $2, 'Invited provider estimate', 'draft', $3,
       'PROVIDER_ESTIMATE', $4, $5, $6
     )
     RETURNING id`,
    [
      quoteId,
      context.task_draft_id,
      `universal-v1-named-operator:${command.actor_user_id}`,
      context.provider_user_id,
      context.provider_organization_id,
      context.routing_decision_id,
    ],
  );
  if (result.rows[0]?.id !== quoteId) {
    fail('ESTIMATE_INVITATION_CREATE_FAILED', 'The estimate quote shell was not created.');
  }
}

async function insertEstimateInvitationFact(
  query: QueryFn,
  context: EstimateInvitationContextRow,
  command: IssueUniversalV1ProviderEstimateInvitation,
  ids: { invitationId: string; quoteId: string },
): Promise<EstimateInvitationReplayRow> {
  const result = await query<EstimateInvitationReplayRow>(
    `INSERT INTO task_provider_estimate_invitations(
       id, eligibility_decision_id, quote_id, decision_authority,
       decided_by, authority_policy_version, valid_until, idempotency_key
     ) VALUES (
       $1, $2, $3, 'NAMED_OPERATOR', $4, $5, $6, $7
     )
     RETURNING id, quote_id, task_draft_id, routing_decision_id,
               eligibility_decision_id, routing_decision_version,
               eligibility_decision_version, valid_until, request_sha256,
               TRUE AS operator_authorized`,
    [
      ids.invitationId,
      command.eligibility_decision_id,
      ids.quoteId,
      command.actor_user_id,
      ESTIMATE_INVITATION_AUTHORITY_POLICY_VERSION,
      context.eligibility_valid_until,
      command.idempotency_key,
    ],
  );
  const row = result.rows[0];
  if (!row) {
    fail('ESTIMATE_INVITATION_CREATE_FAILED', 'The estimate invitation was not created.');
  }
  return row;
}

function estimateReplayCommand(row: EstimateReplayRow): SubmitUniversalV1ProviderEstimate {
  return SubmitUniversalV1ProviderEstimateSchema.parse({
    task_draft_id: row.task_draft_id,
    routing_decision_id: row.routing_decision_id,
    expected_draft_version: row.decision_version,
    quote_id: row.quote_id,
    expected_quote_version: row.expected_quote_version - 1,
    provider: {
      actor_user_id: row.submitted_by,
      provider_user_id: row.provider_user_id,
      provider_organization_id: row.provider_organization_id,
    },
    scope: row.scope_snapshot,
    line_items: row.line_items,
    customer_total_cents: Number(row.customer_total_cents),
    provider_payout_cents: Number(row.provider_payout_cents),
    currency: row.currency,
    idempotency_key: row.idempotency_key,
  });
}

function submittedEstimate(
  row: EstimateReplayRow,
  requestSha256: string,
  replayed: boolean
): SubmittedUniversalV1ProviderEstimate {
  return {
    provider_estimate_submission_id: row.id,
    quote_id: row.quote_id,
    quote_version_id: row.quote_version_id,
    quote_version: row.expected_quote_version,
    routing_decision_id: row.routing_decision_id,
    scope_sha256: row.scope_hash,
    request_sha256: requestSha256,
    replayed,
    payment_creation_performed: false,
    hard_assignment_created: false,
  };
}

function acceptedEstimate(
  row: AcceptanceReplayRow,
  replayed: boolean
): AcceptedUniversalV1ProviderEstimate {
  return {
    materialization_id: row.id,
    task_draft_id: row.task_draft_id,
    task_id: row.task_id,
    scope_version_id: row.scope_version_id,
    provider_estimate_submission_id: row.provider_estimate_submission_id,
    prior_routing_decision_id: row.prior_routing_decision_id,
    resulting_routing_decision_id: row.resulting_routing_decision_id,
    resulting_draft_version: row.resulting_draft_version,
    request_sha256: row.request_sha256,
    replayed,
    payment_creation_performed: false,
    escrow_created: false,
    hard_assignment_created: false,
    universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
  };
}

async function loadEstimateReplay(
  query: QueryFn,
  idempotencyKey: string
): Promise<EstimateReplayRow | undefined> {
  const result = await query<EstimateReplayRow>(
    `SELECT estimate.id, estimate.quote_id, estimate.quote_version_id,
            estimate.routing_decision_id, estimate.provider_user_id,
            estimate.provider_organization_id, estimate.submitted_by,
            estimate.expected_quote_version, estimate.scope_snapshot,
            estimate.scope_hash, estimate.line_items,
            estimate.customer_total_cents, estimate.provider_payout_cents,
            estimate.currency, estimate.idempotency_key,
            route.task_draft_id, route.decision_version
       FROM provider_estimate_submissions estimate
       JOIN task_routing_decisions route ON route.id = estimate.routing_decision_id
      WHERE estimate.idempotency_key = $1`,
    [idempotencyKey]
  );
  return result.rows[0];
}

async function loadActiveEstimateRoute(
  query: QueryFn,
  command: SubmitUniversalV1ProviderEstimate
): Promise<ActiveEstimateRouteRow> {
  const result = await query<ActiveEstimateRouteRow>(
    `SELECT draft.id AS task_draft_id, route.decision_version, route.outcome,
            route.reason_codes, route.category_snapshot,
            draft.universal_contract_version
       FROM task_drafts draft
       JOIN task_routing_decisions route
         ON route.id = draft.active_routing_decision_id
      WHERE draft.id = $1
        AND route.id = $2
      FOR UPDATE OF draft, route`,
    [command.task_draft_id, command.routing_decision_id]
  );
  const route = result.rows[0];
  if (!route || route.universal_contract_version !== 1) {
    fail('ESTIMATE_ROUTE_NOT_ACTIVE', 'The estimate does not bind the active Universal V1 route.');
  }
  if (route.decision_version !== command.expected_draft_version) {
    fail('ESTIMATE_ROUTE_NOT_ACTIVE', 'The Task Draft route version changed before submission.');
  }
  if (route.outcome !== 'ESTIMATE_REQUIRED') {
    fail(
      'ESTIMATE_ROUTE_NOT_ESTIMATE_REQUIRED',
      'A provider estimate requires the exact active ESTIMATE_REQUIRED route.'
    );
  }
  if (route.category_snapshot !== command.scope.work_category_code) {
    fail(
      'ESTIMATE_WORK_CATEGORY_CONFLICT',
      'The estimate work category must match the active routing fact.'
    );
  }
  return route;
}

async function assertProviderAuthority(
  query: QueryFn,
  command: SubmitUniversalV1ProviderEstimate,
  route: ActiveEstimateRouteRow
): Promise<void> {
  const identity = command.provider;
  const tradeRoute = route.reason_codes.includes(TRADE_ROUTE_REASON);
  if (!identity.provider_organization_id) {
    if (tradeRoute) {
      fail(
        'ESTIMATE_TRADE_QUALIFICATION_REQUIRED',
        'Credentialed trade work requires a Verified Trade Business.'
      );
    }
    if (identity.actor_user_id !== identity.provider_user_id) {
      fail(
        'ESTIMATE_PROVIDER_NOT_AUTHORIZED',
        'An individual provider must submit its own estimate.'
      );
    }
    const profile = await query<{ authorized: boolean }>(
      `SELECT public.lock_universal_v1_estimate_authority($2, $1, NULL, NULL, $1)
                AS authority_lock,
              EXISTS (
         SELECT 1 FROM capability_profiles profile
          WHERE profile.user_id = $1
            AND profile.provider_class = 'GENERAL_SERVICE_PROVIDER'
       ) AS authorized`,
      [identity.provider_user_id, command.task_draft_id]
    );
    if (profile.rows[0]?.authorized !== true) {
      fail(
        'ESTIMATE_PROVIDER_NOT_AUTHORIZED',
        'The provider lacks current General Service Provider authority.'
      );
    }
    return;
  }

  const authority = await query<ProviderOrganizationAuthorityRow>(
    `SELECT public.lock_universal_v1_estimate_authority(
              $6, $3, organization.id, invitation.trade_credential_id, $2
            ) AS authority_lock,
            organization.provider_class,
            (
              organization.status = 'ACTIVE'
              AND organization.verification_status = 'VERIFIED'
              AND organization.provider_enabled IS TRUE
            ) AS organization_authorized,
            public.business_membership_has_action(
              organization.id, $2, 'SUBMIT_ESTIMATE'
            ) AS actor_membership_authorized,
            EXISTS (
              SELECT 1 FROM business_memberships membership
               WHERE membership.organization_id = organization.id
                 AND membership.user_id = $3
                 AND membership.status = 'ACTIVE'
                 AND membership.role IN ('OWNER','ADMIN','DISPATCHER','CREW')
            ) AS provider_membership_authorized,
            EXISTS (
              SELECT 1
                FROM current_verified_trade_qualifications qualification
                CROSS JOIN LATERAL unnest(qualification.permitted_work_categories)
                  permitted(category)
               WHERE qualification.organization_id = organization.id
                 AND qualification.provider_user_id = $3
                 AND qualification.jurisdiction_code = $4
                 AND lower(permitted.category) = lower($5)
            ) AS trade_qualification_authorized
       FROM business_organizations organization
       JOIN task_provider_estimate_invitations invitation
         ON invitation.quote_id = $7
        AND invitation.provider_organization_id = organization.id
        AND invitation.provider_user_id = $3
      WHERE organization.id = $1
      FOR SHARE OF organization`,
    [
      identity.provider_organization_id,
      identity.actor_user_id,
      identity.provider_user_id,
      command.scope.region_code,
      command.scope.work_category_code,
      command.task_draft_id,
      command.quote_id,
    ]
  );
  const row = authority.rows[0];
  if (
    !row ||
    row.organization_authorized !== true ||
    !['GENERAL_SERVICE_PROVIDER', 'VERIFIED_TRADE_BUSINESS'].includes(row.provider_class ?? '') ||
    row.actor_membership_authorized !== true ||
    row.provider_membership_authorized !== true
  ) {
    fail(
      'ESTIMATE_PROVIDER_NOT_AUTHORIZED',
      'The organization, submitter, or named provider lacks current provider authority.'
    );
  }
  if (
    tradeRoute &&
    (row.provider_class !== 'VERIFIED_TRADE_BUSINESS' ||
      row.trade_qualification_authorized !== true)
  ) {
    fail(
      'ESTIMATE_TRADE_QUALIFICATION_REQUIRED',
      'The exact provider lacks a current trade qualification for this category and jurisdiction.'
    );
  }
}

async function loadQuoteForUpdate(
  query: QueryFn,
  quoteId: string
): Promise<QuoteAggregateRow | undefined> {
  const result = await query<QuoteAggregateRow>(
    `SELECT quote.id, quote.task_draft_id, quote.task_id, quote.quote_kind,
            quote.provider_user_id, quote.provider_organization_id,
            quote.routing_decision_id, quote.active_version_id,
            active.expected_quote_version AS active_expected_quote_version,
            invitation.id AS invitation_id,
            invitation.task_draft_id AS invitation_task_draft_id,
            invitation.routing_decision_id AS invitation_routing_decision_id,
            invitation.provider_user_id AS invitation_provider_user_id,
            invitation.provider_organization_id AS invitation_provider_organization_id,
            invitation.work_category_code AS invitation_work_category_code,
            invitation.valid_until AS invitation_valid_until
       FROM quotes quote
       LEFT JOIN quote_versions active ON active.id = quote.active_version_id
       LEFT JOIN task_provider_estimate_invitations invitation
         ON invitation.quote_id = quote.id
      WHERE quote.id = $1
      FOR UPDATE OF quote`,
    [quoteId]
  );
  return result.rows[0];
}

function assertQuoteVersion(
  command: SubmitUniversalV1ProviderEstimate,
  quote: QuoteAggregateRow | undefined
): asserts quote is QuoteAggregateRow & { invitation_valid_until: string | Date } {
  if (
    !quote ||
    !quote.invitation_id ||
    !quote.invitation_valid_until ||
    quote.invitation_task_draft_id !== command.task_draft_id ||
    quote.invitation_routing_decision_id !== command.routing_decision_id ||
    quote.invitation_provider_user_id !== command.provider.provider_user_id ||
    !sameNullable(
      quote.invitation_provider_organization_id,
      command.provider.provider_organization_id
    ) ||
    quote.invitation_work_category_code !== command.scope.work_category_code ||
    !Number.isFinite(new Date(quote.invitation_valid_until).valueOf()) ||
    new Date(quote.invitation_valid_until).valueOf() <= Date.now()
  ) {
    fail(
      'ESTIMATE_INVITATION_REQUIRED',
      'Provider estimate submission requires a current exact unexpired invitation.'
    );
  }
  const identity = command.provider;
  const firstInvitedVersion =
    command.expected_quote_version === 0 &&
    quote.active_version_id === null &&
    quote.active_expected_quote_version === null;
  const revision =
    command.expected_quote_version > 0 &&
    quote.active_version_id !== null &&
    quote.active_expected_quote_version === command.expected_quote_version;
  if (
    quote.task_draft_id !== command.task_draft_id ||
    quote.task_id !== null ||
    quote.quote_kind !== 'PROVIDER_ESTIMATE' ||
    quote.provider_user_id !== identity.provider_user_id ||
    !sameNullable(quote.provider_organization_id, identity.provider_organization_id) ||
    quote.routing_decision_id !== command.routing_decision_id ||
    (!firstInvitedVersion && !revision)
  ) {
    fail(
      'ESTIMATE_QUOTE_VERSION_CONFLICT',
      'The estimate quote identity or optimistic version does not match.'
    );
  }
}

async function insertEstimateVersion(
  query: QueryFn,
  command: SubmitUniversalV1ProviderEstimate,
  quoteVersionId: string,
  nextVersion: number,
  invitationValidUntil: string | Date
): Promise<{ id: string; scope_hash: string }> {
  const marginCents = command.customer_total_cents - command.provider_payout_cents;
  const result = await query<{ id: string; scope_hash: string }>(
    `INSERT INTO quote_versions (
       id, quote_id, version_number, status, customer_description,
       internal_notes, subtotal_cents, service_fee_cents, materials_cents,
       discount_cents, total_cents, minimum_acceptable_price_cents,
       hustler_payout_cents, platform_margin_cents, scope_json,
       pay_token, stripe_payment_link_url, stripe_checkout_session_id,
       stripe_payment_intent_id, stripe_mode, paid_at, created_by,
       scope_version_id, scope_hash, provider_submitted_at,
       expected_quote_version, universal_contract_version, payment_posture,
       expires_at
     ) VALUES (
       $1, $2, $3, 'provider_submitted', $4, NULL, $5, 0, 0, 0, $5,
       $6, $6, $7, $8::jsonb,
       NULL, NULL, NULL, NULL, NULL, NULL, $9,
       NULL, encode(digest($8::jsonb::text, 'sha256'), 'hex'),
       clock_timestamp(), $3, 1, 'PAYMENT_FREE_ESTIMATE', $10
     )
     RETURNING id, scope_hash`,
    [
      quoteVersionId,
      command.quote_id,
      nextVersion,
      command.scope.description,
      command.customer_total_cents,
      command.provider_payout_cents,
      marginCents,
      JSON.stringify(command.scope),
      command.provider.actor_user_id,
      invitationValidUntil,
    ]
  );
  const row = result.rows[0];
  if (!row)
    fail('ESTIMATE_TASK_MATERIALIZATION_FAILED', 'Estimate version insert returned no fact.');
  return row;
}

async function publishEstimateVersion(
  query: QueryFn,
  command: SubmitUniversalV1ProviderEstimate,
  quoteVersionId: string
): Promise<void> {
  const updated = await query<{ id: string }>(
    `UPDATE quotes
        SET active_version_id = $2,
            status = 'estimate_submitted',
            updated_at = clock_timestamp()
      WHERE id = $1
        AND task_id IS NULL
      RETURNING id`,
    [command.quote_id, quoteVersionId]
  );
  if (!updated.rows[0]) {
    fail('ESTIMATE_QUOTE_VERSION_CONFLICT', 'The estimate quote changed before publication.');
  }
}

async function insertEstimateSubmission(
  query: QueryFn,
  command: SubmitUniversalV1ProviderEstimate,
  ids: { submissionId: string; quoteVersionId: string },
  nextVersion: number,
  scopeHash: string
): Promise<EstimateReplayRow> {
  const result = await query<EstimateReplayRow>(
    `INSERT INTO provider_estimate_submissions (
       id, quote_id, quote_version_id, routing_decision_id,
       provider_user_id, provider_organization_id, submitted_by,
       expected_quote_version, scope_snapshot, scope_hash, line_items,
       customer_total_cents, provider_payout_cents, currency,
       work_category_code, payload_hash, idempotency_key
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::text, $11::jsonb,
       $12, $13, $14, $15::text,
       encode(digest(jsonb_build_object(
         'scopeSnapshot', $9::jsonb,
         'scopeHash', $10::text,
         'workCategoryCode', $15::text,
         'lineItems', $11::jsonb,
         'customerTotalCents', $12::bigint,
         'providerPayoutCents', $13::bigint,
         'currency', $14::char(3)
       )::text, 'sha256'), 'hex'),
       $16
     )
     RETURNING id, quote_id, quote_version_id, routing_decision_id,
               provider_user_id, provider_organization_id, submitted_by,
               expected_quote_version, scope_snapshot, scope_hash, line_items,
               customer_total_cents, provider_payout_cents, currency,
               idempotency_key`,
    [
      ids.submissionId,
      command.quote_id,
      ids.quoteVersionId,
      command.routing_decision_id,
      command.provider.provider_user_id,
      command.provider.provider_organization_id,
      command.provider.actor_user_id,
      nextVersion,
      JSON.stringify(command.scope),
      scopeHash,
      JSON.stringify(command.line_items),
      command.customer_total_cents,
      command.provider_payout_cents,
      command.currency,
      command.scope.work_category_code,
      command.idempotency_key,
    ]
  );
  const row = result.rows[0];
  if (!row) fail('ESTIMATE_TASK_MATERIALIZATION_FAILED', 'Estimate submission returned no fact.');
  return {
    ...row,
    task_draft_id: command.task_draft_id,
    decision_version: command.expected_draft_version,
  };
}

async function loadAcceptanceReplay(
  query: QueryFn,
  command: AcceptUniversalV1ProviderEstimate
): Promise<AcceptanceReplayRow | undefined> {
  const result = await query<AcceptanceReplayRow>(
    `SELECT materialization.id, materialization.task_draft_id,
            materialization.provider_estimate_submission_id,
            materialization.quote_id, materialization.quote_version_id,
            materialization.poster_user_id,
            materialization.prior_routing_decision_id,
            materialization.resulting_routing_decision_id,
            materialization.task_id, materialization.scope_version_id,
            materialization.expected_draft_version,
            materialization.idempotency_key, materialization.request_sha256,
            materialization.materialization_version,
            route.decision_version AS resulting_draft_version
       FROM task_estimate_acceptance_materializations materialization
       JOIN task_routing_decisions route
         ON route.id = materialization.resulting_routing_decision_id
      WHERE materialization.poster_user_id = $1
        AND materialization.idempotency_key = $2`,
    [command.poster_user_id, command.idempotency_key]
  );
  return result.rows[0];
}

function assertExactAcceptanceReplay(
  replay: AcceptanceReplayRow,
  command: AcceptUniversalV1ProviderEstimate,
  requestSha256: string
): void {
  if (
    replay.task_draft_id !== command.task_draft_id ||
    replay.provider_estimate_submission_id !== command.provider_estimate_submission_id ||
    replay.quote_id !== command.quote_id ||
    replay.quote_version_id !== command.quote_version_id ||
    replay.poster_user_id !== command.poster_user_id ||
    replay.expected_draft_version !== command.expected_draft_version ||
    replay.request_sha256 !== requestSha256 ||
    replay.materialization_version !== 1
  ) {
    fail(
      'ESTIMATE_ACCEPTANCE_IDEMPOTENCY_CONFLICT',
      'The acceptance idempotency key was used with different input.'
    );
  }
}

async function loadAcceptanceContext(
  query: QueryFn,
  command: AcceptUniversalV1ProviderEstimate
): Promise<EstimateAcceptanceContextRow> {
  const result = await query<EstimateAcceptanceContextRow>(
    `SELECT draft.id AS task_draft_id, draft.poster_user_id, draft.task_id,
            draft.ingress_origin, draft.status AS draft_status,
            draft.quote_id AS draft_quote_id, draft.universal_contract_version,
            route.id AS prior_routing_decision_id, route.decision_version,
            route.outcome AS route_outcome,
            estimate.id AS provider_estimate_submission_id,
            estimate.quote_id, estimate.quote_version_id,
            quote.quote_kind, quote.active_version_id,
            estimate.provider_user_id, estimate.provider_organization_id,
            estimate.work_category_code,
            estimate.scope_snapshot, estimate.scope_hash,
            estimate.customer_total_cents, estimate.provider_payout_cents,
            estimate.currency
       FROM task_drafts draft
       JOIN task_routing_decisions route
         ON route.id = draft.active_routing_decision_id
       JOIN provider_estimate_submissions estimate
         ON estimate.id = $2
        AND estimate.routing_decision_id = route.id
       JOIN quotes quote
         ON quote.id = estimate.quote_id
        AND quote.task_draft_id = draft.id
       JOIN quote_versions quote_version
         ON quote_version.id = estimate.quote_version_id
        AND quote_version.quote_id = quote.id
      WHERE draft.id = $1
        AND estimate.quote_id = $3
        AND estimate.quote_version_id = $4
      FOR UPDATE OF draft, route, quote`,
    [
      command.task_draft_id,
      command.provider_estimate_submission_id,
      command.quote_id,
      command.quote_version_id,
    ]
  );
  const context = result.rows[0];
  if (!context) {
    fail('ESTIMATE_ACCEPTANCE_NOT_ALLOWED', 'The exact provider estimate is unavailable.');
  }
  return context;
}

function assertAcceptanceContext(
  context: EstimateAcceptanceContextRow,
  command: AcceptUniversalV1ProviderEstimate
): void {
  if (
    context.universal_contract_version !== 1 ||
    context.ingress_origin !== 'BACKEND_POSTGRESQL' ||
    context.draft_status !== 'account_claimed' ||
    (context.draft_quote_id !== null && context.draft_quote_id !== command.quote_id) ||
    context.poster_user_id !== command.poster_user_id ||
    context.provider_estimate_submission_id !== command.provider_estimate_submission_id ||
    context.quote_id !== command.quote_id ||
    context.quote_version_id !== command.quote_version_id ||
    context.quote_kind !== 'PROVIDER_ESTIMATE' ||
    context.active_version_id !== command.quote_version_id ||
    context.route_outcome !== 'ESTIMATE_REQUIRED' ||
    context.work_category_code !== context.scope_snapshot.work_category_code
  ) {
    fail(
      'ESTIMATE_ACCEPTANCE_NOT_ALLOWED',
      'Acceptance must bind the Poster, active estimate route, and exact immutable quote version.'
    );
  }
  if (context.task_id !== null) {
    fail('ESTIMATE_ACCEPTANCE_NOT_ALLOWED', 'The Task Draft was already materialized.');
  }
  if (context.decision_version !== command.expected_draft_version) {
    fail(
      'ESTIMATE_ACCEPTANCE_VERSION_CONFLICT',
      'The Task Draft route changed before estimate acceptance.'
    );
  }
}

async function loadActiveRegionPolicy(
  query: QueryFn,
  regionCode: string
): Promise<RegionPolicyRow | undefined> {
  const result = await query<RegionPolicyRow>(
    `SELECT policy.id, policy.region_code, policy.version, policy.policy_hash,
            policy.production_enabled, policy.effective_from,
            policy.effective_until, policy.policy_document,
            approval.effective_at AS legal_approval_effective_at,
            approval.review_at AS legal_approval_review_at
       FROM region_policies policy
       LEFT JOIN region_policy_legal_approvals approval
         ON approval.region_policy_id = policy.id
        AND approval.policy_hash = policy.policy_hash
        AND policy.approval_reference =
            'region-policy-legal-approval:' || approval.id::text
      WHERE policy.region_code = $1
        AND policy.policy_state = 'ACTIVE'
        AND policy.effective_from <= clock_timestamp()
        AND (policy.effective_until IS NULL
             OR policy.effective_until > clock_timestamp())
      ORDER BY policy.effective_from DESC, policy.created_at DESC
      LIMIT 1
      FOR SHARE OF policy`,
    [regionCode]
  );
  return result.rows[0];
}

function taskPolicySnapshot(
  policy: RegionPolicyRow | undefined,
  context: EstimateAcceptanceContextRow
): RegionPolicyTaskSnapshot {
  const customerTotalCents = Number(context.customer_total_cents);
  const providerPayoutCents = Number(context.provider_payout_cents);
  const marginCents = customerTotalCents - providerPayoutCents;
  if (!policy) {
    fail('ESTIMATE_REGION_POLICY_REFUSED', 'No active region policy permits this materialization.');
  }
  const evaluation = evaluateTaskAgainstRegionPolicy(policy, {
    regionCode: context.scope_snapshot.region_code,
    automationClassification: 'CONTROLLED_TEST',
    category: context.scope_snapshot.work_category_code,
    riskLevel: context.scope_snapshot.risk_level,
    requiresProof: context.scope_snapshot.requires_proof,
    customerTotalCents,
    payoutCents: providerPayoutCents,
    marginCents,
  });
  if (!evaluation.allowed) {
    fail(
      'ESTIMATE_REGION_POLICY_REFUSED',
      `Region policy refused Task materialization: ${evaluation.reasons.join(',')}`
    );
  }
  if (context.currency !== evaluation.snapshot.currency.toUpperCase()) {
    fail('ESTIMATE_REGION_POLICY_REFUSED', 'Estimate currency does not match region policy.');
  }
  return evaluation.snapshot;
}

async function insertPaymentFreeTask(
  query: QueryFn,
  context: EstimateAcceptanceContextRow,
  command: AcceptUniversalV1ProviderEstimate,
  ids: { taskId: string; scopeVersionId: string },
  policy: RegionPolicyTaskSnapshot
): Promise<void> {
  const scope = context.scope_snapshot;
  const customerTotalCents = Number(context.customer_total_cents);
  const providerPayoutCents = Number(context.provider_payout_cents);
  const marginCents = customerTotalCents - providerPayoutCents;
  const inserted = await query<{ id: string }>(
    `INSERT INTO tasks (
       id, poster_id, worker_id, title, description, requirements,
       location, rough_location, category, price, hustler_payout_cents,
       platform_margin_cents, risk_level, requires_proof, state,
       progress_state, automation_classification, scope_hash,
       active_scope_version_id, region_code, region_policy_id,
       region_policy_version, region_policy_hash, region_policy_snapshot,
       trade_type, location_state, license_required, insurance_required,
       background_check_required, proof_min_photos, proof_max_photos,
       proof_gps_required, currency, universal_contract_version,
       payment_method, universal_payment_posture
     ) VALUES (
       $1, $2, NULL, $3, $4, $5, $6::text, $6::text, $7::text, $8, $9, $10, $11, $12,
       'OPEN', 'POSTED', 'CONTROLLED_TEST', $13, NULL, $14, $15, $16, $17,
       $18::jsonb, $7::text, $19, $20, $21, $22, $23, $24, $25, $26, 0,
       'universal_financial_security', NULL
     )
     RETURNING id`,
    [
      ids.taskId,
      command.poster_user_id,
      scope.title,
      scope.description,
      scope.requirements,
      scope.rough_location,
      scope.work_category_code,
      customerTotalCents,
      providerPayoutCents,
      marginCents,
      scope.risk_level,
      scope.requires_proof,
      context.scope_hash,
      policy.regionCode,
      policy.policyId,
      policy.policyVersion,
      policy.policyHash,
      JSON.stringify(policy),
      policy.locationState,
      policy.licenseRequired,
      policy.insuranceRequired,
      policy.backgroundCheckRequired,
      policy.proofMinPhotos,
      policy.proofMaxPhotos,
      policy.proofGpsRequired,
      policy.currency,
    ]
  );
  if (!inserted.rows[0]) {
    fail('ESTIMATE_TASK_MATERIALIZATION_FAILED', 'Task insert returned no canonical row.');
  }
}

async function insertInitialScope(
  query: QueryFn,
  context: EstimateAcceptanceContextRow,
  command: AcceptUniversalV1ProviderEstimate,
  ids: { taskId: string; scopeVersionId: string }
): Promise<void> {
  const scope = context.scope_snapshot;
  const inserted = await query<{ id: string }>(
    `INSERT INTO task_scope_versions (
       id, task_id, version, scope_hash, title, description, requirements,
       checklist, customer_total_cents, hustler_payout_cents, source,
       change_summary, created_by, universal_contract_version, currency
     ) VALUES (
       $1, $2, 1, $3, $4, $5, $6, $7::jsonb, $8, $9, 'INITIAL',
       'Customer accepted immutable provider estimate', $10, 1, $11
     )
     RETURNING id`,
    [
      ids.scopeVersionId,
      ids.taskId,
      context.scope_hash,
      scope.title,
      scope.description,
      scope.requirements,
      JSON.stringify(scope.checklist),
      Number(context.customer_total_cents),
      Number(context.provider_payout_cents),
      command.poster_user_id,
      context.currency,
    ]
  );
  if (!inserted.rows[0]) {
    fail('ESTIMATE_TASK_MATERIALIZATION_FAILED', 'Scope insert returned no canonical row.');
  }
}

async function promoteTaskToUniversalV1(
  query: QueryFn,
  ids: { taskId: string; scopeVersionId: string }
): Promise<void> {
  const updated = await query<{ id: string }>(
    `UPDATE tasks
        SET universal_contract_version = 1,
            active_scope_version_id = $2,
            universal_payment_posture = 'PAYMENT_CREATION_FROZEN',
            updated_at = clock_timestamp()
      WHERE id = $1
        AND universal_contract_version = 0
        AND active_scope_version_id IS NULL
        AND worker_id IS NULL
        AND payment_method = 'universal_financial_security'
        AND universal_payment_posture IS NULL
      RETURNING id`,
    [ids.taskId, ids.scopeVersionId]
  );
  if (!updated.rows[0]) {
    fail(
      'ESTIMATE_TASK_MATERIALIZATION_FAILED',
      'Task could not bind Universal V1 scope version one.'
    );
  }
}

async function appendFulfillmentCandidateRoute(
  query: QueryFn,
  context: EstimateAcceptanceContextRow,
  command: AcceptUniversalV1ProviderEstimate,
  resultingRoutingDecisionId: string,
  requestSha256: string
): Promise<void> {
  const result = await query<{ id: string }>(
    `INSERT INTO task_routing_decisions (
       id, task_draft_id, decision_version, supersedes_decision_id,
       outcome, reason_codes, policy_version, category_snapshot,
       service_cell_snapshot, decision_authority, decided_by, evidence,
       idempotency_key
     ) VALUES (
       $1, $2, $3, $4, 'FULFILLMENT_CANDIDATE', ARRAY[$5]::text[],
       $6, $7, $8, 'DETERMINISTIC_POLICY', NULL, $9::jsonb, $10
     )
     RETURNING id`,
    [
      resultingRoutingDecisionId,
      command.task_draft_id,
      command.expected_draft_version + 1,
      context.prior_routing_decision_id,
      ESTIMATE_ROUTE_REASON,
      ESTIMATE_ACCEPTANCE_POLICY_VERSION,
      context.scope_snapshot.work_category_code,
      context.scope_snapshot.region_code,
      JSON.stringify({
        providerEstimateSubmissionId: command.provider_estimate_submission_id,
        quoteId: command.quote_id,
        quoteVersionId: command.quote_version_id,
        scopeSha256: context.scope_hash,
        requestSha256,
        paymentCreationPerformed: false,
        hardAssignmentCreated: false,
      }),
      `estimate-accept-route:${requestSha256.slice(0, 64)}`,
    ]
  );
  if (!result.rows[0]) {
    fail('ESTIMATE_TASK_MATERIALIZATION_FAILED', 'Fulfillment-candidate route was not appended.');
  }
}

async function bindTaskDraftAndQuote(
  query: QueryFn,
  command: AcceptUniversalV1ProviderEstimate,
  ids: { taskId: string; resultingRoutingDecisionId: string }
): Promise<void> {
  const draft = await query<{ id: string }>(
    `UPDATE task_drafts
        SET task_id = $2,
            quote_id = $5,
            updated_at = clock_timestamp()
      WHERE id = $1
        AND poster_user_id = $3
        AND task_id IS NULL
        AND active_routing_decision_id = $4
      RETURNING id`,
    [
      command.task_draft_id,
      ids.taskId,
      command.poster_user_id,
      ids.resultingRoutingDecisionId,
      command.quote_id,
    ]
  );
  if (!draft.rows[0]) {
    fail('ESTIMATE_TASK_MATERIALIZATION_FAILED', 'Task Draft changed before exact Task binding.');
  }
  const quote = await query<{ id: string }>(
    `UPDATE quotes
        SET task_id = $2,
            status = 'approved',
            locked_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE id = $1
        AND task_id IS NULL
        AND active_version_id = $3
      RETURNING id`,
    [command.quote_id, ids.taskId, command.quote_version_id]
  );
  if (!quote.rows[0]) {
    fail('ESTIMATE_TASK_MATERIALIZATION_FAILED', 'Quote changed before exact Task binding.');
  }
}

async function insertAcceptanceFact(
  query: QueryFn,
  context: EstimateAcceptanceContextRow,
  command: AcceptUniversalV1ProviderEstimate,
  ids: {
    materializationId: string;
    taskId: string;
    scopeVersionId: string;
    resultingRoutingDecisionId: string;
  },
  requestSha256: string
): Promise<AcceptanceReplayRow> {
  const result = await query<AcceptanceReplayRow>(
    `INSERT INTO task_estimate_acceptance_materializations (
       id, task_draft_id, provider_estimate_submission_id, quote_id,
       quote_version_id, poster_user_id, prior_routing_decision_id,
       resulting_routing_decision_id, task_id, scope_version_id,
       expected_draft_version, idempotency_key, request_sha256,
       materialization_version
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 1
     )
     RETURNING id, task_draft_id, provider_estimate_submission_id, quote_id,
               quote_version_id, poster_user_id, prior_routing_decision_id,
               resulting_routing_decision_id, task_id, scope_version_id,
               expected_draft_version, idempotency_key, request_sha256,
               materialization_version`,
    [
      ids.materializationId,
      command.task_draft_id,
      command.provider_estimate_submission_id,
      command.quote_id,
      command.quote_version_id,
      command.poster_user_id,
      context.prior_routing_decision_id,
      ids.resultingRoutingDecisionId,
      ids.taskId,
      ids.scopeVersionId,
      command.expected_draft_version,
      command.idempotency_key,
      requestSha256,
    ]
  );
  const row = result.rows[0];
  if (!row) fail('ESTIMATE_TASK_MATERIALIZATION_FAILED', 'Acceptance fact insert returned no row.');
  return {
    ...row,
    resulting_draft_version: command.expected_draft_version + 1,
  };
}

export class PostgresUniversalV1EstimateRepository implements UniversalV1EstimateRepository {
  constructor(
    private readonly database: Database = db,
    private readonly randomUuid: () => string = randomUUID
  ) {}

  async issueProviderEstimateInvitation(
    command: IssueUniversalV1ProviderEstimateInvitation,
  ): Promise<IssuedUniversalV1ProviderEstimateInvitation> {
    return this.database.serializableTransaction(async (query) => {
      await query(
        `SELECT pg_advisory_xact_lock(
           hashtext('universal-v1-estimate-invitation-actor'), hashtext($1)
         )`,
        [`${command.actor_user_id}:${command.idempotency_key}`],
      );
      await query(
        `SELECT pg_advisory_xact_lock(hashtextextended(
           'eligibility:' || eligibility.task_draft_id::text || ':' ||
           eligibility.provider_user_id::text || ':' ||
           COALESCE(eligibility.provider_organization_id::text, 'individual'), 0
         ))
           FROM task_provider_eligibility_decisions eligibility
          WHERE eligibility.id = $1`,
        [command.eligibility_decision_id],
      );

      const replay = await loadEstimateInvitationReplay(query, command);
      if (replay) {
        assertExactInvitationReplay(replay, command);
        return issuedEstimateInvitation(replay, true);
      }

      const context = await loadEstimateInvitationContext(query, command);
      assertEstimateInvitationContext(context, command);
      const ids = {
        quoteId: this.randomUuid(),
        invitationId: this.randomUuid(),
      };
      await insertEstimateInvitationQuoteShell(query, context, command, ids.quoteId);
      const invitation = await insertEstimateInvitationFact(query, context, command, ids);
      return issuedEstimateInvitation(invitation, false);
    });
  }

  async submitProviderEstimate(
    command: SubmitUniversalV1ProviderEstimate,
    requestSha256: string
  ): Promise<SubmittedUniversalV1ProviderEstimate> {
    return this.database.serializableTransaction(async (query) => {
      await query(
        `SELECT pg_advisory_xact_lock(
           hashtext('universal-v1-provider-estimate'), hashtext($1)
         )`,
        [command.idempotency_key]
      );
      await query(
        `SELECT pg_advisory_xact_lock(
           hashtext('universal-v1-estimate-quote'), hashtext($1)
         )`,
        [command.quote_id]
      );
      const replay = await loadEstimateReplay(query, command.idempotency_key);
      if (replay) {
        let replayHash: string;
        try {
          replayHash = universalV1EstimateSubmissionRequestSha256(estimateReplayCommand(replay));
        } catch {
          fail(
            'ESTIMATE_IDEMPOTENCY_CONFLICT',
            'Stored estimate replay evidence is not canonical.'
          );
        }
        if (replayHash !== requestSha256) {
          fail('ESTIMATE_IDEMPOTENCY_CONFLICT', 'The estimate key was used with different input.');
        }
        return submittedEstimate(replay, requestSha256, true);
      }

      const route = await loadActiveEstimateRoute(query, command);
      await assertProviderAuthority(query, command, route);
      const quote = await loadQuoteForUpdate(query, command.quote_id);
      assertQuoteVersion(command, quote);

      const nextVersion = command.expected_quote_version + 1;
      const quoteVersionId = this.randomUuid();
      const submissionId = this.randomUuid();
      const quoteVersion = await insertEstimateVersion(
        query,
        command,
        quoteVersionId,
        nextVersion,
        quote.invitation_valid_until
      );
      await publishEstimateVersion(query, command, quoteVersionId);
      const inserted = await insertEstimateSubmission(
        query,
        command,
        { submissionId, quoteVersionId },
        nextVersion,
        quoteVersion.scope_hash
      );
      return submittedEstimate(inserted, requestSha256, false);
    });
  }

  async acceptProviderEstimate(
    command: AcceptUniversalV1ProviderEstimate,
    requestSha256: string
  ): Promise<AcceptedUniversalV1ProviderEstimate> {
    return this.database.serializableTransaction(async (query) => {
      await query(
        `SELECT pg_advisory_xact_lock(
           hashtext('universal-v1-estimate-acceptance'), hashtext($1)
         )`,
        [`${command.poster_user_id}:${command.idempotency_key}`]
      );
      await query(
        `SELECT pg_advisory_xact_lock(
           hashtext('universal-v1-estimate-draft'), hashtext($1)
         )`,
        [command.task_draft_id]
      );
      const replay = await loadAcceptanceReplay(query, command);
      if (replay) {
        assertExactAcceptanceReplay(replay, command, requestSha256);
        return acceptedEstimate(replay, true);
      }

      const context = await loadAcceptanceContext(query, command);
      assertAcceptanceContext(context, command);
      const regionPolicy = await loadActiveRegionPolicy(query, context.scope_snapshot.region_code);
      const policySnapshot = taskPolicySnapshot(regionPolicy, context);
      const ids = {
        materializationId: this.randomUuid(),
        taskId: this.randomUuid(),
        scopeVersionId: this.randomUuid(),
        resultingRoutingDecisionId: this.randomUuid(),
      };

      await insertPaymentFreeTask(query, context, command, ids, policySnapshot);
      await insertInitialScope(query, context, command, ids);
      await promoteTaskToUniversalV1(query, ids);
      await appendFulfillmentCandidateRoute(
        query,
        context,
        command,
        ids.resultingRoutingDecisionId,
        requestSha256
      );
      await bindTaskDraftAndQuote(query, command, ids);
      const fact = await insertAcceptanceFact(query, context, command, ids, requestSha256);
      return acceptedEstimate(fact, false);
    });
  }
}
