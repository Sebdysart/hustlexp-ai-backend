import { createHmac, randomBytes, randomUUID } from 'node:crypto';

import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { BuildIdentity } from '../../src/buildIdentity.js';
import type { Database, QueryFn } from '../../src/db.js';
import {
  releaseManifestDigest,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
} from '../../src/releaseManifest.js';
import {
  submitUniversalV1TaskDraft,
  type TaskDraftIngressDependencies,
  type TaskDraftIngressInput,
} from '../../src/routers/web/taskDrafts.js';
import {
  type AcceptUniversalV1ProviderEstimate,
  type SubmitUniversalV1ProviderEstimate,
} from '../../src/services/UniversalV1EstimateContracts.js';
import { UniversalV1ChangeOrderApplication } from '../../src/services/UniversalV1ChangeOrderApplication.js';
import { UniversalV1CompletionDeliveryApplication } from '../../src/services/UniversalV1CompletionDeliveryApplication.js';
import { PostgresUniversalV1CompletionDeliveryRepository } from '../../src/services/UniversalV1CompletionDeliveryPostgresRepository.js';
import { PostgresUniversalV1ChangeOrderRepository } from '../../src/services/UniversalV1ChangeOrderPostgresRepository.js';
import { PostgresUniversalV1EstimateRepository } from '../../src/services/UniversalV1EstimatePostgresRepository.js';
import { UniversalV1EstimateService } from '../../src/services/UniversalV1EstimateService.js';
import { UniversalV1ExecutionApplication } from '../../src/services/UniversalV1ExecutionApplication.js';
import { PostgresUniversalV1ExecutionRepository } from '../../src/services/UniversalV1ExecutionPostgresRepository.js';
import { UniversalV1WorkOrderApplication } from '../../src/services/UniversalV1WorkOrderApplication.js';
import { UniversalV1FulfillmentApplication } from '../../src/services/UniversalV1FulfillmentApplication.js';
import { PostgresUniversalV1FulfillmentRepository } from '../../src/services/UniversalV1FulfillmentPostgresRepository.js';
import {
  deterministicUuid,
  PostgresUniversalV1WorkOrderRepository,
} from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import { PostgresUniversalV1WorkOrderPublicFactReader } from '../../src/services/UniversalV1WorkOrderPublicFacts.js';
import {
  claimUniversalV1TaskDraft,
  type UniversalV1TaskDraftClaimDependencies,
} from '../../src/services/UniversalV1TaskDraftClaim.js';
import { createUniversalV1FakeFinancialApplicationService } from '../../src/services/payment/UniversalV1FinancialApplicationService.js';
import { createCompletionDeliveryWebhook } from '../../src/serverCompletionDeliveryWebhook.js';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const now = 1_800_000_000_000;
const regionCode = 'US-XQ';

function assertDisposableDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5432' ||
    parsed.username !== 'hx_ci_runner' ||
    parsed.pathname !== '/hx_ci_system_test' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'Estimate materialization proof may run only on the exact disposable system database'
    );
  }
}

function sha256Digest(seed: string): string {
  return `sha256:${seed.repeat(64)}`;
}

function localFakeFinanceAuthority(): {
  env: NodeJS.ProcessEnv;
  release: ReleaseManifestEvidence;
  identity: BuildIdentity;
} {
  const revision = '1'.repeat(40);
  const manifest: ReleaseManifest = {
    version: 1,
    environment: 'local',
    releaseId: 'local-work-order-pg-proof-0001',
    createdAt: '2026-08-27T00:00:00.000Z',
    authority: {
      document: 'HustleXP Business and Universal V1 Charter',
      charterVersion: '1.1.0',
      charterRevision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
      capabilityPolicyDigest: sha256Digest('f'),
    },
    components: {
      backend: {
        revision,
        artifactDigest: sha256Digest('1'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: sha256Digest('2'),
      },
      worker: {
        revision: '2'.repeat(40),
        artifactDigest: sha256Digest('3'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: sha256Digest('4'),
      },
      web: {
        revision: '3'.repeat(40),
        artifactDigest: sha256Digest('5'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: sha256Digest('6'),
      },
      migration: { revision, artifactDigest: sha256Digest('7') },
      policy: { revision: '4'.repeat(40), artifactDigest: sha256Digest('8') },
      fixtures: {
        revision: '5'.repeat(40),
        artifactDigest: sha256Digest('9'),
        imageEvidence: 'VERIFIED_IMMUTABLE_IMAGE',
        imageDigest: sha256Digest('a'),
      },
    },
    capabilities: {
      financialProvider: 'fake',
      fakeFinancialEvents: true,
      customerMoneyCreation: false,
      hardAssignment: false,
      realSettlement: false,
      outboundCommunication: 'sink',
      dataClass: 'synthetic',
    },
    promotion: {
      baseManifestDigest: null,
      changedComponents: ['backend', 'worker', 'web', 'migration', 'policy', 'fixtures'],
    },
    health: {
      backend: { component: 'backend', path: '/health' },
      worker: { component: 'worker', path: '/health' },
      web: { component: 'web', path: '/version.json' },
    },
  };
  return {
    env: {
      HX_ENVIRONMENT: 'local',
      HX_PAYMENT_CREATION_MODE: 'frozen',
      SERVICE_ROLE: 'api',
      HX_EXTERNAL_VALUE: 'false',
      HX_LIVE_PROVIDER_ACCESS: 'false',
    },
    release: {
      schema_version: 1,
      status: 'valid',
      digest: releaseManifestDigest(manifest),
      source: 'system-test-local-manifest',
      errors: [],
      manifest,
      authentication: {
        status: 'missing',
        algorithm: null,
        keyId: null,
        keyFingerprint: null,
        signatureDigest: null,
        source: 'not-required-for-local-system-test',
        errors: [],
      },
    },
    identity: {
      schema_version: 1,
      service: 'hustlexp-engine',
      revision,
      built_at: '2026-08-27T00:00:00.000Z',
      environment: 'test',
      clean_source: false,
      source: 'system-test',
      artifact_digest: manifest.components.backend.artifactDigest,
      artifact_verified: false,
    },
  };
}

interface ProviderIdentity {
  actor_user_id: string;
  provider_user_id: string;
  provider_organization_id: string | null;
}

interface ProviderAuthorityFixture extends ProviderIdentity {
  provider_class: 'GENERAL_SERVICE_PROVIDER' | 'VERIFIED_TRADE_BUSINESS';
  trade_credential_id: string | null;
}

interface EstimateLaneFixture {
  draftId: string;
  submissionId: string;
  posterUserId: string;
  routeId: string;
  routeVersion: number;
  quoteId: string;
  eligibilityDecisionId: string;
  invitationId: string;
  invitationValidUntil: Date;
  invitationOperatorUserId: string;
  invitationIdempotencyKey: string;
  workCategoryCode: 'yard' | 'plumbing';
  provider: ProviderAuthorityFixture;
}

describePg('Universal V1 provider estimate PostgreSQL golden path', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 12 });

  const runTransaction = async <T>(
    isolation: '' | ' ISOLATION LEVEL SERIALIZABLE',
    callback: (query: QueryFn) => Promise<T>
  ): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN${isolation}`);
      const query: QueryFn = async <Row = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
      ) => {
        const result = await client.query(sql, params);
        return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
      };
      const value = await callback(query);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };

  const transaction: Database['transaction'] = (callback) => runTransaction('', callback);
  const serializableTransaction: Database['serializableTransaction'] = (callback) =>
    runTransaction(' ISOLATION LEVEL SERIALIZABLE', callback);

  const database: Database = {
    query: async <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    },
    readQuery: async <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    },
    transaction,
    serializableTransaction,
    healthCheck: async () => ({ connected: true, schemaVersion: null, latencyMs: 0 }),
    getPool: () => pool,
    getPoolStats: () => ({
      totalConnections: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingRequests: pool.waitingCount,
      maxConnections: 12,
      utilizationPercent: 0,
      replicaConnections: null,
    }),
    close: async () => undefined,
  };

  const ingressDependencies: Partial<TaskDraftIngressDependencies> = {
    env: {
      NODE_ENV: 'test',
      HX_ENVIRONMENT: 'test',
      HX_HUMAN_VERIFICATION_MODE: 'synthetic',
      HX_HUMAN_VERIFICATION_URL: 'http://127.0.0.1:8080/v1/human-verification/verify',
      HX_HUMAN_VERIFICATION_SECRET: 'required-test-human-verification-secret-v1',
      PUBLIC_INGRESS_IP_HASH_SALT: 'required-test-estimate-ip-salt-v1',
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
    now: () => now,
    randomUuid: randomUUID,
    transaction,
  };

  const claimDependencies: Partial<UniversalV1TaskDraftClaimDependencies> = {
    now: () => now,
    randomUuid: randomUUID,
    transaction,
  };

  beforeAll(async () => {
    assertDisposableDatabase(databaseUrl);
    expect(process.env.HX_PAYMENT_CREATION_MODE).toBe('frozen');
    await pool.query('SELECT 1');
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
        plumbing: {
          allowedRiskLevels: ['MEDIUM', 'HIGH', 'IN_HOME'],
          credentials: {
            licenseRequired: true,
            insuranceRequired: true,
            backgroundCheckRequired: true,
          },
          evidence: { proofRequired: true, minPhotos: 2, maxPhotos: 5, gpsRequired: false },
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
        timedCheckinRiskLevels: ['MEDIUM', 'HIGH', 'IN_HOME'],
        checkinIntervalsMinutes: [15, 30, 60],
        locationRetentionDays: 30,
        alternateEmergencyActionRequired: true,
      },
    };
    await pool.query(
      `WITH policy AS (SELECT $1::jsonb AS document)
       INSERT INTO region_policies (
         region_code, version, policy_state, production_enabled, approval_state,
         effective_from, policy_document, policy_hash
       )
       SELECT $2, 'universal-v1-estimate-system-v1', 'ACTIVE', FALSE,
              'COUNSEL_APPROVAL_REQUIRED', clock_timestamp() - INTERVAL '1 day',
              document, encode(digest(document::text, 'sha256'), 'hex')
         FROM policy
       ON CONFLICT (region_code, version) DO NOTHING`,
      [JSON.stringify(policyDocument), regionCode]
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  async function userFixture(mode: 'poster' | 'worker' = 'poster'): Promise<string> {
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO users(
         id, firebase_uid, email, full_name, default_mode, date_of_birth, is_minor
       ) VALUES ($1, $2, $3, 'Estimate System Test', $4, DATE '1990-01-01', false)`,
      [userId, `firebase-${userId}`, `${userId}@example.invalid`, mode]
    );
    return userId;
  }

  async function generalProviderFixture(): Promise<ProviderAuthorityFixture> {
    const providerUserId = await userFixture('worker');
    await pool.query(
      `INSERT INTO capability_profiles(user_id, trust_tier, provider_class)
       VALUES ($1, 1, 'GENERAL_SERVICE_PROVIDER')`,
      [providerUserId]
    );
    return {
      actor_user_id: providerUserId,
      provider_user_id: providerUserId,
      provider_organization_id: null,
      provider_class: 'GENERAL_SERVICE_PROVIDER',
      trade_credential_id: null,
    };
  }

  async function verifiedTradeProviderFixture(): Promise<ProviderAuthorityFixture> {
    const providerUserId = await userFixture('worker');
    const organizationId = randomUUID();
    const membershipId = randomUUID();
    const credentialId = randomUUID();
    await pool.query(
      `INSERT INTO business_organizations(
         id, legal_name, display_name, provider_enabled, client_enabled,
         verification_status, status, created_by, creation_idempotency_key,
         provider_class
       ) VALUES (
         $1, 'XQ Plumbing LLC', 'XQ Plumbing', TRUE, FALSE,
         'VERIFIED', 'ACTIVE', $2, $3, 'VERIFIED_TRADE_BUSINESS'
       )`,
      [organizationId, providerUserId, `trade-org:${organizationId}`]
    );
    await pool.query(
      `INSERT INTO business_memberships(
         id, organization_id, user_id, role, status, invited_by, accepted_at
       ) VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', $3, clock_timestamp())`,
      [membershipId, organizationId, providerUserId]
    );
    await pool.query(
      `INSERT INTO business_credentials(
         id, organization_id, membership_id, credential_type, status,
         expires_at, evidence_hash, verified_by, verified_at,
         qualification_contract_version, issuing_authority, jurisdiction_code,
         license_scope, permitted_work_categories, credential_evidence,
         official_source_checked_at
       ) VALUES (
         $1, $2, $3, 'PLUMBING_LICENSE', 'ACTIVE',
         clock_timestamp() + INTERVAL '365 days', $4, $5,
         clock_timestamp() - INTERVAL '1 day', 1, 'XQ Trade Licensing Authority',
         $6, 'Residential plumbing installation and repair', ARRAY['plumbing']::text[],
         $7::jsonb, clock_timestamp() - INTERVAL '1 day'
       )`,
      [
        credentialId,
        organizationId,
        membershipId,
        randomBytes(32).toString('hex'),
        providerUserId,
        regionCode,
        JSON.stringify({ source: 'synthetic-official-register', licenseStatus: 'ACTIVE' }),
      ]
    );
    await pool.query(
      `INSERT INTO verified_trades(
         user_id, trade, state, expires_at, provider_class,
         provider_organization_id, business_credential_id,
         universal_contract_version
       ) VALUES (
         $1, 'plumbing', 'XQ', CURRENT_DATE + 365,
         'VERIFIED_TRADE_BUSINESS', $2, $3, 1
       )`,
      [providerUserId, organizationId, credentialId]
    );
    return {
      actor_user_id: providerUserId,
      provider_user_id: providerUserId,
      provider_organization_id: organizationId,
      provider_class: 'VERIFIED_TRADE_BUSINESS',
      trade_credential_id: credentialId,
    };
  }

  async function claimedDraftFixture(
    category: 'yard' | 'handyman',
    rawInput: string
  ): Promise<{
    draftId: string;
    submissionId: string;
    posterUserId: string;
    routeId: string;
    routeVersion: number;
  }> {
    const submissionId = randomUUID();
    const cardToken = randomBytes(32).toString('hex');
    const create: TaskDraftIngressInput = {
      action: 'create',
      submission_id: submissionId,
      expected_version: 0,
      card_token: cardToken,
      raw_input: rawInput,
      category,
      answers: {
        timing: 'Flexible weekday afternoon',
        access: 'Exterior or accompanied access',
        scope_confirmed_at: new Date(now).toISOString(),
      },
      zip: '98052',
      region: 'Synthetic XQ',
      photo_count: 0,
      consent_version: 'v1',
      turnstile_token: `synthetic-estimate-${randomUUID()}`,
      client_ts: now,
    };
    const created = await submitUniversalV1TaskDraft(
      create,
      { ip: '203.0.113.61' },
      ingressDependencies
    );
    if (!created.ok) throw new Error('synthetic TaskDraft was rejected');

    const leadSubmissionId = randomUUID();
    await pool.query(
      `INSERT INTO leads(submission_id, lead_type, email, name, answers, source)
       VALUES ($1, 'poster', $2, 'Estimate Test',
               jsonb_build_object('task_draft_submission_id', $3::text),
               'required_test')`,
      [leadSubmissionId, `${leadSubmissionId}@example.invalid`, submissionId]
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
      { ip: '203.0.113.61' },
      ingressDependencies
    );
    if (!linked.ok) throw new Error('synthetic TaskDraft contact link was rejected');

    const posterUserId = await userFixture('poster');
    await claimUniversalV1TaskDraft(
      {
        submission_id: submissionId,
        card_token: cardToken,
        expected_version: 0,
        idempotency_key: `claim-estimate:${submissionId}`,
        client_ts: now,
      },
      posterUserId,
      claimDependencies
    );
    const route = await pool.query<{ route_id: string; decision_version: number; outcome: string }>(
      `SELECT route.id AS route_id, route.decision_version, route.outcome
         FROM task_drafts draft
         JOIN task_routing_decisions route ON route.id = draft.active_routing_decision_id
        WHERE draft.id = $1`,
      [linked.draft_id]
    );
    expect(route.rows[0]?.outcome).toBe('ESTIMATE_REQUIRED');
    return {
      draftId: linked.draft_id,
      submissionId,
      posterUserId,
      routeId: route.rows[0]!.route_id,
      routeVersion: route.rows[0]!.decision_version,
    };
  }

  async function normalizeTradeRoute(
    draft: Awaited<ReturnType<typeof claimedDraftFixture>>
  ): Promise<{ routeId: string; routeVersion: number }> {
    const routeId = randomUUID();
    const result = await pool.query<{ id: string; decision_version: number }>(
      `INSERT INTO task_routing_decisions(
         id, task_draft_id, decision_version, supersedes_decision_id, outcome,
         reason_codes, policy_version, category_snapshot, service_cell_snapshot,
         decision_authority, evidence, idempotency_key
       ) VALUES (
         $1, $2, $3, $4, 'ESTIMATE_REQUIRED',
         ARRAY['CREDENTIALED_TRADE_REVIEW_REQUIRED']::text[],
         'universal-v1-trade-normalization-system-v1', 'plumbing', $5,
         'DETERMINISTIC_POLICY', $6::jsonb, $7
       )
       RETURNING id, decision_version`,
      [
        routeId,
        draft.draftId,
        draft.routeVersion + 1,
        draft.routeId,
        regionCode,
        JSON.stringify({ normalizedWorkCategory: 'plumbing', paymentCreationFrozen: true }),
        `trade-route:${draft.draftId}`,
      ]
    );
    return {
      routeId: result.rows[0]!.id,
      routeVersion: result.rows[0]!.decision_version,
    };
  }

  async function quoteInvitation(
    draftId: string,
    routeId: string,
    routeVersion: number,
    provider: ProviderAuthorityFixture,
    workCategoryCode: 'yard' | 'plumbing',
    validForMs = 15 * 60 * 1_000
  ): Promise<{
    quoteId: string;
    eligibilityDecisionId: string;
    invitationId: string;
    invitationValidUntil: Date;
    invitationOperatorUserId: string;
    invitationIdempotencyKey: string;
  }> {
    const prepared = await prepareInvitationAuthority(
      draftId,
      routeId,
      provider,
      workCategoryCode,
      validForMs
    );
    const {
      eligibilityDecisionId,
      invitationValidUntil,
      invitationOperatorUserId,
      invitationIdempotencyKey,
    } = prepared;
    const issued = await estimateService().issueProviderEstimateInvitation({
      eligibility_decision_id: eligibilityDecisionId,
      expected_draft_version: routeVersion,
      expected_eligibility_version: 1,
      actor_user_id: invitationOperatorUserId,
      idempotency_key: invitationIdempotencyKey,
    });
    expect(issued).toMatchObject({
      eligibility_decision_id: eligibilityDecisionId,
      expected_draft_version: routeVersion,
      expected_eligibility_version: 1,
      replayed: false,
      payment_creation_performed: false,
      financial_security_event_created: false,
      conditional_hold_created: false,
      hard_assignment_created: false,
      work_order_created: false,
      universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
    });
    return {
      quoteId: issued.quote_id,
      eligibilityDecisionId,
      invitationId: issued.invitation_id,
      invitationValidUntil: new Date(issued.valid_until),
      invitationOperatorUserId,
      invitationIdempotencyKey,
    };
  }

  async function prepareInvitationAuthority(
    draftId: string,
    routeId: string,
    provider: ProviderAuthorityFixture,
    workCategoryCode: 'yard' | 'plumbing',
    validForMs = 15 * 60 * 1_000
  ): Promise<{
    eligibilityDecisionId: string;
    invitationValidUntil: Date;
    invitationOperatorUserId: string;
    invitationIdempotencyKey: string;
  }> {
    const eligibilityDecisionId = randomUUID();
    const invitationValidUntil = new Date(Date.now() + validForMs);
    const invitationOperatorUserId = await userFixture('poster');
    const invitationIdempotencyKey = `estimate-invite:${eligibilityDecisionId}`;
    await pool.query(
      `INSERT INTO admin_roles(user_id, role, can_manage_operations)
       VALUES ($1, 'support', TRUE)`,
      [invitationOperatorUserId]
    );
    await transaction(async (query) => {
      const evidence = {
        work_category_code: workCategoryCode,
        region_code: regionCode,
        risk_level: workCategoryCode === 'plumbing' ? 'MEDIUM' : 'LOW',
        requires_proof: true,
        rough_location: 'Synthetic XQ service area',
      };
      await query(
        `INSERT INTO task_provider_eligibility_decisions(
           id, task_draft_id, routing_decision_id, decision_version,
           provider_user_id, provider_organization_id, provider_class,
           trade_credential_id, profile_eligible, identity_eligible,
           category_eligible, credential_eligible, geography_eligible,
           availability_eligible, restriction_clear, task_eligible,
           processor_payment_eligible, payout_funding_eligible, trust_tier,
           blocker_codes, policy_version, evidence, decided_by,
           idempotency_key, valid_until
         ) VALUES (
           $1, $2, $3, 1, $4, $5, $6, $7,
           TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
           FALSE, FALSE, 'TIER_1', ARRAY[]::text[],
           'universal-v1-estimate-eligibility-system-v1', $8::jsonb, $9, $10, $11
         )`,
        [
          eligibilityDecisionId,
          draftId,
          routeId,
          provider.provider_user_id,
          provider.provider_organization_id,
          provider.provider_class,
          provider.trade_credential_id,
          JSON.stringify(evidence),
          invitationOperatorUserId,
          `estimate-eligibility:${eligibilityDecisionId}`,
          invitationValidUntil,
        ]
      );
    });
    return {
      eligibilityDecisionId,
      invitationValidUntil,
      invitationOperatorUserId,
      invitationIdempotencyKey,
    };
  }

  async function estimateLaneFixture(
    kind: 'yard' | 'plumbing',
    validForMs = 15 * 60 * 1_000
  ): Promise<EstimateLaneFixture> {
    const provider =
      kind === 'yard' ? await generalProviderFixture() : await verifiedTradeProviderFixture();
    const draft = await claimedDraftFixture(
      kind === 'yard' ? 'yard' : 'handyman',
      kind === 'yard'
        ? 'Trim shrubs and weed two garden beds; scope depends on site conditions'
        : 'Licensed plumbing estimate for replacing a failed residential shutoff valve'
    );
    const route =
      kind === 'yard'
        ? { routeId: draft.routeId, routeVersion: draft.routeVersion }
        : await normalizeTradeRoute(draft);
    const invitation = await quoteInvitation(
      draft.draftId,
      route.routeId,
      route.routeVersion,
      provider,
      kind,
      validForMs
    );
    return {
      ...draft,
      ...route,
      ...invitation,
      provider,
      workCategoryCode: kind,
    };
  }

  function submissionCommand(fixture: EstimateLaneFixture): SubmitUniversalV1ProviderEstimate {
    const trade = fixture.workCategoryCode === 'plumbing';
    return {
      task_draft_id: fixture.draftId,
      routing_decision_id: fixture.routeId,
      expected_draft_version: fixture.routeVersion,
      quote_id: fixture.quoteId,
      expected_quote_version: 0,
      provider: {
        actor_user_id: fixture.provider.actor_user_id,
        provider_user_id: fixture.provider.provider_user_id,
        provider_organization_id: fixture.provider.provider_organization_id,
      },
      scope: {
        title: trade ? 'Replace residential shutoff valve' : 'Trim shrubs and weed beds',
        description: trade
          ? 'Inspect and replace one failed residential water shutoff valve under a fixed scope.'
          : 'Trim the front shrubs and remove weeds from two bounded garden beds.',
        requirements: trade ? 'Current credential and accompanied property access' : null,
        checklist: trade
          ? ['Confirm isolation', 'Replace valve', 'Pressure test', 'Capture completion evidence']
          : [
              'Photograph starting state',
              'Trim shrubs',
              'Weed beds',
              'Capture completion evidence',
            ],
        work_category_code: fixture.workCategoryCode,
        region_code: regionCode,
        rough_location: 'Synthetic XQ service area',
        risk_level: trade ? 'MEDIUM' : 'LOW',
        requires_proof: true,
      },
      line_items: [
        {
          description: trade ? 'Licensed valve replacement' : 'Yard service labor',
          quantity: 1,
          unit_amount_cents: trade ? 18_000 : 10_000,
          total_amount_cents: trade ? 18_000 : 10_000,
        },
      ],
      customer_total_cents: trade ? 18_000 : 10_000,
      provider_payout_cents: trade ? 14_000 : 8_000,
      currency: 'USD',
      idempotency_key: `estimate-submit:${fixture.quoteId}`,
    };
  }

  function acceptanceCommand(
    fixture: EstimateLaneFixture,
    submission: {
      provider_estimate_submission_id: string;
      quote_version_id: string;
    }
  ): AcceptUniversalV1ProviderEstimate {
    return {
      task_draft_id: fixture.draftId,
      provider_estimate_submission_id: submission.provider_estimate_submission_id,
      quote_id: fixture.quoteId,
      quote_version_id: submission.quote_version_id,
      poster_user_id: fixture.posterUserId,
      actor_user_id: fixture.posterUserId,
      expected_draft_version: fixture.routeVersion,
      idempotency_key: `estimate-accept:${fixture.draftId}`,
    };
  }

  function estimateService(
    randomUuidFn: () => string = randomUUID,
    databaseOverride: Database = database
  ): UniversalV1EstimateService {
    return new UniversalV1EstimateService(
      new PostgresUniversalV1EstimateRepository(databaseOverride, randomUuidFn)
    );
  }

  function workOrderService(
    databaseOverride: Database = database
  ): UniversalV1WorkOrderApplication {
    const authority = localFakeFinanceAuthority();
    const query: QueryFn = async <Row = Record<string, unknown>>(sql: string, params?: unknown[]) =>
      databaseOverride.query<Row>(sql, params);
    return new UniversalV1WorkOrderApplication(
      new PostgresUniversalV1WorkOrderPublicFactReader(query),
      new PostgresUniversalV1WorkOrderRepository(databaseOverride),
      () =>
        createUniversalV1FakeFinancialApplicationService(
          databaseOverride,
          authority.env,
          authority.release,
          authority.identity
        )
    );
  }

  function fulfillmentService(
    databaseOverride: Database = database
  ): UniversalV1FulfillmentApplication {
    const authority = localFakeFinanceAuthority();
    return new UniversalV1FulfillmentApplication(
      new PostgresUniversalV1FulfillmentRepository(databaseOverride),
      () =>
        createUniversalV1FakeFinancialApplicationService(
          databaseOverride,
          authority.env,
          authority.release,
          authority.identity
        )
    );
  }

  function executionService(
    databaseOverride: Database = database
  ): UniversalV1ExecutionApplication {
    return new UniversalV1ExecutionApplication(
      new PostgresUniversalV1ExecutionRepository(databaseOverride)
    );
  }

  function databaseRejectingWorkOrderInsert(): Database {
    return {
      ...database,
      serializableTransaction: <T>(callback: (query: QueryFn) => Promise<T>) =>
        runTransaction(' ISOLATION LEVEL SERIALIZABLE', async (query) => {
          const rejectingQuery: QueryFn = async <Row = Record<string, unknown>>(
            sql: string,
            params?: unknown[]
          ) => {
            if (/^\s*INSERT\s+INTO\s+task_work_orders\b/iu.test(sql)) {
              throw Object.assign(new Error('INJECTED_WORK_ORDER_INSERT_FAILURE'), {
                code: 'XX999',
              });
            }
            return query<Row>(sql, params);
          };
          return callback(rejectingQuery);
        }),
    };
  }

  async function acceptedWorkOrderLane(kind: 'yard' | 'plumbing' = 'yard') {
    const fixture = await estimateLaneFixture(kind);
    const service = estimateService();
    const submitted = await service.submitProviderEstimate(submissionCommand(fixture));
    const accepted = await service.acceptProviderEstimate(acceptanceCommand(fixture, submitted));
    const scope = await pool.query<{ version: number }>(
      'SELECT version FROM task_scope_versions WHERE id = $1',
      [accepted.scope_version_id]
    );
    return {
      fixture,
      submitted,
      accepted,
      scopeVersion: scope.rows[0]!.version,
    };
  }

  async function heldWorkOrderLane(kind: 'yard' | 'plumbing' = 'yard') {
    const lane = await acceptedWorkOrderLane(kind);
    const application = workOrderService();
    const interest = await application.expressProviderInterest(
      lane.fixture.provider.actor_user_id,
      {
        task_id: lane.accepted.task_id,
        expected_scope_version: lane.scopeVersion,
        idempotency_key: `workorder-interest:${lane.accepted.task_id}`,
        client_ts: new Date().toISOString(),
      }
    );
    const hold = await application.placeConditionalHold(lane.fixture.posterUserId, {
      interest_application_id: interest.interest_application_id,
      expected_eligibility_version: interest.eligibility_version,
      idempotency_key: `workorder-hold:${lane.accepted.task_id}`,
      client_ts: new Date().toISOString(),
    });
    return { ...lane, application, interest, hold };
  }

  function financialOperationIds(idempotencyKey: string): string[] {
    return ['prepare', 'authorize', 'secure'].map((label) =>
      deterministicUuid(idempotencyKey, label)
    );
  }

  async function workOrderEffectSnapshot(input: {
    draftId: string;
    taskId: string;
    interestId: string;
    holdId: string;
    idempotencyKey: string;
  }) {
    const result = await pool.query<{
      worker_id: string | null;
      task_work_order_id: string | null;
      work_orders: number;
      witnesses: number;
      security_events: number;
      fake_operations: number;
      fake_operation_events: number;
      approved_provider_operations: number;
      non_fake_security_events: number;
      non_fake_external_references: number;
      escrows: number;
      quote_payments: number;
      interest_status: string;
      hold_status: string;
      security_event_kinds: string[] | null;
      security_event_providers: string[] | null;
    }>(
      `SELECT task.worker_id, task.work_order_id AS task_work_order_id,
              (SELECT COUNT(*)::integer FROM task_work_orders work_order
                WHERE work_order.task_id = $2
                  AND work_order.idempotency_key = $5) AS work_orders,
              (SELECT COUNT(*)::integer FROM task_work_order_command_requests request
                WHERE request.task_id = $2
                  AND request.idempotency_key = $5) AS witnesses,
              (SELECT COUNT(*)::integer FROM task_financial_security_events event
                WHERE event.task_id = $2
                  AND event.idempotency_key LIKE $5 || ':%') AS security_events,
              (SELECT COUNT(*)::integer FROM hxos_fake_financial_operations_v1 operation
                WHERE operation.operation_id = ANY($6::uuid[])) AS fake_operations,
              (SELECT COUNT(*)::integer FROM hxos_fake_financial_operation_events_v1 event
                WHERE event.operation_id = ANY($6::uuid[])) AS fake_operation_events,
              (SELECT COUNT(*)::integer FROM task_financial_operations operation
                WHERE operation.task_id = $2
                  AND operation.operation_id::uuid = ANY($6::uuid[])
                  AND operation.provider_kind = 'APPROVED_PROVIDER')
                AS approved_provider_operations,
              (SELECT COUNT(*)::integer FROM task_financial_security_events event
                WHERE event.task_id = $2
                  AND event.idempotency_key LIKE $5 || ':%'
                  AND event.provider_kind <> 'FAKE') AS non_fake_security_events,
              (SELECT COUNT(*)::integer FROM task_financial_security_events event
                WHERE event.task_id = $2
                  AND event.idempotency_key LIKE $5 || ':%'
                  AND event.external_reference !~ '^fake_[a-z_]+_[0-9a-f]{24}$')
                AS non_fake_external_references,
              (SELECT COUNT(*)::integer FROM escrows escrow
                WHERE escrow.task_id = $2) AS escrows,
              (SELECT COUNT(*)::integer FROM quote_payments payment
                WHERE payment.task_id = $2) AS quote_payments,
              application.status AS interest_status,
              reservation.status AS hold_status,
              (SELECT ARRAY_AGG(event.event_kind ORDER BY event.expected_version)
                 FROM task_financial_security_events event
                WHERE event.task_id = $2
                  AND event.idempotency_key LIKE $5 || ':%') AS security_event_kinds,
              (SELECT ARRAY_AGG(DISTINCT event.provider_kind ORDER BY event.provider_kind)
                 FROM task_financial_security_events event
                WHERE event.task_id = $2
                  AND event.idempotency_key LIKE $5 || ':%') AS security_event_providers
         FROM tasks task
         JOIN task_drafts draft ON draft.id = $1 AND draft.task_id = task.id
         JOIN task_applications application ON application.id = $3
         JOIN task_reservations reservation ON reservation.id = $4
        WHERE task.id = $2`,
      [
        input.draftId,
        input.taskId,
        input.interestId,
        input.holdId,
        input.idempotencyKey,
        financialOperationIds(input.idempotencyKey),
      ]
    );
    return result.rows[0];
  }

  async function scopeOnlyChangeOrderSnapshot(input: {
    taskId: string;
    workOrderId: string;
    proposalId: string;
  }) {
    const result = await pool.query<{
      worker_id: string | null;
      active_scope_version_id: string;
      customer_total_cents: number;
      provider_payout_cents: number;
      currency: string;
      proposal_status: string;
      scopes: number;
      approved_change_scopes: number;
      latest_scope_version: number;
      approvals: number;
      distinct_approval_actors: number;
      amendments: number;
      amendment_adjustments: number;
      latest_amendment_version: number;
      execution_facts: number;
      apply_amendment_facts: number;
      latest_execution_version: number;
      latest_execution_state: string;
      latest_execution_transition: string;
      latest_execution_scope_version_id: string;
      financial_events: number;
      adjustment_events: number;
      latest_financial_version: number;
    }>(
      `SELECT task.worker_id,
              task.active_scope_version_id,
              task.price::integer AS customer_total_cents,
              task.hustler_payout_cents::integer AS provider_payout_cents,
              upper(task.currency) AS currency,
              proposal.status AS proposal_status,
              (SELECT COUNT(*)::integer FROM task_scope_versions scope
                WHERE scope.task_id = task.id) AS scopes,
              (SELECT COUNT(*)::integer FROM task_scope_versions scope
                WHERE scope.task_id = task.id
                  AND scope.source = 'APPROVED_CHANGE') AS approved_change_scopes,
              (SELECT MAX(scope.version)::integer FROM task_scope_versions scope
                WHERE scope.task_id = task.id) AS latest_scope_version,
              (SELECT COUNT(*)::integer FROM task_scope_change_approvals approval
                WHERE approval.proposal_id = proposal.id) AS approvals,
              (SELECT COUNT(DISTINCT approval.actor_id)::integer
                 FROM task_scope_change_approvals approval
                WHERE approval.proposal_id = proposal.id) AS distinct_approval_actors,
              (SELECT COUNT(*)::integer FROM task_work_order_amendments amendment
                WHERE amendment.work_order_id = $2) AS amendments,
              (SELECT COUNT(*)::integer FROM task_work_order_amendments amendment
                WHERE amendment.work_order_id = $2
                  AND amendment.adjustment_event_id IS NOT NULL) AS amendment_adjustments,
              COALESCE((SELECT MAX(amendment.amendment_version)::integer
                          FROM task_work_order_amendments amendment
                         WHERE amendment.work_order_id = $2), 0) AS latest_amendment_version,
              (SELECT COUNT(*)::integer FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $2) AS execution_facts,
              (SELECT COUNT(*)::integer FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $2
                  AND execution.transition_kind = 'APPLY_AMENDMENT') AS apply_amendment_facts,
              (SELECT execution.execution_version
                 FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $2
                ORDER BY execution.execution_version DESC
                LIMIT 1) AS latest_execution_version,
              (SELECT execution.state
                 FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $2
                ORDER BY execution.execution_version DESC
                LIMIT 1) AS latest_execution_state,
              (SELECT execution.transition_kind
                 FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $2
                ORDER BY execution.execution_version DESC
                LIMIT 1) AS latest_execution_transition,
              (SELECT execution.scope_version_id
                 FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $2
                ORDER BY execution.execution_version DESC
                LIMIT 1) AS latest_execution_scope_version_id,
              (SELECT COUNT(*)::integer FROM task_financial_security_events financial
                WHERE financial.task_id = task.id) AS financial_events,
              (SELECT COUNT(*)::integer FROM task_financial_security_events financial
                WHERE financial.task_id = task.id
                  AND financial.change_order_id = proposal.id) AS adjustment_events,
              (SELECT MAX(financial.expected_version)::integer
                 FROM task_financial_security_events financial
                WHERE financial.task_id = task.id) AS latest_financial_version
         FROM tasks task
         JOIN task_scope_change_proposals proposal ON proposal.task_id = task.id
        WHERE task.id = $1
          AND task.work_order_id = $2
          AND proposal.id = $3`,
      [input.taskId, input.workOrderId, input.proposalId]
    );
    return result.rows[0]!;
  }

  async function zeroEffectSnapshot(draftId: string, taskId: string) {
    const result = await pool.query<{
      escrows: number;
      financial_operations: number;
      financial_security_events: number;
      reservations: number;
      work_orders: number;
      applications: number;
      quote_payments: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM escrows WHERE task_id = $2) AS escrows,
         (SELECT COUNT(*)::integer FROM task_financial_operations
           WHERE task_draft_id = $1 OR task_id = $2) AS financial_operations,
         (SELECT COUNT(*)::integer FROM task_financial_security_events
           WHERE task_draft_id = $1 OR task_id = $2) AS financial_security_events,
         (SELECT COUNT(*)::integer FROM task_reservations WHERE task_id = $2) AS reservations,
         (SELECT COUNT(*)::integer FROM task_work_orders
           WHERE task_draft_id = $1 OR task_id = $2) AS work_orders,
         (SELECT COUNT(*)::integer FROM task_applications WHERE task_id = $2) AS applications,
         (SELECT COUNT(*)::integer FROM quote_payments payment
           JOIN quotes quote ON quote.id = payment.quote_id
          WHERE quote.task_draft_id = $1) AS quote_payments`,
      [draftId, taskId]
    );
    return result.rows[0];
  }

  async function unmaterializedSnapshot(fixture: EstimateLaneFixture) {
    const result = await pool.query<{
      task_id: string | null;
      active_route_id: string;
      route_outcome: string;
      quote_task_id: string | null;
      quote_status: string;
      tasks: number;
      scopes: number;
      materializations: number;
      financial_operations: number;
      financial_security_events: number;
      work_orders: number;
      escrows: number;
    }>(
      `SELECT draft.task_id,
              draft.active_routing_decision_id AS active_route_id,
              route.outcome AS route_outcome,
              quote.task_id AS quote_task_id,
              quote.status AS quote_status,
              (SELECT COUNT(*)::integer FROM tasks task
                WHERE task.poster_id = draft.poster_user_id
                  AND task.created_at >= draft.created_at) AS tasks,
              (SELECT COUNT(*)::integer FROM task_scope_versions scope
                JOIN tasks task ON task.id = scope.task_id
               WHERE task.poster_id = draft.poster_user_id
                 AND task.created_at >= draft.created_at) AS scopes,
              (SELECT COUNT(*)::integer FROM task_estimate_acceptance_materializations fact
                WHERE fact.task_draft_id = draft.id) AS materializations,
              (SELECT COUNT(*)::integer FROM task_financial_operations operation
                WHERE operation.task_draft_id = draft.id) AS financial_operations,
              (SELECT COUNT(*)::integer FROM task_financial_security_events event
                WHERE event.task_draft_id = draft.id) AS financial_security_events,
              (SELECT COUNT(*)::integer FROM task_work_orders work_order
                WHERE work_order.task_draft_id = draft.id) AS work_orders,
              (SELECT COUNT(*)::integer FROM escrows escrow
                JOIN tasks task ON task.id = escrow.task_id
               WHERE task.poster_id = draft.poster_user_id
                 AND task.created_at >= draft.created_at) AS escrows
         FROM task_drafts draft
         JOIN task_routing_decisions route ON route.id = draft.active_routing_decision_id
         JOIN quotes quote ON quote.id = $2
        WHERE draft.id = $1`,
      [fixture.draftId, fixture.quoteId]
    );
    return result.rows[0];
  }

  async function invitationCounts(eligibilityDecisionId: string): Promise<{
    invitations: number;
    quotes: number;
  }> {
    const result = await pool.query<{ invitations: number; quotes: number }>(
      `SELECT COUNT(*)::integer AS invitations,
              COUNT(quote.id)::integer AS quotes
         FROM task_provider_estimate_invitations invitation
         LEFT JOIN quotes quote ON quote.id = invitation.quote_id
        WHERE invitation.eligibility_decision_id = $1`,
      [eligibilityDecisionId]
    );
    return result.rows[0]!;
  }

  it('denies direct deterministic invitation insertion and rolls back its quote shell', async () => {
    const provider = await generalProviderFixture();
    const draft = await claimedDraftFixture('yard', 'Deterministic invitation denial');
    const prepared = await prepareInvitationAuthority(
      draft.draftId,
      draft.routeId,
      provider,
      'yard'
    );
    const quoteId = randomUUID();
    await expect(
      transaction(async (query) => {
        await query(
          `INSERT INTO quotes(
           id, task_draft_id, title, status, created_by, quote_kind,
           provider_user_id, provider_organization_id, routing_decision_id
         ) VALUES ($1, $2, 'Denied deterministic shell', 'draft',
                   'deterministic-policy-test', 'PROVIDER_ESTIMATE', $3, NULL, $4)`,
          [quoteId, draft.draftId, provider.provider_user_id, draft.routeId]
        );
        await query(
          `INSERT INTO task_provider_estimate_invitations(
           eligibility_decision_id, quote_id, decision_authority, decided_by,
           authority_policy_version, valid_until, idempotency_key
         ) VALUES ($1, $2, 'DETERMINISTIC_POLICY', NULL,
                   'disabled-policy-test-v1', $3, $4)`,
          [
            prepared.eligibilityDecisionId,
            quoteId,
            prepared.invitationValidUntil,
            `deterministic-denied:${prepared.eligibilityDecisionId}`,
          ]
        );
      })
    ).rejects.toMatchObject({ code: expect.stringMatching(/23514|P0001/u) });
    expect(await invitationCounts(prepared.eligibilityDecisionId)).toEqual({
      invitations: 0,
      quotes: 0,
    });
    expect(
      (await pool.query('SELECT COUNT(*)::integer AS count FROM quotes WHERE id = $1', [quoteId]))
        .rows[0]?.count
    ).toBe(0);
  });

  it.each([
    ['inactive', `account_status = 'SUSPENDED'`, 'users'],
    ['minor', 'is_minor = TRUE', 'users'],
    ['banned', 'is_banned = TRUE', 'users'],
    ['capability-less', 'can_manage_operations = FALSE', 'admin_roles'],
  ] as const)(
    'denies a %s named operator without leaving an orphan quote or invitation',
    async (_label, mutation, table) => {
      const provider = await generalProviderFixture();
      const draft = await claimedDraftFixture('yard', `Denied operator ${_label}`);
      const prepared = await prepareInvitationAuthority(
        draft.draftId,
        draft.routeId,
        provider,
        'yard'
      );
      await pool.query(
        `UPDATE ${table} SET ${mutation} WHERE ${table === 'users' ? 'id' : 'user_id'} = $1`,
        [prepared.invitationOperatorUserId]
      );
      await expect(
        estimateService().issueProviderEstimateInvitation({
          eligibility_decision_id: prepared.eligibilityDecisionId,
          expected_draft_version: draft.routeVersion,
          expected_eligibility_version: 1,
          actor_user_id: prepared.invitationOperatorUserId,
          idempotency_key: prepared.invitationIdempotencyKey,
        })
      ).rejects.toMatchObject({
        code: expect.stringMatching(/ESTIMATE_INVITATION_OPERATOR_NOT_AUTHORIZED|P0001/u),
      });
      expect(await invitationCounts(prepared.eligibilityDecisionId)).toEqual({
        invitations: 0,
        quotes: 0,
      });
      const orphan = await pool.query<{ count: number }>(
        `SELECT COUNT(*)::integer AS count FROM quotes WHERE created_by = $1`,
        [`universal-v1-named-operator:${prepared.invitationOperatorUserId}`]
      );
      expect(orphan.rows[0]?.count).toBe(0);
    }
  );

  it.each(['OWNER', 'ADMIN'] as const)(
    'allows an organization %s to submit commercial estimate pricing',
    async (role) => {
      const fixture = await estimateLaneFixture('plumbing');
      let actorUserId = fixture.provider.provider_user_id;
      if (role === 'ADMIN') {
        actorUserId = await userFixture('worker');
        await pool.query(
          `INSERT INTO business_memberships(
             organization_id, user_id, role, status, invited_by, accepted_at
           ) VALUES ($1, $2, 'ADMIN', 'ACTIVE', $3, clock_timestamp())`,
          [
            fixture.provider.provider_organization_id,
            actorUserId,
            fixture.provider.provider_user_id,
          ]
        );
      }
      await expect(
        estimateService().submitProviderEstimate({
          ...submissionCommand(fixture),
          provider: {
            actor_user_id: actorUserId,
            provider_user_id: fixture.provider.provider_user_id,
            provider_organization_id: fixture.provider.provider_organization_id,
          },
          idempotency_key: `estimate-${role.toLowerCase()}:${fixture.quoteId}`,
        })
      ).resolves.toMatchObject({ replayed: false, payment_creation_performed: false });
    }
  );

  it.each(['DISPATCHER', 'CREW', 'VIEWER'] as const)(
    'denies organization %s commercial estimate pricing',
    async (role) => {
      const fixture = await estimateLaneFixture('plumbing');
      const actorUserId = await userFixture('worker');
      await pool.query(
        `INSERT INTO business_memberships(
           organization_id, user_id, role, status, invited_by, accepted_at
         ) VALUES ($1, $2, $3, 'ACTIVE', $4, clock_timestamp())`,
        [
          fixture.provider.provider_organization_id,
          actorUserId,
          role,
          fixture.provider.provider_user_id,
        ]
      );
      await expect(
        estimateService().submitProviderEstimate({
          ...submissionCommand(fixture),
          provider: {
            actor_user_id: actorUserId,
            provider_user_id: fixture.provider.provider_user_id,
            provider_organization_id: fixture.provider.provider_organization_id,
          },
          idempotency_key: `estimate-denied-${role.toLowerCase()}:${fixture.quoteId}`,
        })
      ).rejects.toMatchObject({ code: 'ESTIMATE_PROVIDER_NOT_AUTHORIZED' });
      const state = await pool.query<{ versions: number; submissions: number }>(
        `SELECT (SELECT COUNT(*)::integer FROM quote_versions WHERE quote_id = $1) AS versions,
                (SELECT COUNT(*)::integer FROM provider_estimate_submissions
                  WHERE quote_id = $1) AS submissions`,
        [fixture.quoteId]
      );
      expect(state.rows[0]).toEqual({ versions: 0, submissions: 0 });
    }
  );

  it('serializes two named operators racing for one eligibility into one invitation and quote', async () => {
    const provider = await generalProviderFixture();
    const draft = await claimedDraftFixture('yard', 'Concurrent invitation issuance');
    const prepared = await prepareInvitationAuthority(
      draft.draftId,
      draft.routeId,
      provider,
      'yard'
    );
    const secondOperator = await userFixture('poster');
    await pool.query(
      `INSERT INTO admin_roles(user_id, role, can_manage_operations)
       VALUES ($1, 'support', TRUE)`,
      [secondOperator]
    );
    const issue = (actor_user_id: string, suffix: string) =>
      estimateService().issueProviderEstimateInvitation({
        eligibility_decision_id: prepared.eligibilityDecisionId,
        expected_draft_version: draft.routeVersion,
        expected_eligibility_version: 1,
        actor_user_id,
        idempotency_key: `estimate-race-${suffix}:${prepared.eligibilityDecisionId}`,
      });
    const outcomes = await Promise.allSettled([
      issue(prepared.invitationOperatorUserId, 'one'),
      issue(secondOperator, 'two'),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await invitationCounts(prepared.eligibilityDecisionId)).toEqual({
      invitations: 1,
      quotes: 1,
    });
    const shells = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
         FROM quotes
        WHERE created_by = ANY($1::text[])`,
      [
        [
          `universal-v1-named-operator:${prepared.invitationOperatorUserId}`,
          `universal-v1-named-operator:${secondOperator}`,
        ],
      ]
    );
    expect(shells.rows[0]?.count).toBe(1);
  });

  it.each(['operator-capability', 'provider-membership', 'organization', 'credential'] as const)(
    'observes %s revocation committed ahead of the shared eligibility lock',
    async (target) => {
      const trade = target !== 'operator-capability';
      const provider = trade
        ? await verifiedTradeProviderFixture()
        : await generalProviderFixture();
      const draft = await claimedDraftFixture(
        trade ? 'handyman' : 'yard',
        `Invitation revocation race ${target}`
      );
      const route = trade
        ? await normalizeTradeRoute(draft)
        : { routeId: draft.routeId, routeVersion: draft.routeVersion };
      const prepared = await prepareInvitationAuthority(
        draft.draftId,
        route.routeId,
        provider,
        trade ? 'plumbing' : 'yard'
      );
      if (target === 'provider-membership') {
        const remainingOwner = await userFixture('worker');
        await pool.query(
          `INSERT INTO business_memberships(
             organization_id, user_id, role, status, invited_by, accepted_at
           ) VALUES ($1, $2, 'OWNER', 'ACTIVE', $3, clock_timestamp())`,
          [provider.provider_organization_id, remainingOwner, provider.provider_user_id]
        );
      }

      const revoker = await pool.connect();
      try {
        await revoker.query('BEGIN');
        await revoker.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `eligibility:${draft.draftId}:${provider.provider_user_id}:${provider.provider_organization_id ?? 'individual'}`,
        ]);
        if (target === 'operator-capability') {
          await revoker.query(
            `UPDATE admin_roles SET can_manage_operations = FALSE WHERE user_id = $1`,
            [prepared.invitationOperatorUserId]
          );
        } else if (target === 'provider-membership') {
          await revoker.query(
            `UPDATE business_memberships SET status = 'REVOKED'
              WHERE organization_id = $1 AND user_id = $2`,
            [provider.provider_organization_id, provider.provider_user_id]
          );
        } else if (target === 'organization') {
          await revoker.query(
            `UPDATE business_organizations SET status = 'SUSPENDED' WHERE id = $1`,
            [provider.provider_organization_id]
          );
        } else {
          await revoker.query(`UPDATE business_credentials SET status = 'REVOKED' WHERE id = $1`, [
            provider.trade_credential_id,
          ]);
        }

        const issuing = estimateService().issueProviderEstimateInvitation({
          eligibility_decision_id: prepared.eligibilityDecisionId,
          expected_draft_version: route.routeVersion,
          expected_eligibility_version: 1,
          actor_user_id: prepared.invitationOperatorUserId,
          idempotency_key: prepared.invitationIdempotencyKey,
        });
        await revoker.query('COMMIT');
        await expect(issuing).rejects.toMatchObject({
          code: expect.stringMatching(
            /^(?:ESTIMATE_INVITATION_OPERATOR_NOT_AUTHORIZED|ESTIMATE_INVITATION_NOT_ALLOWED|P0001|40001)$/u
          ),
        });
      } catch (error) {
        await revoker.query('ROLLBACK');
        throw error;
      } finally {
        revoker.release();
      }
      expect(await invitationCounts(prepared.eligibilityDecisionId)).toEqual({
        invitations: 0,
        quotes: 0,
      });
    }
  );

  it('materializes one yard-work Task with exact replay, strict authority, and no money or assignment', async () => {
    const fixture = await estimateLaneFixture('yard');
    const command = submissionCommand(fixture);
    const service = estimateService();

    await expect(
      service.issueProviderEstimateInvitation({
        eligibility_decision_id: fixture.eligibilityDecisionId,
        expected_draft_version: fixture.routeVersion,
        expected_eligibility_version: 1,
        actor_user_id: fixture.invitationOperatorUserId,
        idempotency_key: fixture.invitationIdempotencyKey,
      })
    ).resolves.toMatchObject({
      invitation_id: fixture.invitationId,
      quote_id: fixture.quoteId,
      replayed: true,
      payment_creation_performed: false,
      financial_security_event_created: false,
      conditional_hold_created: false,
      hard_assignment_created: false,
      work_order_created: false,
      universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
    });
    await expect(
      service.issueProviderEstimateInvitation({
        eligibility_decision_id: fixture.eligibilityDecisionId,
        expected_draft_version: fixture.routeVersion,
        expected_eligibility_version: 2,
        actor_user_id: fixture.invitationOperatorUserId,
        idempotency_key: fixture.invitationIdempotencyKey,
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_INVITATION_IDEMPOTENCY_CONFLICT' });
    expect(await unmaterializedSnapshot(fixture)).toEqual({
      task_id: null,
      active_route_id: fixture.routeId,
      route_outcome: 'ESTIMATE_REQUIRED',
      quote_task_id: null,
      quote_status: 'draft',
      tasks: 0,
      scopes: 0,
      materializations: 0,
      financial_operations: 0,
      financial_security_events: 0,
      work_orders: 0,
      escrows: 0,
    });
    const invitationOnly = await pool.query<{
      quote_versions: number;
      estimate_submissions: number;
      reservations: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM quote_versions WHERE quote_id = $1)
           AS quote_versions,
         (SELECT COUNT(*)::integer FROM provider_estimate_submissions WHERE quote_id = $1)
           AS estimate_submissions,
         (SELECT COUNT(*)::integer FROM task_reservations reservation
           JOIN tasks task ON task.id = reservation.task_id
          WHERE task.poster_id = $2) AS reservations`,
      [fixture.quoteId, fixture.posterUserId]
    );
    expect(invitationOnly.rows[0]).toEqual({
      quote_versions: 0,
      estimate_submissions: 0,
      reservations: 0,
    });

    await expect(
      pool.query(
        `INSERT INTO quotes(
         id, task_draft_id, title, status, created_by, quote_kind,
         provider_user_id, provider_organization_id, routing_decision_id
       ) VALUES (
         $1, $2, 'Uninvited provider estimate', 'draft', 'uninvited-system-test',
         'PROVIDER_ESTIMATE', $3, $4, $5
       )`,
        [
          randomUUID(),
          fixture.draftId,
          fixture.provider.provider_user_id,
          fixture.provider.provider_organization_id,
          fixture.routeId,
        ]
      )
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('HXUV1-INVITE-15'),
    });
    const missingShellCommand = { ...command, quote_id: randomUUID() };
    await expect(service.submitProviderEstimate(missingShellCommand)).rejects.toMatchObject({
      code: 'ESTIMATE_INVITATION_REQUIRED',
    });
    const wrongActor = await userFixture('worker');
    await expect(
      service.submitProviderEstimate({
        ...command,
        provider: { ...command.provider, actor_user_id: wrongActor },
        idempotency_key: `estimate-wrong-actor:${fixture.quoteId}`,
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_PROVIDER_NOT_AUTHORIZED' });
    const unauthorizedProvider = await userFixture('worker');
    await expect(
      service.submitProviderEstimate({
        ...command,
        provider: {
          actor_user_id: unauthorizedProvider,
          provider_user_id: unauthorizedProvider,
          provider_organization_id: null,
        },
        idempotency_key: `estimate-wrong-provider:${fixture.quoteId}`,
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_PROVIDER_NOT_AUTHORIZED' });
    const differentlyInvitedProvider = await generalProviderFixture();
    await expect(
      service.submitProviderEstimate({
        ...command,
        provider: {
          actor_user_id: differentlyInvitedProvider.actor_user_id,
          provider_user_id: differentlyInvitedProvider.provider_user_id,
          provider_organization_id: differentlyInvitedProvider.provider_organization_id,
        },
        idempotency_key: `estimate-wrong-invitation:${fixture.quoteId}`,
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_INVITATION_REQUIRED' });
    await expect(
      service.submitProviderEstimate({
        ...command,
        expected_draft_version: fixture.routeVersion + 1,
        idempotency_key: `estimate-stale-route:${fixture.quoteId}`,
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_ROUTE_NOT_ACTIVE' });
    await expect(
      service.submitProviderEstimate({
        ...command,
        expected_quote_version: 1,
        idempotency_key: `estimate-stale-quote:${fixture.quoteId}`,
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_QUOTE_VERSION_CONFLICT' });

    const submitted = await service.submitProviderEstimate(command);
    expect(submitted).toMatchObject({
      replayed: false,
      quote_version: 1,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    await expect(service.submitProviderEstimate(command)).resolves.toMatchObject({
      provider_estimate_submission_id: submitted.provider_estimate_submission_id,
      quote_version_id: submitted.quote_version_id,
      request_sha256: submitted.request_sha256,
      replayed: true,
    });
    await expect(
      service.submitProviderEstimate({
        ...command,
        customer_total_cents: command.customer_total_cents + 1,
        line_items: [
          {
            ...command.line_items[0]!,
            unit_amount_cents: 10_001,
            total_amount_cents: 10_001,
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_IDEMPOTENCY_CONFLICT' });

    const acceptance = acceptanceCommand(fixture, submitted);
    const wrongOwner = await userFixture('poster');
    await expect(
      service.acceptProviderEstimate({
        ...acceptance,
        poster_user_id: wrongOwner,
        actor_user_id: wrongOwner,
        idempotency_key: `estimate-wrong-owner:${fixture.draftId}`,
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_ACCEPTANCE_NOT_ALLOWED' });
    await expect(
      service.acceptProviderEstimate({
        ...acceptance,
        expected_draft_version: fixture.routeVersion + 1,
        idempotency_key: `estimate-stale-accept:${fixture.draftId}`,
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_ACCEPTANCE_VERSION_CONFLICT' });

    const accepted = await service.acceptProviderEstimate(acceptance);
    expect(accepted).toMatchObject({
      replayed: false,
      resulting_draft_version: fixture.routeVersion + 1,
      payment_creation_performed: false,
      escrow_created: false,
      hard_assignment_created: false,
      universal_payment_posture: 'PAYMENT_CREATION_FROZEN',
    });
    await expect(service.acceptProviderEstimate(acceptance)).resolves.toMatchObject({
      materialization_id: accepted.materialization_id,
      task_id: accepted.task_id,
      scope_version_id: accepted.scope_version_id,
      resulting_routing_decision_id: accepted.resulting_routing_decision_id,
      replayed: true,
    });
    await expect(
      service.acceptProviderEstimate({
        ...acceptance,
        quote_version_id: randomUUID(),
      })
    ).rejects.toMatchObject({ code: 'ESTIMATE_ACCEPTANCE_IDEMPOTENCY_CONFLICT' });

    const authority = await pool.query<{
      draft_task_id: string;
      active_route_id: string;
      route_outcome: string;
      tasks: number;
      scopes: number;
      materializations: number;
      worker_id: string | null;
      work_order_id: string | null;
      payment_method: string;
      payment_posture: string;
      task_contract_version: number;
      quote_pay_token: string | null;
      quote_stripe_mode: string | null;
      quote_paid_at: Date | null;
      quote_expires_at: Date;
      acceptance_routes: number;
      invitations: number;
      eligibility_facts: number;
    }>(
      `SELECT draft.task_id AS draft_task_id,
              draft.active_routing_decision_id AS active_route_id,
              route.outcome AS route_outcome,
              (SELECT COUNT(*)::integer FROM tasks task WHERE task.id = draft.task_id) AS tasks,
              (SELECT COUNT(*)::integer FROM task_scope_versions scope
                WHERE scope.task_id = draft.task_id) AS scopes,
              (SELECT COUNT(*)::integer FROM task_estimate_acceptance_materializations fact
                WHERE fact.task_draft_id = draft.id) AS materializations,
              task.worker_id, task.work_order_id,
              task.payment_method, task.universal_payment_posture AS payment_posture,
              task.universal_contract_version AS task_contract_version,
              version.pay_token AS quote_pay_token,
              version.stripe_mode AS quote_stripe_mode,
              version.paid_at AS quote_paid_at,
              version.expires_at AS quote_expires_at,
              (SELECT COUNT(*)::integer FROM task_routing_decisions candidate
                WHERE candidate.task_draft_id = draft.id
                  AND candidate.supersedes_decision_id = $3
                  AND candidate.outcome = 'FULFILLMENT_CANDIDATE') AS acceptance_routes,
              (SELECT COUNT(*)::integer FROM task_provider_estimate_invitations invitation
                WHERE invitation.id = $4
                  AND invitation.quote_id = version.quote_id) AS invitations,
              (SELECT COUNT(*)::integer FROM task_provider_eligibility_decisions eligibility
                WHERE eligibility.id = $5
                  AND eligibility.task_draft_id = draft.id) AS eligibility_facts
         FROM task_drafts draft
         JOIN task_routing_decisions route ON route.id = draft.active_routing_decision_id
         JOIN tasks task ON task.id = draft.task_id
         JOIN quote_versions version ON version.id = $2
        WHERE draft.id = $1`,
      [
        fixture.draftId,
        submitted.quote_version_id,
        fixture.routeId,
        fixture.invitationId,
        fixture.eligibilityDecisionId,
      ]
    );
    expect(authority.rows[0]).toMatchObject({
      draft_task_id: accepted.task_id,
      active_route_id: accepted.resulting_routing_decision_id,
      route_outcome: 'FULFILLMENT_CANDIDATE',
      tasks: 1,
      scopes: 1,
      materializations: 1,
      worker_id: null,
      work_order_id: null,
      payment_method: 'universal_financial_security',
      payment_posture: 'PAYMENT_CREATION_FROZEN',
      task_contract_version: 1,
      quote_pay_token: null,
      quote_stripe_mode: null,
      quote_paid_at: null,
      quote_expires_at: fixture.invitationValidUntil,
      acceptance_routes: 1,
      invitations: 1,
      eligibility_facts: 1,
    });
    expect(await zeroEffectSnapshot(fixture.draftId, accepted.task_id)).toEqual({
      escrows: 0,
      financial_operations: 0,
      financial_security_events: 0,
      reservations: 0,
      work_orders: 0,
      applications: 0,
      quote_payments: 0,
    });

    await expect(
      pool.query(
        `UPDATE task_estimate_acceptance_materializations
          SET request_sha256 = $2
        WHERE id = $1`,
        [accepted.materialization_id, '0'.repeat(64)]
      )
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query('DELETE FROM task_estimate_acceptance_materializations WHERE id = $1', [
        accepted.materialization_id,
      ])
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query('TRUNCATE task_estimate_acceptance_materializations')
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query(
        `UPDATE task_provider_estimate_invitations
          SET valid_until = valid_until + INTERVAL '1 minute'
        WHERE id = $1`,
        [fixture.invitationId]
      )
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query('DELETE FROM task_provider_estimate_invitations WHERE id = $1', [
        fixture.invitationId,
      ])
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(pool.query('TRUNCATE task_provider_estimate_invitations')).rejects.toMatchObject({
      code: 'P0001',
    });
    await expect(
      pool.query(`UPDATE tasks SET universal_payment_posture = NULL WHERE id = $1`, [
        accepted.task_id,
      ])
    ).rejects.toMatchObject({ code: 'P0001' });
    await expect(
      pool.query(
        `INSERT INTO escrows(task_id, amount, state)
       VALUES ($1, 10000, 'PENDING')`,
        [accepted.task_id]
      )
    ).rejects.toMatchObject({ code: 'P0001' });
  });

  it('requires an exact current government-backed trade qualification before a plumbing estimate', async () => {
    const fixture = await estimateLaneFixture('plumbing');
    const command = submissionCommand(fixture);
    const service = estimateService();
    const individualProvider = await generalProviderFixture();
    await expect(
      quoteInvitation(
        fixture.draftId,
        fixture.routeId,
        fixture.routeVersion,
        individualProvider,
        'plumbing'
      )
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringMatching(/HXUV1-INVITE-(?:11|12)/u),
    });

    const submitted = await service.submitProviderEstimate(command);
    const accepted = await service.acceptProviderEstimate(acceptanceCommand(fixture, submitted));
    const state = await pool.query<{
      category: string;
      trade_type: string;
      location_state: string;
      license_required: boolean;
      insurance_required: boolean;
      background_check_required: boolean;
      worker_id: string | null;
      work_order_id: string | null;
      qualification_rows: number;
    }>(
      `SELECT task.category, task.trade_type, task.location_state,
              task.license_required, task.insurance_required,
              task.background_check_required, task.worker_id, task.work_order_id,
              (SELECT COUNT(*)::integer
                 FROM current_verified_trade_qualifications qualification
                 CROSS JOIN LATERAL unnest(qualification.permitted_work_categories) category
                WHERE qualification.provider_user_id = $2
                  AND qualification.organization_id = $3
                  AND qualification.jurisdiction_code = $4
                  AND category = 'plumbing') AS qualification_rows
         FROM tasks task
        WHERE task.id = $1`,
      [
        accepted.task_id,
        fixture.provider.provider_user_id,
        fixture.provider.provider_organization_id,
        regionCode,
      ]
    );
    expect(state.rows[0]).toEqual({
      category: 'plumbing',
      trade_type: 'plumbing',
      location_state: 'XQ',
      license_required: true,
      insurance_required: true,
      background_check_required: true,
      worker_id: null,
      work_order_id: null,
      qualification_rows: 1,
    });
    expect(await zeroEffectSnapshot(fixture.draftId, accepted.task_id)).toEqual({
      escrows: 0,
      financial_operations: 0,
      financial_security_events: 0,
      reservations: 0,
      work_orders: 0,
      applications: 0,
      quote_payments: 0,
    });
  });

  it('rejects an expired invitation before submission and again before customer acceptance', async () => {
    const expiredBeforeSubmission = await estimateLaneFixture('yard', 1_500);
    await pool.query('SELECT pg_sleep(1.7)');
    await expect(
      estimateService().submitProviderEstimate(submissionCommand(expiredBeforeSubmission))
    ).rejects.toMatchObject({ code: 'ESTIMATE_INVITATION_REQUIRED' });
    const absentVersion = await pool.query<{ versions: number; submissions: number }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM quote_versions WHERE quote_id = $1) AS versions,
         (SELECT COUNT(*)::integer FROM provider_estimate_submissions WHERE quote_id = $1)
           AS submissions`,
      [expiredBeforeSubmission.quoteId]
    );
    expect(absentVersion.rows[0]).toEqual({ versions: 0, submissions: 0 });

    const expiresBeforeAcceptance = await estimateLaneFixture('yard', 2_000);
    const service = estimateService();
    const submitted = await service.submitProviderEstimate(
      submissionCommand(expiresBeforeAcceptance)
    );
    await pool.query('SELECT pg_sleep(2.2)');
    await expect(
      service.acceptProviderEstimate(acceptanceCommand(expiresBeforeAcceptance, submitted))
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('HXUV1-INVITE-21'),
    });
    expect(await unmaterializedSnapshot(expiresBeforeAcceptance)).toEqual({
      task_id: null,
      active_route_id: expiresBeforeAcceptance.routeId,
      route_outcome: 'ESTIMATE_REQUIRED',
      quote_task_id: null,
      quote_status: 'estimate_submitted',
      tasks: 0,
      scopes: 0,
      materializations: 0,
      financial_operations: 0,
      financial_security_events: 0,
      work_orders: 0,
      escrows: 0,
    });
  });

  it('rolls acceptance back when a submitted trade credential is revoked or expires', async () => {
    for (const lapse of ['revoked', 'expired'] as const) {
      const fixture = await estimateLaneFixture('plumbing');
      const service = estimateService();
      const submitted = await service.submitProviderEstimate(submissionCommand(fixture));
      if (lapse === 'revoked') {
        await pool.query(`UPDATE business_credentials SET status = 'REVOKED' WHERE id = $1`, [
          fixture.provider.trade_credential_id,
        ]);
      } else {
        await pool.query(
          `UPDATE business_credentials
              SET expires_at = clock_timestamp() - INTERVAL '1 second'
            WHERE id = $1`,
          [fixture.provider.trade_credential_id]
        );
      }
      await expect(
        service.acceptProviderEstimate(acceptanceCommand(fixture, submitted))
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('HXUV1-INVITE-21'),
      });
      expect(await unmaterializedSnapshot(fixture)).toEqual({
        task_id: null,
        active_route_id: fixture.routeId,
        route_outcome: 'ESTIMATE_REQUIRED',
        quote_task_id: null,
        quote_status: 'estimate_submitted',
        tasks: 0,
        scopes: 0,
        materializations: 0,
        financial_operations: 0,
        financial_security_events: 0,
        work_orders: 0,
        escrows: 0,
      });
    }
  });

  it('materializes one fake-secured unassigned Work Order, replays exactly, and rejects changed-context reuse', async () => {
    const first = await heldWorkOrderLane('yard');
    const idempotencyKey = `workorder-materialize:${randomUUID()}`;
    const command = {
      conditional_hold_id: first.hold.conditional_hold_id,
      expected_eligibility_version: first.interest.eligibility_version,
      idempotency_key: idempotencyKey,
      client_ts: new Date().toISOString(),
    };

    const materialized = await first.application.secureAndMaterializeFakeWorkOrder(
      first.fixture.posterUserId,
      command
    );
    expect(materialized).toMatchObject({
      replayed: false,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });
    await expect(
      first.application.secureAndMaterializeFakeWorkOrder(first.fixture.posterUserId, {
        ...command,
        client_ts: new Date().toISOString(),
      })
    ).resolves.toEqual({ ...materialized, replayed: true });

    const committed = await workOrderEffectSnapshot({
      draftId: first.fixture.draftId,
      taskId: first.accepted.task_id,
      interestId: first.interest.interest_application_id,
      holdId: first.hold.conditional_hold_id,
      idempotencyKey,
    });
    expect(committed).toEqual({
      worker_id: null,
      task_work_order_id: materialized.work_order_id,
      work_orders: 1,
      witnesses: 1,
      security_events: 3,
      fake_operations: 3,
      fake_operation_events: 3,
      approved_provider_operations: 0,
      non_fake_security_events: 0,
      non_fake_external_references: 0,
      escrows: 0,
      quote_payments: 0,
      interest_status: 'expired',
      hold_status: 'RELEASED',
      security_event_kinds: ['PAYMENT_METHOD_PREPARED', 'AUTHORIZED', 'SECURED'],
      security_event_providers: ['FAKE'],
    });
    const exactBinding = await pool.query<{
      work_order_id: string;
      financial_security_event_id: string;
      event_kind: string;
      event_status: string;
      provider_kind: string;
      processor_payment_eligible: boolean;
      payout_funding_eligible: boolean;
    }>(
      `SELECT work_order.id AS work_order_id,
              work_order.financial_security_event_id,
              event.event_kind, event.status AS event_status, event.provider_kind,
              eligibility.processor_payment_eligible,
              eligibility.payout_funding_eligible
         FROM task_work_orders work_order
         JOIN task_financial_security_events event
           ON event.id = work_order.financial_security_event_id
         JOIN task_provider_eligibility_decisions eligibility
           ON eligibility.id = work_order.eligibility_decision_id
        WHERE work_order.id = $1`,
      [materialized.work_order_id]
    );
    expect(exactBinding.rows[0]).toEqual({
      work_order_id: materialized.work_order_id,
      financial_security_event_id: materialized.financial_security_event_id,
      event_kind: 'SECURED',
      event_status: 'SUCCEEDED',
      provider_kind: 'FAKE',
      processor_payment_eligible: false,
      payout_funding_eligible: false,
    });

    const second = await heldWorkOrderLane('yard');
    await expect(
      second.application.secureAndMaterializeFakeWorkOrder(second.fixture.posterUserId, {
        conditional_hold_id: second.hold.conditional_hold_id,
        expected_eligibility_version: second.interest.eligibility_version,
        idempotency_key: idempotencyKey,
        client_ts: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'WORK_ORDER_IDEMPOTENCY_CONFLICT' });
    expect(
      await workOrderEffectSnapshot({
        draftId: second.fixture.draftId,
        taskId: second.accepted.task_id,
        interestId: second.interest.interest_application_id,
        holdId: second.hold.conditional_hold_id,
        idempotencyKey,
      })
    ).toMatchObject({
      worker_id: null,
      task_work_order_id: null,
      work_orders: 0,
      witnesses: 0,
      security_events: 0,
      approved_provider_operations: 0,
      non_fake_security_events: 0,
      non_fake_external_references: 0,
      escrows: 0,
      quote_payments: 0,
      interest_status: 'pending',
      hold_status: 'ACTIVE',
      security_event_kinds: null,
      security_event_providers: null,
    });
    expect(
      await workOrderEffectSnapshot({
        draftId: first.fixture.draftId,
        taskId: first.accepted.task_id,
        interestId: first.interest.interest_application_id,
        holdId: first.hold.conditional_hold_id,
        idempotencyKey,
      })
    ).toEqual(committed);
  });

  it('preserves committed fake-finance evidence when terminal Work Order insertion fails', async () => {
    const lane = await heldWorkOrderLane('yard');
    const idempotencyKey = `workorder-rollback:${randomUUID()}`;
    const failingApplication = workOrderService(databaseRejectingWorkOrderInsert());

    await expect(
      failingApplication.secureAndMaterializeFakeWorkOrder(lane.fixture.posterUserId, {
        conditional_hold_id: lane.hold.conditional_hold_id,
        expected_eligibility_version: lane.interest.eligibility_version,
        idempotency_key: idempotencyKey,
        client_ts: new Date().toISOString(),
      })
    ).rejects.toMatchObject({
      code: 'XX999',
      message: 'INJECTED_WORK_ORDER_INSERT_FAILURE',
    });
    expect(
      await workOrderEffectSnapshot({
        draftId: lane.fixture.draftId,
        taskId: lane.accepted.task_id,
        interestId: lane.interest.interest_application_id,
        holdId: lane.hold.conditional_hold_id,
        idempotencyKey,
      })
    ).toEqual({
      worker_id: null,
      task_work_order_id: null,
      work_orders: 0,
      witnesses: 1,
      security_events: 3,
      fake_operations: 3,
      fake_operation_events: 3,
      approved_provider_operations: 0,
      non_fake_security_events: 0,
      non_fake_external_references: 0,
      escrows: 0,
      quote_payments: 0,
      interest_status: 'pending',
      hold_status: 'ACTIVE',
      security_event_kinds: [
        'PAYMENT_METHOD_PREPARED',
        'AUTHORIZED',
        'SECURED',
      ],
      security_event_providers: ['FAKE'],
    });
  });

  it('rejects Work Order materialization after provider authority is revoked with zero financial effects', async () => {
    const lane = await heldWorkOrderLane('yard');
    const idempotencyKey = `workorder-revoked:${randomUUID()}`;
    await pool.query('UPDATE users SET is_banned = TRUE WHERE id = $1', [
      lane.fixture.provider.provider_user_id,
    ]);

    await expect(
      lane.application.secureAndMaterializeFakeWorkOrder(lane.fixture.posterUserId, {
        conditional_hold_id: lane.hold.conditional_hold_id,
        expected_eligibility_version: lane.interest.eligibility_version,
        idempotency_key: idempotencyKey,
        client_ts: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'WORK_ORDER_AUTHORITY_REVOKED' });
    expect(
      await workOrderEffectSnapshot({
        draftId: lane.fixture.draftId,
        taskId: lane.accepted.task_id,
        interestId: lane.interest.interest_application_id,
        holdId: lane.hold.conditional_hold_id,
        idempotencyKey,
      })
    ).toEqual({
      worker_id: null,
      task_work_order_id: null,
      work_orders: 0,
      witnesses: 0,
      security_events: 0,
      fake_operations: 0,
      fake_operation_events: 0,
      approved_provider_operations: 0,
      non_fake_security_events: 0,
      non_fake_external_references: 0,
      escrows: 0,
      quote_payments: 0,
      interest_status: 'pending',
      hold_status: 'ACTIVE',
      security_event_kinds: null,
      security_event_providers: null,
    });
  });

  it('rolls every materialization write back when the final immutable fact violates a database constraint', async () => {
    const acceptedFixture = await estimateLaneFixture('yard');
    const acceptedService = estimateService();
    const acceptedSubmission = await acceptedService.submitProviderEstimate(
      submissionCommand(acceptedFixture)
    );
    const accepted = await acceptedService.acceptProviderEstimate(
      acceptanceCommand(acceptedFixture, acceptedSubmission)
    );

    const rollbackFixture = await estimateLaneFixture('yard');
    const rollbackSubmission = await acceptedService.submitProviderEstimate(
      submissionCommand(rollbackFixture)
    );
    const generatedIds = [accepted.materialization_id, randomUUID(), randomUUID(), randomUUID()];
    const rollbackService = estimateService(() => generatedIds.shift() ?? randomUUID());
    await expect(
      rollbackService.acceptProviderEstimate(acceptanceCommand(rollbackFixture, rollbackSubmission))
    ).rejects.toMatchObject({ code: '23505' });

    const rolledBack = await pool.query<{
      task_id: string | null;
      active_route_id: string;
      route_outcome: string;
      quote_task_id: string | null;
      quote_status: string;
      tasks: number;
      scopes: number;
      materializations: number;
    }>(
      `SELECT draft.task_id,
              draft.active_routing_decision_id AS active_route_id,
              route.outcome AS route_outcome,
              quote.task_id AS quote_task_id,
              quote.status AS quote_status,
              (SELECT COUNT(*)::integer FROM tasks task
                WHERE task.poster_id = draft.poster_user_id
                  AND task.created_at >= draft.created_at) AS tasks,
              (SELECT COUNT(*)::integer FROM task_scope_versions scope
                JOIN tasks task ON task.id = scope.task_id
               WHERE task.poster_id = draft.poster_user_id
                 AND task.created_at >= draft.created_at) AS scopes,
              (SELECT COUNT(*)::integer FROM task_estimate_acceptance_materializations fact
                WHERE fact.task_draft_id = draft.id) AS materializations
         FROM task_drafts draft
         JOIN task_routing_decisions route ON route.id = draft.active_routing_decision_id
         JOIN quotes quote ON quote.id = $2
        WHERE draft.id = $1`,
      [rollbackFixture.draftId, rollbackFixture.quoteId]
    );
    expect(rolledBack.rows[0]).toEqual({
      task_id: null,
      active_route_id: rollbackFixture.routeId,
      route_outcome: 'ESTIMATE_REQUIRED',
      quote_task_id: null,
      quote_status: 'estimate_submitted',
      tasks: 0,
      scopes: 0,
      materializations: 0,
    });
  });

  it('materializes and replays one dual-approved scope-only change on the exact execution chain', async () => {
    const lane = await heldWorkOrderLane('yard');
    const workOrder = await lane.application.secureAndMaterializeFakeWorkOrder(
      lane.fixture.posterUserId,
      {
        conditional_hold_id: lane.hold.conditional_hold_id,
        expected_eligibility_version: lane.interest.eligibility_version,
        idempotency_key: `workorder-scope-change:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    const execution = executionService();
    const genesis = await execution.getWorkOrderExecutionState(
      lane.fixture.provider.actor_user_id,
      { work_order_id: workOrder.work_order_id }
    );
    const acknowledged = await execution.advanceWorkOrderExecution(
      lane.fixture.provider.actor_user_id,
      {
        work_order_id: workOrder.work_order_id,
        action: 'ACKNOWLEDGE',
        expected_execution_version: genesis.execution_version,
        expected_scope_version: lane.scopeVersion,
        idempotency_key: `scope-change-acknowledge:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    expect(acknowledged).toMatchObject({
      execution_version: 2,
      state: 'ACKNOWLEDGED',
      transition_kind: 'ACKNOWLEDGE',
    });

    let financeAuthorizationCalls = 0;
    const changeOrders = new UniversalV1ChangeOrderApplication(
      new PostgresUniversalV1ChangeOrderRepository(database),
      () => {
        financeAuthorizationCalls += 1;
        throw new Error('Scope-only change orders must not authorize a financial provider.');
      }
    );
    const proposal = await changeOrders.proposeChangeOrder(lane.fixture.posterUserId, {
      work_order_id: workOrder.work_order_id,
      expected_scope_version: lane.scopeVersion,
      expected_amendment_version: 0,
      expected_latest_proposal_version: 0,
      observed_scope_summary: 'Add leaf bagging to the exact accepted yard-work scope.',
      proposed_scope: {
        title: 'Yard cleanup with leaf bagging',
        description:
          'Complete the accepted yard cleanup and bag the collected leaves for customer disposal.',
        requirements: 'Use customer-designated bags and keep all work inside the marked yard.',
        checklist: [
          'Complete the accepted yard cleanup',
          'Bag the collected leaves',
          'Place filled bags at the customer-designated location',
        ],
      },
      change_order_kind: 'SCOPE_ONLY',
      idempotency_key: `scope-change-proposal:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    expect(proposal).toMatchObject({
      proposal_version: 1,
      change_order_kind: 'SCOPE_ONLY',
      proposer_party: 'CUSTOMER',
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });

    const providerApproval = await changeOrders.decideChangeOrder(
      lane.fixture.provider.actor_user_id,
      {
        proposal_id: proposal.proposal_id,
        expected_proposal_version: proposal.proposal_version,
        decision: 'APPROVED',
        reason: 'Provider approves the exact replacement scope.',
        idempotency_key: `scope-change-provider-approval:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    const customerApproval = await changeOrders.decideChangeOrder(lane.fixture.posterUserId, {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: proposal.proposal_version,
      decision: 'APPROVED',
      reason: 'Customer approves the exact replacement scope.',
      idempotency_key: `scope-change-customer-approval:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    expect(providerApproval).toMatchObject({
      approver_party: 'PROVIDER',
      decision: 'APPROVED',
      proposal_status: 'PENDING',
      replayed: false,
    });
    expect(customerApproval).toMatchObject({
      approver_party: 'CUSTOMER',
      decision: 'APPROVED',
      proposal_status: 'PENDING',
      replayed: false,
    });
    expect(providerApproval.approval_id).not.toBe(customerApproval.approval_id);

    const beforeFinalization = await scopeOnlyChangeOrderSnapshot({
      taskId: lane.accepted.task_id,
      workOrderId: workOrder.work_order_id,
      proposalId: proposal.proposal_id,
    });
    expect(beforeFinalization).toMatchObject({
      worker_id: null,
      active_scope_version_id: lane.accepted.scope_version_id,
      proposal_status: 'PENDING',
      scopes: 1,
      approved_change_scopes: 0,
      latest_scope_version: lane.scopeVersion,
      approvals: 2,
      distinct_approval_actors: 2,
      amendments: 0,
      amendment_adjustments: 0,
      latest_amendment_version: 0,
      execution_facts: 2,
      apply_amendment_facts: 0,
      latest_execution_version: acknowledged.execution_version,
      latest_execution_state: 'ACKNOWLEDGED',
      latest_execution_transition: 'ACKNOWLEDGE',
      latest_execution_scope_version_id: lane.accepted.scope_version_id,
      financial_events: 3,
      adjustment_events: 0,
      latest_financial_version: 2,
    });

    await expect(
      changeOrders.authorizeAndMaterializeFakeChangeOrder(lane.fixture.posterUserId, {
        proposal_id: proposal.proposal_id,
        expected_proposal_version: proposal.proposal_version,
        expected_scope_version: lane.scopeVersion,
        expected_amendment_version: 0,
        expected_execution_version: genesis.execution_version,
        expected_financial_version: beforeFinalization.latest_financial_version,
        idempotency_key: `scope-change-stale-finalization:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'CHANGE_ORDER_VERSION_CONFLICT' });
    expect(
      await scopeOnlyChangeOrderSnapshot({
        taskId: lane.accepted.task_id,
        workOrderId: workOrder.work_order_id,
        proposalId: proposal.proposal_id,
      })
    ).toEqual(beforeFinalization);

    const finalizationCommand = {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: proposal.proposal_version,
      expected_scope_version: lane.scopeVersion,
      expected_amendment_version: 0,
      expected_execution_version: acknowledged.execution_version,
      expected_financial_version: beforeFinalization.latest_financial_version,
      idempotency_key: `scope-change-finalization:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    };
    const amendment = await changeOrders.authorizeAndMaterializeFakeChangeOrder(
      lane.fixture.posterUserId,
      finalizationCommand
    );
    expect(amendment).toMatchObject({
      proposal_id: proposal.proposal_id,
      amendment_version: 1,
      scope_version: lane.scopeVersion + 1,
      adjustment_event_id: null,
      provider_kind: null,
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    expect(financeAuthorizationCalls).toBe(0);

    const afterFinalization = await scopeOnlyChangeOrderSnapshot({
      taskId: lane.accepted.task_id,
      workOrderId: workOrder.work_order_id,
      proposalId: proposal.proposal_id,
    });
    expect(afterFinalization).toEqual({
      ...beforeFinalization,
      active_scope_version_id: amendment.scope_version_id,
      proposal_status: 'APPROVED',
      scopes: beforeFinalization.scopes + 1,
      approved_change_scopes: beforeFinalization.approved_change_scopes + 1,
      latest_scope_version: amendment.scope_version,
      amendments: 1,
      latest_amendment_version: amendment.amendment_version,
      execution_facts: beforeFinalization.execution_facts + 1,
      apply_amendment_facts: 1,
      latest_execution_version: acknowledged.execution_version + 1,
      latest_execution_state: 'ACKNOWLEDGED',
      latest_execution_transition: 'APPLY_AMENDMENT',
      latest_execution_scope_version_id: amendment.scope_version_id,
    });

    await expect(
      changeOrders.authorizeAndMaterializeFakeChangeOrder(
        lane.fixture.posterUserId,
        finalizationCommand
      )
    ).resolves.toEqual({ ...amendment, replayed: true });
    expect(financeAuthorizationCalls).toBe(0);
    expect(
      await scopeOnlyChangeOrderSnapshot({
        taskId: lane.accepted.task_id,
        workOrderId: workOrder.work_order_id,
        proposalId: proposal.proposal_id,
      })
    ).toEqual(afterFinalization);

    await expect(
      execution.advanceWorkOrderExecution(lane.fixture.provider.actor_user_id, {
        work_order_id: workOrder.work_order_id,
        action: 'START_WORK',
        expected_execution_version: afterFinalization.latest_execution_version,
        expected_scope_version: amendment.scope_version,
        idempotency_key: `scope-change-start-work:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      })
    ).resolves.toMatchObject({
      execution_version: acknowledged.execution_version + 2,
      state: 'IN_PROGRESS',
      transition_kind: 'START_WORK',
      scope_version: amendment.scope_version,
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
  });

  it('continues an unassigned Work Order through evidence, completion, fake capture, settlement, and reconciliation', async () => {
    const lane = await heldWorkOrderLane('yard');
    const materializationKey = `workorder-fulfillment:${randomUUID()}`;
    const materialized = await lane.application.secureAndMaterializeFakeWorkOrder(
      lane.fixture.posterUserId,
      {
        conditional_hold_id: lane.hold.conditional_hold_id,
        expected_eligibility_version: lane.interest.eligibility_version,
        idempotency_key: materializationKey,
        client_ts: new Date().toISOString(),
      }
    );
    const execution = executionService();
    const genesis = await execution.getWorkOrderExecutionState(
      lane.fixture.provider.actor_user_id,
      { work_order_id: materialized.work_order_id }
    );
    expect(genesis).toMatchObject({
      execution_version: 1,
      state: 'MATERIALIZED',
      transition_kind: 'MATERIALIZED',
      scope_version: lane.scopeVersion,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });

    const acknowledged = await execution.advanceWorkOrderExecution(
      lane.fixture.provider.actor_user_id,
      {
        work_order_id: materialized.work_order_id,
        action: 'ACKNOWLEDGE',
        expected_execution_version: genesis.execution_version,
        expected_scope_version: lane.scopeVersion,
        idempotency_key: `execution-acknowledge:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    expect(acknowledged).toMatchObject({
      execution_version: 2,
      state: 'ACKNOWLEDGED',
      transition_kind: 'ACKNOWLEDGE',
      replayed: false,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });

    await expect(
      execution.advanceWorkOrderExecution(lane.fixture.provider.actor_user_id, {
        work_order_id: materialized.work_order_id,
        action: 'START_WORK',
        expected_execution_version: genesis.execution_version,
        expected_scope_version: lane.scopeVersion,
        idempotency_key: `execution-stale-start:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'EXECUTION_VERSION_CONFLICT' });
    await expect(
      execution.getWorkOrderExecutionState(lane.fixture.provider.actor_user_id, {
        work_order_id: materialized.work_order_id,
      })
    ).resolves.toMatchObject({
      execution_version: acknowledged.execution_version,
      state: 'ACKNOWLEDGED',
      transition_kind: 'ACKNOWLEDGE',
    });

    const started = await execution.advanceWorkOrderExecution(lane.fixture.provider.actor_user_id, {
      work_order_id: materialized.work_order_id,
      action: 'START_WORK',
      expected_execution_version: acknowledged.execution_version,
      expected_scope_version: lane.scopeVersion,
      idempotency_key: `execution-start:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    expect(started).toMatchObject({
      execution_version: 3,
      state: 'IN_PROGRESS',
      transition_kind: 'START_WORK',
      replayed: false,
      hard_assignment_created: false,
      payment_creation_performed: false,
    });

    const fulfillment = fulfillmentService();
    const progress = await fulfillment.recordExecutionEvidence(
      lane.fixture.provider.actor_user_id,
      {
        work_order_id: materialized.work_order_id,
        expected_scope_version: lane.scopeVersion,
        expected_execution_version: started.execution_version,
        evidence_kind: 'PROGRESS',
        description: 'Provider recorded deterministic controlled-test execution progress.',
        photo_evidence: [],
        idempotency_key: `fulfillment-progress:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    expect(progress).toMatchObject({
      evidence_kind: 'PROGRESS',
      completion_fact_id: null,
      hard_assignment_created: false,
    });

    const submitted = await fulfillment.submitCompletionEvidence(
      lane.fixture.provider.actor_user_id,
      {
        work_order_id: materialized.work_order_id,
        expected_scope_version: lane.scopeVersion,
        expected_execution_version: started.execution_version,
        description: 'Provider completed every item in the accepted controlled-test scope.',
        photo_evidence: [],
        decision_reason: 'Provider submitted the exact scope for customer review.',
        idempotency_key: `fulfillment-completion:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    expect(submitted).toMatchObject({
      evidence_kind: 'COMPLETION',
      completion_version: 1,
      incident_gate: 'CLEAR',
      hard_assignment_created: false,
    });
    const submittedExecution = await execution.getWorkOrderExecutionState(
      lane.fixture.provider.actor_user_id,
      { work_order_id: materialized.work_order_id }
    );
    expect(submittedExecution).toMatchObject({
      execution_version: 4,
      state: 'COMPLETION_SUBMITTED',
      transition_kind: 'COMPLETION_SUBMITTED',
    });

    const sinkActorId = await userFixture('poster');
    const sinkSecret = 'system-test-completion-delivery-secret-at-least-32-bytes';
    const providerDeliveryId = `synthetic-sink-delivery:${randomUUID()}`;
    const deliveryCommand = {
      schema_version: 1 as const,
      event_type: 'COMPLETION_NOTICE_DELIVERED' as const,
      task_id: lane.accepted.task_id,
      work_order_id: materialized.work_order_id,
      submitted_completion_fact_id: submitted.completion_fact_id!,
      expected_completion_version: submitted.completion_version!,
      expected_execution_version: submittedExecution.execution_version,
      provider_delivery_id: providerDeliveryId,
      channel: 'EMAIL' as const,
      delivered_at: new Date().toISOString(),
      idempotency_key: `completion-delivery:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    };
    const deliveryBody = JSON.stringify(deliveryCommand);
    const deliverySignature = createHmac('sha256', sinkSecret)
      .update(deliveryBody, 'utf8')
      .digest('hex');
    const deliveryApp = new Hono();
    deliveryApp.post(
      '/webhooks/completion-delivery',
      createCompletionDeliveryWebhook({
        env: {
          HX_COMPLETION_DELIVERY_WEBHOOK_SECRET: sinkSecret,
          HX_COMPLETION_DELIVERY_SINK_ACTOR_ID: sinkActorId,
        },
        application: new UniversalV1CompletionDeliveryApplication(
          new PostgresUniversalV1CompletionDeliveryRepository(database)
        ),
      })
    );
    const sendDeliveryReceipt = () =>
      deliveryApp.request('/webhooks/completion-delivery', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-hustlexp-completion-delivery-signature': deliverySignature,
        },
        body: deliveryBody,
      });
    const deliveryResponses = await Promise.all([sendDeliveryReceipt(), sendDeliveryReceipt()]);
    expect(deliveryResponses.map((response) => response.status)).toEqual([200, 200]);
    const deliveryResults = (await Promise.all(
      deliveryResponses.map((response) => response.json())
    )) as Array<{
      delivery_event_id: string;
      idempotency_replayed: boolean;
      payment_creation_performed: boolean;
      hard_assignment_created: boolean;
    }>;
    expect(deliveryResults.map((result) => result.idempotency_replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(deliveryResults[0]).toMatchObject({
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    expect(deliveryResults[1]!.delivery_event_id).toBe(deliveryResults[0]!.delivery_event_id);

    const delayedDeliveryApp = new Hono();
    delayedDeliveryApp.post(
      '/webhooks/completion-delivery',
      createCompletionDeliveryWebhook({
        env: {
          HX_COMPLETION_DELIVERY_WEBHOOK_SECRET: sinkSecret,
          HX_COMPLETION_DELIVERY_SINK_ACTOR_ID: sinkActorId,
        },
        application: new UniversalV1CompletionDeliveryApplication(
          new PostgresUniversalV1CompletionDeliveryRepository(
            database,
            () => Date.parse(deliveryCommand.client_ts) + 24 * 60 * 60_000
          )
        ),
      })
    );
    const unsignedDelayedReplay = await delayedDeliveryApp.request(
      '/webhooks/completion-delivery',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: deliveryBody,
      }
    );
    expect(unsignedDelayedReplay.status).toBe(401);
    const delayedReplay = await delayedDeliveryApp.request('/webhooks/completion-delivery', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hustlexp-completion-delivery-signature': deliverySignature,
      },
      body: deliveryBody,
    });
    expect(delayedReplay.status).toBe(200);
    expect(await delayedReplay.json()).toMatchObject({
      delivery_event_id: deliveryResults[0]!.delivery_event_id,
      idempotency_replayed: true,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });

    const conflictingDeliveryBody = JSON.stringify({
      ...deliveryCommand,
      idempotency_key: `completion-delivery:${randomUUID()}`,
    });
    const conflictingDelivery = await delayedDeliveryApp.request('/webhooks/completion-delivery', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hustlexp-completion-delivery-signature': createHmac('sha256', sinkSecret)
          .update(conflictingDeliveryBody, 'utf8')
          .digest('hex'),
      },
      body: conflictingDeliveryBody,
    });
    expect(conflictingDelivery.status).toBe(409);

    const deliveryAudit = await pool.query<{
      receipt_count: number;
      work_order_id: string;
      expected_completion_fact_id: string;
      expected_execution_version: number;
      recorded_by: string;
      provider_service_identity: string;
    }>(
      `SELECT COUNT(*) OVER ()::integer AS receipt_count,
              work_order_id, expected_completion_fact_id,
              expected_execution_version, recorded_by,
              provider_service_identity
         FROM task_completion_delivery_events
        WHERE provider_delivery_id = $1`,
      [providerDeliveryId]
    );
    expect(deliveryAudit.rows[0]).toEqual({
      receipt_count: 1,
      work_order_id: materialized.work_order_id,
      expected_completion_fact_id: submitted.completion_fact_id,
      expected_execution_version: submittedExecution.execution_version,
      recorded_by: sinkActorId,
      provider_service_identity: `hustlexp.synthetic-communications-sink.v1:${sinkActorId}`,
    });
    const approved = await fulfillment.decideCompletion(lane.fixture.posterUserId, {
      work_order_id: materialized.work_order_id,
      submitted_completion_fact_id: submitted.completion_fact_id!,
      expected_completion_version: submitted.completion_version!,
      expected_execution_version: submittedExecution.execution_version,
      decision: 'APPROVED',
      delivery_event_id: deliveryResults[0]!.delivery_event_id,
      decision_reason: 'Customer approved the exact submitted controlled-test completion.',
      idempotency_key: `fulfillment-approval:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    expect(approved).toMatchObject({
      completion_version: 2,
      decision: 'APPROVED',
      replayed: false,
      payment_creation_performed: false,
    });
    const completedExecution = await execution.getWorkOrderExecutionState(
      lane.fixture.posterUserId,
      { work_order_id: materialized.work_order_id }
    );
    expect(completedExecution).toMatchObject({
      execution_version: 5,
      state: 'COMPLETED',
      transition_kind: 'COMPLETION_APPROVED',
    });

    const lifecycleKey = `fulfillment-settlement:${randomUUID()}`;
    const terminal = await fulfillment.completeFakeFinancialLifecycle(lane.fixture.posterUserId, {
      work_order_id: materialized.work_order_id,
      approved_completion_fact_id: approved.completion_fact_id,
      path: 'SETTLED',
      expected_execution_version: completedExecution.execution_version,
      expected_financial_version: 2,
      expected_reconciliation_version: 0,
      idempotency_key: lifecycleKey,
      client_ts: new Date().toISOString(),
    });
    expect(terminal).toMatchObject({
      path: 'SETTLED',
      replayed: false,
      provider_kind: 'FAKE',
      refund_event_id: null,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });

    const facts = await pool.query<{
      worker_id: string | null;
      progress_proofs: number;
      completion_proofs: number;
      completion_facts: number;
      execution_facts: number;
      execution_versions: number[];
      execution_states: string[];
      execution_transitions: string[];
      execution_scope_bindings: number;
      completion_execution_facts: number;
      event_kinds: string[];
      provider_kinds: string[];
      approved_provider_events: number;
      approved_provider_operations: number;
      fake_operations: number;
      fake_operation_events: number;
      escrows: number;
      quote_payments: number;
      capture_state: string;
      settlement_state: string;
      funding_state: string;
      provider_release_state: string;
      payout_state: string;
      bank_settlement_state: string;
      reconciliation_state: string;
      customer_ledger_amount_cents: string;
      provider_ledger_amount_cents: string;
    }>(
      `SELECT task.worker_id,
              (SELECT COUNT(*)::integer FROM proofs proof
                WHERE proof.work_order_id = $1
                  AND proof.evidence_kind = 'PROGRESS') AS progress_proofs,
              (SELECT COUNT(*)::integer FROM proofs proof
                WHERE proof.work_order_id = $1
                  AND proof.evidence_kind = 'COMPLETION') AS completion_proofs,
              (SELECT COUNT(*)::integer FROM task_completion_facts completion
                WHERE completion.work_order_id = $1) AS completion_facts,
              (SELECT COUNT(*)::integer FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $1) AS execution_facts,
              (SELECT array_agg(execution.execution_version ORDER BY execution.execution_version)
                 FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $1) AS execution_versions,
              (SELECT array_agg(execution.state ORDER BY execution.execution_version)
                 FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $1) AS execution_states,
              (SELECT array_agg(execution.transition_kind ORDER BY execution.execution_version)
                 FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $1) AS execution_transitions,
              (SELECT COUNT(DISTINCT execution.scope_version_id)::integer
                 FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $1) AS execution_scope_bindings,
              (SELECT COUNT(*)::integer FROM task_work_order_execution_facts execution
                WHERE execution.work_order_id = $1
                  AND execution.completion_fact_id IS NOT NULL) AS completion_execution_facts,
              (SELECT array_agg(event.event_kind ORDER BY event.expected_version)
                 FROM task_financial_security_events event
                WHERE event.task_id = task.id) AS event_kinds,
              (SELECT array_agg(DISTINCT event.provider_kind ORDER BY event.provider_kind)
                 FROM task_financial_security_events event
                WHERE event.task_id = task.id) AS provider_kinds,
              (SELECT COUNT(*)::integer FROM task_financial_security_events event
                WHERE event.task_id = task.id
                  AND event.provider_kind = 'APPROVED_PROVIDER') AS approved_provider_events,
              (SELECT COUNT(*)::integer FROM task_financial_operations operation
                WHERE operation.task_id = task.id
                  AND operation.provider_kind = 'APPROVED_PROVIDER') AS approved_provider_operations,
              (SELECT COUNT(*)::integer FROM hxos_fake_financial_operations_v1 operation
                WHERE operation.operation_id = ANY($3::uuid[])) AS fake_operations,
              (SELECT COUNT(*)::integer FROM hxos_fake_financial_operation_events_v1 event
                WHERE event.operation_id = ANY($3::uuid[])) AS fake_operation_events,
              (SELECT COUNT(*)::integer FROM escrows escrow
                WHERE escrow.task_id = task.id) AS escrows,
              (SELECT COUNT(*)::integer FROM quote_payments payment
                WHERE payment.quote_id = $2) AS quote_payments,
              reconciliation.capture_state,
              reconciliation.settlement_state,
              reconciliation.funding_state,
              reconciliation.provider_release_state,
              reconciliation.payout_state,
              reconciliation.bank_settlement_state,
              reconciliation.reconciliation_state,
              reconciliation.customer_ledger_amount_cents::text,
              reconciliation.provider_ledger_amount_cents::text
         FROM tasks task
         JOIN task_reconciliation_facts reconciliation
           ON reconciliation.id = $4
        WHERE task.id = $5`,
      [
        materialized.work_order_id,
        lane.fixture.quoteId,
        [
          ...financialOperationIds(materializationKey),
          deterministicUuid(
            `fake-provider-account:${lane.fixture.provider.actor_user_id}`,
            'onboard'
          ),
          deterministicUuid(
            `fake-provider-account:${lane.fixture.provider.actor_user_id}`,
            'state'
          ),
          deterministicUuid(lifecycleKey, 'capture'),
          deterministicUuid(lifecycleKey, 'settle'),
          deterministicUuid(lifecycleKey, 'fund'),
          deterministicUuid(lifecycleKey, 'provider-release'),
          deterministicUuid(lifecycleKey, 'payout'),
          deterministicUuid(lifecycleKey, 'bank-settlement'),
          deterministicUuid(lifecycleKey, 'reconciliation'),
        ],
        terminal.reconciliation_id,
        lane.accepted.task_id,
      ]
    );
    expect(facts.rows[0]).toEqual({
      worker_id: null,
      progress_proofs: 1,
      completion_proofs: 1,
      completion_facts: 2,
      execution_facts: 5,
      execution_versions: [1, 2, 3, 4, 5],
      execution_states: [
        'MATERIALIZED',
        'ACKNOWLEDGED',
        'IN_PROGRESS',
        'COMPLETION_SUBMITTED',
        'COMPLETED',
      ],
      execution_transitions: [
        'MATERIALIZED',
        'ACKNOWLEDGE',
        'START_WORK',
        'COMPLETION_SUBMITTED',
        'COMPLETION_APPROVED',
      ],
      execution_scope_bindings: 1,
      completion_execution_facts: 2,
      event_kinds: [
        'PAYMENT_METHOD_PREPARED',
        'AUTHORIZED',
        'SECURED',
        'CAPTURED',
        'SETTLEMENT_OBSERVED',
        'FUNDING_OBSERVED',
        'PROVIDER_RELEASED',
        'PAYOUT_OBSERVED',
        'BANK_SETTLEMENT_OBSERVED',
      ],
      provider_kinds: ['FAKE'],
      approved_provider_events: 0,
      approved_provider_operations: 0,
      fake_operations: 12,
      fake_operation_events: 12,
      escrows: 0,
      quote_payments: 0,
      capture_state: 'CAPTURED',
      settlement_state: 'SETTLED',
      funding_state: 'FUNDED',
      provider_release_state: 'RELEASED',
      payout_state: 'PAID',
      bank_settlement_state: 'SETTLED',
      reconciliation_state: 'MATCHED',
      customer_ledger_amount_cents: '10000',
      provider_ledger_amount_cents: '8000',
    });
  });
});
