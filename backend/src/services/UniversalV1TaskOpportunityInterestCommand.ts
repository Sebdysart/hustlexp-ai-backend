import type { QueryFn } from '../db.js';
import type { Context } from '../trpc-context.js';
import {
  actorId,
  fail,
  type ExpressUniversalV1TaskInterestInput,
  type InterestRow,
  type OpportunityDatabase,
  type OpportunityRow,
  type ProviderAuthorityReady,
  interestColumns,
  opportunityColumns,
  requestSha256,
  translateDatabaseError,
} from './UniversalV1TaskOpportunityModel.js';
import { interestResult } from './UniversalV1TaskOpportunityProjection.js';
import {
  assertActiveProviderIdentity,
  resolveProviderAuthority,
} from './UniversalV1TaskOpportunityProviderAuthority.js';

async function acquireInterestLocks(
  query: QueryFn,
  providerUserId: string,
  input: ExpressUniversalV1TaskInterestInput
): Promise<void> {
  await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `task-opportunity-interest:${providerUserId}:${input.idempotencyKey}`,
  ]);
  await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    `task-opportunity-provider:${providerUserId}:${input.providerOrganizationId ?? ''}:${input.opportunityId}`,
  ]);
}

async function loadCurrentOpportunity(
  query: QueryFn,
  input: ExpressUniversalV1TaskInterestInput
): Promise<OpportunityRow> {
  const opportunity = await query<OpportunityRow>(
    `SELECT ${opportunityColumns}
     FROM public.current_universal_v1_task_opportunities_v1 opportunity
     WHERE opportunity.opportunity_id = $1::UUID
       AND opportunity.opportunity_version = $2
     LIMIT 1`,
    [input.opportunityId, input.expectedOpportunityVersion]
  );
  return opportunity.rows[0] ?? fail(
    'CONFLICT',
    'The exact current open Task Opportunity version is unavailable.'
  );
}

async function readInterestReplay(
  query: QueryFn,
  providerUserId: string,
  input: ExpressUniversalV1TaskInterestInput,
  requestDigest: string
) {
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
  const row = replay.rows[0];
  if (!row) return null;
  if (row.request_sha256.trim() !== requestDigest) {
    return fail('CONFLICT', 'The idempotency key is bound to a different request.');
  }
  return interestResult(row, true);
}

async function assertTradeQualification(
  query: QueryFn,
  providerUserId: string,
  authority: ProviderAuthorityReady,
  opportunity: OpportunityRow
): Promise<void> {
  if (authority.providerClass !== 'VERIFIED_TRADE_BUSINESS') return;
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
      opportunity.region_code,
      opportunity.work_category_code,
    ]
  );
  if (qualification.rowCount !== 1) {
    return fail(
      'PRECONDITION_FAILED',
      'Current trade credential does not cover this category and jurisdiction.'
    );
  }
}

async function assertNoExistingInterest(
  query: QueryFn,
  providerUserId: string,
  input: ExpressUniversalV1TaskInterestInput,
  authority: ProviderAuthorityReady
): Promise<void> {
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
}

async function insertInterest(
  query: QueryFn,
  providerUserId: string,
  input: ExpressUniversalV1TaskInterestInput,
  requestDigest: string,
  authority: ProviderAuthorityReady
) {
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
}

async function recordInterestTransaction(
  query: QueryFn,
  providerUserId: string,
  input: ExpressUniversalV1TaskInterestInput,
  requestDigest: string
) {
  await acquireInterestLocks(query, providerUserId, input);
  await assertActiveProviderIdentity(query, providerUserId);

  const authority = await resolveProviderAuthority(query, providerUserId, input);
  if (authority.state === 'HELD') {
    return fail(
      'PRECONDITION_FAILED',
      `Provider observation held: ${authority.blockerCodes.join(',')}.`
    );
  }
  const opportunity = await loadCurrentOpportunity(query, input);
  if (
    opportunity.routing_outcome === 'FULFILLMENT_CANDIDATE'
    && (
      !opportunity.standardized_quote_id
      || opportunity.fake_payment_method_ready !== true
      || opportunity.payment_method_readiness_posture
        !== 'FAKE_PAYMENT_METHOD_READY_NO_FINANCIAL_EFFECT'
    )
  ) {
    return fail(
      'PRECONDITION_FAILED',
      'The standardized opportunity is not ready for observation-only provider interest.'
    );
  }

  // The current opportunity view and its insert trigger independently bind a
  // standardized route to exact accepted, unexpired FAKE readiness. Recording
  // interest remains observation-only and grants no eligibility or later power.
  const replay = await readInterestReplay(query, providerUserId, input, requestDigest);
  if (replay) return replay;
  await assertTradeQualification(query, providerUserId, authority, opportunity);
  await assertNoExistingInterest(query, providerUserId, input, authority);
  return insertInterest(query, providerUserId, input, requestDigest, authority);
}

export async function expressUniversalV1TaskInterest(
  database: OpportunityDatabase,
  context: Context,
  input: ExpressUniversalV1TaskInterestInput
) {
  const providerUserId = actorId(context);
  const requestDigest = requestSha256(providerUserId, input);
  try {
    return await database.transaction((query) =>
      recordInterestTransaction(query, providerUserId, input, requestDigest)
    );
  } catch (error) {
    return translateDatabaseError(error);
  }
}
