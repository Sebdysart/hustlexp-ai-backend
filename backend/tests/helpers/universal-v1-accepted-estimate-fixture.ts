import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Database, QueryFn } from '../../src/db.js';
import {
  submitUniversalV1TaskDraft,
  type TaskDraftIngressDependencies,
  type TaskDraftIngressInput,
} from '../../src/routers/web/taskDrafts.js';
import {
  claimUniversalV1TaskDraft,
  type UniversalV1TaskDraftClaimDependencies,
} from '../../src/services/UniversalV1TaskDraftClaim.js';
import type {
  AcceptUniversalV1ProviderEstimate,
  SubmitUniversalV1ProviderEstimate,
} from '../../src/services/UniversalV1EstimateContracts.js';
import { PostgresUniversalV1EstimateRepository } from '../../src/services/UniversalV1EstimatePostgresRepository.js';
import { UniversalV1EstimateService } from '../../src/services/UniversalV1EstimateService.js';
import {
  ensureUniversalV1SyntheticServiceCell,
  SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
  SYNTHETIC_SERVICE_CELL_REGION_CODE,
} from './universal-v1-service-cell-authority.js';

/** Existing public-ingress and estimate application flow, restricted to disposable v13 fixtures. */
export async function createAcceptedEstimateFixture(
  database: Database,
  databaseClient: Pick<Pool, 'query'>,
  label: string,
  bindTaskEligibility = true,
  beforeAcceptance?: (context: { draftId: string; posterUserId: string }) => Promise<void>
) {
  const identity = await databaseClient.query(
    'SELECT current_database() AS database, session_user AS role'
  );
  if (
    !/^hx_ci_v13_[a-f0-9]{32}_test$/u.test(identity.rows[0]?.database ?? '') ||
    identity.rows[0]?.role !== 'hx_ci_runner'
  )
    throw new Error('EXACT_SYNTHETIC_LIFECYCLE_DATABASE_REQUIRED');
  const token = () => randomBytes(32).toString('base64url');
  async function insertUser(mode: 'poster' | 'worker'): Promise<string> {
    const id = randomUUID();
    await databaseClient.query(
      `INSERT INTO public.users(id,firebase_uid,email,full_name,default_mode,date_of_birth,account_status,is_minor,is_banned)
        VALUES ($1,$2,$3,'Synthetic lifecycle fixture',$4,DATE '1990-01-01','ACTIVE',FALSE,FALSE)`,
      [id, `firebase:${id}`, `${id}@synthetic.invalid`, mode]
    );
    return id;
  }
  const fixtureNow = Date.now();
  await ensureUniversalV1SyntheticServiceCell(databaseClient!);
  const policyDocument = {
    schemaVersion: 'hxos-region-policy-v1',
    categories: {
      yard: {
        allowedRiskLevels: ['LOW', 'MEDIUM'],
        credentials: {
          licenseRequired: false,
          insuranceRequired: false,
          backgroundCheckRequired: false,
        },
        evidence: { proofRequired: true, minPhotos: 1, maxPhotos: 5, gpsRequired: false },
      },
    },
    recording: { allowed: false, standaloneConsentRequired: true },
    workerRights: {
      standaloneScreeningConsentRequired: true,
      reportAccessRequired: true,
      disputeAndAppealRequired: true,
      adverseActionNoticeRequired: true,
    },
    financial: {
      currency: 'usd',
      minimumCustomerCents: 5_000,
      minimumPayoutCents: 4_000,
      minimumMarginCents: 500,
    },
    safety: {
      incidentIntakeRequired: true,
      timedCheckinRiskLevels: ['MEDIUM'],
      checkinIntervalsMinutes: [15, 30, 60],
      locationRetentionDays: 30,
      alternateEmergencyActionRequired: true,
    },
  };
  await databaseClient!.query(
    `WITH policy AS (SELECT $1::JSONB AS document)
       INSERT INTO public.region_policies(
         region_code, version, policy_state, production_enabled, approval_state,
         effective_from, policy_document, policy_hash
       )
       SELECT $2, 'universal-v1-work-order-exact-role-v1', 'ACTIVE', FALSE,
              'COUNSEL_APPROVAL_REQUIRED', pg_catalog.clock_timestamp() - INTERVAL '1 day',
              document, pg_catalog.encode(public.digest(document::TEXT, 'sha256'), 'hex')
         FROM policy
       ON CONFLICT (region_code, version) DO NOTHING`,
    [JSON.stringify(policyDocument), SYNTHETIC_SERVICE_CELL_REGION_CODE]
  );

  const submissionId = randomUUID();
  const cardToken = token();
  const ingressTransaction = <T>(callback: (query: QueryFn) => Promise<T>) =>
    database.transaction(callback);
  const ingressDependencies: Partial<TaskDraftIngressDependencies> = {
    env: {
      NODE_ENV: 'test',
      HX_ENVIRONMENT: 'test',
      HX_HUMAN_VERIFICATION_MODE: 'synthetic',
      HX_HUMAN_VERIFICATION_URL: 'http://127.0.0.1/verify',
      HX_HUMAN_VERIFICATION_SECRET: 'exact-role-fixture-secret-v1',
      PUBLIC_INGRESS_IP_HASH_SALT: 'exact-role-fixture-salt-v1',
      TASK_DRAFT_RATE_LIMIT_PER_IP_HOUR: '1000',
      ALLOWED_ORIGINS: 'http://localhost:5173',
    },
    fetch: async () =>
      new Response(
        JSON.stringify({
          success: true,
          action: 'task',
          hostname: 'synthetic.invalid',
          metadata: { result_with_testing_key: true },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      ),
    now: () => fixtureNow,
    randomUuid: randomUUID,
    transaction: ingressTransaction,
  };
  const create: TaskDraftIngressInput = {
    action: 'create',
    submission_id: submissionId,
    expected_version: 0,
    card_token: cardToken,
    raw_input: `Trim shrubs and weed two garden beds (${label})`,
    category: 'yard',
    answers: {
      timing: 'Flexible weekday afternoon',
      access: 'Exterior access',
      scope_confirmed_at: new Date(fixtureNow).toISOString(),
    },
    zip: SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
    region: 'Untrusted location hint',
    photo_count: 0,
    consent_version: 'v1',
    turnstile_token: `synthetic-${randomUUID()}`,
    client_ts: fixtureNow,
  };
  const created = await submitUniversalV1TaskDraft(
    create,
    { ip: '203.0.113.77' },
    ingressDependencies
  );
  if (!created.ok) throw new Error('Exact-role TaskDraft create refused');
  const leadSubmissionId = randomUUID();
  await databaseClient!.query(
    `INSERT INTO public.leads(submission_id, lead_type, email, name, answers, source)
       VALUES ($1, 'poster', $2, 'Exact Role Fixture',
               pg_catalog.jsonb_build_object('task_draft_submission_id', $3::TEXT),
               'required_test')`,
    [leadSubmissionId, `${leadSubmissionId}@synthetic.invalid`, submissionId]
  );
  const linked = await submitUniversalV1TaskDraft(
    {
      ...create,
      action: 'link_contact',
      expected_version: created.version,
      raw_input: 'contact link',
      lead_submission_id: leadSubmissionId,
      turnstile_token: undefined,
    },
    { ip: '203.0.113.77' },
    ingressDependencies
  );
  if (!linked.ok) throw new Error('Exact-role TaskDraft contact link refused');
  const posterUserId = await insertUser('poster');
  const claimDependencies: Partial<UniversalV1TaskDraftClaimDependencies> = {
    now: () => fixtureNow,
    randomUuid: randomUUID,
    transaction: ingressTransaction,
  };
  await claimUniversalV1TaskDraft(
    {
      submission_id: submissionId,
      card_token: cardToken,
      expected_version: 0,
      idempotency_key: `claim:${label}:${submissionId}`,
      client_ts: fixtureNow,
    },
    posterUserId,
    claimDependencies
  );
  const initialRoute = await databaseClient!.query<{
    id: string;
    decision_version: number;
  }>(
    `SELECT route.id, route.decision_version
         FROM public.task_drafts draft
         JOIN public.task_routing_decisions route
           ON route.id = draft.active_routing_decision_id
        WHERE draft.id = $1 AND route.outcome = 'ESTIMATE_REQUIRED'`,
    [linked.draft_id]
  );
  const providerUserId = await insertUser('worker');
  await databaseClient!.query(
    `INSERT INTO public.capability_profiles(user_id, trust_tier, provider_class)
       VALUES ($1, 1, 'GENERAL_SERVICE_PROVIDER')`,
    [providerUserId]
  );
  const operatorUserId = await insertUser('poster');
  await databaseClient!.query(
    `INSERT INTO public.admin_roles(user_id, role, can_manage_operations)
       VALUES ($1, 'support', TRUE)`,
    [operatorUserId]
  );
  const eligibilityId = randomUUID();
  const evidence = {
    work_category_code: 'yard',
    region_code: SYNTHETIC_SERVICE_CELL_REGION_CODE,
    risk_level: 'LOW',
    requires_proof: true,
    rough_location: 'Synthetic XQ service area',
  };
  await databaseClient!.query(
    `INSERT INTO public.task_provider_eligibility_decisions(
         id, task_draft_id, routing_decision_id, decision_version,
         provider_user_id, provider_class, profile_eligible, identity_eligible,
         category_eligible, credential_eligible, geography_eligible,
         availability_eligible, restriction_clear, task_eligible,
         processor_payment_eligible, payout_funding_eligible, trust_tier,
         blocker_codes, policy_version, evidence, decided_by, idempotency_key,
         valid_until
       ) VALUES (
         $1, $2, $3, 1, $4, 'GENERAL_SERVICE_PROVIDER',
         TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE,
         'TIER_1', ARRAY[]::TEXT[], 'universal-v1-exact-role-fixture-v1',
         $5::JSONB, $6, $7, pg_catalog.clock_timestamp() + INTERVAL '15 minutes'
       )`,
    [
      eligibilityId,
      linked.draft_id,
      initialRoute.rows[0]!.id,
      providerUserId,
      JSON.stringify(evidence),
      operatorUserId,
      `eligibility:${label}:${eligibilityId}`,
    ]
  );
  const estimates = new UniversalV1EstimateService(
    new PostgresUniversalV1EstimateRepository(database)
  );
  const invitation = await estimates.issueProviderEstimateInvitation({
    eligibility_decision_id: eligibilityId,
    expected_draft_version: initialRoute.rows[0]!.decision_version,
    expected_eligibility_version: 1,
    actor_user_id: operatorUserId,
    idempotency_key: `invitation:${label}:${eligibilityId}`,
  });
  const submission: SubmitUniversalV1ProviderEstimate = {
    task_draft_id: linked.draft_id,
    routing_decision_id: initialRoute.rows[0]!.id,
    expected_draft_version: initialRoute.rows[0]!.decision_version,
    quote_id: invitation.quote_id,
    expected_quote_version: 0,
    provider: {
      actor_user_id: providerUserId,
      provider_user_id: providerUserId,
      provider_organization_id: null,
    },
    scope: {
      title: 'Trim shrubs and weed beds',
      description: 'Trim bounded shrubs and remove weeds from two garden beds.',
      requirements: null,
      checklist: ['Photograph start', 'Trim shrubs', 'Weed beds', 'Capture evidence'],
      work_category_code: 'yard',
      region_code: SYNTHETIC_SERVICE_CELL_REGION_CODE,
      rough_location: 'Synthetic XQ service area',
      risk_level: 'LOW',
      requires_proof: true,
    },
    line_items: [
      {
        description: 'Yard service labor',
        quantity: 1,
        unit_amount_cents: 10_000,
        total_amount_cents: 10_000,
      },
    ],
    customer_total_cents: 10_000,
    provider_payout_cents: 8_000,
    currency: 'USD',
    idempotency_key: `estimate-submit:${label}:${invitation.quote_id}`,
  };
  const submitted = await estimates.submitProviderEstimate(submission);
  const acceptance: AcceptUniversalV1ProviderEstimate = {
    task_draft_id: linked.draft_id,
    provider_estimate_submission_id: submitted.provider_estimate_submission_id,
    quote_id: invitation.quote_id,
    quote_version_id: submitted.quote_version_id,
    poster_user_id: posterUserId,
    actor_user_id: posterUserId,
    expected_draft_version: initialRoute.rows[0]!.decision_version,
    idempotency_key: `estimate-accept:${label}:${linked.draft_id}`,
  };
  await beforeAcceptance?.({ draftId: linked.draft_id, posterUserId });
  const accepted = await estimates.acceptProviderEstimate(acceptance);
  const scope = await databaseClient!.query<{ version: number }>(
    `SELECT version FROM public.task_scope_versions WHERE id = $1`,
    [accepted.scope_version_id]
  );
  // Stop at genuine estimate acceptance when the caller will express interest
  // through the authenticated H146 command port. Do not fabricate task eligibility.
  if (!bindTaskEligibility)
    return {
      eligibilityDecisionId: eligibilityId,
      posterUserId,
      providerUserId,
      draftId: linked.draft_id,
      taskId: accepted.task_id,
      scopeVersion: scope.rows[0]!.version,
      scopeVersionId: accepted.scope_version_id,
    };
  // Synthetic financial fixture prerequisite, subject to the unchanged
  // eligibility sequence guard. Acceptance does not itself create post-estimate
  // eligibility, interest or a hold. Payment/funding eligibility stays false.
  const taskEligibility = await databaseClient.query(
    `INSERT INTO public.task_provider_eligibility_decisions(
      task_draft_id,task_id,scope_version_id,routing_decision_id,decision_version,
      supersedes_decision_id,provider_user_id,provider_class,profile_eligible,
      identity_eligible,category_eligible,credential_eligible,geography_eligible,
      availability_eligible,restriction_clear,task_eligible,processor_payment_eligible,
      payout_funding_eligible,trust_tier,blocker_codes,policy_version,evidence,
      decided_by,idempotency_key,valid_until
    ) SELECT source.task_draft_id,$2,$3,draft.active_routing_decision_id,
      source.decision_version+1,source.id,source.provider_user_id,source.provider_class,
      source.profile_eligible,source.identity_eligible,source.category_eligible,
      source.credential_eligible,source.geography_eligible,source.availability_eligible,
      source.restriction_clear,source.task_eligible,FALSE,FALSE,source.trust_tier,
      source.blocker_codes,source.policy_version,
      source.evidence || jsonb_build_object('synthetic_materialization_fixture',TRUE),
      source.decided_by,$4,source.valid_until
    FROM public.task_provider_eligibility_decisions source
    JOIN public.task_drafts draft ON draft.id=source.task_draft_id
    WHERE source.id=$1 RETURNING id`,
    [eligibilityId, accepted.task_id, accepted.scope_version_id, `lifecycle-elig:${randomUUID()}`]
  );
  if (taskEligibility.rows.length !== 1) throw new Error('SYNTHETIC_TASK_ELIGIBILITY_MISSING');
  return {
    eligibilityDecisionId: taskEligibility.rows[0]!.id as string,
    posterUserId,
    providerUserId,
    draftId: linked.draft_id,
    taskId: accepted.task_id,
    scopeVersion: scope.rows[0]!.version,
    scopeVersionId: accepted.scope_version_id,
  };
}
