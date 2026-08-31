import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

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
import {
  PostgresUniversalV1ChangeOrderRecoveryRepository,
  UniversalV1ChangeOrderRecoveryService,
} from '../../src/services/UniversalV1ChangeOrderRecovery.js';
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
  PostgresUniversalV1OccurrenceFactReader,
  PostgresUniversalV1OperationsOccurrenceReader,
  UniversalV1OccurrenceReadApplication,
  universalV1OccurrenceProjectionSha256,
} from '../../src/services/UniversalV1OccurrenceReadModel.js';
import {
  deterministicUuid,
  PostgresUniversalV1WorkOrderRepository,
  type WorkOrderCompensationCommand,
} from '../../src/services/UniversalV1WorkOrderPostgresRepository.js';
import { PostgresUniversalV1WorkOrderPublicFactReader } from '../../src/services/UniversalV1WorkOrderPublicFacts.js';
import { executeUniversalV1WorkOrderCompensation } from '../../src/jobs/universal-v1-work-order-compensation-worker.js';
import {
  ensureUniversalV1SyntheticServiceCell,
  SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
  SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
  SYNTHETIC_SERVICE_CELL_REGION_CODE,
} from '../helpers/universal-v1-service-cell-authority.js';
import {
  claimUniversalV1TaskDraft,
  type UniversalV1TaskDraftClaimDependencies,
} from '../../src/services/UniversalV1TaskDraftClaim.js';
import {
  createUniversalV1FakeFinancialApplicationService,
  PostgresUniversalV1FinancialLifecycleRepository,
  UniversalV1FinancialApplicationService,
} from '../../src/services/payment/UniversalV1FinancialApplicationService.js';
import {
  FakeFinancialProvider,
  PostgresFakeFinancialOperationRepository,
} from '../../src/services/payment/FakeFinancialProvider.js';
import {
  PostgresFinancialProviderCommandJournal,
  type ForegroundFinancialProviderCommandContext,
  type ForegroundFinancialProviderCommandCoordinator,
  type ForegroundFinancialProviderCommandResult,
} from '../../src/services/payment/FinancialProviderCommandJournal.js';
import {
  DurableFakeFinancialProviderCommandCoordinator,
  PostgresFinancialProviderCommandRecoveryRepository,
} from '../../src/services/payment/FinancialProviderCommandRecovery.js';
import {
  PostgresUniversalV1PreparedFinancialCommandAuthority,
  type PrepareUniversalV1FinancialCommandInput,
  type PreparedUniversalV1FinancialCommandReceipt,
  type UniversalV1PreparedFinancialCommandAuthority,
} from '../../src/services/payment/PreparedFinancialCommandAuthority.js';
import { PostgresUniversalV1FakeProviderAccountRepository } from '../../src/services/payment/UniversalV1FakeProviderAccountRepository.js';
import { createCompletionDeliveryWebhook } from '../../src/serverCompletionDeliveryWebhook.js';
import {
  promoteExpiredDirectProviderClaims,
  reconcileNotificationProviderReceipts,
} from '../../src/services/NotificationDeliveryRecoveryService.js';
import { processEmailJob } from '../../src/jobs/email-worker.js';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const now = 1_800_000_000_000;
const regionCode = SYNTHETIC_SERVICE_CELL_REGION_CODE;

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
    await ensureUniversalV1SyntheticServiceCell(pool);
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
    const ownerUserId = await userFixture('worker');
    const providerUserId = await userFixture('worker');
    const organizationId = randomUUID();
    const ownerMembershipId = randomUUID();
    const crewMembershipId = randomUUID();
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
      [organizationId, ownerUserId, `trade-org:${organizationId}`]
    );
    await pool.query(
      `INSERT INTO business_memberships(
         id, organization_id, user_id, role, status, invited_by, accepted_at
       ) VALUES
         ($1, $3, $4, 'OWNER', 'ACTIVE', $4, clock_timestamp()),
         ($2, $3, $5, 'CREW', 'ACTIVE', $4, clock_timestamp())`,
      [ownerMembershipId, crewMembershipId, organizationId, ownerUserId, providerUserId]
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
        ownerMembershipId,
        randomBytes(32).toString('hex'),
        ownerUserId,
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
      actor_user_id: ownerUserId,
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
      zip: SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
      region: 'Untrusted client location hint',
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
    const route = await pool.query<{
      route_id: string;
      decision_version: number;
      outcome: string;
      category_snapshot: string;
      service_cell_snapshot: string;
      service_cell_authority_id: string;
      evidence_work_category_code: string;
      evidence_service_cell_authority_id: string;
    }>(
      `SELECT route.id AS route_id, route.decision_version, route.outcome,
              route.category_snapshot, route.service_cell_snapshot,
              route.service_cell_authority_id,
              route.evidence ->> 'work_category_code' AS evidence_work_category_code,
              route.evidence ->> 'service_cell_authority_id'
                AS evidence_service_cell_authority_id
         FROM task_drafts draft
         JOIN task_routing_decisions route ON route.id = draft.active_routing_decision_id
        WHERE draft.id = $1`,
      [linked.draft_id]
    );
    expect(route.rows[0]?.outcome).toBe('ESTIMATE_REQUIRED');
    expect(route.rows[0]).toMatchObject({
      category_snapshot: category === 'handyman' ? 'plumbing' : 'yard',
      service_cell_snapshot: SYNTHETIC_SERVICE_CELL_REGION_CODE,
      service_cell_authority_id: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
      evidence_work_category_code: category === 'handyman' ? 'plumbing' : 'yard',
      evidence_service_cell_authority_id: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
    });
    return {
      draftId: linked.draft_id,
      submissionId,
      posterUserId,
      routeId: route.rows[0]!.route_id,
      routeVersion: route.rows[0]!.decision_version,
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
    const route = { routeId: draft.routeId, routeVersion: draft.routeVersion };
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
    completionSinkActorId: string,
    databaseOverride: Database = database
  ): UniversalV1FulfillmentApplication {
    return new UniversalV1FulfillmentApplication(
      new PostgresUniversalV1FulfillmentRepository(
        databaseOverride,
        undefined,
        {
          NODE_ENV: 'test',
          HX_ENVIRONMENT: 'test',
          HX_PAYMENT_CREATION_MODE: 'frozen',
          HX_OUTBOUND_COMMUNICATION_MODE: 'sink',
          HX_EMAIL_DELIVERY_MODE: 'sink',
          HX_LIVE_DELIVERY: 'false',
          HX_LIVE_PROVIDER_ACCESS: 'false',
          HX_EXTERNAL_VALUE: 'false',
          HX_COMPLETION_DELIVERY_SINK_ACTOR_ID: completionSinkActorId,
        }
      ),
      () => fakeFinanceService(databaseOverride)
    );
  }

  function fakeFinanceService(databaseOverride: Database = database) {
    const authority = localFakeFinanceAuthority();
    return createUniversalV1FakeFinancialApplicationService(
      databaseOverride,
      authority.env,
      authority.release,
      authority.identity
    );
  }

  function boundaryFakeFinanceService(options: {
    readonly crashAfterPreparedOperation?: 'CAPTURE';
    readonly crashAfterRequestedOperation?: 'SETTLE';
    readonly leaseDurationSeconds?: number;
  }) {
    const fakeEvents = new PostgresFakeFinancialOperationRepository(database);
    const prepared = new PostgresUniversalV1PreparedFinancialCommandAuthority(database);
    let preparedCrashInjected = false;
    const preparedAuthority: UniversalV1PreparedFinancialCommandAuthority =
      options.crashAfterPreparedOperation === undefined
        ? prepared
        : {
            async prepare(
              input: PrepareUniversalV1FinancialCommandInput
            ): Promise<PreparedUniversalV1FinancialCommandReceipt> {
              const receipt = await prepared.prepare(input);
              if (
                !preparedCrashInjected &&
                input.operationKind === options.crashAfterPreparedOperation
              ) {
                preparedCrashInjected = true;
                throw new Error(`SYSTEM_TEST_CRASH_AFTER_PREPARED_${input.operationKind}`);
              }
              return receipt;
            },
          };
    const durableCoordinator = new DurableFakeFinancialProviderCommandCoordinator(
      new PostgresFinancialProviderCommandRecoveryRepository(database),
      fakeEvents,
      {
        leaseOwnerId: randomUUID(),
        ...(options.leaseDurationSeconds === undefined
          ? {}
          : {
              leaseDurationSeconds: options.leaseDurationSeconds,
              outcomeTimeoutSeconds: options.leaseDurationSeconds - 1,
            }),
      }
    );
    let requestedCrashInjected = false;
    const foregroundCoordinator: ForegroundFinancialProviderCommandCoordinator =
      options.crashAfterRequestedOperation === undefined
        ? durableCoordinator
        : {
            async dispatchOrReplay<TRequest, TResult>(
              context: ForegroundFinancialProviderCommandContext<TRequest>,
              invokeAdapter: (exactCanonicalRequest: TRequest) => Promise<TResult>
            ): Promise<ForegroundFinancialProviderCommandResult<TResult>> {
              if (
                !requestedCrashInjected &&
                context.operationKind === options.crashAfterRequestedOperation
              ) {
                requestedCrashInjected = true;
                throw new Error(`SYSTEM_TEST_CRASH_AFTER_REQUESTED_${context.operationKind}`);
              }
              return durableCoordinator.dispatchOrReplay(context, invokeAdapter);
            },
          };
    return new UniversalV1FinancialApplicationService(
      new FakeFinancialProvider(fakeEvents),
      new PostgresUniversalV1FinancialLifecycleRepository(database),
      { assertAuthorized: () => undefined },
      'FAKE',
      new PostgresFinancialProviderCommandJournal(database),
      preparedAuthority,
      undefined,
      foregroundCoordinator
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

  async function approvedPriceAndScopeRecoveryLane(label: string) {
    const lane = await heldWorkOrderLane('yard');
    const workOrder = await lane.application.secureAndMaterializeFakeWorkOrder(
      lane.fixture.posterUserId,
      {
        conditional_hold_id: lane.hold.conditional_hold_id,
        expected_eligibility_version: lane.interest.eligibility_version,
        idempotency_key: `recovery-work-order:${label}:${randomUUID()}`,
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
        idempotency_key: `recovery-acknowledge:${label}:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    const repository = new PostgresUniversalV1ChangeOrderRepository(database);
    const changeOrders = new UniversalV1ChangeOrderApplication(
      repository,
      () => fakeFinanceService()
    );
    const economics = await pool.query<{
      customer_total_cents: number;
      provider_payout_cents: number;
    }>(
      `SELECT customer_total_cents::integer,
              hustler_payout_cents::integer AS provider_payout_cents
         FROM task_scope_versions
        WHERE id = $1`,
      [lane.accepted.scope_version_id]
    );
    const customerTotalCents = Number(economics.rows[0]!.customer_total_cents) + 3_000;
    const providerPayoutCents = Number(economics.rows[0]!.provider_payout_cents) + 2_000;
    const proposal = await changeOrders.proposeChangeOrder(lane.fixture.posterUserId, {
      work_order_id: workOrder.work_order_id,
      expected_scope_version: lane.scopeVersion,
      expected_amendment_version: 0,
      expected_latest_proposal_version: 0,
      observed_scope_summary: `Recovery boundary ${label} adds approved debris hauling.`,
      proposed_scope: {
        title: `Recovery boundary ${label} yard cleanup`,
        description: 'Complete the accepted yard cleanup and haul one approved debris load.',
        requirements: 'Use the approved disposal route and preserve completion evidence.',
        checklist: [
          'Complete the accepted yard cleanup',
          'Haul the approved debris load',
          'Record disposal completion evidence',
        ],
      },
      change_order_kind: 'PRICE_AND_SCOPE',
      proposed_customer_total_cents: customerTotalCents,
      proposed_provider_payout_cents: providerPayoutCents,
      idempotency_key: `recovery-proposal:${label}:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    await changeOrders.decideChangeOrder(lane.fixture.provider.actor_user_id, {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: proposal.proposal_version,
      decision: 'APPROVED',
      reason: 'Provider approves the exact revised scope and economics.',
      idempotency_key: `recovery-provider-approval:${label}:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    await changeOrders.decideChangeOrder(lane.fixture.posterUserId, {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: proposal.proposal_version,
      decision: 'APPROVED',
      reason: 'Customer approves the exact revised scope and economics.',
      idempotency_key: `recovery-customer-approval:${label}:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    const financial = await pool.query<{
      id: string;
      operation_id: string;
      expected_version: number;
      amount_cents: number;
      currency: string;
    }>(
      `SELECT id, operation_id, expected_version::integer,
              amount_cents::integer, currency
         FROM task_financial_security_events
        WHERE task_id = $1
        ORDER BY expected_version DESC
        LIMIT 1`,
      [lane.accepted.task_id]
    );
    const predecessor = financial.rows[0]!;
    const command = {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: proposal.proposal_version,
      expected_scope_version: lane.scopeVersion,
      expected_amendment_version: 0,
      expected_execution_version: acknowledged.execution_version,
      expected_financial_version: predecessor.expected_version,
      idempotency_key: `recovery-finalization:${label}:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    };
    return {
      ...lane,
      workOrder,
      execution,
      acknowledged,
      repository,
      changeOrders,
      proposal,
      command,
      predecessor,
      customerTotalCents,
      providerPayoutCents,
    };
  }

  async function preparedPriceAndScopeRecoveryLane(label: string) {
    const lane = await approvedPriceAndScopeRecoveryLane(label);
    const phase = await lane.repository.preparePriceAndScopeMaterialization(
      lane.fixture.posterUserId,
      lane.command
    );
    if (phase.completed) throw new Error('SYSTEM_TEST_EXPECTED_PHASE_A_WITNESS');
    return { ...lane, phase };
  }

  async function executeRecoveryAdjustment(
    lane: Awaited<ReturnType<typeof preparedPriceAndScopeRecoveryLane>>,
    scenario: 'SUCCESS' | 'DECLINE' = 'SUCCESS'
  ) {
    const context = lane.phase.context;
    return fakeFinanceService().executeFinancialEvent({
      providerKind: 'FAKE',
      operationKind: 'ADJUST',
      operationId: context.adjustmentOperationId,
      idempotencyKey: `${lane.phase.idempotencyKey}:adjust`,
      providerExpectedVersion: 0,
      lifecycleExpectedVersion: context.expectedFinancialVersion + 1,
      taskDraftId: context.taskDraftId,
      taskId: context.taskId,
      eligibilityDecisionId: context.eligibilityDecisionId,
      scopeVersionId: context.scopeVersionId,
      predecessorEventId: context.predecessorEventId,
      relatedOperationId: context.predecessorOperationId,
      changeOrderId: context.proposalId,
      amountCents: context.customerTotalCents,
      currency: context.currency.toLowerCase(),
      recordedBy: lane.fixture.posterUserId,
      occurredAt: context.occurredAt,
      scenario,
    });
  }

  function financialOperationIds(idempotencyKey: string): string[] {
    return ['prepare', 'authorize', 'secure'].map((label) =>
      deterministicUuid(idempotencyKey, label)
    );
  }

  async function workOrderCompensationCommand(
    idempotencyKey: string
  ): Promise<WorkOrderCompensationCommand> {
    const result = await pool.query<
      Omit<WorkOrderCompensationCommand, 'amount_cents' | 'created_at'> & {
        amount_cents: string | number;
        created_at: string | Date;
      }
    >(
      `SELECT compensation_command_id,work_order_idempotency_key,task_draft_id,
              task_id,scope_version_id,eligibility_decision_id,secured_event_id,
              secured_operation_id,void_operation_id,void_idempotency_key,
              amount_cents,currency,requested_by,created_at
         FROM universal_v1_work_order_compensation_commands
        WHERE work_order_idempotency_key=$1`,
      [idempotencyKey]
    );
    const command = result.rows[0];
    if (!command) throw new Error('SYSTEM_TEST_WORK_ORDER_COMPENSATION_MISSING');
    return {
      ...command,
      amount_cents: Number(command.amount_cents),
      created_at: new Date(command.created_at).toISOString(),
    };
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
        [
          ...financialOperationIds(input.idempotencyKey),
          deterministicUuid(input.idempotencyKey, 'void'),
        ],
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
      let actorUserId = fixture.provider.actor_user_id;
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
        `${trade ? 'Licensed plumbing estimate for ' : ''}invitation revocation race ${target}`
      );
      const route = { routeId: draft.routeId, routeVersion: draft.routeVersion };
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

  it('copies locked trade eligibility and refuses an active trust hold before interest', async () => {
    const tradeLane = await acceptedWorkOrderLane('plumbing');
    const application = workOrderService();
    const tradeInterestCommand = {
      task_id: tradeLane.accepted.task_id,
      expected_scope_version: tradeLane.scopeVersion,
      idempotency_key: `workorder-trade-interest:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    };
    const interest = await application.expressProviderInterest(
      tradeLane.fixture.provider.actor_user_id,
      tradeInterestCommand
    );
    await expect(
      application.expressProviderInterest(
        tradeLane.fixture.provider.actor_user_id,
        tradeInterestCommand
      )
    ).resolves.toEqual({ ...interest, replayed: true });
    await expect(
      application.expressProviderInterest(tradeLane.fixture.provider.actor_user_id, {
        ...tradeInterestCommand,
        client_ts: new Date(Date.parse(tradeInterestCommand.client_ts) + 1).toISOString(),
      })
    ).rejects.toMatchObject({ code: 'WORK_ORDER_IDEMPOTENCY_CONFLICT' });
    await expect(
      application.expressProviderInterest(tradeLane.fixture.provider.actor_user_id, {
        ...tradeInterestCommand,
        idempotency_key: `workorder-trade-interest-changed:${randomUUID()}`,
      })
    ).rejects.toMatchObject({ code: 'WORK_ORDER_AUTHORITY_REVOKED' });
    await expect(
      application.expressProviderInterest(tradeLane.fixture.provider.actor_user_id, {
        ...tradeInterestCommand,
        expected_scope_version: tradeLane.scopeVersion + 1,
      })
    ).rejects.toMatchObject({ code: 'WORK_ORDER_VERSION_CONFLICT' });
    const copied = await pool.query<{
      decision_version: number;
      supersedes_decision_id: string;
      provider_class: string;
      trade_credential_id: string;
      profile_eligible: boolean;
      identity_eligible: boolean;
      category_eligible: boolean;
      credential_eligible: boolean;
      geography_eligible: boolean;
      availability_eligible: boolean;
      restriction_clear: boolean;
      task_eligible: boolean;
      processor_payment_eligible: boolean;
      payout_funding_eligible: boolean;
      policy_version: string;
      evidence: Record<string, unknown>;
      worker_id: string | null;
      work_order_id: string | null;
    }>(
      `SELECT eligibility.decision_version, eligibility.supersedes_decision_id,
              eligibility.provider_class, eligibility.trade_credential_id,
              eligibility.profile_eligible, eligibility.identity_eligible,
              eligibility.category_eligible, eligibility.credential_eligible,
              eligibility.geography_eligible, eligibility.availability_eligible,
              eligibility.restriction_clear, eligibility.task_eligible,
              eligibility.processor_payment_eligible,
              eligibility.payout_funding_eligible, eligibility.policy_version,
              eligibility.evidence, task.worker_id, task.work_order_id
         FROM task_provider_eligibility_decisions eligibility
         JOIN tasks task ON task.id = eligibility.task_id
        WHERE eligibility.id = $1`,
      [interest.eligibility_decision_id]
    );
    expect(copied.rows[0]).toMatchObject({
      decision_version: 2,
      supersedes_decision_id: tradeLane.fixture.eligibilityDecisionId,
      provider_class: 'VERIFIED_TRADE_BUSINESS',
      trade_credential_id: tradeLane.fixture.provider.trade_credential_id,
      profile_eligible: true,
      identity_eligible: true,
      category_eligible: true,
      credential_eligible: true,
      geography_eligible: true,
      availability_eligible: true,
      restriction_clear: true,
      task_eligible: true,
      processor_payment_eligible: false,
      payout_funding_eligible: false,
      policy_version: 'universal-v1-post-estimate-1.2.0',
      evidence: expect.objectContaining({
        source_eligibility_id: tradeLane.fixture.eligibilityDecisionId,
        payment_creation_frozen: true,
        payout_funding_frozen: true,
        final_availability_confirmation_required: true,
        interest_is_not_assignment: true,
      }),
      worker_id: null,
      work_order_id: null,
    });

    const restrictedLane = await acceptedWorkOrderLane('yard');
    await pool.query(
      `UPDATE users
          SET trust_hold = TRUE,
              trust_hold_until = clock_timestamp() + INTERVAL '1 hour'
        WHERE id = $1`,
      [restrictedLane.fixture.provider.provider_user_id]
    );
    await expect(
      application.expressProviderInterest(restrictedLane.fixture.provider.actor_user_id, {
        task_id: restrictedLane.accepted.task_id,
        expected_scope_version: restrictedLane.scopeVersion,
        idempotency_key: `workorder-trust-hold:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'WORK_ORDER_AUTHORITY_REVOKED' });
    const refused = await pool.query<{
      interests: number;
      post_estimate_eligibility: number;
      worker_id: string | null;
      work_order_id: string | null;
    }>(
      `SELECT
          (SELECT COUNT(*)::integer FROM task_applications application
            WHERE application.task_id = task.id
              AND application.universal_contract_version = 1) AS interests,
          (SELECT COUNT(*)::integer FROM task_provider_eligibility_decisions eligibility
            WHERE eligibility.task_id = task.id) AS post_estimate_eligibility,
          task.worker_id, task.work_order_id
         FROM tasks task
        WHERE task.id = $1`,
      [restrictedLane.accepted.task_id]
    );
    expect(refused.rows[0]).toEqual({
      interests: 0,
      post_estimate_eligibility: 0,
      worker_id: null,
      work_order_id: null,
    });
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
    const command = {
      conditional_hold_id: lane.hold.conditional_hold_id,
      expected_eligibility_version: lane.interest.eligibility_version,
      idempotency_key: idempotencyKey,
      client_ts: new Date().toISOString(),
    };

    await expect(
      failingApplication.secureAndMaterializeFakeWorkOrder(lane.fixture.posterUserId, command)
    ).rejects.toMatchObject({
      code: 'XX999',
      message: 'INJECTED_WORK_ORDER_INSERT_FAILURE',
    });
    const compensated = await workOrderEffectSnapshot({
      draftId: lane.fixture.draftId,
      taskId: lane.accepted.task_id,
      interestId: lane.interest.interest_application_id,
      holdId: lane.hold.conditional_hold_id,
      idempotencyKey,
    });
    expect(compensated).toEqual({
      worker_id: null,
      task_work_order_id: null,
      work_orders: 0,
      witnesses: 1,
      security_events: 4,
      fake_operations: 4,
      fake_operation_events: 4,
      approved_provider_operations: 0,
      non_fake_security_events: 0,
      non_fake_external_references: 0,
      escrows: 0,
      quote_payments: 0,
      interest_status: 'pending',
      hold_status: 'ACTIVE',
      security_event_kinds: ['PAYMENT_METHOD_PREPARED', 'AUTHORIZED', 'SECURED', 'VOIDED'],
      security_event_providers: ['FAKE'],
    });

    await expect(
      failingApplication.secureAndMaterializeFakeWorkOrder(lane.fixture.posterUserId, {
        ...command,
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
    ).toEqual(compensated);

    const operationIds = [
      ...financialOperationIds(idempotencyKey),
      deterministicUuid(idempotencyKey, 'void'),
    ];
    const authority = await pool.query<{
      compensation_commands: number;
      prepared_commands: number;
      journal_commands: number;
      dispatch_attempts: number;
      observed_outcomes: number;
      lifecycle_bridges: number;
      successful_voids: number;
    }>(
      `SELECT
       (SELECT COUNT(*)::integer
          FROM universal_v1_work_order_compensation_commands compensation
         WHERE compensation.work_order_idempotency_key=$1
           AND compensation.task_id=$2
           AND compensation.reason_code='FINALIZATION_FAILED') AS compensation_commands,
       (SELECT COUNT(*)::integer
          FROM universal_v1_prepared_financial_commands prepared
         WHERE prepared.operation_id=ANY($3::uuid[])) AS prepared_commands,
       (SELECT COUNT(*)::integer
          FROM financial_provider_command_journal command
         WHERE command.operation_id=ANY($3::uuid[])) AS journal_commands,
       (SELECT COUNT(*)::integer
          FROM financial_provider_command_dispatch_attempts attempt
          JOIN financial_provider_command_journal command
            ON command.command_id=attempt.command_id
         WHERE command.operation_id=ANY($3::uuid[])) AS dispatch_attempts,
       (SELECT COUNT(*)::integer
          FROM financial_provider_command_outcome_facts outcome
          JOIN financial_provider_command_journal command
            ON command.command_id=outcome.command_id
         WHERE command.operation_id=ANY($3::uuid[])
           AND outcome.outcome_kind='OUTCOME_OBSERVED'
           AND outcome.retryable IS FALSE) AS observed_outcomes,
       (SELECT COUNT(*)::integer
          FROM universal_v1_fake_financial_lifecycle_bridges bridge
         WHERE bridge.fake_operation_id=ANY($3::uuid[])) AS lifecycle_bridges,
       (SELECT COUNT(*)::integer
          FROM task_financial_security_events event
         WHERE event.operation_id=$4
           AND event.event_kind='VOIDED'
           AND event.status='SUCCEEDED'
           AND event.provider_kind='FAKE'
           AND event.expected_version=3) AS successful_voids`,
      [
        idempotencyKey,
        lane.accepted.task_id,
        operationIds,
        deterministicUuid(idempotencyKey, 'void'),
      ]
    );
    expect(authority.rows[0]).toEqual({
      compensation_commands: 1,
      prepared_commands: 4,
      journal_commands: 4,
      dispatch_attempts: 4,
      observed_outcomes: 4,
      lifecycle_bridges: 4,
      successful_voids: 1,
    });
  });

  it('uses only the exact compensation claim when eligibility changes after SECURE', async () => {
    const lane = await heldWorkOrderLane('yard');
    const idempotencyKey = `workorder-stale-compensation:${randomUUID()}`;
    const repository = new PostgresUniversalV1WorkOrderRepository(database);
    let successorEligibilityId: string | null = null;
    const invalidatingRepository = {
      prepareMaterialization: repository.prepareMaterialization.bind(repository),
      claimMaterializationCompensation:
        repository.claimMaterializationCompensation.bind(repository),
      finalizeMaterialization: async (
        ...args: Parameters<typeof repository.finalizeMaterialization>
      ) => {
        if (successorEligibilityId === null) {
          const successor = await pool.query<{ id: string }>(
            `INSERT INTO task_provider_eligibility_decisions(
               task_draft_id,task_id,scope_version_id,interest_application_id,
               routing_decision_id,decision_version,supersedes_decision_id,
               provider_user_id,provider_organization_id,provider_class,
               trade_credential_id,profile_eligible,identity_eligible,
               category_eligible,credential_eligible,geography_eligible,
               availability_eligible,restriction_clear,task_eligible,
               processor_payment_eligible,payout_funding_eligible,trust_tier,
               blocker_codes,policy_version,evidence,decided_by,idempotency_key,
               evaluated_at,valid_until
             )
             SELECT eligibility.task_draft_id,eligibility.task_id,
                    eligibility.scope_version_id,eligibility.interest_application_id,
                    eligibility.routing_decision_id,eligibility.decision_version+1,
                    eligibility.id,eligibility.provider_user_id,
                    eligibility.provider_organization_id,eligibility.provider_class,
                    eligibility.trade_credential_id,eligibility.profile_eligible,
                    eligibility.identity_eligible,eligibility.category_eligible,
                    eligibility.credential_eligible,eligibility.geography_eligible,
                    eligibility.availability_eligible,eligibility.restriction_clear,
                    eligibility.task_eligible,eligibility.processor_payment_eligible,
                    eligibility.payout_funding_eligible,eligibility.trust_tier,
                    eligibility.blocker_codes,eligibility.policy_version,
                    eligibility.evidence||jsonb_build_object(
                      'system_test_successor_after_secure',true
                    ),eligibility.decided_by,
                    eligibility.idempotency_key||':after-secure',
                    clock_timestamp(),eligibility.valid_until
               FROM task_provider_eligibility_decisions eligibility
              WHERE eligibility.id=$1
             RETURNING id`,
            [lane.interest.eligibility_decision_id]
          );
          successorEligibilityId = successor.rows[0]!.id;
        }
        return repository.finalizeMaterialization(...args);
      },
    };
    const authority = localFakeFinanceAuthority();
    const application = new UniversalV1WorkOrderApplication(
      new PostgresUniversalV1WorkOrderPublicFactReader(database.query),
      invalidatingRepository as never,
      () => createUniversalV1FakeFinancialApplicationService(
        database,
        authority.env,
        authority.release,
        authority.identity
      )
    );

    await expect(
      application.secureAndMaterializeFakeWorkOrder(lane.fixture.posterUserId, {
        conditional_hold_id: lane.hold.conditional_hold_id,
        expected_eligibility_version: lane.interest.eligibility_version,
        idempotency_key: idempotencyKey,
        client_ts: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'WORK_ORDER_AUTHORITY_REVOKED' });
    expect(successorEligibilityId).not.toBeNull();

    const compensated = await workOrderEffectSnapshot({
      draftId: lane.fixture.draftId,
      taskId: lane.accepted.task_id,
      interestId: lane.interest.interest_application_id,
      holdId: lane.hold.conditional_hold_id,
      idempotencyKey,
    });
    expect(compensated).toMatchObject({
      worker_id: null,
      task_work_order_id: null,
      work_orders: 0,
      witnesses: 1,
      security_events: 4,
      fake_operations: 4,
      fake_operation_events: 4,
      approved_provider_operations: 0,
      non_fake_security_events: 0,
      non_fake_external_references: 0,
      escrows: 0,
      quote_payments: 0,
      interest_status: 'pending',
      hold_status: 'ACTIVE',
      security_event_kinds: ['PAYMENT_METHOD_PREPARED', 'AUTHORIZED', 'SECURED', 'VOIDED'],
      security_event_providers: ['FAKE'],
    });

    const compensation = await workOrderCompensationCommand(idempotencyKey);
    const replayedVoid = await executeUniversalV1WorkOrderCompensation(
      fakeFinanceService(),
      compensation
    );
    expect(replayedVoid).toMatchObject({
      operationId: deterministicUuid(idempotencyKey, 'void'),
      eventKind: 'VOIDED',
      status: 'SUCCEEDED',
      providerKind: 'FAKE',
      predecessorEventId: compensation.secured_event_id,
      idempotencyReplayed: true,
    });
    expect(
      await workOrderEffectSnapshot({
        draftId: lane.fixture.draftId,
        taskId: lane.accepted.task_id,
        interestId: lane.interest.interest_application_id,
        holdId: lane.hold.conditional_hold_id,
        idempotencyKey,
      })
    ).toEqual(compensated);

    const exact = await pool.query<{
      compensation_commands: number;
      successor_decisions: number;
      work_orders: number;
      approved_provider_commands: number;
    }>(
      `SELECT
       (SELECT COUNT(*)::integer
          FROM universal_v1_work_order_compensation_commands compensation
         WHERE compensation.work_order_idempotency_key=$1
           AND compensation.eligibility_decision_id=$2
           AND compensation.secured_operation_id=$3
           AND compensation.void_operation_id=$4) AS compensation_commands,
       (SELECT COUNT(*)::integer
          FROM task_provider_eligibility_decisions eligibility
         WHERE eligibility.id=$5
           AND eligibility.supersedes_decision_id=$2) AS successor_decisions,
       (SELECT COUNT(*)::integer FROM task_work_orders work_order
         WHERE work_order.task_id=$6) AS work_orders,
       (SELECT COUNT(*)::integer FROM financial_provider_command_journal command
         WHERE command.operation_id=ANY($7::uuid[])
           AND command.provider_kind='APPROVED_PROVIDER') AS approved_provider_commands`,
      [
        idempotencyKey,
        lane.interest.eligibility_decision_id,
        deterministicUuid(idempotencyKey, 'secure'),
        deterministicUuid(idempotencyKey, 'void'),
        successorEligibilityId,
        lane.accepted.task_id,
        [
          ...financialOperationIds(idempotencyKey),
          deterministicUuid(idempotencyKey, 'void'),
        ],
      ]
    );
    expect(exact.rows[0]).toEqual({
      compensation_commands: 1,
      successor_decisions: 1,
      work_orders: 0,
      approved_provider_commands: 0,
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

  it('commits, fake-authorizes, materializes, and exactly replays one price-and-scope change', async () => {
    const lane = await heldWorkOrderLane('yard');
    const workOrder = await lane.application.secureAndMaterializeFakeWorkOrder(
      lane.fixture.posterUserId,
      {
        conditional_hold_id: lane.hold.conditional_hold_id,
        expected_eligibility_version: lane.interest.eligibility_version,
        idempotency_key: `workorder-price-change:${randomUUID()}`,
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
        idempotency_key: `price-change-acknowledge:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    const changeOrders = new UniversalV1ChangeOrderApplication(
      new PostgresUniversalV1ChangeOrderRepository(database),
      () => fakeFinanceService()
    );
    const currentEconomics = await pool.query<{
      customer_total_cents: number;
      provider_payout_cents: number;
    }>(
      `SELECT customer_total_cents::integer,
              hustler_payout_cents::integer AS provider_payout_cents
         FROM task_scope_versions
        WHERE id = $1`,
      [lane.accepted.scope_version_id]
    );
    const customerTotalCents = Number(currentEconomics.rows[0]!.customer_total_cents) + 3_000;
    const providerPayoutCents = Number(currentEconomics.rows[0]!.provider_payout_cents) + 2_000;
    const proposal = await changeOrders.proposeChangeOrder(lane.fixture.posterUserId, {
      work_order_id: workOrder.work_order_id,
      expected_scope_version: lane.scopeVersion,
      expected_amendment_version: 0,
      expected_latest_proposal_version: 0,
      observed_scope_summary: 'Add customer-approved debris hauling and exact revised economics.',
      proposed_scope: {
        title: 'Yard cleanup with debris hauling',
        description:
          'Complete the accepted yard cleanup and haul the customer-approved debris load.',
        requirements: 'Keep all work inside the marked yard and use the approved disposal route.',
        checklist: [
          'Complete the accepted yard cleanup',
          'Load the approved debris',
          'Record disposal completion evidence',
        ],
      },
      change_order_kind: 'PRICE_AND_SCOPE',
      proposed_customer_total_cents: customerTotalCents,
      proposed_provider_payout_cents: providerPayoutCents,
      idempotency_key: `price-change-proposal:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    await changeOrders.decideChangeOrder(lane.fixture.provider.actor_user_id, {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: proposal.proposal_version,
      decision: 'APPROVED',
      reason: 'Provider approves the exact revised scope and economics.',
      idempotency_key: `price-change-provider-approval:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    await changeOrders.decideChangeOrder(lane.fixture.posterUserId, {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: proposal.proposal_version,
      decision: 'APPROVED',
      reason: 'Customer approves the exact revised scope and economics.',
      idempotency_key: `price-change-customer-approval:${randomUUID()}`,
      client_ts: new Date().toISOString(),
    });
    const financialBefore = await pool.query<{ expected_version: number }>(
      `SELECT MAX(expected_version)::integer AS expected_version
         FROM task_financial_security_events
        WHERE task_id = $1`,
      [lane.accepted.task_id]
    );
    const idempotencyKey = `price-change-finalization:${randomUUID()}`;
    const command = {
      proposal_id: proposal.proposal_id,
      expected_proposal_version: proposal.proposal_version,
      expected_scope_version: lane.scopeVersion,
      expected_amendment_version: 0,
      expected_execution_version: acknowledged.execution_version,
      expected_financial_version: Number(financialBefore.rows[0]?.expected_version),
      idempotency_key: idempotencyKey,
      client_ts: new Date().toISOString(),
    };
    const amendment = await changeOrders.authorizeAndMaterializeFakeChangeOrder(
      lane.fixture.posterUserId,
      command
    );
    expect(amendment).toMatchObject({
      proposal_id: proposal.proposal_id,
      amendment_version: 1,
      scope_version: lane.scopeVersion + 1,
      provider_kind: 'FAKE',
      replayed: false,
      payment_creation_performed: false,
      hard_assignment_created: false,
    });
    expect(amendment.adjustment_event_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );

    const exactFacts = await pool.query<{
      witness_count: string;
      adjustment_count: string;
      bridge_count: string;
      amendment_count: string;
      active_scope_version_id: string;
      scope_customer_total_cents: number;
      scope_provider_payout_cents: number;
      projected_task_price: number;
      worker_id: string | null;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM universal_v1_change_order_materialization_commands command
           WHERE command.proposal_id = $1) AS witness_count,
         (SELECT COUNT(*) FROM task_financial_security_events financial
           WHERE financial.change_order_id = $1
             AND financial.event_kind = 'ADJUSTMENT_AUTHORIZED'
             AND financial.status = 'SUCCEEDED'
             AND financial.provider_kind = 'FAKE') AS adjustment_count,
         (SELECT COUNT(*) FROM universal_v1_fake_financial_lifecycle_bridges bridge
           JOIN task_financial_security_events financial
             ON financial.id = bridge.task_financial_security_event_id
           WHERE financial.change_order_id = $1
             AND bridge.fake_operation_kind = 'ADJUST') AS bridge_count,
         (SELECT COUNT(*) FROM task_work_order_amendments amendment
           WHERE amendment.change_order_id = $1
             AND amendment.adjustment_event_id = $2) AS amendment_count,
         task.active_scope_version_id,
         active_scope.customer_total_cents AS scope_customer_total_cents,
         active_scope.hustler_payout_cents AS scope_provider_payout_cents,
         task.price AS projected_task_price,
         task.worker_id
       FROM tasks task
       JOIN task_scope_versions active_scope ON active_scope.id = task.active_scope_version_id
       WHERE task.id = $3`,
      [proposal.proposal_id, amendment.adjustment_event_id, lane.accepted.task_id]
    );
    expect(exactFacts.rows[0]).toEqual({
      witness_count: '1',
      adjustment_count: '1',
      bridge_count: '1',
      amendment_count: '1',
      active_scope_version_id: amendment.scope_version_id,
      scope_customer_total_cents: customerTotalCents,
      scope_provider_payout_cents: providerPayoutCents,
      projected_task_price: customerTotalCents,
      worker_id: null,
    });

    const occurrencePurpose = 'Verify the exact approved change-order occurrence projection.';
    const occurrence = new UniversalV1OccurrenceReadApplication(
      new PostgresUniversalV1OccurrenceFactReader(database.readQuery),
      new PostgresUniversalV1OperationsOccurrenceReader(database.transaction)
    );
    const customerView = await occurrence.customer(
      lane.fixture.draftId,
      lane.fixture.posterUserId
    );
    const providerView = await occurrence.provider(
      lane.fixture.draftId,
      lane.fixture.provider.actor_user_id
    );
    const operationsView = await occurrence.operationsAudited(
      lane.fixture.draftId,
      lane.fixture.invitationOperatorUserId,
      occurrencePurpose
    );
    const occurrenceAudit = await pool.query<{
      actor_id: string;
      purpose: string;
      projection_sha256: string;
    }>(
      `SELECT actor_id, purpose, projection_sha256
         FROM universal_v1_occurrence_access_audit
        WHERE task_draft_id = $1
          AND actor_id = $2
          AND purpose = $3
        ORDER BY observed_at DESC, id DESC
        LIMIT 1`,
      [lane.fixture.draftId, lane.fixture.invitationOperatorUserId, occurrencePurpose]
    );
    expect(occurrenceAudit.rows[0]).toEqual({
      actor_id: lane.fixture.invitationOperatorUserId,
      purpose: occurrencePurpose,
      projection_sha256: universalV1OccurrenceProjectionSha256(operationsView),
    });
    expect(customerView.scope).toMatchObject({
      scope_version_id: amendment.scope_version_id,
      version: lane.scopeVersion + 1,
      source: 'APPROVED_CHANGE',
      customer_total_cents: customerTotalCents,
    });
    expect(customerView.scope).not.toHaveProperty('provider_payout_cents');
    expect(providerView.scope).toMatchObject({
      scope_version_id: amendment.scope_version_id,
      version: lane.scopeVersion + 1,
      source: 'APPROVED_CHANGE',
      customer_total_cents: customerTotalCents,
      provider_payout_cents: providerPayoutCents,
    });
    expect(operationsView.scope).toMatchObject({
      scope_version_id: amendment.scope_version_id,
      version: lane.scopeVersion + 1,
      source: 'APPROVED_CHANGE',
      customer_total_cents: customerTotalCents,
      provider_payout_cents: providerPayoutCents,
    });
    for (const view of [customerView, providerView, operationsView]) {
      expect(view).toMatchObject({
        work_order: { work_order_id: workOrder.work_order_id },
        execution: {
          execution_version: acknowledged.execution_version + 1,
          transition_kind: 'APPLY_AMENDMENT',
        },
        payment_creation_frozen: true,
        hard_assignment_created: false,
        final_availability_confirmation_required: true,
      });
    }

    await expect(
      changeOrders.authorizeAndMaterializeFakeChangeOrder(
        lane.fixture.posterUserId,
        command
      )
    ).resolves.toEqual({ ...amendment, replayed: true });
    await expect(
      changeOrders.authorizeAndMaterializeFakeChangeOrder(lane.fixture.posterUserId, {
        ...command,
        idempotency_key: `price-change-conflict:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      })
    ).rejects.toMatchObject({ code: 'CHANGE_ORDER_IDEMPOTENCY_CONFLICT' });
  });

  it(
    'recovers every price-change crash boundary and terminally seals revoked authority',
    async () => {
      const phaseACrash = await preparedPriceAndScopeRecoveryLane('phase-a-crash');
      const revokedBeforeAdjust = await preparedPriceAndScopeRecoveryLane(
        'revoked-before-adjust'
      );
      const confirmedNoEffect = await preparedPriceAndScopeRecoveryLane(
        'confirmed-no-effect'
      );
      const revokedAfterAdjust = await preparedPriceAndScopeRecoveryLane(
        'revoked-after-adjust'
      );
      const amendmentRace = await preparedPriceAndScopeRecoveryLane('amendment-race');
      const witnessFirst = await preparedPriceAndScopeRecoveryLane('witness-first-slot');
      const financeFirst = await approvedPriceAndScopeRecoveryLane('finance-first-slot');

      const declinedAdjustment = await executeRecoveryAdjustment(
        confirmedNoEffect,
        'DECLINE'
      );
      expect(declinedAdjustment).toMatchObject({
        operationId: confirmedNoEffect.phase.context.adjustmentOperationId,
        eventKind: 'ADJUSTMENT_AUTHORIZED',
        status: 'DECLINED',
        providerKind: 'FAKE',
      });
      const succeededAfterRevocationBoundary = await executeRecoveryAdjustment(
        revokedAfterAdjust
      );
      const succeededForAmendmentRace = await executeRecoveryAdjustment(amendmentRace);
      expect(succeededAfterRevocationBoundary.status).toBe('SUCCEEDED');
      expect(succeededForAmendmentRace.status).toBe('SUCCEEDED');

      await pool.query(`UPDATE users SET is_banned = TRUE WHERE id = $1`, [
        revokedBeforeAdjust.fixture.provider.provider_user_id,
      ]);
      await pool.query(`UPDATE users SET is_banned = TRUE WHERE id = $1`, [
        revokedAfterAdjust.fixture.posterUserId,
      ]);

      const preparedAuthority = new PostgresUniversalV1PreparedFinancialCommandAuthority(
        database
      );
      const witnessFirstContext = witnessFirst.phase.context;
      const conflictingAdjustmentOperationId = randomUUID();
      await expect(
        preparedAuthority.prepare({
          operationKind: 'ADJUST',
          operationId: conflictingAdjustmentOperationId,
          providerKind: 'FAKE',
          idempotencyKey: `witness-first-conflict:${randomUUID()}`,
          providerExpectedVersion: 0,
          lifecycleExpectedVersion: witnessFirstContext.expectedFinancialVersion + 1,
          providerRequestSha256: createHash('sha256')
            .update(`witness-first:${conflictingAdjustmentOperationId}`)
            .digest('hex'),
          taskDraftId: witnessFirstContext.taskDraftId,
          taskId: witnessFirstContext.taskId,
          eligibilityDecisionId: witnessFirstContext.eligibilityDecisionId,
          scopeVersionId: witnessFirstContext.scopeVersionId,
          changeOrderId: witnessFirstContext.proposalId,
          predecessorEventId: witnessFirstContext.predecessorEventId,
          completionFactId: null,
          relatedOperationId: witnessFirstContext.predecessorOperationId,
          amountCents: witnessFirstContext.customerTotalCents,
          currency: witnessFirstContext.currency,
          recordedBy: witnessFirst.fixture.posterUserId,
        })
      ).rejects.toThrow(/HXUV1-CHANGE-(?:3P-4|RECOVERY-29)/u);
      expect(
        await pool.query(
          `SELECT 1 FROM universal_v1_prepared_financial_commands
            WHERE operation_id = $1`,
          [conflictingAdjustmentOperationId]
        )
      ).toMatchObject({ rowCount: 0 });

      const financeFirstOperationId = randomUUID();
      await expect(
        preparedAuthority.prepare({
          operationKind: 'VOID',
          operationId: financeFirstOperationId,
          providerKind: 'FAKE',
          idempotencyKey: `finance-first-void:${randomUUID()}`,
          providerExpectedVersion: 0,
          lifecycleExpectedVersion: financeFirst.predecessor.expected_version + 1,
          providerRequestSha256: createHash('sha256')
            .update(`finance-first:${financeFirstOperationId}`)
            .digest('hex'),
          taskDraftId: financeFirst.fixture.draftId,
          taskId: financeFirst.accepted.task_id,
          eligibilityDecisionId: financeFirst.interest.eligibility_decision_id,
          scopeVersionId: financeFirst.accepted.scope_version_id,
          changeOrderId: null,
          predecessorEventId: financeFirst.predecessor.id,
          completionFactId: null,
          relatedOperationId: financeFirst.predecessor.operation_id,
          amountCents: financeFirst.predecessor.amount_cents,
          currency: financeFirst.predecessor.currency,
          recordedBy: financeFirst.fixture.posterUserId,
        })
      ).resolves.toMatchObject({
        operationKind: 'VOID',
        operationId: financeFirstOperationId,
        workOrderId: financeFirst.workOrder.work_order_id,
        commandState: 'PREPARED',
      });
      await expect(
        financeFirst.repository.preparePriceAndScopeMaterialization(
          financeFirst.fixture.posterUserId,
          financeFirst.command
        )
      ).rejects.toThrow(/HXUV1-CHANGE-RECOVERY-30/u);
      const rolledBackFinanceFirst = await pool.query<{
        witnesses: number;
        approved_change_scopes: number;
        proposal_status: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::integer
              FROM universal_v1_change_order_materialization_commands command
             WHERE command.proposal_id = proposal.id) AS witnesses,
           (SELECT COUNT(*)::integer
              FROM task_scope_versions scope
             WHERE scope.task_id = proposal.task_id
               AND scope.source = 'APPROVED_CHANGE') AS approved_change_scopes,
           proposal.status AS proposal_status
         FROM task_scope_change_proposals proposal
        WHERE proposal.id = $1`,
        [financeFirst.proposal.proposal_id]
      );
      expect(rolledBackFinanceFirst.rows[0]).toEqual({
        witnesses: 0,
        approved_change_scopes: 0,
        proposal_status: 'PENDING',
      });

      // Recovery intentionally waits for an age floor so a foreground Phase C
      // has the first opportunity to finish. One bounded wait ages every fixture.
      await pool.query('SELECT pg_sleep(5.1)');
      const recoveryRepository = new PostgresUniversalV1ChangeOrderRecoveryRepository(
        database
      );
      const recoveryService = new UniversalV1ChangeOrderRecoveryService(
        recoveryRepository,
        new PostgresUniversalV1ChangeOrderRepository(database)
      );
      const claims = await recoveryRepository.claimDue({
        leaseOwnerId: randomUUID(),
        limit: 100,
        leaseDurationSeconds: 60,
        minimumAgeSeconds: 5,
      });
      const claimFor = (proposalId: string) => {
        const claim = claims.find((candidate) => candidate.proposalId === proposalId);
        if (!claim) throw new Error(`SYSTEM_TEST_RECOVERY_CLAIM_MISSING:${proposalId}`);
        return claim;
      };

      const phaseAResult = await recoveryService.recover(
        claimFor(phaseACrash.proposal.proposal_id),
        fakeFinanceService()
      );
      expect(phaseAResult).toMatchObject({
        status: 'MATERIALIZED',
        terminal: true,
        holdsMayClear: true,
        allowedNextCommands: 'ORDINARY_AMENDMENT_FLOW',
      });

      const materializedAdjustment = await pool.query<{
        id: string;
        expected_version: number;
        amount_cents: number;
        currency: string;
      }>(
        `SELECT id, expected_version::integer, amount_cents::integer, currency
           FROM task_financial_security_events
          WHERE change_order_id = $1
            AND event_kind = 'ADJUSTMENT_AUTHORIZED'
            AND status = 'SUCCEEDED'`,
        [phaseACrash.proposal.proposal_id]
      );
      expect(materializedAdjustment.rowCount).toBe(1);
      const arbitraryScopeDriftOperationId = randomUUID();
      const arbitraryScopeDriftIdempotencyKey = `arbitrary-drift:${randomUUID()}`;
      await expect(
        pool.query(
          `INSERT INTO public.task_financial_security_events (
             task_draft_id, task_id, eligibility_decision_id, scope_version_id,
             predecessor_event_id, event_kind, status, operation_id,
             idempotency_key, expected_version, provider_kind, amount_cents,
             currency, recorded_by, occurred_at
           ) VALUES (
             $1,$2,$3,$4,$5,'REVERSED','SUCCEEDED',$6,$7,$8,'FAKE',$9,$10,$11,
             clock_timestamp()
           )`,
          [
            phaseACrash.fixture.draftId,
            phaseACrash.accepted.task_id,
            phaseACrash.interest.eligibility_decision_id,
            phaseACrash.accepted.scope_version_id,
            materializedAdjustment.rows[0]!.id,
            arbitraryScopeDriftOperationId,
            arbitraryScopeDriftIdempotencyKey,
            materializedAdjustment.rows[0]!.expected_version + 1,
            materializedAdjustment.rows[0]!.amount_cents,
            materializedAdjustment.rows[0]!.currency,
            phaseACrash.fixture.posterUserId,
          ]
        )
      ).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('HXUV1-FIN-12'),
      });
      const arbitraryScopeDriftPersistence = await pool.query<{
        operations: number;
        events: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::integer FROM task_financial_operations operation
             WHERE operation.operation_id = $1) AS operations,
           (SELECT COUNT(*)::integer FROM task_financial_security_events event
             WHERE event.operation_id = $1) AS events`,
        [arbitraryScopeDriftOperationId]
      );
      expect(arbitraryScopeDriftPersistence.rows[0]).toEqual({
        operations: 0,
        events: 0,
      });

      const revokedBeforeClaim = claimFor(revokedBeforeAdjust.proposal.proposal_id);
      expect(revokedBeforeClaim).toMatchObject({
        observation: 'ADJUST_NO_EFFECT_AUTHORITY_REVOKED',
        adjustmentOutcomeFactId: null,
        authorityRevocationReason: expect.any(String),
      });
      const revokedBeforeResult = await recoveryService.recover(
        revokedBeforeClaim,
        fakeFinanceService()
      );
      expect(revokedBeforeResult).toEqual({
        status: 'CANCELLED_RECOVERY_REQUIRED',
        terminal: true,
        holdsMayClear: true,
        allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY',
        terminalEvidence: 'NO_EFFECT',
        compensationEventId: null,
      });

      const confirmedNoEffectClaim = claimFor(confirmedNoEffect.proposal.proposal_id);
      expect(confirmedNoEffectClaim).toMatchObject({
        observation: 'ADJUST_TERMINAL_NO_EFFECT',
        adjustmentOutcomeFactId: expect.any(String),
        authorityRevocationReason: null,
      });
      const confirmedNoEffectResult = await recoveryService.recover(
        confirmedNoEffectClaim,
        fakeFinanceService()
      );
      expect(confirmedNoEffectResult).toEqual({
        status: 'CANCELLED_RECOVERY_REQUIRED',
        terminal: true,
        holdsMayClear: true,
        allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY',
        terminalEvidence: 'NO_EFFECT',
        compensationEventId: null,
      });

      const revokedAfterResult = await recoveryService.recover(
        claimFor(revokedAfterAdjust.proposal.proposal_id),
        fakeFinanceService()
      );
      expect(revokedAfterResult).toMatchObject({
        status: 'CANCELLED_RECOVERY_REQUIRED',
        terminal: true,
        holdsMayClear: true,
        allowedNextCommands: 'BOUNDED_CANCELLATION_RECOVERY_ONLY',
        terminalEvidence: 'REVERSAL',
        compensationEventId: expect.any(String),
      });

      const raceClaim = claimFor(amendmentRace.proposal.proposal_id);
      const [compensationContender, amendmentContender] = await Promise.allSettled([
        recoveryRepository.claimCompensation(
          raceClaim,
          succeededForAmendmentRace.id
        ),
        amendmentRace.repository.finalizePriceAndScopeMaterialization(
          amendmentRace.phase,
          succeededForAmendmentRace.id,
          amendmentRace.fixture.posterUserId
        ),
      ]);
      expect(amendmentContender.status).toBe('fulfilled');
      if (compensationContender.status === 'fulfilled') {
        expect(compensationContender.value.kind).toBe('AMENDMENT_MATERIALIZED');
      } else {
        expect(compensationContender.reason).toBeInstanceOf(Error);
      }
      await expect(
        recoveryService.recover(raceClaim, fakeFinanceService())
      ).resolves.toMatchObject({ status: 'MATERIALIZED', terminal: true });
      const raceWinner = await pool.query<{
        amendments: number;
        compensation_commands: number;
        materialized_terminals: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::integer FROM task_work_order_amendments amendment
             WHERE amendment.change_order_id = $1) AS amendments,
           (SELECT COUNT(*)::integer
              FROM universal_v1_change_order_compensation_commands compensation
             WHERE compensation.proposal_id = $1) AS compensation_commands,
           (SELECT COUNT(*)::integer
              FROM universal_v1_change_order_recovery_terminal_facts terminal
             WHERE terminal.proposal_id = $1
               AND terminal.outcome_state = 'MATERIALIZED') AS materialized_terminals`,
        [amendmentRace.proposal.proposal_id]
      );
      expect(raceWinner.rows[0]).toEqual({
        amendments: 1,
        compensation_commands: 0,
        materialized_terminals: 1,
      });

      const terminalFacts = await pool.query<{
        proposal_id: string;
        outcome_state: string;
        recovery_state: string;
        adjustment_event_id: string | null;
        compensation_event_id: string | null;
        no_effect_outcome_fact_id: string | null;
        authority_revocation_reason: string | null;
        resolution_evidence_kind: string;
        prior_secured_state_restored: boolean;
        execution_resume_authorized: boolean;
        capture_resume_authorized: boolean;
      }>(
        `SELECT proposal_id, outcome_state, recovery_state, adjustment_event_id,
                compensation_event_id, no_effect_outcome_fact_id,
                authority_revocation_reason, resolution_evidence_kind,
                prior_secured_state_restored, execution_resume_authorized,
                capture_resume_authorized
           FROM universal_v1_change_order_recovery_terminal_facts
          WHERE proposal_id = ANY($1::uuid[])
          ORDER BY proposal_id`,
        [[
          revokedBeforeAdjust.proposal.proposal_id,
          confirmedNoEffect.proposal.proposal_id,
          revokedAfterAdjust.proposal.proposal_id,
        ]]
      );
      const terminalByProposal = new Map(
        terminalFacts.rows.map((fact) => [fact.proposal_id, fact])
      );
      expect(terminalByProposal.get(revokedBeforeAdjust.proposal.proposal_id)).toMatchObject({
        outcome_state: 'CANCELLED',
        recovery_state: 'RECOVERY_REQUIRED',
        adjustment_event_id: null,
        compensation_event_id: null,
        no_effect_outcome_fact_id: null,
        authority_revocation_reason: 'PROVIDER_ACTOR_AUTHORITY_REVOKED',
        resolution_evidence_kind: 'NO_EFFECT',
        prior_secured_state_restored: false,
        execution_resume_authorized: false,
        capture_resume_authorized: false,
      });
      expect(terminalByProposal.get(confirmedNoEffect.proposal.proposal_id)).toMatchObject({
        outcome_state: 'CANCELLED',
        recovery_state: 'RECOVERY_REQUIRED',
        adjustment_event_id: declinedAdjustment.id,
        compensation_event_id: null,
        no_effect_outcome_fact_id: expect.any(String),
        authority_revocation_reason: null,
        resolution_evidence_kind: 'NO_EFFECT',
        prior_secured_state_restored: false,
        execution_resume_authorized: false,
        capture_resume_authorized: false,
      });
      expect(terminalByProposal.get(revokedAfterAdjust.proposal.proposal_id)).toMatchObject({
        outcome_state: 'CANCELLED',
        recovery_state: 'RECOVERY_REQUIRED',
        adjustment_event_id: succeededAfterRevocationBoundary.id,
        compensation_event_id: revokedAfterResult.compensationEventId,
        no_effect_outcome_fact_id: null,
        authority_revocation_reason: null,
        resolution_evidence_kind: 'REVERSAL',
        prior_secured_state_restored: false,
        execution_resume_authorized: false,
        capture_resume_authorized: false,
      });

      await expect(
        revokedAfterAdjust.execution.advanceWorkOrderExecution(
          revokedAfterAdjust.fixture.provider.actor_user_id,
          {
            work_order_id: revokedAfterAdjust.workOrder.work_order_id,
            action: 'START_WORK',
            expected_execution_version: revokedAfterAdjust.acknowledged.execution_version,
            expected_scope_version: revokedAfterAdjust.scopeVersion,
            idempotency_key: `terminal-execution-denial:${randomUUID()}`,
            client_ts: new Date().toISOString(),
          }
        )
      ).rejects.toThrow(/HXUV1-CHANGE-RECOVERY-27/u);
      await expect(
        revokedAfterAdjust.changeOrders.proposeChangeOrder(
          revokedAfterAdjust.fixture.provider.actor_user_id,
          {
            work_order_id: revokedAfterAdjust.workOrder.work_order_id,
            expected_scope_version: revokedAfterAdjust.scopeVersion,
            expected_amendment_version: 0,
            expected_latest_proposal_version: revokedAfterAdjust.proposal.proposal_version,
            observed_scope_summary: 'Attempted proposal after terminal recovery.',
            proposed_scope: {
              title: 'Forbidden post-recovery scope',
              description: 'This proposal must never become authoritative.',
              requirements: null,
              checklist: ['Remain terminally held'],
            },
            change_order_kind: 'SCOPE_ONLY',
            idempotency_key: `terminal-proposal-denial:${randomUUID()}`,
            client_ts: new Date().toISOString(),
          }
        )
      ).rejects.toThrow(/HXUV1-CHANGE-RECOVERY-28/u);

      const captureOperationId = randomUUID();
      await expect(
        preparedAuthority.prepare({
          operationKind: 'CAPTURE',
          operationId: captureOperationId,
          providerKind: 'FAKE',
          idempotencyKey: `terminal-capture-denial:${randomUUID()}`,
          providerExpectedVersion: 0,
          lifecycleExpectedVersion:
            revokedAfterAdjust.phase.context.expectedFinancialVersion + 3,
          providerRequestSha256: createHash('sha256')
            .update(`terminal-capture:${captureOperationId}`)
            .digest('hex'),
          taskDraftId: revokedAfterAdjust.fixture.draftId,
          taskId: revokedAfterAdjust.accepted.task_id,
          eligibilityDecisionId: revokedAfterAdjust.interest.eligibility_decision_id,
          scopeVersionId: revokedAfterAdjust.accepted.scope_version_id,
          changeOrderId: null,
          predecessorEventId: revokedAfterResult.compensationEventId,
          completionFactId: randomUUID(),
          relatedOperationId: deterministicUuid(
            revokedAfterAdjust.phase.idempotencyKey,
            'recovery:reversal'
          ),
          amountCents: revokedAfterAdjust.customerTotalCents,
          currency: revokedAfterAdjust.predecessor.currency,
          recordedBy: revokedAfterAdjust.fixture.posterUserId,
        })
      ).rejects.toThrow();
      const terminalAuthority = await pool.query<{
        resolution: string;
        capture_preparations: number;
      }>(
        `SELECT public.universal_v1_change_order_recovery_resolution_v1($1) AS resolution,
                (SELECT COUNT(*)::integer
                   FROM universal_v1_prepared_financial_commands prepared
                  WHERE prepared.operation_id = $2) AS capture_preparations`,
        [revokedAfterAdjust.proposal.proposal_id, captureOperationId]
      );
      expect(terminalAuthority.rows[0]).toEqual({
        resolution: 'CANCELLED_RECOVERY_REQUIRED',
        capture_preparations: 0,
      });

      const materializedClaim = claimFor(phaseACrash.proposal.proposal_id);
      const materializedAmendment = await pool.query<{
        amendment_id: string;
        adjustment_event_id: string;
      }>(
        `SELECT amendment.id AS amendment_id, amendment.adjustment_event_id
           FROM task_work_order_amendments amendment
          WHERE amendment.change_order_id = $1`,
        [phaseACrash.proposal.proposal_id]
      );
      const runtimeRole = 'hx_change_recovery_test_worker';
      const roleClient = await pool.connect();
      const dropRuntimeRole = async () => {
        const existing = await roleClient.query(
          `SELECT 1 FROM pg_roles WHERE rolname = $1`,
          [runtimeRole]
        );
        if (existing.rowCount === 0) return;
        await roleClient.query(
          `REVOKE EXECUTE ON FUNCTION public.record_universal_v1_change_order_materialized_recovery_v1(uuid,uuid,uuid,uuid,uuid) FROM ${runtimeRole}`
        );
        await roleClient.query(`REVOKE USAGE ON SCHEMA public FROM ${runtimeRole}`);
        await roleClient.query(`REVOKE ${runtimeRole} FROM hx_ci_runner`);
        await roleClient.query(`DROP ROLE ${runtimeRole}`);
      };
      try {
        await dropRuntimeRole();
        await roleClient.query(`CREATE ROLE ${runtimeRole} NOLOGIN`);
        await roleClient.query(`GRANT ${runtimeRole} TO hx_ci_runner`);
        await roleClient.query(`GRANT USAGE ON SCHEMA public TO ${runtimeRole}`);
        await roleClient.query(
          `GRANT EXECUTE ON FUNCTION public.record_universal_v1_change_order_materialized_recovery_v1(uuid,uuid,uuid,uuid,uuid) TO ${runtimeRole}`
        );
        await roleClient.query(`SET ROLE ${runtimeRole}`);
        await expect(
          roleClient.query(
            `INSERT INTO public.universal_v1_change_order_recovery_leases(
               proposal_id, lease_owner_id, lease_duration_seconds, expires_at
             ) VALUES ($1,$2,60,clock_timestamp() + interval '60 seconds')`,
            [phaseACrash.proposal.proposal_id, randomUUID()]
          )
        ).rejects.toMatchObject({ code: '42501' });
        const typedReplay = await roleClient.query<{ terminal_fact_id: string }>(
          `SELECT terminal_fact_id
             FROM public.record_universal_v1_change_order_materialized_recovery_v1(
               $1,$2,$3,$4,$5
             )`,
          [
            phaseACrash.proposal.proposal_id,
            materializedClaim.recoveryLeaseId,
            materializedClaim.leaseOwnerId,
            materializedAmendment.rows[0]!.amendment_id,
            materializedAmendment.rows[0]!.adjustment_event_id,
          ]
        );
        expect(typedReplay.rowCount).toBe(1);
      } finally {
        await roleClient.query('RESET ROLE');
        try {
          await dropRuntimeRole();
        } finally {
          roleClient.release();
        }
      }
    },
    60_000
  );

  it('serializes one organization account across owner/admin actors and rejects forged or out-of-order authority', async () => {
    const provider = await verifiedTradeProviderFixture();
    const organizationId = provider.provider_organization_id!;
    const ownerUserId = provider.actor_user_id;
    const adminUserId = await userFixture('worker');
    await pool.query(
      `INSERT INTO business_memberships(
         organization_id, user_id, role, status, invited_by, accepted_at
       ) VALUES ($1, $2, 'ADMIN', 'ACTIVE', $3, clock_timestamp())`,
      [organizationId, adminUserId, ownerUserId]
    );

    const repository = new PostgresUniversalV1FakeProviderAccountRepository(database);
    const providerSubject = { kind: 'ORGANIZATION' as const, organizationId };
    const evidence = async (
      actorId: string,
      suffix: string,
      refreshScenario: 'SUCCESS' | 'PROVIDER_ACCOUNT_FAILURE' = 'SUCCESS'
    ) => {
      const key = `provider-account-authority:${suffix}:${randomUUID()}`;
      const finance = fakeFinanceService();
      const onboard = await finance.onboardProvider({
        providerKind: 'FAKE',
        operationId: deterministicUuid(key, 'onboard'),
        idempotencyKey: `${key}:onboard`,
        providerExpectedVersion: 0,
        providerId: organizationId,
        scenario: 'SUCCESS',
        recordedBy: actorId,
      });
      const refresh = await finance.refreshProviderAccountState({
        providerKind: 'FAKE',
        operationId: deterministicUuid(key, 'refresh'),
        idempotencyKey: `${key}:refresh`,
        providerExpectedVersion: 0,
        providerId: organizationId,
        providerAccountReference: onboard.externalReference,
        scenario: refreshScenario,
        recordedBy: actorId,
      });
      return {
        onboard: onboard.durableFakeEvidence,
        refresh: refresh.durableFakeEvidence,
        providerAccountReference: onboard.externalReference,
      };
    };

    const ownerEvidence = await evidence(ownerUserId, 'owner');
    const adminEvidence = await evidence(adminUserId, 'admin');
    const competingInputs = [
      {
        providerSubject,
        recordedBy: ownerUserId,
        onboard: ownerEvidence.onboard,
        refresh: ownerEvidence.refresh,
      },
      {
        providerSubject,
        recordedBy: adminUserId,
        onboard: adminEvidence.onboard,
        refresh: adminEvidence.refresh,
      },
    ] as const;
    const competingOutcomes = await Promise.allSettled(
      competingInputs.map((input) => repository.materializeFromDurableEvidence(input))
    );
    const winnerIndex = competingOutcomes.findIndex((outcome) => outcome.status === 'fulfilled');
    const refusedIndex = competingOutcomes.findIndex((outcome) => outcome.status === 'rejected');
    expect(winnerIndex).toBeGreaterThanOrEqual(0);
    expect(refusedIndex).toBeGreaterThanOrEqual(0);
    expect(competingOutcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(competingOutcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect((competingOutcomes[refusedIndex] as PromiseRejectedResult).reason).toMatchObject({
      code: '40001',
    });
    const firstFact = (
      competingOutcomes[winnerIndex] as PromiseFulfilledResult<
        Awaited<ReturnType<typeof repository.materializeFromDurableEvidence>>
      >
    ).value;
    const retriedFact = await repository.materializeFromDurableEvidence(
      competingInputs[refusedIndex]!
    );
    const orderedFacts = [firstFact, retriedFact].sort(
      (left, right) => left.accountVersion - right.accountVersion
    );
    expect(orderedFacts.map((fact) => fact.accountVersion)).toEqual([1, 2]);
    expect(orderedFacts[1]).toMatchObject({
      supersedesFactId: orderedFacts[0]!.providerAccountFactId,
      providerSubject,
      accountState: 'ENABLED',
      payoutsEnabled: true,
    });
    expect(new Set(orderedFacts.map((fact) => fact.recordedBy))).toEqual(
      new Set([ownerUserId, adminUserId])
    );
    await expect(repository.findLatestPayoutReady({ providerSubject })).resolves.toMatchObject({
      providerAccountFactId: orderedFacts[1]!.providerAccountFactId,
      accountVersion: 2,
    });

    const staleVersionEvidence = await evidence(adminUserId, 'stale-version');
    await expect(
      pool.query(
        `INSERT INTO public.universal_v1_fake_provider_account_facts (
           provider_subject_kind, provider_organization_id, account_version,
           onboard_command_id, onboard_dispatch_attempt_id, onboard_outcome_fact_id,
           onboard_fake_event_id, refresh_command_id, refresh_dispatch_attempt_id,
           refresh_outcome_fact_id, refresh_fake_event_id, recorded_by
         ) VALUES ('ORGANIZATION', $1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          organizationId,
          staleVersionEvidence.onboard.commandId,
          staleVersionEvidence.onboard.dispatchAttemptId,
          staleVersionEvidence.onboard.outcomeFactId,
          staleVersionEvidence.onboard.fakeOperationEventId,
          staleVersionEvidence.refresh.commandId,
          staleVersionEvidence.refresh.dispatchAttemptId,
          staleVersionEvidence.refresh.outcomeFactId,
          staleVersionEvidence.refresh.fakeOperationEventId,
          adminUserId,
        ]
      )
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('HXUV1-FTL-18'),
    });
    const thirdFact = await repository.materializeFromDurableEvidence({
      providerSubject,
      recordedBy: adminUserId,
      onboard: staleVersionEvidence.onboard,
      refresh: staleVersionEvidence.refresh,
    });
    expect(thirdFact).toMatchObject({
      accountVersion: 3,
      supersedesFactId: orderedFacts[1]!.providerAccountFactId,
      accountState: 'ENABLED',
    });

    const reusedOnboardRefreshKey = `provider-account-authority:reused-onboard:${randomUUID()}`;
    const reusedOnboardRefresh = await fakeFinanceService().refreshProviderAccountState({
      providerKind: 'FAKE',
      operationId: deterministicUuid(reusedOnboardRefreshKey, 'refresh'),
      idempotencyKey: `${reusedOnboardRefreshKey}:refresh`,
      providerExpectedVersion: 0,
      providerId: organizationId,
      providerAccountReference: staleVersionEvidence.providerAccountReference,
      scenario: 'PROVIDER_ACCOUNT_FAILURE',
      recordedBy: adminUserId,
    });
    const forgedStateEvidence = {
      onboard: staleVersionEvidence.onboard,
      refresh: reusedOnboardRefresh.durableFakeEvidence,
    };
    await expect(
      pool.query(
        `INSERT INTO public.universal_v1_fake_provider_account_facts (
           provider_subject_kind, provider_organization_id,
           onboard_command_id, onboard_dispatch_attempt_id, onboard_outcome_fact_id,
           onboard_fake_event_id, refresh_command_id, refresh_dispatch_attempt_id,
           refresh_outcome_fact_id, refresh_fake_event_id,
           account_state, charges_enabled, payouts_enabled, recorded_by
         ) VALUES (
           'ORGANIZATION', $1, $2, $3, $4, $5, $6, $7, $8, $9,
           'ENABLED', TRUE, TRUE, $10
         )`,
        [
          organizationId,
          forgedStateEvidence.onboard.commandId,
          forgedStateEvidence.onboard.dispatchAttemptId,
          forgedStateEvidence.onboard.outcomeFactId,
          forgedStateEvidence.onboard.fakeOperationEventId,
          forgedStateEvidence.refresh.commandId,
          forgedStateEvidence.refresh.dispatchAttemptId,
          forgedStateEvidence.refresh.outcomeFactId,
          forgedStateEvidence.refresh.fakeOperationEventId,
          adminUserId,
        ]
      )
    ).rejects.toMatchObject({
      code: 'P0001',
      message: expect.stringContaining('HXUV1-FTL-18'),
    });
    const restrictedLatest = await repository.materializeFromDurableEvidence({
      providerSubject,
      recordedBy: adminUserId,
      ...forgedStateEvidence,
    });
    expect(restrictedLatest).toMatchObject({
      accountVersion: 4,
      supersedesFactId: thirdFact.providerAccountFactId,
      accountState: 'FAILED',
      chargesEnabled: false,
      payoutsEnabled: false,
    });
    await expect(repository.findLatestPayoutReady({ providerSubject })).resolves.toBeNull();

    const causalKey = `provider-account-causal:${randomUUID()}`;
    const causalOnboardOperationId = deterministicUuid(causalKey, 'onboard');
    const expectedAccountReference = `fake_onboard_provider_${createHash('sha256')
      .update(JSON.stringify(causalOnboardOperationId), 'utf8')
      .digest('hex')
      .slice(0, 24)}`;
    const causalFinance = fakeFinanceService();
    const refreshBeforeOnboard = await causalFinance.refreshProviderAccountState({
      providerKind: 'FAKE',
      operationId: deterministicUuid(causalKey, 'refresh'),
      idempotencyKey: `${causalKey}:refresh`,
      providerExpectedVersion: 0,
      providerId: organizationId,
      providerAccountReference: expectedAccountReference,
      scenario: 'SUCCESS',
      recordedBy: adminUserId,
    });
    const laterOnboard = await causalFinance.onboardProvider({
      providerKind: 'FAKE',
      operationId: causalOnboardOperationId,
      idempotencyKey: `${causalKey}:onboard`,
      providerExpectedVersion: 0,
      providerId: organizationId,
      scenario: 'SUCCESS',
      recordedBy: adminUserId,
    });
    expect(laterOnboard.externalReference).toBe(expectedAccountReference);
    await expect(
      repository.materializeFromDurableEvidence({
        providerSubject,
        recordedBy: adminUserId,
        onboard: laterOnboard.durableFakeEvidence,
        refresh: refreshBeforeOnboard.durableFakeEvidence,
      })
    ).rejects.toMatchObject({ reason: 'EVIDENCE_INVALID' });

    const observationKey = `provider-account-observation-order:${randomUUID()}`;
    const observationOnboard = await fakeFinanceService().onboardProvider({
      providerKind: 'FAKE',
      operationId: deterministicUuid(observationKey, 'onboard'),
      idempotencyKey: `${observationKey}:onboard`,
      providerExpectedVersion: 0,
      providerId: organizationId,
      scenario: 'SUCCESS',
      recordedBy: adminUserId,
    });
    const oldSuccess = await fakeFinanceService().refreshProviderAccountState({
      providerKind: 'FAKE',
      operationId: deterministicUuid(observationKey, 'old-success'),
      idempotencyKey: `${observationKey}:old-success`,
      providerExpectedVersion: 0,
      providerId: organizationId,
      providerAccountReference: observationOnboard.externalReference,
      scenario: 'SUCCESS',
      recordedBy: adminUserId,
    });
    const newFailure = await fakeFinanceService().refreshProviderAccountState({
      providerKind: 'FAKE',
      operationId: deterministicUuid(observationKey, 'new-failure'),
      idempotencyKey: `${observationKey}:new-failure`,
      providerExpectedVersion: 0,
      providerId: organizationId,
      providerAccountReference: observationOnboard.externalReference,
      scenario: 'PROVIDER_ACCOUNT_FAILURE',
      recordedBy: adminUserId,
    });
    const latestFailure = await repository.materializeFromDurableEvidence({
      providerSubject,
      recordedBy: adminUserId,
      onboard: observationOnboard.durableFakeEvidence,
      refresh: newFailure.durableFakeEvidence,
    });
    expect(latestFailure).toMatchObject({
      accountVersion: 5,
      accountState: 'FAILED',
      payoutsEnabled: false,
    });
    await expect(
      repository.materializeFromDurableEvidence({
        providerSubject,
        recordedBy: adminUserId,
        onboard: observationOnboard.durableFakeEvidence,
        refresh: oldSuccess.durableFakeEvidence,
      })
    ).rejects.toMatchObject({ reason: 'EVIDENCE_INVALID' });
    const latestObservation = await pool.query<{
      provider_account_fact_id: string;
      account_version: string;
      account_state: string;
      fact_count: string;
    }>(
      `SELECT fact.provider_account_fact_id, fact.account_version::text,
              fact.account_state, COUNT(*) OVER ()::text AS fact_count
         FROM universal_v1_fake_provider_account_facts fact
        WHERE fact.provider_subject_kind = 'ORGANIZATION'
          AND fact.provider_organization_id = $1
        ORDER BY fact.account_version DESC
        LIMIT 1`,
      [organizationId]
    );
    expect(latestObservation.rows[0]).toEqual({
      provider_account_fact_id: latestFailure.providerAccountFactId,
      account_version: '5',
      account_state: 'FAILED',
      fact_count: '5',
    });
    await expect(repository.findLatestPayoutReady({ providerSubject })).resolves.toBeNull();
  });

  it('delivers one completion notice through the real worker and loopback SMTP sink', async () => {
    const lane = await heldWorkOrderLane('yard');
    const materialized = await lane.application.secureAndMaterializeFakeWorkOrder(
      lane.fixture.posterUserId,
      {
        conditional_hold_id: lane.hold.conditional_hold_id,
        expected_eligibility_version: lane.interest.eligibility_version,
        idempotency_key: `smtp-worker-workorder:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    const execution = executionService();
    const genesis = await execution.getWorkOrderExecutionState(
      lane.fixture.provider.actor_user_id,
      { work_order_id: materialized.work_order_id }
    );
    const acknowledged = await execution.advanceWorkOrderExecution(
      lane.fixture.provider.actor_user_id,
      {
        work_order_id: materialized.work_order_id,
        action: 'ACKNOWLEDGE',
        expected_execution_version: genesis.execution_version,
        expected_scope_version: lane.scopeVersion,
        idempotency_key: `smtp-worker-acknowledge:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    const started = await execution.advanceWorkOrderExecution(
      lane.fixture.provider.actor_user_id,
      {
        work_order_id: materialized.work_order_id,
        action: 'START_WORK',
        expected_execution_version: acknowledged.execution_version,
        expected_scope_version: lane.scopeVersion,
        idempotency_key: `smtp-worker-start:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    const sinkActorId = await userFixture('poster');
    const fulfillment = fulfillmentService(sinkActorId);
    const submitted = await fulfillment.submitCompletionEvidence(
      lane.fixture.provider.actor_user_id,
      {
        work_order_id: materialized.work_order_id,
        expected_scope_version: lane.scopeVersion,
        expected_execution_version: started.execution_version,
        description: 'Real worker loopback SMTP completion evidence.',
        photo_evidence: [],
        decision_reason: 'Exercise the exact synthetic completion-notice adapter boundary.',
        idempotency_key: `smtp-worker-completion:${randomUUID()}`,
        client_ts: new Date().toISOString(),
      }
    );
    const dispatchAttemptId = randomUUID();
    const bullmqJobId = `completion-smtp-worker:${randomUUID()}`;
    const dispatch = await pool.query<{
      request_id: string;
      email_id: string;
      email_idempotency_key: string;
      event_version: number;
      payload: {
        emailId: string;
        userId: string;
        toEmail: string;
        template: string;
        params: Record<string, unknown>;
      };
    }>(
      `UPDATE outbox_events outbox
          SET status='enqueued',dispatch_attempt_id=$2,bullmq_job_id=$3,
              dispatch_deadline_at=clock_timestamp()+INTERVAL '5 minutes',
              updated_at=clock_timestamp()
         FROM email_outbox email
         JOIN task_completion_notice_requests notice_request
           ON notice_request.id=email.task_completion_notice_request_id
        WHERE notice_request.submitted_completion_fact_id=$1
          AND outbox.idempotency_key=notice_request.email_idempotency_key
          AND outbox.aggregate_id=email.id
        RETURNING notice_request.id AS request_id,email.id AS email_id,
                  notice_request.email_idempotency_key,outbox.event_version,
                  outbox.payload`,
      [submitted.completion_fact_id, dispatchAttemptId, bullmqJobId]
    );
    expect(dispatch.rows).toHaveLength(1);
    const dispatchRow = dispatch.rows[0]!;
    const financialBefore = await pool.query<{
      worker_id: string | null;
      security_events: string;
      financial_operations: string;
    }>(
      `SELECT task.worker_id,
              (SELECT COUNT(*)::text FROM task_financial_security_events event
                WHERE event.task_id=task.id) AS security_events,
              (SELECT COUNT(*)::text FROM task_financial_operations operation
                WHERE operation.task_id=task.id) AS financial_operations
         FROM tasks task WHERE task.id=$1`,
      [lane.accepted.task_id]
    );

    let acceptedMessages = 0;
    const smtpServer = createServer((socket) => {
      let buffer = '';
      let readingData = false;
      socket.write('220 hustlexp-completion-sink ready\r\n');
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split('\r\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (readingData) {
            if (line === '.') {
              readingData = false;
              acceptedMessages += 1;
              socket.write('250 completion accepted\r\n');
              // Final DATA acceptance is authoritative. Closing without a
              // QUIT/221 response must retain the deterministic receipt.
              socket.end();
            }
          } else if (line.startsWith('EHLO ')) {
            socket.write('250-hustlexp-completion-sink\r\n250 8BITMIME\r\n');
          } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) {
            socket.write('250 accepted\r\n');
          } else if (line === 'DATA') {
            readingData = true;
            socket.write('354 end with dot\r\n');
          }
        }
      });
    });
    await new Promise<void>((resolveListen) =>
      smtpServer.listen(0, '127.0.0.1', resolveListen)
    );
    const smtpAddress = smtpServer.address();
    if (!smtpAddress || typeof smtpAddress === 'string') {
      throw new Error('Completion SMTP system sink did not bind TCP');
    }

    const outboundEnvironment = {
      HX_ENVIRONMENT: process.env.HX_ENVIRONMENT,
      HX_OUTBOUND_COMMUNICATION_MODE: process.env.HX_OUTBOUND_COMMUNICATION_MODE,
      HX_EMAIL_DELIVERY_MODE: process.env.HX_EMAIL_DELIVERY_MODE,
      HX_LIVE_DELIVERY: process.env.HX_LIVE_DELIVERY,
      HX_LIVE_PROVIDER_ACCESS: process.env.HX_LIVE_PROVIDER_ACCESS,
      HX_EXTERNAL_VALUE: process.env.HX_EXTERNAL_VALUE,
      HX_COMPLETION_DELIVERY_SINK_ACTOR_ID:
        process.env.HX_COMPLETION_DELIVERY_SINK_ACTOR_ID,
      SMTP_URL: process.env.SMTP_URL,
    };
    Object.assign(process.env, {
      HX_ENVIRONMENT: 'test',
      HX_OUTBOUND_COMMUNICATION_MODE: 'sink',
      HX_EMAIL_DELIVERY_MODE: 'sink',
      HX_LIVE_DELIVERY: 'false',
      HX_LIVE_PROVIDER_ACCESS: 'false',
      HX_EXTERNAL_VALUE: 'false',
      HX_COMPLETION_DELIVERY_SINK_ACTOR_ID: sinkActorId,
      SMTP_URL: `smtp://127.0.0.1:${smtpAddress.port}`,
    });
    const completionJob = {
      id: bullmqJobId,
      data: {
        aggregate_type: 'email',
        aggregate_id: dispatchRow.email_id,
        event_version: dispatchRow.event_version,
        outbox_idempotency_key: dispatchRow.email_idempotency_key,
        outbox_dispatch_attempt_id: dispatchAttemptId,
        outbox_bullmq_job_id: bullmqJobId,
        payload: dispatchRow.payload,
      },
    } as never;
    try {
      await processEmailJob(completionJob, database);
      await processEmailJob(completionJob, database);
    } finally {
      for (const [name, previous] of Object.entries(outboundEnvironment)) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
      await new Promise<void>((resolveClose, rejectClose) =>
        smtpServer.close((error) => {
          if (error) rejectClose(error);
          else resolveClose();
        })
      );
    }

    expect(acceptedMessages).toBe(1);
    const delivery = await pool.query<{
      email_status: string;
      provider_name: string;
      provider_msg_id: string;
      outbox_status: string;
      delivery_count: string;
      provider_kind: string;
      recorded_by: string;
    }>(
      `SELECT email.status AS email_status,email.provider_name,email.provider_msg_id,
              outbox.status AS outbox_status,
              COUNT(delivery.id) OVER ()::text AS delivery_count,
              delivery.provider_kind,delivery.recorded_by
         FROM email_outbox email
         JOIN outbox_events outbox
           ON outbox.idempotency_key=email.idempotency_key
         JOIN task_completion_delivery_events delivery
           ON delivery.completion_notice_request_id=email.task_completion_notice_request_id
        WHERE email.id=$1`,
      [dispatchRow.email_id]
    );
    expect(delivery.rows).toHaveLength(1);
    expect(delivery.rows[0]).toMatchObject({
      email_status: 'sent',
      provider_name: 'smtp_sink',
      outbox_status: 'processed',
      delivery_count: '1',
      provider_kind: 'SYNTHETIC_SINK',
      recorded_by: sinkActorId,
    });
    expect(delivery.rows[0]!.provider_msg_id).toMatch(/^smtp-sink-[0-9a-f]{64}$/u);
    const financialAfter = await pool.query<{
      worker_id: string | null;
      security_events: string;
      financial_operations: string;
    }>(
      `SELECT task.worker_id,
              (SELECT COUNT(*)::text FROM task_financial_security_events event
                WHERE event.task_id=task.id) AS security_events,
              (SELECT COUNT(*)::text FROM task_financial_operations operation
                WHERE operation.task_id=task.id) AS financial_operations
         FROM tasks task WHERE task.id=$1`,
      [lane.accepted.task_id]
    );
    expect(financialAfter.rows[0]).toEqual(financialBefore.rows[0]);
    expect(financialAfter.rows[0]!.worker_id).toBeNull();
  }, 30_000);

  it.each([
    {
      path: 'SETTLED' as const,
      description: 'settlement and reconciliation',
    },
    {
      path: 'FULL_REFUND' as const,
      description: 'full refund and closed reconciliation',
    },
  ])(
    'continues an unassigned Work Order through evidence, completion, fake capture, $description',
    async ({ path }) => {
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

      const started = await execution.advanceWorkOrderExecution(
        lane.fixture.provider.actor_user_id,
        {
          work_order_id: materialized.work_order_id,
          action: 'START_WORK',
          expected_execution_version: acknowledged.execution_version,
          expected_scope_version: lane.scopeVersion,
          idempotency_key: `execution-start:${randomUUID()}`,
          client_ts: new Date().toISOString(),
        }
      );
      expect(started).toMatchObject({
        execution_version: 3,
        state: 'IN_PROGRESS',
        transition_kind: 'START_WORK',
        replayed: false,
        hard_assignment_created: false,
        payment_creation_performed: false,
      });

      const sinkActorId = await userFixture('poster');
      const fulfillment = fulfillmentService(sinkActorId);
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

      const beforeEmailDisabledSubmission = await pool.query<{
        proofs: string;
        completion_facts: string;
        execution_facts: string;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM proofs proof
             WHERE proof.work_order_id=$1) AS proofs,
           (SELECT COUNT(*)::text FROM task_completion_facts completion
             WHERE completion.work_order_id=$1) AS completion_facts,
           (SELECT COUNT(*)::text FROM task_work_order_execution_facts execution
             WHERE execution.work_order_id=$1) AS execution_facts`,
        [materialized.work_order_id]
      );
      await pool.query(`UPDATE users SET do_not_email=TRUE WHERE id=$1`, [
        lane.fixture.posterUserId,
      ]);
      await expect(
        fulfillment.submitCompletionEvidence(lane.fixture.provider.actor_user_id, {
          work_order_id: materialized.work_order_id,
          expected_scope_version: lane.scopeVersion,
          expected_execution_version: started.execution_version,
          description: 'This completion must roll back without truthful EMAIL authority.',
          photo_evidence: [],
          decision_reason: 'The poster disabled email before submission.',
          idempotency_key: `fulfillment-completion-email-disabled:${randomUUID()}`,
          client_ts: new Date().toISOString(),
        })
      ).rejects.toMatchObject({ code: 'FULFILLMENT_COMPLETION_NOTICE_UNAVAILABLE' });
      const afterEmailDisabledSubmission = await pool.query<{
        proofs: string;
        completion_facts: string;
        execution_facts: string;
      }>(
          `SELECT
             (SELECT COUNT(*)::text FROM proofs proof
               WHERE proof.work_order_id=$1) AS proofs,
             (SELECT COUNT(*)::text FROM task_completion_facts completion
               WHERE completion.work_order_id=$1) AS completion_facts,
             (SELECT COUNT(*)::text FROM task_work_order_execution_facts execution
               WHERE execution.work_order_id=$1) AS execution_facts`,
          [materialized.work_order_id]
        );
      expect(afterEmailDisabledSubmission.rows[0]).toEqual(
        beforeEmailDisabledSubmission.rows[0]
      );
      await pool.query(`UPDATE users SET do_not_email=FALSE WHERE id=$1`, [
        lane.fixture.posterUserId,
      ]);

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

      const noticeDispatch = await pool.query<{
        request_id: string;
        submitted_completion_fact_id: string;
        completion_execution_fact_id: string;
        recipient_user_id: string;
        sink_actor_user_id: string;
        channel: string;
        provider_kind: string;
        email_id: string;
        email_status: string;
        template: string;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        queue_name: string;
        outbox_status: string;
      }>(
        `SELECT request.id AS request_id,
                request.submitted_completion_fact_id,
                request.completion_execution_fact_id,
                request.recipient_user_id,
                request.sink_actor_user_id,
                request.channel,
                request.provider_kind,
                email.id AS email_id,
                email.status AS email_status,
                email.template,
                outbox.event_type,
                outbox.aggregate_type,
                outbox.aggregate_id,
                outbox.queue_name,
                outbox.status AS outbox_status
           FROM task_completion_notice_requests request
           JOIN email_outbox email
             ON email.task_completion_notice_request_id = request.id
           JOIN outbox_events outbox
             ON outbox.idempotency_key = request.email_idempotency_key
          WHERE request.submitted_completion_fact_id = $1`,
        [submitted.completion_fact_id]
      );
      expect(noticeDispatch.rows).toHaveLength(1);
      expect(noticeDispatch.rows[0]).toMatchObject({
        submitted_completion_fact_id: submitted.completion_fact_id,
        completion_execution_fact_id: submittedExecution.execution_fact_id,
        recipient_user_id: lane.fixture.posterUserId,
        sink_actor_user_id: sinkActorId,
        channel: 'EMAIL',
        provider_kind: 'SYNTHETIC_SINK',
        email_status: 'pending',
        template: 'universal_v1_completion_notice',
        event_type: 'email.send_requested',
        aggregate_type: 'email',
        queue_name: 'user_notifications',
        outbox_status: 'pending',
      });
      expect(noticeDispatch.rows[0]!.aggregate_id).toBe(noticeDispatch.rows[0]!.email_id);

      await expect(
        pool.query(
          `UPDATE email_outbox
              SET provider_name='sendgrid',
                  provider_msg_id='sendgrid-live-provider-receipt',
                  provider_receipt_at=clock_timestamp()
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE email_outbox
              SET status='suppressed'
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE outbox_events
              SET status='processed',processed_at=clock_timestamp()
            WHERE aggregate_id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE outbox_events
              SET idempotency_key=$2
            WHERE aggregate_id=$1`,
          [
            noticeDispatch.rows[0]!.email_id,
            `completion-notice-email:${randomUUID()}`,
          ]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query('DELETE FROM outbox_events WHERE aggregate_id=$1', [noticeDispatch.rows[0]!.email_id])
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(pool.query('TRUNCATE email_outbox')).rejects.toMatchObject({ code: 'P0001' });
      await expect(pool.query('TRUNCATE outbox_events')).rejects.toMatchObject({ code: 'P0001' });

      const suppressNoticeForRollbackProbe = async (query: QueryFn) => {
        await query(
          `UPDATE email_outbox
              SET status='sending',pre_provider_claim_id=$2,
                  pre_provider_claimed_at=clock_timestamp(),
                  pre_provider_claim_deadline_at=clock_timestamp()+INTERVAL '5 minutes'
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id, randomUUID()]
        );
        await query(
          `UPDATE email_outbox
              SET status='suppressed',suppressed_reason='rollback_terminal_probe',
                  suppressed_at=clock_timestamp(),pre_provider_claim_id=NULL,
                  pre_provider_claimed_at=NULL,pre_provider_claim_deadline_at=NULL
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        );
      };
      await expect(
        runTransaction('', async (query) => {
          await suppressNoticeForRollbackProbe(query);
          await query(
            `UPDATE email_outbox
                SET status='pending',suppressed_reason=NULL,suppressed_at=NULL
              WHERE id=$1`,
            [noticeDispatch.rows[0]!.email_id]
          );
        })
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        runTransaction('', async (query) => {
          await suppressNoticeForRollbackProbe(query);
          await query(
            `UPDATE outbox_events
                SET status='processed',processed_at=clock_timestamp()
              WHERE aggregate_id=$1`,
            [noticeDispatch.rows[0]!.email_id]
          );
          await query(
            `UPDATE outbox_events SET status='pending' WHERE aggregate_id=$1`,
            [noticeDispatch.rows[0]!.email_id]
          );
        })
      ).rejects.toMatchObject({ code: 'P0001' });

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
      const legacyDeliveryResponse = await sendDeliveryReceipt();
      expect(legacyDeliveryResponse.status).toBe(422);
      expect(await legacyDeliveryResponse.json()).toMatchObject({
        code: 'COMPLETION_DELIVERY_CONTEXT_UNAVAILABLE',
      });
      expect(
        await pool.query(
          `SELECT id
             FROM task_completion_delivery_events
            WHERE work_order_id=$1
              AND expected_completion_fact_id=$2
              AND completion_notice_request_id IS NULL`,
          [materialized.work_order_id, submitted.completion_fact_id]
        )
      ).toMatchObject({ rowCount: 0 });

      const fulfillmentLockHolder = await pool.connect();
      const directExecutionWriter = await pool.connect();
      try {
        await fulfillmentLockHolder.query('BEGIN');
        await fulfillmentLockHolder.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          [`fulfillment:${materialized.work_order_id}`]
        );
        await directExecutionWriter.query('BEGIN');
        await directExecutionWriter.query(`SET LOCAL lock_timeout='250ms'`);
        await expect(
          directExecutionWriter.query(
            `INSERT INTO task_work_order_execution_facts (
               work_order_id,task_id,scope_version_id,execution_version,
               supersedes_fact_id,state,transition_kind,completion_fact_id,
               work_order_amendment_id,actor_role,actor_user_id,reason,
               idempotency_key,request_sha256,client_occurred_at,policy_version
             ) VALUES (
               $1,$2,$3,$4,$5,'REWORK_REQUIRED','COMPLETION_REJECTED',$6,
               NULL,'CUSTOMER',$7,$8,$9,repeat('0',64),clock_timestamp(),
               'universal-v1-work-order-execution-1.0.0'
             )`,
            [
              materialized.work_order_id,
              lane.accepted.task_id,
              lane.accepted.scope_version_id,
              submittedExecution.execution_version + 1,
              submittedExecution.execution_fact_id,
              submitted.completion_fact_id,
              lane.fixture.posterUserId,
              'Direct execution DML must serialize behind fulfillment authority.',
              `direct-execution-lock-proof:${randomUUID()}`,
            ]
          )
        ).rejects.toMatchObject({ code: '55P03' });
        await directExecutionWriter.query('ROLLBACK');
        await directExecutionWriter.query('BEGIN');
        await directExecutionWriter.query(`SET LOCAL lock_timeout='250ms'`);
        await expect(
          directExecutionWriter.query(
            `INSERT INTO task_completion_facts (
               work_order_id,task_id,scope_version_id,proof_id,
               proof_snapshot_hash,completion_version,supersedes_fact_id,
               fact_kind,amount_approved_cents,incident_gate,
               customer_notice_at,delivery_event_id,actor_role,
               decision_reason,actor_id,idempotency_key
             )
             SELECT source.work_order_id,source.task_id,source.scope_version_id,
                    source.proof_id,source.proof_snapshot_hash,
                    source.completion_version+1,source.id,'REJECTED',NULL,'CLEAR',
                    NULL,NULL,'CUSTOMER',$2,$3,$4
               FROM task_completion_facts source
              WHERE source.id=$1`,
            [
              submitted.completion_fact_id,
              'Direct completion DML must serialize behind fulfillment authority.',
              lane.fixture.posterUserId,
              `direct-completion-lock-proof:${randomUUID()}`,
            ]
          )
        ).rejects.toMatchObject({ code: '55P03' });
        await directExecutionWriter.query('ROLLBACK');
        await directExecutionWriter.query('BEGIN');
        await directExecutionWriter.query(`SET LOCAL lock_timeout='250ms'`);
        await expect(
          directExecutionWriter.query(
            `INSERT INTO task_completion_notice_requests (
               id,task_id,work_order_id,scope_version_id,scope_version,
               submitted_completion_fact_id,completion_version,
               completion_execution_fact_id,execution_version,
               recipient_user_id,sink_actor_user_id,channel,provider_kind,
               idempotency_key,email_idempotency_key,request_sha256,policy_version
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'EMAIL','SYNTHETIC_SINK',
               $12,$13,repeat('0',64),
               'universal-v1-completion-notice-dispatch-1.0.0'
             )`,
            [
              randomUUID(),
              lane.accepted.task_id,
              materialized.work_order_id,
              lane.accepted.scope_version_id,
              lane.scopeVersion,
              submitted.completion_fact_id,
              submitted.completion_version,
              submittedExecution.execution_fact_id,
              submittedExecution.execution_version,
              lane.fixture.posterUserId,
              sinkActorId,
              `completion-notice-request:${randomUUID()}`,
              `completion-notice-email:${randomUUID()}`,
            ]
          )
        ).rejects.toMatchObject({ code: '55P03' });
      } finally {
        await directExecutionWriter.query('ROLLBACK');
        await fulfillmentLockHolder.query('ROLLBACK');
        directExecutionWriter.release();
        fulfillmentLockHolder.release();
      }

      let decisionWinnerTerminalState: {
        email_status: string;
        suppressed_reason: string;
        outbox_status: string;
      } | null = null;
      await expect(
        runTransaction('', async (query) => {
          const rollbackClaimId = randomUUID();
          await query(
            `UPDATE outbox_events
                SET status='processing',dispatch_attempt_id=$2,
                    bullmq_job_id=$3,updated_at=clock_timestamp()
              WHERE aggregate_id=$1`,
            [
              noticeDispatch.rows[0]!.email_id,
              randomUUID(),
              `completion-notice-decision-winner:${randomUUID()}`,
            ]
          );
          await query(
            `UPDATE email_outbox
                SET status='sending',pre_provider_claim_id=$2,
                    pre_provider_claimed_at=clock_timestamp(),
                    pre_provider_claim_deadline_at=clock_timestamp()+INTERVAL '5 minutes'
              WHERE id=$1`,
            [noticeDispatch.rows[0]!.email_id, rollbackClaimId]
          );
          const submittedFact = await query<{
            proof_id: string;
            proof_snapshot_hash: string;
            scope_version_id: string;
          }>(
            `SELECT proof_id,proof_snapshot_hash,scope_version_id
               FROM task_completion_facts
              WHERE id=$1
              FOR SHARE`,
            [submitted.completion_fact_id]
          );
          await query(
            `UPDATE proofs
                SET state='REJECTED',reviewed_by=$2,reviewed_at=clock_timestamp(),
                    rejection_reason=$3,updated_at=clock_timestamp()
              WHERE id=$1 AND state='SUBMITTED'`,
            [
              submittedFact.rows[0]!.proof_id,
              lane.fixture.posterUserId,
              'Rollback-only decision-wins-before-provider regression.',
            ]
          );
          await query(
            `INSERT INTO task_completion_facts (
               work_order_id,task_id,scope_version_id,proof_id,
               proof_snapshot_hash,completion_version,supersedes_fact_id,
               fact_kind,amount_approved_cents,incident_gate,
               customer_notice_at,delivery_event_id,actor_role,
               decision_reason,actor_id,idempotency_key
             ) VALUES (
               $1,$2,$3,$4,$5,$6,$7,'REJECTED',NULL,'CLEAR',
               NULL,NULL,'CUSTOMER',$8,$9,$10
             )`,
            [
              materialized.work_order_id,
              lane.accepted.task_id,
              submittedFact.rows[0]!.scope_version_id,
              submittedFact.rows[0]!.proof_id,
              submittedFact.rows[0]!.proof_snapshot_hash,
              submitted.completion_version! + 1,
              submitted.completion_fact_id,
              'Rollback-only decision-wins-before-provider regression.',
              lane.fixture.posterUserId,
              `completion-decision-winner:${randomUUID()}`,
            ]
          );
          await query(
            `UPDATE email_outbox
                SET status='suppressed',
                    suppressed_reason='completion_notice_authority_revoked',
                    suppressed_at=clock_timestamp(),pre_provider_claim_id=NULL,
                    pre_provider_claimed_at=NULL,pre_provider_claim_deadline_at=NULL
              WHERE id=$1 AND status='sending'
                AND pre_provider_claim_id=$2::UUID
                AND provider_io_started_at IS NULL`,
            [noticeDispatch.rows[0]!.email_id, rollbackClaimId]
          );
          await query(
            `UPDATE outbox_events
                SET status='processed',processed_at=clock_timestamp()
              WHERE aggregate_id=$1`,
            [noticeDispatch.rows[0]!.email_id]
          );
          const terminal = await query<{
            email_status: string;
            suppressed_reason: string;
            outbox_status: string;
          }>(
            `SELECT email.status AS email_status,email.suppressed_reason,
                    outbox.status AS outbox_status
               FROM email_outbox email
               JOIN outbox_events outbox ON outbox.aggregate_id=email.id
              WHERE email.id=$1`,
            [noticeDispatch.rows[0]!.email_id]
          );
          decisionWinnerTerminalState = terminal.rows[0]!;
          throw new Error('ROLLBACK_DECISION_WINNER_NOTICE_PROBE');
        })
      ).rejects.toThrow('ROLLBACK_DECISION_WINNER_NOTICE_PROBE');
      expect(decisionWinnerTerminalState).toEqual({
        email_status: 'suppressed',
        suppressed_reason: 'completion_notice_authority_revoked',
        outbox_status: 'processed',
      });

      const financialEffectsBeforeNotice = await pool.query<{
        worker_id: string | null;
        security_events: string;
        financial_operations: string;
      }>(
        `SELECT task.worker_id,
                (SELECT COUNT(*)::text FROM task_financial_security_events event
                  WHERE event.task_id=task.id) AS security_events,
                (SELECT COUNT(*)::text FROM task_financial_operations operation
                  WHERE operation.task_id=task.id) AS financial_operations
           FROM tasks task
          WHERE task.id=$1`,
        [lane.accepted.task_id]
      );
      const preProviderClaimId = randomUUID();
      const providerAttemptId = randomUUID();
      const providerMessageId = `smtp-sink-completion-${randomUUID()}`;
      await pool.query(
        `UPDATE outbox_events
            SET status='processing',dispatch_attempt_id=$2,
                bullmq_job_id=$3,updated_at=clock_timestamp()
          WHERE aggregate_id=$1`,
        [
          noticeDispatch.rows[0]!.email_id,
          randomUUID(),
          `completion-notice-worker:${randomUUID()}`,
        ]
      );
      await expect(
        pool.query(
          `UPDATE email_outbox
              SET status='sending',
                  pre_provider_claim_id=$2,
                  pre_provider_claimed_at=clock_timestamp(),
                  pre_provider_claim_deadline_at=clock_timestamp()+INTERVAL '5 minutes',
                  provider_io_started_at=clock_timestamp()
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id, randomUUID()]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE email_outbox
              SET notification_provider_attempt_id=$2
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id, randomUUID()]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE email_outbox
              SET pre_provider_claim_id=$2,
                  pre_provider_claimed_at=clock_timestamp(),
                  pre_provider_claim_deadline_at=clock_timestamp()+INTERVAL '5 minutes',
                  provider_io_started_at=clock_timestamp(),
                  notification_provider_attempt_id=$3
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id, randomUUID(), randomUUID()]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      const providerMarker = await pool.query<{ provider_io_started_at: string }>(
        `UPDATE email_outbox
            SET status='sending',
                attempts=attempts+1,
                pre_provider_claim_id=$2,
                pre_provider_claimed_at=clock_timestamp(),
                pre_provider_claim_deadline_at=clock_timestamp()+INTERVAL '50 milliseconds',
                provider_io_started_at=clock_timestamp(),
                notification_provider_attempt_id=$3,
                updated_at=clock_timestamp()
          WHERE id=$1
          RETURNING provider_io_started_at::text`,
        [noticeDispatch.rows[0]!.email_id, preProviderClaimId, providerAttemptId]
      );
      expect(providerMarker.rows).toHaveLength(1);
      await expect(
        pool.query(
          `UPDATE email_outbox
              SET status='failed',provider_io_started_at=NULL,
                  notification_provider_attempt_id=NULL
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE email_outbox
              SET pre_provider_claim_id=NULL,
                  pre_provider_claimed_at=NULL,
                  pre_provider_claim_deadline_at=NULL
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE email_outbox
              SET provider_name=NULL,provider_msg_id=$2,
                  provider_receipt_at=clock_timestamp()
            WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id, `smtp-null-provider:${randomUUID()}`]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      // Simulate a dispatcher crash/race that left the immutable event with
      // stale transport metadata after the provider boundary marker. Recovery
      // must use the request/email envelope, not that expired BullMQ token.
      await pool.query(
        `UPDATE outbox_events
            SET status='failed',error_message='stale_completion_dispatch_regression',
                dispatch_attempt_id=$2,bullmq_job_id=$3,updated_at=clock_timestamp()
          WHERE aggregate_id=$1`,
        [
          noticeDispatch.rows[0]!.email_id,
          randomUUID(),
          `stale-completion-dispatch:${randomUUID()}`,
        ]
      );
      await pool.query(`SELECT pg_sleep(0.1)`);
      await expect(
        promoteExpiredDirectProviderClaims(100, database)
      ).resolves.toBeGreaterThanOrEqual(1);
      expect(
        await pool.query(
          `SELECT email.status AS email_status,email.last_error,
                  outbox.status AS outbox_status,outbox.error_message
             FROM email_outbox email
             JOIN outbox_events outbox ON outbox.aggregate_id=email.id
            WHERE email.id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).toMatchObject({
        rows: [{
          email_status: 'provider_outcome_unknown',
          last_error: 'provider_attempt_deadline_exceeded',
          outbox_status: 'processed',
          error_message: 'provider_outcome_unknown',
        }],
      });
      await expect(
        pool.query(
          `UPDATE email_outbox SET status='pending' WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE email_outbox SET sent_at=clock_timestamp() WHERE id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE outbox_events SET status='pending' WHERE aggregate_id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(
          `UPDATE outbox_events SET processed_at=clock_timestamp() WHERE aggregate_id=$1`,
          [noticeDispatch.rows[0]!.email_id]
        )
      ).rejects.toMatchObject({ code: 'P0001' });
      await pool.query(`UPDATE users SET is_banned=TRUE WHERE id=$1`, [sinkActorId]);
      const persistedReceipt = await pool.query<{
        provider_receipt_at: string;
        provider_io_started_at: string;
      }>(
        `UPDATE email_outbox
            SET provider_name='smtp_sink',
                provider_msg_id=$2,
                provider_receipt_at=clock_timestamp(),
                updated_at=clock_timestamp()
          WHERE id=$1
          RETURNING provider_receipt_at::text,provider_io_started_at::text`,
        [noticeDispatch.rows[0]!.email_id, providerMessageId]
      );
      expect(
        Date.parse(persistedReceipt.rows[0]!.provider_receipt_at)
      ).toBeGreaterThanOrEqual(Date.parse(persistedReceipt.rows[0]!.provider_io_started_at));

      const exactDeliveryServiceIdentity =
        `hustlexp.synthetic-communications-sink.v1:${sinkActorId}`;
      const exactDeliveryIdempotency =
        `completion-notice-delivery:${noticeDispatch.rows[0]!.request_id}`;
      const deliveryAuditNullCases = [
        {
          providerKind: null,
          serviceIdentity: exactDeliveryServiceIdentity,
          idempotencyKey: exactDeliveryIdempotency,
          callbackAt: new Date().toISOString(),
          policyVersion: 'universal-v1-completion-delivery-receipt-1.0.0',
        },
        {
          providerKind: 'SYNTHETIC_SINK',
          serviceIdentity: null,
          idempotencyKey: exactDeliveryIdempotency,
          callbackAt: new Date().toISOString(),
          policyVersion: 'universal-v1-completion-delivery-receipt-1.0.0',
        },
        {
          providerKind: 'SYNTHETIC_SINK',
          serviceIdentity: exactDeliveryServiceIdentity,
          idempotencyKey: null,
          callbackAt: new Date().toISOString(),
          policyVersion: 'universal-v1-completion-delivery-receipt-1.0.0',
        },
        {
          providerKind: 'SYNTHETIC_SINK',
          serviceIdentity: exactDeliveryServiceIdentity,
          idempotencyKey: exactDeliveryIdempotency,
          callbackAt: null,
          policyVersion: 'universal-v1-completion-delivery-receipt-1.0.0',
        },
        {
          providerKind: 'SYNTHETIC_SINK',
          serviceIdentity: exactDeliveryServiceIdentity,
          idempotencyKey: exactDeliveryIdempotency,
          callbackAt: new Date().toISOString(),
          policyVersion: null,
        },
      ];
      for (const auditTuple of deliveryAuditNullCases) {
        await expect(
          runTransaction('', async (query) => {
            await query(
              `UPDATE email_outbox
                  SET status='sent',sent_at=clock_timestamp()
                WHERE id=$1`,
              [noticeDispatch.rows[0]!.email_id]
            );
            await query(
              `INSERT INTO task_completion_delivery_events (
                 task_id,work_order_id,expected_completion_fact_id,
                 expected_completion_version,expected_execution_version,
                 completion_notice_request_id,provider_delivery_id,channel,
                 delivered_at,recorded_by,provider_kind,provider_service_identity,
                 idempotency_key,request_sha256,provider_callback_at,policy_version
               ) VALUES (
                 $1,$2,$3,$4,$5,$6,$7,'EMAIL',$8,$9,$10,$11,$12,
                 public.universal_v1_completion_notice_receipt_sha256(
                   $6,$13,$14,$8::timestamptz,$9
                 ),$15::timestamptz,$16
               )`,
              [
                lane.accepted.task_id,
                materialized.work_order_id,
                submitted.completion_fact_id,
                submitted.completion_version,
                submittedExecution.execution_version,
                noticeDispatch.rows[0]!.request_id,
                `smtp_sink:${providerMessageId}`,
                persistedReceipt.rows[0]!.provider_receipt_at,
                sinkActorId,
                auditTuple.providerKind,
                auditTuple.serviceIdentity,
                auditTuple.idempotencyKey,
                noticeDispatch.rows[0]!.email_id,
                providerMessageId,
                auditTuple.callbackAt,
                auditTuple.policyVersion,
              ]
            );
          })
        ).rejects.toMatchObject({ code: 'P0001' });
      }

      // Prove the first materialization can arrive after a customer decision
      // appended a newer execution, and after the sink was revoked, because
      // the provider-I/O marker already linearized current authority. Roll the
      // probe back so the golden path can then exercise concurrent replay.
      let delayedDecisionDeliveryId: string | null = null;
      await expect(
        runTransaction('', async (query) => {
          await query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
            `fulfillment:${materialized.work_order_id}`,
          ]);
          const submittedFact = await query<{
            proof_id: string;
            scope_version_id: string;
          }>(
            `SELECT proof_id,scope_version_id
               FROM task_completion_facts
              WHERE id=$1
              FOR SHARE`,
            [submitted.completion_fact_id]
          );
          await query(
            `UPDATE proofs
                SET state='REJECTED',reviewed_by=$2,reviewed_at=clock_timestamp(),
                    rejection_reason=$3,updated_at=clock_timestamp()
              WHERE id=$1 AND state='SUBMITTED'`,
            [
              submittedFact.rows[0]!.proof_id,
              lane.fixture.posterUserId,
              'Rollback-only delayed completion decision regression.',
            ]
          );
          const rejectionKey = `completion-delayed-rejection:${randomUUID()}`;
          const rejected = await query<{ id: string }>(
            `INSERT INTO task_completion_facts (
               work_order_id,task_id,scope_version_id,proof_id,
               proof_snapshot_hash,completion_version,supersedes_fact_id,
               fact_kind,amount_approved_cents,incident_gate,
               customer_notice_at,delivery_event_id,actor_role,
               decision_reason,actor_id,idempotency_key
             ) VALUES (
               $1,$2,$3,$4,repeat('0',64),$5,$6,'REJECTED',NULL,'CLEAR',
               NULL,NULL,'CUSTOMER',$7,$8,$9
             ) RETURNING id`,
            [
              materialized.work_order_id,
              lane.accepted.task_id,
              submittedFact.rows[0]!.scope_version_id,
              submittedFact.rows[0]!.proof_id,
              submitted.completion_version! + 1,
              submitted.completion_fact_id,
              'Rollback-only delayed completion decision regression.',
              lane.fixture.posterUserId,
              `${rejectionKey}:fact`,
            ]
          );
          const decisionClientTs = new Date().toISOString();
          const executionKey = `${rejectionKey}:execution`;
          await query(
            `INSERT INTO task_work_order_execution_facts (
               work_order_id,task_id,scope_version_id,execution_version,
               supersedes_fact_id,state,transition_kind,completion_fact_id,
               work_order_amendment_id,actor_role,actor_user_id,reason,
               idempotency_key,request_sha256,client_occurred_at,policy_version
             ) VALUES (
               $1,$2,$3,$4,$5,'REWORK_REQUIRED','COMPLETION_REJECTED',$6,
               NULL,'CUSTOMER',$7,$8,$9,
               public.universal_v1_execution_internal_request_sha256(
                 $7,$1,'COMPLETION_REJECTED','REWORK_REQUIRED',$10,$3,$6,NULL,$9,
                 $11::timestamptz,$8
               ),$11::timestamptz,'universal-v1-work-order-execution-1.0.0'
             )`,
            [
              materialized.work_order_id,
              lane.accepted.task_id,
              submittedFact.rows[0]!.scope_version_id,
              submittedExecution.execution_version + 1,
              submittedExecution.execution_fact_id,
              rejected.rows[0]!.id,
              lane.fixture.posterUserId,
              'Rollback-only delayed completion decision regression.',
              executionKey,
              submittedExecution.execution_version,
              decisionClientTs,
            ]
          );
          await query(`UPDATE email_outbox
                          SET status='sent',sent_at=COALESCE(sent_at,clock_timestamp())
                        WHERE id=$1`, [
            noticeDispatch.rows[0]!.email_id,
          ]);
          const delayed = await query<{
            materialize_universal_v1_completion_notice_delivery: string;
          }>(
            `SELECT public.materialize_universal_v1_completion_notice_delivery($1::UUID)`,
            [noticeDispatch.rows[0]!.email_id]
          );
          delayedDecisionDeliveryId =
            delayed.rows[0]!.materialize_universal_v1_completion_notice_delivery;
          throw new Error('ROLLBACK_DELAYED_COMPLETION_NOTICE_PROBE');
        })
      ).rejects.toThrow('ROLLBACK_DELAYED_COMPLETION_NOTICE_PROBE');
      expect(delayedDecisionDeliveryId).toMatch(/^[0-9a-f-]{36}$/iu);

      const finalizeReceipt = () =>
        runTransaction('', async (query) => {
          await query(`UPDATE email_outbox
                          SET status='sent',sent_at=COALESCE(sent_at,clock_timestamp())
                        WHERE id=$1`, [
            noticeDispatch.rows[0]!.email_id,
          ]);
          const delivery = await query<{
            materialize_universal_v1_completion_notice_delivery: string;
          }>(
            `SELECT public.materialize_universal_v1_completion_notice_delivery($1::UUID)`,
            [noticeDispatch.rows[0]!.email_id]
          );
          return delivery.rows[0]!.materialize_universal_v1_completion_notice_delivery;
        });
      const [workerDeliveryOne, workerDeliveryTwo, recoveredReceipts] = await Promise.all([
        finalizeReceipt(),
        finalizeReceipt(),
        reconcileNotificationProviderReceipts(100, database),
      ]);
      expect(workerDeliveryTwo).toBe(workerDeliveryOne);
      // Either the receipt reconciler or one worker transaction may win the
      // row/advisory lock. A zero here means a worker won first; uniqueness
      // and the exact delivery audit below prove convergence in both orders.
      expect([0, 1]).toContain(recoveredReceipts);
      const deliveryEventId = workerDeliveryOne;
      expect(
        await pool.query(`SELECT status FROM outbox_events WHERE aggregate_id=$1`, [
          noticeDispatch.rows[0]!.email_id,
        ])
      ).toMatchObject({ rows: [{ status: 'processed' }] });
      await expect(
        pool.query(`UPDATE email_outbox SET status='pending' WHERE id=$1`, [
          noticeDispatch.rows[0]!.email_id,
        ])
      ).rejects.toMatchObject({ code: 'P0001' });
      await expect(
        pool.query(`UPDATE email_outbox SET sent_at=clock_timestamp() WHERE id=$1`, [
          noticeDispatch.rows[0]!.email_id,
        ])
      ).rejects.toMatchObject({ code: 'P0001' });
      await pool.query(`UPDATE users SET is_banned=FALSE WHERE id=$1`, [sinkActorId]);

      const deliveryAudit = await pool.query<{
        receipt_count: number;
        work_order_id: string;
        expected_completion_fact_id: string;
        expected_execution_version: number;
        recorded_by: string;
        provider_service_identity: string;
      }>(
        `SELECT COUNT(*) OVER ()::integer AS receipt_count,
                work_order_id,expected_completion_fact_id,
                expected_execution_version,recorded_by,provider_service_identity
           FROM task_completion_delivery_events
          WHERE completion_notice_request_id=$1`,
        [noticeDispatch.rows[0]!.request_id]
      );
      expect(deliveryAudit.rows[0]).toEqual({
        receipt_count: 1,
        work_order_id: materialized.work_order_id,
        expected_completion_fact_id: submitted.completion_fact_id,
        expected_execution_version: submittedExecution.execution_version,
        recorded_by: sinkActorId,
        provider_service_identity: `hustlexp.synthetic-communications-sink.v1:${sinkActorId}`,
      });
      expect(await pool.query(`SELECT worker_id FROM tasks WHERE id=$1`, [lane.accepted.task_id]))
        .toMatchObject({ rows: [{ worker_id: null }] });
      expect(
        await pool.query<{
          security_events: string;
          financial_operations: string;
        }>(
          `SELECT (SELECT COUNT(*)::text FROM task_financial_security_events event
                    WHERE event.task_id=$1) AS security_events,
                  (SELECT COUNT(*)::text FROM task_financial_operations operation
                    WHERE operation.task_id=$1) AS financial_operations`,
          [lane.accepted.task_id]
        )
      ).toMatchObject({
        rows: [{
          security_events: financialEffectsBeforeNotice.rows[0]!.security_events,
          financial_operations: financialEffectsBeforeNotice.rows[0]!.financial_operations,
        }],
      });

      const unrelatedLegacyDelivery = await pool.query<{ id: string }>(
        `INSERT INTO task_completion_delivery_events (
           task_id,provider_delivery_id,channel,delivered_at,recorded_by
         ) VALUES ($1,$2,'EMAIL',clock_timestamp(),$3)
         RETURNING id`,
        [
          lane.accepted.task_id,
          `legacy-task-only:${randomUUID()}`,
          lane.fixture.posterUserId,
        ]
      );
      await expect(
        fulfillment.decideCompletion(lane.fixture.posterUserId, {
          work_order_id: materialized.work_order_id,
          submitted_completion_fact_id: submitted.completion_fact_id!,
          expected_completion_version: submitted.completion_version!,
          expected_execution_version: submittedExecution.execution_version,
          decision: 'APPROVED',
          delivery_event_id: unrelatedLegacyDelivery.rows[0]!.id,
          decision_reason: 'This unrelated legacy receipt must not authorize approval.',
          idempotency_key: `fulfillment-unrelated-delivery:${randomUUID()}`,
          client_ts: new Date().toISOString(),
        })
      ).rejects.toMatchObject({ code: 'FULFILLMENT_COMPLETION_STATE_CONFLICT' });
      await expect(
        fulfillment.decideCompletion(lane.fixture.posterUserId, {
          work_order_id: materialized.work_order_id,
          submitted_completion_fact_id: submitted.completion_fact_id!,
          expected_completion_version: submitted.completion_version!,
          expected_execution_version: submittedExecution.execution_version,
          decision: 'REJECTED',
          delivery_event_id: unrelatedLegacyDelivery.rows[0]!.id,
          decision_reason: 'This unrelated legacy receipt must not be attached to rejection.',
          idempotency_key: `fulfillment-unrelated-rejection-delivery:${randomUUID()}`,
          client_ts: new Date().toISOString(),
        })
      ).rejects.toMatchObject({ code: 'FULFILLMENT_COMPLETION_STATE_CONFLICT' });
      const approved = await fulfillment.decideCompletion(lane.fixture.posterUserId, {
        work_order_id: materialized.work_order_id,
        submitted_completion_fact_id: submitted.completion_fact_id!,
        expected_completion_version: submitted.completion_version!,
        expected_execution_version: submittedExecution.execution_version,
        decision: 'APPROVED',
        delivery_event_id: deliveryEventId,
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

      const predecessorResult = await pool.query<{
        operation_id: string;
        expected_version: string;
        amount_cents: string;
        currency: string;
        scope_version_id: string;
        task_draft_id: string;
        task_id: string;
        eligibility_decision_id: string;
      }>(
        `SELECT operation_id, expected_version::text, amount_cents::text,
                currency, scope_version_id, task_draft_id, task_id,
                eligibility_decision_id
           FROM task_financial_security_events
          WHERE id = $1`,
        [materialized.financial_security_event_id]
      );
      const predecessor = predecessorResult.rows[0]!;
      const noIntentCaptureKey = `no-intent-capture:${randomUUID()}`;
      const noIntentCaptureOperationId = deterministicUuid(noIntentCaptureKey, 'capture');
      await expect(
        fakeFinanceService().executeFinancialEvent({
          providerKind: 'FAKE',
          operationKind: 'CAPTURE',
          operationId: noIntentCaptureOperationId,
          idempotencyKey: `${noIntentCaptureKey}:capture`,
          providerExpectedVersion: 0,
          lifecycleExpectedVersion: Number(predecessor.expected_version) + 1,
          taskDraftId: predecessor.task_draft_id,
          taskId: predecessor.task_id,
          eligibilityDecisionId: predecessor.eligibility_decision_id,
          scopeVersionId: predecessor.scope_version_id,
          predecessorEventId: materialized.financial_security_event_id,
          relatedOperationId: predecessor.operation_id,
          amountCents: Number(predecessor.amount_cents),
          currency: predecessor.currency.toLowerCase(),
          completionFactId: approved.completion_fact_id,
          scenario: 'SUCCESS',
          recordedBy: lane.fixture.posterUserId,
          occurredAt: new Date().toISOString(),
        })
      ).rejects.toThrow(/HXUV1-FTL-40/u);

      const noIntentReconciliationKey = `no-intent-reconciliation:${randomUUID()}`;
      const noIntentReconciliationOperationId = deterministicUuid(
        noIntentReconciliationKey,
        'reconciliation'
      );
      await expect(
        fakeFinanceService().reconcile({
          providerKind: 'FAKE',
          operationId: noIntentReconciliationOperationId,
          idempotencyKey: `${noIntentReconciliationKey}:reconciliation`,
          providerExpectedVersion: 0,
          relatedOperationId: randomUUID(),
          scenario: 'SUCCESS',
          snapshot: {
            workOrderId: materialized.work_order_id,
            reconciliationVersion: 1,
            captureEventId: randomUUID(),
            voidState: 'NOT_APPLICABLE',
            captureState: 'CAPTURED',
            refundState: 'NOT_APPLICABLE',
            reversalState: 'NOT_APPLICABLE',
            settlementState: 'NOT_APPLICABLE',
            fundingState: 'NOT_APPLICABLE',
            providerReleaseState: 'NOT_APPLICABLE',
            payoutState: 'NOT_APPLICABLE',
            bankSettlementState: 'NOT_APPLICABLE',
            ledgerState: 'MATCHED',
            reconciliationState: 'MATCHED',
            mismatchCodes: [],
            customerLedgerAmountCents: Number(predecessor.amount_cents),
            providerLedgerAmountCents: 8_000,
            currency: predecessor.currency,
            expectedVersion: 0,
            recordedBy: lane.fixture.posterUserId,
          },
        })
      ).rejects.toThrow(/HXUV1-FTL-43/u);

      const refusedAuthority = await pool.query<{
        prepared_commands: number;
        journal_commands: number;
        dispatch_attempts: number;
        observed_outcomes: number;
        fake_operations: number;
        fake_operation_events: number;
        lifecycle_operations: number;
        lifecycle_events: number;
      }>(
        `SELECT
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_prepared_financial_commands prepared
           WHERE prepared.operation_id = ANY($1::uuid[])) AS prepared_commands,
         (SELECT COUNT(*)::integer
            FROM public.financial_provider_command_journal command
           WHERE command.operation_id = ANY($1::uuid[])) AS journal_commands,
         (SELECT COUNT(*)::integer
            FROM public.financial_provider_command_dispatch_attempts attempt
            JOIN public.financial_provider_command_journal command
              ON command.command_id = attempt.command_id
           WHERE command.operation_id = ANY($1::uuid[])) AS dispatch_attempts,
         (SELECT COUNT(*)::integer
            FROM public.financial_provider_command_outcome_facts outcome
            JOIN public.financial_provider_command_journal command
              ON command.command_id = outcome.command_id
           WHERE command.operation_id = ANY($1::uuid[])) AS observed_outcomes,
         (SELECT COUNT(*)::integer
            FROM public.hxos_fake_financial_operations_v1 operation
           WHERE operation.operation_id = ANY($1::uuid[])) AS fake_operations,
         (SELECT COUNT(*)::integer
            FROM public.hxos_fake_financial_operation_events_v1 event
           WHERE event.operation_id = ANY($1::uuid[])) AS fake_operation_events,
         (SELECT COUNT(*)::integer
            FROM public.task_financial_operations operation
           WHERE operation.operation_id = ANY($2::text[])) AS lifecycle_operations,
         (SELECT COUNT(*)::integer
            FROM public.task_financial_security_events event
           WHERE event.operation_id = ANY($2::text[])) AS lifecycle_events`,
        [
          [noIntentCaptureOperationId, noIntentReconciliationOperationId],
          [noIntentCaptureOperationId, noIntentReconciliationOperationId],
        ]
      );
      expect(refusedAuthority.rows[0]).toEqual({
        prepared_commands: 0,
        journal_commands: 0,
        dispatch_attempts: 0,
        observed_outcomes: 0,
        fake_operations: 0,
        fake_operation_events: 0,
        lifecycle_operations: 0,
        lifecycle_events: 0,
      });

      const providerAccountOperationIds: string[] = [];
      if (path === 'SETTLED') {
        const accountKey = `fake-provider-account:${lane.fixture.provider.actor_user_id}:${materialized.work_order_id}`;
        const onboardOperationId = deterministicUuid(accountKey, 'onboard');
        const refreshOperationId = deterministicUuid(accountKey, 'state');
        const providerId =
          lane.fixture.provider.provider_organization_id ?? lane.fixture.provider.provider_user_id;
        const finance = fakeFinanceService();
        const onboard = await finance.onboardProvider({
          providerKind: 'FAKE',
          operationId: onboardOperationId,
          idempotencyKey: `${accountKey}:onboard`,
          providerExpectedVersion: 0,
          providerId,
          scenario: 'SUCCESS',
          recordedBy: lane.fixture.provider.actor_user_id,
        });
        const refresh = await finance.refreshProviderAccountState({
          providerKind: 'FAKE',
          operationId: refreshOperationId,
          idempotencyKey: `${accountKey}:refresh`,
          providerExpectedVersion: 0,
          providerId,
          providerAccountReference: onboard.externalReference,
          scenario: 'SUCCESS',
          recordedBy: lane.fixture.provider.actor_user_id,
        });
        const accountFact = await new PostgresUniversalV1FakeProviderAccountRepository(
          database
        ).materializeFromDurableEvidence({
          providerSubject:
            lane.fixture.provider.provider_organization_id === null
              ? {
                  kind: 'USER',
                  userId: lane.fixture.provider.provider_user_id,
                }
              : {
                  kind: 'ORGANIZATION',
                  organizationId: lane.fixture.provider.provider_organization_id,
                },
          recordedBy: lane.fixture.provider.actor_user_id,
          onboard: onboard.durableFakeEvidence,
          refresh: refresh.durableFakeEvidence,
        });
        expect(accountFact).toMatchObject({
          providerSubject:
            lane.fixture.provider.provider_organization_id === null
              ? {
                  kind: 'USER',
                  userId: lane.fixture.provider.provider_user_id,
                }
              : {
                  kind: 'ORGANIZATION',
                  organizationId: lane.fixture.provider.provider_organization_id,
                },
          accountVersion: 1,
          accountState: 'ENABLED',
          payoutsEnabled: true,
          idempotencyReplayed: false,
        });
        providerAccountOperationIds.push(onboardOperationId, refreshOperationId);
      }

      const lifecycleKey = `fulfillment-${path.toLowerCase()}:${randomUUID()}`;
      const lifecycleCommand = {
        work_order_id: materialized.work_order_id,
        approved_completion_fact_id: approved.completion_fact_id,
        path,
        expected_execution_version: completedExecution.execution_version,
        expected_financial_version: 2,
        expected_reconciliation_version: 0,
        idempotency_key: lifecycleKey,
        client_ts: new Date().toISOString(),
      };
      const providerEffectCounts = async (operationId: string) => {
        const refused = await pool.query<{
          prepared_commands: number;
          journal_commands: number;
          dispatch_attempts: number;
          fake_operations: number;
          fake_operation_events: number;
        }>(
          `SELECT
           (SELECT COUNT(*)::integer
              FROM universal_v1_prepared_financial_commands prepared
             WHERE prepared.operation_id = $1) AS prepared_commands,
           (SELECT COUNT(*)::integer
              FROM financial_provider_command_journal command
             WHERE command.operation_id = $1) AS journal_commands,
           (SELECT COUNT(*)::integer
              FROM financial_provider_command_dispatch_attempts attempt
              JOIN financial_provider_command_journal command
                ON command.command_id = attempt.command_id
             WHERE command.operation_id = $1) AS dispatch_attempts,
           (SELECT COUNT(*)::integer
              FROM hxos_fake_financial_operations_v1 operation
             WHERE operation.operation_id = $1::uuid) AS fake_operations,
           (SELECT COUNT(*)::integer
              FROM hxos_fake_financial_operation_events_v1 event
             WHERE event.operation_id = $1::uuid) AS fake_operation_events`,
          [operationId]
        );
        return refused.rows[0]!;
      };
      const expectNoProviderEffect = async (operationId: string) => {
        expect(await providerEffectCounts(operationId)).toEqual({
          prepared_commands: 0,
          journal_commands: 0,
          dispatch_attempts: 0,
          fake_operations: 0,
          fake_operation_events: 0,
        });
      };
      let alteredScenarioRefused = false;
      let alteredPayoutReferenceRefused = false;
      let alteredReconciliationSnapshotRefused = false;
      const captureOperationId = deterministicUuid(lifecycleKey, 'capture');
      const scenarioTamperFinance = fakeFinanceService();
      await expect(
        new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
          lane.fixture.posterUserId,
          lifecycleCommand,
          {
            executeFinancialEvent: (command) =>
              scenarioTamperFinance.executeFinancialEvent({
                ...command,
                scenario: 'DECLINE',
              }),
            reconcile: (command) => scenarioTamperFinance.reconcile(command),
          }
        )
      ).rejects.toThrow(/HXUV1-FTL-45/u);
      await expectNoProviderEffect(captureOperationId);
      alteredScenarioRefused = true;

      if (path === 'SETTLED') {
        const preparedCrashFinance = boundaryFakeFinanceService({
          crashAfterPreparedOperation: 'CAPTURE',
        });
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            preparedCrashFinance
          )
        ).rejects.toThrow('SYSTEM_TEST_CRASH_AFTER_PREPARED_CAPTURE');
        expect(await providerEffectCounts(captureOperationId)).toEqual({
          prepared_commands: 1,
          journal_commands: 0,
          dispatch_attempts: 0,
          fake_operations: 0,
          fake_operation_events: 0,
        });

        await pool.query(`UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1`, [
          lane.fixture.provider.provider_user_id,
        ]);
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            boundaryFakeFinanceService({ leaseDurationSeconds: 2 })
          )
        ).rejects.toThrow(/HXUV1-FTL-47/u);
        expect(await providerEffectCounts(captureOperationId)).toEqual({
          prepared_commands: 1,
          journal_commands: 1,
          dispatch_attempts: 0,
          fake_operations: 0,
          fake_operation_events: 0,
        });
        await pool.query(`UPDATE users SET account_status = 'ACTIVE' WHERE id = $1`, [
          lane.fixture.provider.provider_user_id,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 2_100));

        const captureRecoveryFinance = fakeFinanceService();
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            {
              executeFinancialEvent: async (command) => {
                const result = await captureRecoveryFinance.executeFinancialEvent(command);
                if (command.operationKind === 'CAPTURE') {
                  throw new Error('SYSTEM_TEST_CRASH_AFTER_CAPTURE_RECOVERY');
                }
                return result;
              },
              reconcile: (command) => captureRecoveryFinance.reconcile(command),
            }
          )
        ).rejects.toThrow('SYSTEM_TEST_CRASH_AFTER_CAPTURE_RECOVERY');

        const settleOperationId = deterministicUuid(lifecycleKey, 'settle');
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            boundaryFakeFinanceService({ crashAfterRequestedOperation: 'SETTLE' })
          )
        ).rejects.toThrow('SYSTEM_TEST_CRASH_AFTER_REQUESTED_SETTLE');
        expect(await providerEffectCounts(settleOperationId)).toEqual({
          prepared_commands: 1,
          journal_commands: 1,
          dispatch_attempts: 0,
          fake_operations: 0,
          fake_operation_events: 0,
        });

        await pool.query(`UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1`, [
          lane.fixture.provider.provider_user_id,
        ]);
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            boundaryFakeFinanceService({ leaseDurationSeconds: 2 })
          )
        ).rejects.toThrow(/HXUV1-FTL-47/u);
        expect(await providerEffectCounts(settleOperationId)).toEqual({
          prepared_commands: 1,
          journal_commands: 1,
          dispatch_attempts: 0,
          fake_operations: 0,
          fake_operation_events: 0,
        });
        await pool.query(`UPDATE users SET account_status = 'ACTIVE' WHERE id = $1`, [
          lane.fixture.provider.provider_user_id,
        ]);
        await new Promise((resolve) => setTimeout(resolve, 2_100));
      } else {
        const openRefundIncident = async (description: string): Promise<string> => {
          const incident = await pool.query<{ id: string }>(
            `INSERT INTO task_safety_incidents (
               task_id,
               reporter_user_id,
               category,
               urgency,
               description,
               contact_permission,
               idempotency_key
             ) VALUES ($1, $2, 'other', 'standard', $3, 'in_app_only', $4)
             RETURNING id`,
            [
              lane.accepted.task_id,
              lane.fixture.posterUserId,
              description,
              randomUUID(),
            ]
          );
          return incident.rows[0]!.id;
        };
        const resolveRefundIncident = async (incidentId: string): Promise<void> => {
          await pool.query(
            `UPDATE task_safety_incidents
                SET status = 'acknowledged',
                    acknowledged_at = clock_timestamp(),
                    assigned_admin_id = $2,
                    updated_at = clock_timestamp()
              WHERE id = $1`,
            [incidentId, lane.fixture.invitationOperatorUserId]
          );
          await pool.query(
            `INSERT INTO task_safety_incident_events (
               incident_id,
               event_type,
               actor_user_id,
               public_message,
               metadata
             ) VALUES (
               $1,
               'resolved',
               $2,
               'Synthetic incident resolution permits controlled-test replay to resume.',
               jsonb_build_object(
                 'resolution_code', 'safety_plan_confirmed',
                 'idempotency_key', $3::text,
                 'request_hash', repeat('a', 64)
               )
             )`,
            [incidentId, lane.fixture.invitationOperatorUserId, randomUUID()]
          );
          await pool.query(
            `UPDATE task_safety_incidents
                SET status = 'resolved',
                    resolved_at = clock_timestamp(),
                    updated_at = clock_timestamp()
              WHERE id = $1`,
            [incidentId]
          );
        };

        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            boundaryFakeFinanceService({ crashAfterPreparedOperation: 'CAPTURE' })
          )
        ).rejects.toThrow('SYSTEM_TEST_CRASH_AFTER_PREPARED_CAPTURE');
        expect(await providerEffectCounts(captureOperationId)).toEqual({
          prepared_commands: 1,
          journal_commands: 0,
          dispatch_attempts: 0,
          fake_operations: 0,
          fake_operation_events: 0,
        });

        const preparedIncidentId = await openRefundIncident(
          'Refund replay must stop after an incident opens beyond PREPARED authority.'
        );
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            boundaryFakeFinanceService({ leaseDurationSeconds: 2 })
          )
        ).rejects.toThrow(/HXUV1-FTL-47/u);
        expect(await providerEffectCounts(captureOperationId)).toEqual({
          prepared_commands: 1,
          journal_commands: 1,
          dispatch_attempts: 0,
          fake_operations: 0,
          fake_operation_events: 0,
        });
        await resolveRefundIncident(preparedIncidentId);
        await new Promise((resolve) => setTimeout(resolve, 2_100));

        const captureRecoveryFinance = fakeFinanceService();
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            {
              executeFinancialEvent: async (command) => {
                const result = await captureRecoveryFinance.executeFinancialEvent(command);
                if (command.operationKind === 'CAPTURE') {
                  throw new Error('SYSTEM_TEST_CRASH_AFTER_REFUND_CAPTURE_RECOVERY');
                }
                return result;
              },
              reconcile: (command) => captureRecoveryFinance.reconcile(command),
            }
          )
        ).rejects.toThrow('SYSTEM_TEST_CRASH_AFTER_REFUND_CAPTURE_RECOVERY');

        const refundOperationId = deterministicUuid(lifecycleKey, 'full-refund');
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            boundaryFakeFinanceService({ crashAfterRequestedOperation: 'REFUND' })
          )
        ).rejects.toThrow('SYSTEM_TEST_CRASH_AFTER_REQUESTED_REFUND');
        expect(await providerEffectCounts(refundOperationId)).toEqual({
          prepared_commands: 1,
          journal_commands: 1,
          dispatch_attempts: 0,
          fake_operations: 0,
          fake_operation_events: 0,
        });

        const requestedIncidentId = await openRefundIncident(
          'Refund replay must stop after an incident opens beyond REQUESTED authority.'
        );
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            boundaryFakeFinanceService({ leaseDurationSeconds: 2 })
          )
        ).rejects.toThrow(/HXUV1-FTL-47/u);
        expect(await providerEffectCounts(refundOperationId)).toEqual({
          prepared_commands: 1,
          journal_commands: 1,
          dispatch_attempts: 0,
          fake_operations: 0,
          fake_operation_events: 0,
        });
        await resolveRefundIncident(requestedIncidentId);
        await new Promise((resolve) => setTimeout(resolve, 2_100));
      }
      const crashBoundaries =
        path === 'SETTLED'
          ? [
              'CAPTURE',
              'SETTLE',
              'FUND',
              'PROVIDER_RELEASE',
              'PAYOUT',
              'OBSERVE_BANK_SETTLEMENT',
              'RECONCILE',
            ]
          : ['CAPTURE', 'REFUND', 'RECONCILE'];
      for (const crashBoundary of crashBoundaries) {
        const durableFinance = fakeFinanceService();
        let injected = false;
        const crashAfterCommittedBoundary = {
          executeFinancialEvent: async (
            command: Parameters<typeof durableFinance.executeFinancialEvent>[0]
          ) => {
            if (!alteredScenarioRefused && command.operationKind === 'CAPTURE') {
              await expect(
                durableFinance.executeFinancialEvent({ ...command, scenario: 'DECLINE' })
              ).rejects.toThrow(/HXUV1-FTL-45/u);
              await expectNoProviderEffect(command.operationId);
              alteredScenarioRefused = true;
            }
            if (!alteredPayoutReferenceRefused && command.operationKind === 'PAYOUT') {
              await expect(
                durableFinance.executeFinancialEvent({
                  ...command,
                  providerAccountReference: `tampered-${randomUUID()}`,
                })
              ).rejects.toThrow(/HXUV1-FTL-45/u);
              await expectNoProviderEffect(command.operationId);
              alteredPayoutReferenceRefused = true;
            }
            const result = await durableFinance.executeFinancialEvent(command);
            if (!injected && command.operationKind === crashBoundary) {
              injected = true;
              throw new Error(`SYSTEM_TEST_CRASH_AFTER_${crashBoundary}`);
            }
            return result;
          },
          reconcile: async (command: Parameters<typeof durableFinance.reconcile>[0]) => {
            if (!alteredReconciliationSnapshotRefused) {
              await expect(
                durableFinance.reconcile({
                  ...command,
                  snapshot: {
                    ...command.snapshot,
                    customerLedgerAmountCents:
                      command.snapshot.customerLedgerAmountCents + 1,
                  },
                })
              ).rejects.toThrow(/HXUV1-FTL-44/u);
              await expectNoProviderEffect(command.operationId);
              alteredReconciliationSnapshotRefused = true;
            }
            const result = await durableFinance.reconcile(command);
            if (!injected && crashBoundary === 'RECONCILE') {
              injected = true;
              throw new Error('SYSTEM_TEST_CRASH_AFTER_RECONCILE');
            }
            return result;
          },
        };
        await expect(
          new PostgresUniversalV1FulfillmentRepository(database).completeFakeFinancialLifecycle(
            lane.fixture.posterUserId,
            lifecycleCommand,
            crashAfterCommittedBoundary
          )
        ).rejects.toThrow(`SYSTEM_TEST_CRASH_AFTER_${crashBoundary}`);
        expect(injected).toBe(true);
      }
      expect(alteredScenarioRefused).toBe(true);
      expect(alteredPayoutReferenceRefused).toBe(path === 'SETTLED');
      expect(alteredReconciliationSnapshotRefused).toBe(true);
      const terminal = await fulfillment.completeFakeFinancialLifecycle(
        lane.fixture.posterUserId,
        lifecycleCommand
      );
      expect(terminal).toMatchObject({
        path,
        replayed: true,
        reconciliation_version: 1,
        provider_kind: 'FAKE',
        refund_event_id: path === 'FULL_REFUND' ? expect.any(String) : null,
        settlement_event_id: path === 'SETTLED' ? expect.any(String) : null,
        payment_creation_performed: false,
        hard_assignment_created: false,
      });

      const terminalLifecycleOperationIds =
        path === 'SETTLED'
          ? [
              deterministicUuid(lifecycleKey, 'capture'),
              deterministicUuid(lifecycleKey, 'settle'),
              deterministicUuid(lifecycleKey, 'fund'),
              deterministicUuid(lifecycleKey, 'provider-release'),
              deterministicUuid(lifecycleKey, 'payout'),
              deterministicUuid(lifecycleKey, 'bank-settlement'),
            ]
          : [
              deterministicUuid(lifecycleKey, 'capture'),
              deterministicUuid(lifecycleKey, 'full-refund'),
            ];
      const reconciliationOperationId = deterministicUuid(lifecycleKey, 'reconciliation');
      const operationIds = [
        ...financialOperationIds(materializationKey),
        ...providerAccountOperationIds,
        ...terminalLifecycleOperationIds,
        reconciliationOperationId,
      ];

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
          operationIds,
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
        event_kinds:
          path === 'SETTLED'
            ? [
                'PAYMENT_METHOD_PREPARED',
                'AUTHORIZED',
                'SECURED',
                'CAPTURED',
                'SETTLEMENT_OBSERVED',
                'FUNDING_OBSERVED',
                'PROVIDER_RELEASED',
                'PAYOUT_OBSERVED',
                'BANK_SETTLEMENT_OBSERVED',
              ]
            : ['PAYMENT_METHOD_PREPARED', 'AUTHORIZED', 'SECURED', 'CAPTURED', 'REFUNDED'],
        provider_kinds: ['FAKE'],
        approved_provider_events: 0,
        approved_provider_operations: 0,
        fake_operations: operationIds.length,
        fake_operation_events: operationIds.length,
        escrows: 0,
        quote_payments: 0,
        capture_state: 'CAPTURED',
        settlement_state: path === 'SETTLED' ? 'SETTLED' : 'NOT_APPLICABLE',
        funding_state: path === 'SETTLED' ? 'FUNDED' : 'NOT_APPLICABLE',
        provider_release_state: path === 'SETTLED' ? 'RELEASED' : 'NOT_APPLICABLE',
        payout_state: path === 'SETTLED' ? 'PAID' : 'NOT_APPLICABLE',
        bank_settlement_state: path === 'SETTLED' ? 'SETTLED' : 'NOT_APPLICABLE',
        reconciliation_state: path === 'SETTLED' ? 'MATCHED' : 'CLOSED',
        customer_ledger_amount_cents: path === 'SETTLED' ? '10000' : '0',
        provider_ledger_amount_cents: path === 'SETTLED' ? '8000' : '0',
      });

      const terminalRelatedOperationId = terminalLifecycleOperationIds.at(-1)!;
      const authority = await pool.query<{
        journal_commands: number;
        dispatch_attempts: number;
        observed_outcomes: number;
        prepared_commands: number;
        exact_prepared_requests: number;
        lifecycle_bridges: number;
        pre_work_order_commands: number;
        post_work_order_commands: number;
        provider_scoped_commands: number;
        reconciliation_commands: number;
        reconciliations: number;
        capture_completion_bindings: number;
        terminal_intents: number;
        provider_account_facts: number;
        reconciliation_bridges: number;
        canonical_snapshot_bindings: number;
      }>(
        `SELECT
         (SELECT COUNT(*)::integer
            FROM public.financial_provider_command_journal command
           WHERE command.operation_id = ANY($1::uuid[])) AS journal_commands,
         (SELECT COUNT(*)::integer
            FROM public.financial_provider_command_dispatch_attempts attempt
            JOIN public.financial_provider_command_journal command
              ON command.command_id = attempt.command_id
           WHERE command.operation_id = ANY($1::uuid[])) AS dispatch_attempts,
         (SELECT COUNT(*)::integer
            FROM public.financial_provider_command_outcome_facts outcome
            JOIN public.financial_provider_command_journal command
              ON command.command_id = outcome.command_id
           WHERE command.operation_id = ANY($1::uuid[])
             AND outcome.outcome_kind = 'OUTCOME_OBSERVED'
             AND outcome.retryable IS FALSE) AS observed_outcomes,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_prepared_financial_commands prepared
           WHERE prepared.operation_id = ANY($1::uuid[])) AS prepared_commands,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_prepared_financial_commands prepared
            JOIN public.financial_provider_command_journal command
              ON command.prepared_financial_command_id = prepared.prepared_command_id
             AND command.prepared_authority_sha256 = prepared.authority_context_sha256
             AND command.work_order_id IS NOT DISTINCT FROM prepared.work_order_id
             AND command.request_sha256 = prepared.provider_request_sha256
           WHERE prepared.operation_id = ANY($1::uuid[])) AS exact_prepared_requests,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_fake_financial_lifecycle_bridges bridge
           WHERE bridge.fake_operation_id = ANY($1::uuid[])) AS lifecycle_bridges,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_prepared_financial_commands prepared
           WHERE prepared.operation_id = ANY($1::uuid[])
             AND prepared.operation_kind IN (
               'PREPARE_PAYMENT_METHOD', 'AUTHORIZE', 'SECURE'
             )
             AND prepared.work_order_id IS NULL) AS pre_work_order_commands,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_prepared_financial_commands prepared
           WHERE prepared.operation_id = ANY($1::uuid[])
             AND prepared.operation_kind IN (
               'CAPTURE', 'REFUND', 'SETTLE', 'FUND',
               'PROVIDER_RELEASE', 'PAYOUT', 'OBSERVE_BANK_SETTLEMENT'
             )
             AND prepared.work_order_id = $2) AS post_work_order_commands,
         (SELECT COUNT(*)::integer
            FROM public.financial_provider_command_journal command
           WHERE command.operation_id = ANY($1::uuid[])
             AND command.operation_kind IN (
               'ONBOARD_PROVIDER', 'REFRESH_PROVIDER_ACCOUNT_STATE'
             )
             AND command.prepared_financial_command_id IS NULL
             AND command.prepared_authority_sha256 IS NULL
             AND command.task_draft_id IS NULL
             AND command.task_id IS NULL
             AND command.work_order_id IS NULL
             AND command.related_operation_id IS NULL
             AND command.amount_cents IS NULL
             AND command.currency IS NULL
             AND command.recorded_actor_id = $5
             AND command.recorded_actor_kind = 'PARTICIPANT') AS provider_scoped_commands,
         (SELECT COUNT(*)::integer
            FROM public.financial_provider_command_journal command
           WHERE command.operation_id = $3
             AND command.operation_kind = 'RECONCILE'
             AND command.prepared_financial_command_id IS NULL
             AND command.prepared_authority_sha256 IS NULL
             AND command.task_draft_id IS NULL
             AND command.task_id IS NULL
             AND command.work_order_id = $2
             AND command.related_operation_id = $4
             AND command.amount_cents IS NULL
             AND command.currency IS NULL
             AND command.recorded_actor_id = $6
             AND command.recorded_actor_kind = 'PARTICIPANT') AS reconciliation_commands,
         (SELECT COUNT(*)::integer
            FROM public.task_reconciliation_facts reconciliation
           WHERE reconciliation.id = $7
             AND reconciliation.work_order_id = $2
             AND reconciliation.evidence->>'operationId' = $3::text) AS reconciliations,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_prepared_financial_commands prepared
           WHERE prepared.operation_id = $8
             AND prepared.operation_kind = 'CAPTURE'
             AND prepared.work_order_id = $2
             AND prepared.completion_fact_id = $9) AS capture_completion_bindings,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_fake_terminal_lifecycle_intents intent
           WHERE intent.work_order_id = $2
             AND intent.idempotency_key = $10
             AND intent.requested_by = $6
             AND intent.terminal_path = $11) AS terminal_intents,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_fake_provider_account_facts account
           WHERE account.provider_subject_kind = CASE
                   WHEN $12::UUID IS NULL THEN 'USER'
                   ELSE 'ORGANIZATION'
                 END
             AND account.provider_user_id IS NOT DISTINCT FROM CASE
                   WHEN $12::UUID IS NULL THEN $5::UUID
                   ELSE NULL
                 END
             AND account.provider_organization_id IS NOT DISTINCT FROM $12::UUID
             AND account.recorded_by = $5
             AND account.account_state = 'ENABLED'
             AND account.payouts_enabled IS TRUE) AS provider_account_facts,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_fake_reconciliation_bridges bridge
            JOIN public.universal_v1_fake_terminal_lifecycle_intents intent
              ON intent.terminal_intent_id = bridge.terminal_intent_id
           WHERE bridge.reconciliation_fact_id = $7
             AND intent.work_order_id = $2
             AND bridge.provider_account_fact_id IS NOT DISTINCT FROM intent.provider_account_fact_id
         ) AS reconciliation_bridges,
         (SELECT COUNT(*)::integer
            FROM public.universal_v1_fake_reconciliation_bridges bridge
            JOIN public.task_reconciliation_facts reconciliation
              ON reconciliation.id = bridge.reconciliation_fact_id
            JOIN public.hxos_fake_financial_operation_events_v1 fake_event
              ON fake_event.event_id = bridge.fake_operation_event_id
           WHERE bridge.reconciliation_fact_id = $7
             AND fake_event.metadata->>'reconciliationSnapshotSha256' =
                 public.universal_v1_reconciliation_snapshot_sha256_v1(reconciliation.id)
             AND reconciliation.evidence->>'reconciliationSnapshotSha256' =
                 public.universal_v1_reconciliation_snapshot_sha256_v1(reconciliation.id)
         ) AS canonical_snapshot_bindings`,
        [
          operationIds,
          materialized.work_order_id,
          reconciliationOperationId,
          terminalRelatedOperationId,
          lane.fixture.provider.actor_user_id,
          lane.fixture.posterUserId,
          terminal.reconciliation_id,
          deterministicUuid(lifecycleKey, 'capture'),
          approved.completion_fact_id,
          lifecycleKey,
          path,
          lane.fixture.provider.provider_organization_id,
        ]
      );
      const expectedPreparedCommands = 3 + terminalLifecycleOperationIds.length;
      expect(authority.rows[0]).toEqual({
        journal_commands: operationIds.length,
        dispatch_attempts: operationIds.length,
        observed_outcomes: operationIds.length,
        prepared_commands: expectedPreparedCommands,
        exact_prepared_requests: expectedPreparedCommands,
        lifecycle_bridges: expectedPreparedCommands,
        pre_work_order_commands: 3,
        post_work_order_commands: terminalLifecycleOperationIds.length,
        provider_scoped_commands: providerAccountOperationIds.length,
        reconciliation_commands: 1,
        reconciliations: 1,
        capture_completion_bindings: 1,
        terminal_intents: 1,
        provider_account_facts: path === 'SETTLED' ? 1 : 0,
        reconciliation_bridges: 1,
        canonical_snapshot_bindings: 1,
      });
    }
  );
});
