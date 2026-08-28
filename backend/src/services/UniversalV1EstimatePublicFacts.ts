import { db, type QueryFn } from '../db.js';
import type {
  TrustedUniversalV1EstimateAcceptance,
  TrustedUniversalV1EstimateInvitation,
  UniversalV1EstimatePublicFactReader,
} from './UniversalV1EstimateApplication.js';

/**
 * Resolve one server-issued, still-current invitation for an authenticated
 * provider actor. Every predicate is read from PostgreSQL authority; a client
 * supplies only the opaque quote and expected versions.
 */
const LOAD_SUBMISSION_INVITATION_SQL = `
  SELECT invitation.id AS invitation_id,
         invitation.quote_id,
         invitation.task_draft_id,
         invitation.routing_decision_id,
         invitation.routing_decision_version AS expected_draft_version,
         COALESCE(active_version.expected_quote_version, 0)::integer
           AS expected_quote_version,
         invitation.provider_user_id,
         invitation.provider_organization_id,
         invitation.work_category_code,
         invitation.region_code,
         invitation.rough_location,
         invitation.risk_level,
         invitation.requires_proof,
         'USD'::text AS currency
    FROM task_provider_estimate_invitations invitation
    JOIN task_drafts draft
      ON draft.id = invitation.task_draft_id
     AND draft.universal_contract_version = 1
     AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
     AND draft.status = 'account_claimed'
     AND draft.task_id IS NULL
     AND draft.active_routing_decision_id = invitation.routing_decision_id
    JOIN task_routing_decisions route
      ON route.id = invitation.routing_decision_id
     AND route.task_draft_id = invitation.task_draft_id
     AND route.decision_version = invitation.routing_decision_version
     AND route.policy_version = invitation.routing_policy_version
     AND route.outcome = 'ESTIMATE_REQUIRED'
     AND route.category_snapshot = invitation.work_category_code
    JOIN task_provider_eligibility_decisions eligibility
      ON eligibility.id = invitation.eligibility_decision_id
     AND eligibility.task_draft_id = invitation.task_draft_id
     AND eligibility.task_id IS NULL
     AND eligibility.scope_version_id IS NULL
     AND eligibility.routing_decision_id = invitation.routing_decision_id
     AND eligibility.decision_version = invitation.eligibility_decision_version
     AND eligibility.policy_version = invitation.eligibility_policy_version
     AND eligibility.provider_user_id = invitation.provider_user_id
     AND eligibility.provider_organization_id IS NOT DISTINCT FROM
         invitation.provider_organization_id
     AND eligibility.provider_class = invitation.provider_class
     AND eligibility.trade_credential_id IS NOT DISTINCT FROM
         invitation.trade_credential_id
     AND eligibility.task_eligible IS TRUE
     AND eligibility.valid_until >= invitation.valid_until
     AND encode(digest(eligibility.evidence::text, 'sha256'), 'hex') =
         invitation.eligibility_evidence_sha256
    JOIN quotes quote
      ON quote.id = invitation.quote_id
     AND quote.task_draft_id = invitation.task_draft_id
     AND quote.task_id IS NULL
     AND quote.quote_kind = 'PROVIDER_ESTIMATE'
     AND quote.provider_user_id = invitation.provider_user_id
     AND quote.provider_organization_id IS NOT DISTINCT FROM
         invitation.provider_organization_id
     AND quote.routing_decision_id = invitation.routing_decision_id
     AND quote.created_by IS NOT DISTINCT FROM invitation.quote_created_by
    LEFT JOIN quote_versions active_version
      ON active_version.id = quote.active_version_id
     AND active_version.quote_id = quote.id
     AND active_version.universal_contract_version = 1
     AND active_version.payment_posture = 'PAYMENT_FREE_ESTIMATE'
     AND active_version.expires_at = invitation.valid_until
    JOIN users provider
      ON provider.id = invitation.provider_user_id
     AND provider.account_status = 'ACTIVE'
     AND provider.is_minor IS FALSE
     AND COALESCE(provider.is_banned, FALSE) IS FALSE
   WHERE invitation.quote_id = $1
     AND invitation.valid_until > clock_timestamp()
     AND eligibility.valid_until > clock_timestamp()
     AND (
       quote.active_version_id IS NULL
       OR active_version.id IS NOT NULL
     )
     AND NOT EXISTS (
       SELECT 1
         FROM task_provider_eligibility_decisions newer
        WHERE newer.task_draft_id = eligibility.task_draft_id
          AND newer.provider_user_id = eligibility.provider_user_id
          AND newer.provider_organization_id IS NOT DISTINCT FROM
              eligibility.provider_organization_id
          AND newer.decision_version > eligibility.decision_version
     )
     AND public.universal_v1_invited_provider_authority_is_current(
       invitation.provider_user_id,
       invitation.provider_organization_id,
       invitation.provider_class,
       invitation.trade_credential_id,
       invitation.work_category_code,
       invitation.region_code
     ) IS TRUE
     AND (
       (
         invitation.provider_organization_id IS NULL
         AND invitation.provider_user_id = $2
       )
       OR public.business_membership_has_action(
         invitation.provider_organization_id,
         $2,
         'SUBMIT_ESTIMATE'
       )
     )
   LIMIT 1`;

/**
 * Resolve acceptance identifiers only through the immutable provider
 * submission, quote version, prior route, and authoritative Poster owner.
 * A completed materialization remains readable for exact idempotent replay
 * after the invitation expires; a new acceptance requires an unexpired exact
 * invitation/version chain.
 */
const LOAD_ACCEPTANCE_SQL = `
  WITH completed AS (
    SELECT materialization.provider_estimate_submission_id,
           materialization.task_draft_id,
           materialization.quote_id,
           materialization.quote_version_id,
           materialization.poster_user_id,
           materialization.expected_draft_version,
           estimate.expected_quote_version
      FROM task_estimate_acceptance_materializations materialization
      JOIN provider_estimate_submissions estimate
        ON estimate.id = materialization.provider_estimate_submission_id
       AND estimate.quote_id = materialization.quote_id
       AND estimate.quote_version_id = materialization.quote_version_id
      JOIN task_routing_decisions prior_route
        ON prior_route.id = materialization.prior_routing_decision_id
       AND prior_route.task_draft_id = materialization.task_draft_id
       AND prior_route.decision_version = materialization.expected_draft_version
       AND estimate.routing_decision_id = prior_route.id
      JOIN task_drafts draft
        ON draft.id = materialization.task_draft_id
       AND draft.poster_user_id = materialization.poster_user_id
       AND draft.task_id = materialization.task_id
       AND draft.universal_contract_version = 1
       AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
      JOIN quotes quote
        ON quote.id = materialization.quote_id
       AND quote.task_draft_id = draft.id
       AND quote.task_id = materialization.task_id
       AND quote.quote_kind = 'PROVIDER_ESTIMATE'
       AND quote.provider_user_id = estimate.provider_user_id
       AND quote.provider_organization_id IS NOT DISTINCT FROM
           estimate.provider_organization_id
       AND quote.routing_decision_id = prior_route.id
       AND quote.active_version_id = materialization.quote_version_id
      JOIN quote_versions quote_version
        ON quote_version.id = materialization.quote_version_id
       AND quote_version.quote_id = quote.id
       AND quote_version.expected_quote_version = estimate.expected_quote_version
       AND quote_version.universal_contract_version = 1
       AND quote_version.payment_posture = 'PAYMENT_FREE_ESTIMATE'
     WHERE materialization.provider_estimate_submission_id = $1
       AND materialization.poster_user_id = $2
  ),
  available AS (
    SELECT estimate.id AS provider_estimate_submission_id,
           route.task_draft_id,
           estimate.quote_id,
           estimate.quote_version_id,
           draft.poster_user_id,
           route.decision_version AS expected_draft_version,
           estimate.expected_quote_version
      FROM provider_estimate_submissions estimate
      JOIN task_routing_decisions route
        ON route.id = estimate.routing_decision_id
       AND route.outcome = 'ESTIMATE_REQUIRED'
       AND route.category_snapshot IS NOT NULL
      JOIN task_drafts draft
        ON draft.id = route.task_draft_id
       AND draft.universal_contract_version = 1
       AND draft.ingress_origin = 'BACKEND_POSTGRESQL'
       AND draft.status = 'account_claimed'
       AND draft.task_id IS NULL
       AND draft.poster_user_id = $2
       AND draft.active_routing_decision_id = route.id
      JOIN quotes quote
        ON quote.id = estimate.quote_id
       AND quote.task_draft_id = draft.id
       AND quote.task_id IS NULL
       AND quote.quote_kind = 'PROVIDER_ESTIMATE'
       AND quote.provider_user_id = estimate.provider_user_id
       AND quote.provider_organization_id IS NOT DISTINCT FROM
           estimate.provider_organization_id
       AND quote.routing_decision_id = route.id
       AND quote.active_version_id = estimate.quote_version_id
      JOIN quote_versions quote_version
        ON quote_version.id = estimate.quote_version_id
       AND quote_version.quote_id = quote.id
       AND quote_version.expected_quote_version = estimate.expected_quote_version
       AND quote_version.universal_contract_version = 1
       AND quote_version.payment_posture = 'PAYMENT_FREE_ESTIMATE'
      JOIN task_provider_estimate_invitations invitation
        ON invitation.quote_id = quote.id
       AND invitation.task_draft_id = draft.id
       AND invitation.routing_decision_id = route.id
       AND invitation.routing_decision_version = route.decision_version
       AND invitation.provider_user_id = estimate.provider_user_id
       AND invitation.provider_organization_id IS NOT DISTINCT FROM
           estimate.provider_organization_id
       AND invitation.work_category_code = route.category_snapshot
       AND invitation.routing_policy_version = route.policy_version
       AND quote.created_by IS NOT DISTINCT FROM invitation.quote_created_by
       AND estimate.work_category_code = invitation.work_category_code
       AND estimate.scope_snapshot->>'work_category_code' =
           invitation.work_category_code
       AND estimate.scope_snapshot->>'region_code' = invitation.region_code
       AND estimate.scope_snapshot->>'risk_level' = invitation.risk_level
       AND estimate.scope_snapshot->>'rough_location' = invitation.rough_location
       AND (estimate.scope_snapshot->>'requires_proof')::boolean =
           invitation.requires_proof
       AND quote_version.expires_at = invitation.valid_until
      JOIN task_provider_eligibility_decisions eligibility
        ON eligibility.id = invitation.eligibility_decision_id
       AND eligibility.task_draft_id = draft.id
       AND eligibility.routing_decision_id = route.id
       AND eligibility.decision_version = invitation.eligibility_decision_version
       AND eligibility.policy_version = invitation.eligibility_policy_version
       AND eligibility.provider_user_id = invitation.provider_user_id
       AND eligibility.provider_organization_id IS NOT DISTINCT FROM
           invitation.provider_organization_id
       AND eligibility.provider_class = invitation.provider_class
       AND eligibility.trade_credential_id IS NOT DISTINCT FROM
           invitation.trade_credential_id
       AND eligibility.task_eligible IS TRUE
       AND eligibility.valid_until >= invitation.valid_until
       AND encode(digest(eligibility.evidence::text, 'sha256'), 'hex') =
           invitation.eligibility_evidence_sha256
      JOIN users provider
        ON provider.id = invitation.provider_user_id
       AND provider.account_status = 'ACTIVE'
       AND provider.is_minor IS FALSE
       AND COALESCE(provider.is_banned, FALSE) IS FALSE
     WHERE estimate.id = $1
       AND invitation.valid_until > clock_timestamp()
       AND eligibility.valid_until > clock_timestamp()
       AND quote_version.expires_at > clock_timestamp()
       AND NOT EXISTS (
         SELECT 1
           FROM task_provider_eligibility_decisions newer
          WHERE newer.task_draft_id = eligibility.task_draft_id
            AND newer.provider_user_id = eligibility.provider_user_id
            AND newer.provider_organization_id IS NOT DISTINCT FROM
                eligibility.provider_organization_id
            AND newer.decision_version > eligibility.decision_version
       )
       AND public.universal_v1_invited_provider_authority_is_current(
         invitation.provider_user_id,
         invitation.provider_organization_id,
         invitation.provider_class,
         invitation.trade_credential_id,
         invitation.work_category_code,
         invitation.region_code
       ) IS TRUE
  )
  SELECT * FROM completed
  UNION ALL
  SELECT * FROM available
   WHERE NOT EXISTS (SELECT 1 FROM completed)
   LIMIT 1`;

export class PostgresUniversalV1EstimatePublicFactReader
implements UniversalV1EstimatePublicFactReader {
  constructor(private readonly query: QueryFn = db.query) {}

  async loadSubmissionInvitation(input: {
    actorUserId: string;
    quoteId: string;
    expectedDraftVersion: number;
    expectedQuoteVersion: number;
  }): Promise<TrustedUniversalV1EstimateInvitation | null> {
    const result = await this.query<TrustedUniversalV1EstimateInvitation>(
      LOAD_SUBMISSION_INVITATION_SQL,
      [
        input.quoteId,
        input.actorUserId,
      ],
    );
    return result.rows[0] ?? null;
  }

  async loadAcceptance(input: {
    actorUserId: string;
    providerEstimateSubmissionId: string;
    expectedDraftVersion: number;
    expectedQuoteVersion: number;
  }): Promise<TrustedUniversalV1EstimateAcceptance | null> {
    const result = await this.query<TrustedUniversalV1EstimateAcceptance>(
      LOAD_ACCEPTANCE_SQL,
      [
        input.providerEstimateSubmissionId,
        input.actorUserId,
      ],
    );
    return result.rows[0] ?? null;
  }
}
