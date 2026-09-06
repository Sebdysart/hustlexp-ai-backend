import type { QueryFn } from '../db.js';
import type { Context } from '../trpc-context.js';
import {
  actorId,
  fail,
  type BrowseUniversalV1TaskOpportunitiesInput,
  type GetUniversalV1TaskInterestJourneyInput,
  type InterestAuthoritySelectionRow,
  type InterestJourneyRow,
  type InterestRow,
  type ListUniversalV1TaskInterestsForOpsInput,
  type ListUniversalV1TaskInterestsInput,
  type OpportunityDatabase,
  type OpportunityRow,
  interestColumns,
  opportunityColumns,
  universalV1TaskOpportunityAuthority,
} from './UniversalV1TaskOpportunityModel.js';
import {
  interestJourneyResult,
  interestResult,
  opportunityResult,
} from './UniversalV1TaskOpportunityProjection.js';
import {
  assertActiveProviderIdentity,
  resolveProviderAuthority,
} from './UniversalV1TaskOpportunityProviderAuthority.js';

export async function browseUniversalV1TaskOpportunities(
  database: OpportunityDatabase,
  context: Context,
  input: BrowseUniversalV1TaskOpportunitiesInput
) {
  const providerUserId = actorId(context);
  const authority = await resolveProviderAuthority(database.query, providerUserId, input);
  if (authority.state === 'HELD') {
    return {
      state: authority.state,
      blockerCodes: authority.blockerCodes,
      opportunities: [],
      authority: universalV1TaskOpportunityAuthority,
    };
  }
  const result = await database.query<OpportunityRow>(
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

async function readJourneyTransaction(
  query: QueryFn,
  providerUserId: string,
  input: GetUniversalV1TaskInterestJourneyInput
) {
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
  if (!selected) return fail('NOT_FOUND', 'The Task Opportunity interest is unavailable.');

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
  if (!row) return fail('NOT_FOUND', 'The Task Opportunity interest is unavailable.');
  return interestJourneyResult(row);
}

export async function getMyPreEstimateJourneyState(
  database: OpportunityDatabase,
  context: Context,
  input: GetUniversalV1TaskInterestJourneyInput
) {
  const providerUserId = actorId(context);
  return database.transaction((query) => readJourneyTransaction(query, providerUserId, input));
}

export async function listMyUniversalV1TaskInterests(
  database: OpportunityDatabase,
  context: Context,
  input: ListUniversalV1TaskInterestsInput
) {
  const providerUserId = actorId(context);
  await assertActiveProviderIdentity(database.query, providerUserId);
  const result = await database.query<InterestRow>(
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

export async function listUniversalV1TaskInterestsForOps(
  database: OpportunityDatabase,
  _context: Context,
  input: ListUniversalV1TaskInterestsForOpsInput
) {
  const result = await database.query<InterestRow>(
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
