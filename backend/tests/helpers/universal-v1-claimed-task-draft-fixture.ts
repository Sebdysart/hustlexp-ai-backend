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
import {
  ensureUniversalV1SyntheticServiceCell,
  SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
  SYNTHETIC_SERVICE_CELL_REGION_CODE,
} from './universal-v1-service-cell-authority.js';

/** Existing public-ingress, contact and account-claim application flow, restricted to disposable v13 fixtures. */
export async function createClaimedTaskDraftFixture(
  database: Database,
  databaseClient: Pick<Pool, 'query'>,
  label: string
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
  return { draftId: linked.draft_id, posterUserId };
}
