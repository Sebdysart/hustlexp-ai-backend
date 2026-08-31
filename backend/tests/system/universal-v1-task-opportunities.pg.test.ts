import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Hono } from 'hono';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildIdentity } from '../../src/buildIdentity.js';
import type { QueryFn } from '../../src/db.js';
import { releaseManifestEvidence } from '../../src/releaseManifest.js';
import {
  submitUniversalV1TaskDraft,
  type TaskDraftIngressDependencies,
  type TaskDraftIngressInput,
} from '../../src/routers/web/taskDrafts.js';
import { registerHealthRoutes } from '../../src/serverHealthRoutes.js';
import { registerTrpcRoutes } from '../../src/serverTrpcRoutes.js';
import type { HustleApp } from '../../src/serverTypes.js';
import {
  UniversalV1TaskOpportunityService,
  universalV1TaskOpportunityAuthority,
} from '../../src/services/UniversalV1TaskOpportunityService.js';
import {
  claimUniversalV1TaskDraft,
  type UniversalV1TaskDraftClaimDependencies,
} from '../../src/services/UniversalV1TaskDraftClaim.js';
import { createTestTask } from '../setup.js';
import {
  ensureUniversalV1SyntheticServiceCell,
  SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
  SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
  SYNTHETIC_SERVICE_CELL_REGION_CODE,
} from '../helpers/universal-v1-service-cell-authority.js';

const enabled = process.env.HX_ALLOW_TASK_DRAFT_INGRESS_PG === '1';
const describePg = enabled ? describe : describe.skip;
const databaseUrl = process.env.LOCAL_TEST_DB_URL ?? '';
const applicationDatabaseUrl = process.env.DATABASE_URL ?? '';
const now = 1_800_000_000_000;
const localCertificationSecret =
  'required-test-opportunity-http-auth-secret-v1-0000000000000000';
const relationshipOriginMigration = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20261001_universal_v1_relationship_origin_v1.sql'
  ),
  'utf8'
);
const opportunityMigration = readFileSync(
  resolve(
    process.cwd(),
    'backend/database/migrations/20261003_universal_v1_task_opportunities_v1.sql'
  ),
  'utf8'
);

interface ProviderFixture {
  userId: string;
  organizationId: string | null;
  credentialId: string | null;
}

interface OpportunityFixture {
  taskDraftId: string;
  posterUserId: string;
  opportunityId: string;
  opportunityVersion: number;
  routingDecisionId: string;
  relationshipOriginId: string;
  scopeArtifactSha256: string;
  workCategoryCode: string;
  rawInputSecret: string;
  leadEmailSecret: string;
}

interface ConsequentialState {
  tasks: number;
  reservations: number;
  eligibility_decisions: number;
  private_data_releases: number;
  financial_operations: number;
  financial_events: number;
  work_orders: number;
  escrows: number;
  payout_events: number;
  earnings_rows: number;
}

interface ApiTaskDraftResult {
  ok: true;
  submission_id: string;
  draft_id: string;
  status: string;
  version: number;
  card_token?: string;
  routing: {
    outcome: string;
    decision_version: number;
  };
  payment_creation_frozen: true;
  hard_assignment_created: false;
}

interface ApiLeadResult {
  ok: true;
  submission_id: string;
  lead_id: string;
  status: string;
}

interface ApiClaimResult {
  ok: true;
  draft_id: string;
  status: 'account_claimed';
  claim_version: 1;
  payment_creation_frozen: true;
  hard_assignment_created: false;
}

interface ApiOpportunity {
  opportunityId: string;
  opportunityVersion: number;
  taskDraftId: string;
  workCategoryCode: string;
  privacyPosture: 'ROUTE_CONTEXT_ALLOWLIST_ONLY';
  assignmentAuthority: 'NONE';
  addressContactAuthority: 'NONE';
  financialAuthority: 'NONE';
}

interface ApiBrowseResult {
  state: 'READY';
  opportunities: ApiOpportunity[];
}

interface ApiInterestResult {
  interestId: string;
  opportunityId: string;
  opportunityVersion: number;
  taskDraftId: string;
  idempotencyReplayed: boolean;
  reservationCreated: false;
  eligibilityDecisionCreated: false;
  assignmentCreated: false;
  addressContactAccessGranted: false;
  financialEventCreated: false;
  payableCreated: false;
  guaranteedEarning: false;
}

interface ApiJourneyResult {
  interest: ApiInterestResult & { routing: { outcome: string } };
  interestStatus: string;
  opportunityCurrent: boolean;
  providerObservationCurrent: boolean;
  taskEligibility: { state: string; decisionId: string | null };
  processorEligibility: {
    decisionPresent: boolean;
    paymentEligibleObservation: boolean;
    payoutFundingEligibleObservation: boolean;
    positiveAuthority: 'NONE';
  };
  estimateInvitation: { state: string; invitationId: string | null };
  nextStep: string;
  blockerCodes: string[];
  commandMutationPerformed: false;
  authority: {
    databaseCallerIdentityAttested: false;
    initialEligibilityCommand: 'HELD_PENDING_APPROVED_ACTOR_ATTESTATION';
    mutationAuthority: 'NONE';
    assignmentAuthority: 'NONE';
    addressContactAuthority: 'NONE';
    financialAuthority: 'NONE';
  };
}

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
    throw new Error('Task Opportunity proof may run only on the exact disposable system database');
  }
}

function assertDisposableApplicationDatabase(value: string): void {
  const parsed = new URL(value);
  if (
    !['postgres:', 'postgresql:'].includes(parsed.protocol) ||
    parsed.hostname !== '127.0.0.1' ||
    parsed.port !== '5432' ||
    parsed.username !== 'hx_ci_runner' ||
    parsed.pathname !== '/hx_ci_invariant_test' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(
      'Task Opportunity HTTP proof may run only on the exact disposable application database'
    );
  }
}

function providerContext(userId: string) {
  return {
    user: {
      id: userId,
      is_banned: false,
      account_status: 'ACTIVE',
      default_mode: 'worker',
    },
    firebaseUid: `firebase-${userId}`,
  } as any;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function localCertificationToken(uid: string): string {
  const issuedAt = Math.floor(Date.now() / 1_000);
  const unsigned = `${encodeJson({ alg: 'HS256', typ: 'JWT' })}.${encodeJson({
    iss: 'hxos-local-certification',
    aud: 'hustlexp-engine-test',
    sub: uid,
    iat: issuedAt,
    exp: issuedAt + 300,
    hxos_test: true,
  })}`;
  const signature = createHmac('sha256', localCertificationSecret)
    .update(unsigned)
    .digest('base64url');
  return `${unsigned}.${signature}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function trpcData<T>(envelope: unknown): T {
  const root = asRecord(envelope);
  const result = asRecord(root?.result);
  const data = result?.data;
  const record = asRecord(data);
  return (record && Object.hasOwn(record, 'json') ? record.json : data) as T;
}

async function callTrpc<T>(
  app: HustleApp,
  path: string,
  operation: 'query' | 'mutation',
  input: unknown,
  bearerToken?: string
): Promise<T> {
  const headers: Record<string, string> = {
    origin: 'http://localhost:5173',
    'x-real-ip': '127.0.0.1',
  };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;
  const requestPath = operation === 'query'
    ? `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`
    : `/trpc/${path}`;
  if (operation === 'mutation') headers['content-type'] = 'application/json';
  const response = await app.request(requestPath, {
    method: operation === 'query' ? 'GET' : 'POST',
    headers,
    ...(operation === 'mutation' ? { body: JSON.stringify(input) } : {}),
  });
  const text = await response.text();
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error(`${path} returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || asRecord(envelope)?.error) {
    throw new Error(`${path} returned HTTP ${response.status}: ${text}`);
  }
  return trpcData<T>(envelope);
}

function assertRecursivelyPrivacyRedacted(value: unknown, secrets: readonly string[]): void {
  const forbiddenKeys = new Set([
    'contact',
    'customerIdentity',
    'email',
    'exactAddress',
    'leadId',
    'phone',
    'posterUserId',
    'rawInput',
    'scopeSummary',
    'customer_identity',
    'exact_address',
    'lead_id',
    'poster_user_id',
    'raw_input',
    'scope_summary',
  ]);
  const visit = (candidate: unknown): void => {
    if (typeof candidate === 'string') {
      for (const secret of secrets) expect(candidate).not.toContain(secret);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    const record = asRecord(candidate);
    if (!record) return;
    for (const [key, nested] of Object.entries(record)) {
      expect(forbiddenKeys.has(key), `private API field ${key} must remain omitted`).toBe(false);
      visit(nested);
    }
  };
  visit(value);
}

describePg('Universal V1 Task Opportunities PostgreSQL authority', () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 20 });
  const applicationPool = new pg.Pool({ connectionString: applicationDatabaseUrl, max: 10 });

  const transaction = async <T>(callback: (query: QueryFn) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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

  const database = {
    query: async <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      const result = await pool.query(sql, params);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? 0 };
    },
    transaction,
  };
  const service = new UniversalV1TaskOpportunityService(database);

  const ingressDependencies: Partial<TaskDraftIngressDependencies> = {
    env: {
      NODE_ENV: 'test',
      HX_ENVIRONMENT: 'test',
      HX_HUMAN_VERIFICATION_MODE: 'synthetic',
      HX_HUMAN_VERIFICATION_URL: 'http://127.0.0.1:8080/v1/human-verification/verify',
      HX_HUMAN_VERIFICATION_SECRET: 'required-test-human-verification-secret-v1',
      PUBLIC_INGRESS_IP_HASH_SALT: 'required-test-opportunity-ip-salt-v1',
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
    assertDisposableApplicationDatabase(applicationDatabaseUrl);
    expect(process.env.HX_PAYMENT_CREATION_MODE).toBe('frozen');
    await pool.query('SELECT 1');
    await applicationPool.query('SELECT 1');

    // The required test gate recreates this database from the registered
    // canonical baseline. These unregistered successors are installed in
    // dependency order here, so the first run is a clean installation and
    // later diagnostic runs prove deterministic replay.
    await pool.query(relationshipOriginMigration);
    await pool.query(opportunityMigration);
    await pool.query(opportunityMigration);
    await ensureUniversalV1SyntheticServiceCell(pool);
    await applicationPool.query(relationshipOriginMigration);
    await applicationPool.query(opportunityMigration);
    await applicationPool.query(opportunityMigration);
    await ensureUniversalV1SyntheticServiceCell(applicationPool);
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await applicationPool.end();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  async function userFixture(
    mode: 'poster' | 'worker' = 'worker',
    state: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
    isMinor = false,
    isBanned = false,
    targetPool: pg.Pool = pool,
    requestedFirebaseUid?: string
  ): Promise<string> {
    const userId = randomUUID();
    await targetPool.query(
      `INSERT INTO public.users(
         id, firebase_uid, email, full_name, default_mode, date_of_birth,
         is_minor, is_banned, account_status
       ) VALUES (
         $1, $2, $3, 'Task Opportunity System Test', $4,
         CASE WHEN $6 THEN DATE '2012-01-01' ELSE DATE '1990-01-01' END,
         $6, $7, $5
       )`,
      [
        userId,
        requestedFirebaseUid ?? `firebase-${userId}`,
        `${userId}@opportunity.example.invalid`,
        mode,
        state,
        isMinor,
        isBanned,
      ]
    );
    return userId;
  }

  async function capabilityFixture(
    userId: string,
    providerClass: 'GENERAL_SERVICE_PROVIDER' | 'VERIFIED_TRADE_BUSINESS',
    targetPool: pg.Pool = pool
  ): Promise<void> {
    await targetPool.query(
      `INSERT INTO public.capability_profiles(user_id, trust_tier, provider_class)
       VALUES ($1, 1, $2)`,
      [userId, providerClass]
    );
  }

  async function generalIndividualFixture(): Promise<ProviderFixture> {
    const userId = await userFixture();
    await capabilityFixture(userId, 'GENERAL_SERVICE_PROVIDER');
    return { userId, organizationId: null, credentialId: null };
  }

  async function generalBusinessFixture(): Promise<ProviderFixture> {
    const userId = await userFixture();
    const organizationId = randomUUID();
    await capabilityFixture(userId, 'GENERAL_SERVICE_PROVIDER');
    await pool.query(
      `INSERT INTO public.business_organizations(
         id, legal_name, display_name, provider_enabled, client_enabled,
         verification_status, status, created_by, creation_idempotency_key,
         provider_class
       ) VALUES (
         $1, 'Synthetic General Services LLC', 'Synthetic General Services',
         TRUE, FALSE, 'VERIFIED', 'ACTIVE', $2, $3,
         'GENERAL_SERVICE_PROVIDER'
       )`,
      [organizationId, userId, `opportunity-org:${organizationId}`]
    );
    await pool.query(
      `INSERT INTO public.business_memberships(
         organization_id, user_id, role, status, invited_by, accepted_at
       ) VALUES ($1, $2, 'OWNER', 'ACTIVE', $2, clock_timestamp())`,
      [organizationId, userId]
    );
    return { userId, organizationId, credentialId: null };
  }

  async function verifiedTradeBusinessFixture(
    targetPool: pg.Pool = pool,
    requestedFirebaseUid?: string
  ): Promise<ProviderFixture> {
    const userId = await userFixture(
      'worker',
      'ACTIVE',
      false,
      false,
      targetPool,
      requestedFirebaseUid
    );
    const organizationId = randomUUID();
    const membershipId = randomUUID();
    const credentialId = randomUUID();
    await capabilityFixture(userId, 'VERIFIED_TRADE_BUSINESS', targetPool);
    await targetPool.query(
      `INSERT INTO public.business_organizations(
         id, legal_name, display_name, provider_enabled, client_enabled,
         verification_status, status, created_by, creation_idempotency_key,
         provider_class
       ) VALUES (
         $1, 'Synthetic XQ Plumbing LLC', 'Synthetic XQ Plumbing', TRUE, FALSE,
         'VERIFIED', 'ACTIVE', $2, $3, 'VERIFIED_TRADE_BUSINESS'
       )`,
      [organizationId, userId, `opportunity-trade-org:${organizationId}`]
    );
    await targetPool.query(
      `INSERT INTO public.business_memberships(
         id, organization_id, user_id, role, status, invited_by, accepted_at
       ) VALUES ($1, $2, $3, 'OWNER', 'ACTIVE', $3, clock_timestamp())`,
      [membershipId, organizationId, userId]
    );
    await targetPool.query(
      `INSERT INTO public.business_credentials(
         id, organization_id, membership_id, credential_type, status,
         expires_at, evidence_hash, verified_by, verified_at,
         qualification_contract_version, issuing_authority, jurisdiction_code,
         license_scope, permitted_work_categories, credential_evidence,
         official_source_checked_at
       ) VALUES (
         $1, $2, $3, 'PLUMBING_LICENSE', 'ACTIVE',
         TIMESTAMPTZ '2030-01-01T00:00:00Z', $4, $5,
         TIMESTAMPTZ '2026-08-29T00:00:00Z', 1,
         'XQ Trade Licensing Authority', $6,
         'Residential plumbing installation and repair',
         ARRAY['plumbing']::TEXT[], $7::JSONB,
         TIMESTAMPTZ '2026-08-29T01:00:00Z'
       )`,
      [
        credentialId,
        organizationId,
        membershipId,
        sha256(`credential-evidence:${credentialId}`),
        userId,
        SYNTHETIC_SERVICE_CELL_REGION_CODE,
        JSON.stringify({
          source: 'synthetic-official-register',
          registryStatus: 'ACTIVE',
          registryId: `XQ-${credentialId}`,
        }),
      ]
    );
    await targetPool.query(
      `INSERT INTO public.verified_trades(
         user_id, trade, state, expires_at, provider_class,
         provider_organization_id, business_credential_id,
         universal_contract_version
       ) VALUES (
         $1, 'plumbing', 'XQ', DATE '2030-01-01',
         'VERIFIED_TRADE_BUSINESS', $2, $3, 1
       )`,
      [userId, organizationId, credentialId]
    );
    return { userId, organizationId, credentialId };
  }

  async function claimedOpportunityFixture(
    category: 'furniture_assembly' | 'handyman',
    label: string
  ): Promise<OpportunityFixture> {
    const submissionId = randomUUID();
    const cardToken = randomBytes(32).toString('hex');
    const rawInputSecret =
      category === 'handyman'
        ? `${label} private raw scope ${randomUUID()}`
        : 'Assemble a sealed-box dresser with ordinary hand tools';
    const leadEmailSecret = `${randomUUID()}@private-opportunity.example.invalid`;
    const create: TaskDraftIngressInput = {
      action: 'create',
      submission_id: submissionId,
      expected_version: 0,
      card_token: cardToken,
      raw_input:
        category === 'handyman'
          ? `${rawInputSecret}; replace a leaking fixture using licensed plumbing work`
          : rawInputSecret,
      category,
      answers: {
        ...(category === 'furniture_assembly' ? { item: 'Dresser', new_in_box: true } : {}),
        timing: 'Flexible weekday afternoon',
        access: 'Details released only after later authority',
        scope_confirmed_at: new Date(now).toISOString(),
      },
      zip: SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
      region: 'untrusted-client-location-hint',
      photo_count: 0,
      consent_version: 'v1',
      turnstile_token: `synthetic-opportunity-${randomUUID()}`,
      client_ts: now,
    };
    const created = await submitUniversalV1TaskDraft(
      create,
      { ip: '203.0.113.92' },
      ingressDependencies
    );
    if (!created.ok) throw new Error('synthetic TaskDraft was rejected');

    const leadSubmissionId = randomUUID();
    await pool.query(
      `INSERT INTO public.leads(submission_id, lead_type, email, name, answers, source)
       VALUES (
         $1, 'poster', $2, $3,
         jsonb_build_object('task_draft_submission_id', $4::TEXT),
         'required_test'
       )`,
      [leadSubmissionId, leadEmailSecret, `${label} Private Customer`, submissionId]
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
      { ip: '203.0.113.92' },
      ingressDependencies
    );
    if (!linked.ok) throw new Error('synthetic TaskDraft contact link was rejected');

    const posterUserId = await userFixture('poster');
    await claimUniversalV1TaskDraft(
      {
        submission_id: submissionId,
        card_token: cardToken,
        expected_version: 0,
        idempotency_key: `claim-opportunity:${submissionId}`,
        client_ts: now,
      },
      posterUserId,
      claimDependencies
    );
    const opportunity = await pool.query<{
      opportunity_id: string;
      opportunity_version: number;
      routing_decision_id: string;
      relationship_origin_id: string;
      scope_artifact_sha256: string;
      work_category_code: string;
    }>(
      `SELECT opportunity_id, opportunity_version, routing_decision_id,
              relationship_origin_id, btrim(scope_artifact_sha256) AS scope_artifact_sha256,
              work_category_code
       FROM public.current_universal_v1_task_opportunities_v1
       WHERE task_draft_id = $1`,
      [linked.draft_id]
    );
    const row = opportunity.rows[0];
    if (!row) throw new Error('canonical TaskDraft did not project a Task Opportunity');
    return {
      taskDraftId: linked.draft_id,
      posterUserId,
      opportunityId: row.opportunity_id,
      opportunityVersion: row.opportunity_version,
      routingDecisionId: row.routing_decision_id,
      relationshipOriginId: row.relationship_origin_id,
      scopeArtifactSha256: row.scope_artifact_sha256,
      workCategoryCode: row.work_category_code,
      rawInputSecret,
      leadEmailSecret,
    };
  }

  async function browse(provider: ProviderFixture, workCategoryCode?: string) {
    return service.browse(providerContext(provider.userId), {
      serviceCellAuthorityId: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
      workCategoryCode,
      providerOrganizationId: provider.organizationId ?? undefined,
      businessCredentialId: provider.credentialId ?? undefined,
      limit: 100,
      offset: 0,
    });
  }

  async function express(provider: ProviderFixture, opportunity: OpportunityFixture, key: string) {
    return service.expressInterest(providerContext(provider.userId), {
      opportunityId: opportunity.opportunityId,
      expectedOpportunityVersion: opportunity.opportunityVersion,
      providerOrganizationId: provider.organizationId ?? undefined,
      businessCredentialId: provider.credentialId ?? undefined,
      idempotencyKey: key,
    });
  }

  async function consequentialState(targetPool: pg.Pool = pool): Promise<ConsequentialState> {
    const result = await targetPool.query<ConsequentialState>(`
      SELECT
        (SELECT COUNT(*)::INTEGER FROM public.tasks) AS tasks,
        (SELECT COUNT(*)::INTEGER FROM public.task_reservations) AS reservations,
        (SELECT COUNT(*)::INTEGER FROM public.task_provider_eligibility_decisions)
          AS eligibility_decisions,
        (SELECT COUNT(*)::INTEGER FROM public.task_location_access_log)
          AS private_data_releases,
        (SELECT COUNT(*)::INTEGER FROM public.task_financial_operations)
          AS financial_operations,
        (SELECT COUNT(*)::INTEGER FROM public.task_financial_security_events)
          AS financial_events,
        (SELECT COUNT(*)::INTEGER FROM public.task_work_orders) AS work_orders,
        (SELECT COUNT(*)::INTEGER FROM public.escrows) AS escrows,
        (SELECT COUNT(*)::INTEGER FROM public.business_provider_payout_events)
          AS payout_events,
        (SELECT COUNT(*)::INTEGER FROM public.verification_earnings_ledger)
          AS earnings_rows
    `);
    return result.rows[0]!;
  }

  it('installs and replays after RelationshipOrigin with fixed search paths and no PUBLIC power', async () => {
    const installed = await pool.query<{
      view_installed: boolean;
      opportunity_constraint_valid: boolean;
      public_executable_functions: number;
      unsafe_function_search_paths: number;
    }>(`
      SELECT
        to_regclass('public.current_universal_v1_task_opportunities_v1') IS NOT NULL
          AS view_installed,
        EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conrelid = 'public.task_applications'::regclass
            AND conname = 'task_applications_interest_authority_check'
            AND convalidated
        ) AS opportunity_constraint_valid,
        (
          SELECT COUNT(*)::INTEGER
          FROM pg_proc procedure
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure.proname IN (
              'universal_v1_task_opportunity_interest_request_sha256',
              'enforce_universal_post_estimate_interest',
              'enforce_universal_v1_task_opportunity_interest_v1',
              'enforce_universal_interest_integrity',
              'prevent_universal_v1_task_opportunity_interest_delete',
              'prevent_universal_v1_task_opportunity_interest_truncate'
            )
            AND has_function_privilege(
              'public', procedure.oid, 'EXECUTE'
            )
        ) AS public_executable_functions,
        (
          SELECT COUNT(*)::INTEGER
          FROM pg_proc procedure
          JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
          WHERE namespace.nspname = 'public'
            AND procedure.proname IN (
              'universal_v1_task_opportunity_interest_request_sha256',
              'enforce_universal_post_estimate_interest',
              'enforce_universal_v1_task_opportunity_interest_v1',
              'enforce_universal_interest_integrity',
              'prevent_universal_v1_task_opportunity_interest_delete',
              'prevent_universal_v1_task_opportunity_interest_truncate'
            )
            AND NOT COALESCE(procedure.proconfig, ARRAY[]::TEXT[])
              @> ARRAY['search_path=pg_catalog, public']::TEXT[]
        ) AS unsafe_function_search_paths
    `);
    expect(installed.rows[0]).toEqual({
      view_installed: true,
      opportunity_constraint_valid: true,
      public_executable_functions: 0,
      unsafe_function_search_paths: 0,
    });
    expect(universalV1TaskOpportunityAuthority).toMatchObject({
      databaseCallerIdentityAttested: false,
      eligibilityAuthority: 'HELD_PENDING_TASK_SPECIFIC_EVALUATION',
      assignmentAuthority: 'NONE',
      addressContactAuthority: 'NONE',
      financialAuthority: 'NONE',
      payableAuthority: 'NONE',
      guaranteedEarningAuthority: 'NONE',
    });
  });

  it('runs the canonical public HTTP and authenticated provider journey to the Gate-2 hold', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('HX_ENVIRONMENT', 'test');
    vi.stubEnv('ENGINE_API_MODE', 'test');
    vi.stubEnv('STRIPE_MODE', 'test');
    vi.stubEnv('HX_PAYMENT_CREATION_MODE', 'frozen');
    vi.stubEnv('HXOS_ALLOW_LOCAL_TEST_AUTH', 'true');
    vi.stubEnv('HXOS_LOCAL_TEST_AUTH_SECRET', localCertificationSecret);
    vi.stubEnv('HX_HUMAN_VERIFICATION_MODE', 'synthetic');
    vi.stubEnv(
      'HX_HUMAN_VERIFICATION_URL',
      'http://127.0.0.1:8080/v1/human-verification/verify'
    );
    vi.stubEnv(
      'HX_HUMAN_VERIFICATION_SECRET',
      'required-test-human-verification-secret-v1'
    );
    vi.stubEnv('PUBLIC_INGRESS_IP_HASH_SALT', 'required-test-opportunity-http-ip-salt-v1');
    vi.stubEnv('TASK_DRAFT_RATE_LIMIT_PER_IP_HOUR', '1000');
    vi.stubEnv('LEAD_PRIVACY_HASH_SALT', 'required-test-opportunity-http-lead-salt-v1');
    vi.stubEnv('LEAD_RATE_LIMIT_PER_IP_TYPE_HOUR', '1000');
    vi.stubEnv('ALLOWED_ORIGINS', 'http://localhost:5173');

    const syntheticHumanVerification = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit
    ) => {
      const target = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      expect(target).toBe('http://127.0.0.1:8080/v1/human-verification/verify');
      const body = new URLSearchParams(String(init?.body ?? ''));
      expect(body.get('secret')).toBe('required-test-human-verification-secret-v1');
      expect(body.get('expected_action')).toBe('task');
      expect(body.get('response')).toMatch(/^synthetic-http-task-/u);
      return new Response(
        JSON.stringify({
          success: true,
          action: 'task',
          hostname: 'synthetic.invalid',
          metadata: { result_with_testing_key: true },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', syntheticHumanVerification);

    const app = new Hono() as unknown as HustleApp;
    registerHealthRoutes(app);
    registerTrpcRoutes(app);

    const posterUid = `hxos-local-poster-api-${randomUUID()}`;
    const providerUid = `hxos-local-hustler-api-${randomUUID()}`;
    const posterUserId = await userFixture(
      'poster',
      'ACTIVE',
      false,
      false,
      applicationPool,
      posterUid
    );
    const provider = await verifiedTradeBusinessFixture(applicationPool, providerUid);
    if (!provider.organizationId || !provider.credentialId) {
      throw new Error('verified trade HTTP fixture lacks its exact organization or credential');
    }
    const posterToken = localCertificationToken(posterUid);
    const providerToken = localCertificationToken(providerUid);
    const before = await consequentialState(applicationPool);

    const requestNow = Date.now();
    const submissionId = randomUUID();
    const cardToken = randomBytes(32).toString('hex');
    const rawScopeSecret = `private-http-scope-${randomUUID()}`;
    const exactAddress = '123 Main Street Apt 4';
    const leadSubmissionId = randomUUID();
    const leadEmailSecret = `${randomUUID()}@private-http.example.invalid`;
    const leadNameSecret = `Private HTTP Customer ${randomUUID()}`;
    const leadPhoneSecret = '+1 (425) 555-0199';
    const commonAnswers = {
      timing: 'Flexible weekday afternoon',
      access: 'Details released only after later authority',
      scope_confirmed_at: new Date(requestNow).toISOString(),
    };
    const createInput: TaskDraftIngressInput = {
      action: 'create',
      submission_id: submissionId,
      expected_version: 0,
      card_token: cardToken,
      raw_input:
        `${rawScopeSecret}; replace a leaking fixture using licensed plumbing work `
        + `at ${exactAddress}; contact ${leadEmailSecret}`,
      category: 'handyman',
      answers: commonAnswers,
      zip: SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
      region: 'untrusted-client-location-hint',
      photo_count: 0,
      consent_version: 'v1',
      turnstile_token: `synthetic-http-task-${randomUUID()}`,
      client_ts: requestNow,
    };
    const created = await callTrpc<ApiTaskDraftResult>(
      app,
      'webTaskDrafts.submit',
      'mutation',
      createInput
    );
    expect(created).toMatchObject({
      ok: true,
      submission_id: submissionId,
      version: 1,
      card_token: cardToken,
      routing: { outcome: 'ESTIMATE_REQUIRED', decision_version: 1 },
      payment_creation_frozen: true,
      hard_assignment_created: false,
    });

    const updateInput: TaskDraftIngressInput = {
      ...createInput,
      action: 'update',
      expected_version: created.version,
      raw_input:
        `${rawScopeSecret}; replace the leaking shutoff fixture using licensed plumbing work `
        + `at ${exactAddress}; contact ${leadEmailSecret}`,
      answers: { ...commonAnswers, shutoff_accessible: true },
      turnstile_token: undefined,
      client_ts: requestNow + 1,
    };
    const updated = await callTrpc<ApiTaskDraftResult>(
      app,
      'webTaskDrafts.submit',
      'mutation',
      updateInput
    );
    expect(updated).toMatchObject({
      draft_id: created.draft_id,
      version: 2,
      routing: { outcome: 'ESTIMATE_REQUIRED', decision_version: 2 },
      payment_creation_frozen: true,
      hard_assignment_created: false,
    });

    const lead = await callTrpc<ApiLeadResult>(
      app,
      'webLeads.submitLead',
      'mutation',
      {
        submission_id: leadSubmissionId,
        lead_type: 'poster',
        email: leadEmailSecret,
        name: leadNameSecret,
        phone: leadPhoneSecret,
        region: SYNTHETIC_SERVICE_CELL_REGION_CODE,
        zip: SYNTHETIC_SERVICE_CELL_POSTAL_CODE,
        consent_version: 'v1',
        draft_submission_id: submissionId,
        draft_card_token: cardToken,
        client_ts: requestNow + 2,
      }
    );
    expect(lead).toMatchObject({
      ok: true,
      submission_id: leadSubmissionId,
      status: 'new',
    });
    expect(lead.lead_id).toMatch(/^[0-9a-f-]{36}$/u);

    const linked = await callTrpc<ApiTaskDraftResult>(
      app,
      'webTaskDrafts.submit',
      'mutation',
      {
        ...updateInput,
        action: 'link_contact',
        expected_version: updated.version,
        raw_input: 'contact link',
        lead_submission_id: leadSubmissionId,
        client_ts: requestNow + 3,
      }
    );
    expect(linked).toMatchObject({
      draft_id: created.draft_id,
      status: 'contact_captured',
      version: updated.version + 1,
      routing: { outcome: 'ESTIMATE_REQUIRED', decision_version: updated.version + 1 },
      payment_creation_frozen: true,
      hard_assignment_created: false,
    });
    expect(syntheticHumanVerification).toHaveBeenCalledTimes(1);

    const claimed = await callTrpc<ApiClaimResult>(
      app,
      'webTaskDrafts.claim',
      'mutation',
      {
        submission_id: submissionId,
        card_token: cardToken,
        expected_version: 0,
        idempotency_key: `claim-http:${submissionId}`,
        client_ts: requestNow + 4,
      },
      posterToken
    );
    expect(claimed).toEqual(expect.objectContaining({
      ok: true,
      draft_id: created.draft_id,
      status: 'account_claimed',
      claim_version: 1,
      payment_creation_frozen: true,
      hard_assignment_created: false,
    }));

    const listing = await callTrpc<ApiBrowseResult>(
      app,
      'universalV1TaskOpportunities.browse',
      'query',
      {
        serviceCellAuthorityId: SYNTHETIC_SERVICE_CELL_AUTHORITY_ID,
        workCategoryCode: 'plumbing',
        providerOrganizationId: provider.organizationId,
        businessCredentialId: provider.credentialId,
        limit: 100,
        offset: 0,
      },
      providerToken
    );
    expect(listing.state).toBe('READY');
    const opportunity = listing.opportunities.find(
      (candidate) => candidate.taskDraftId === created.draft_id
    );
    expect(opportunity).toMatchObject({
      taskDraftId: created.draft_id,
      opportunityVersion: linked.version,
      workCategoryCode: 'plumbing',
      privacyPosture: 'ROUTE_CONTEXT_ALLOWLIST_ONLY',
      assignmentAuthority: 'NONE',
      addressContactAuthority: 'NONE',
      financialAuthority: 'NONE',
    });
    if (!opportunity) throw new Error('claimed HTTP TaskDraft did not project an opportunity');

    const interest = await callTrpc<ApiInterestResult>(
      app,
      'universalV1TaskOpportunities.expressInterest',
      'mutation',
      {
        opportunityId: opportunity.opportunityId,
        expectedOpportunityVersion: opportunity.opportunityVersion,
        providerOrganizationId: provider.organizationId,
        businessCredentialId: provider.credentialId,
        idempotencyKey: `express-http:${randomUUID()}`,
      },
      providerToken
    );
    expect(interest).toMatchObject({
      opportunityId: opportunity.opportunityId,
      opportunityVersion: opportunity.opportunityVersion,
      taskDraftId: created.draft_id,
      idempotencyReplayed: false,
      reservationCreated: false,
      eligibilityDecisionCreated: false,
      assignmentCreated: false,
      addressContactAccessGranted: false,
      financialEventCreated: false,
      payableCreated: false,
      guaranteedEarning: false,
    });

    const journey = await callTrpc<ApiJourneyResult>(
      app,
      'universalV1TaskOpportunities.getMyPreEstimateJourneyState',
      'query',
      { interestId: interest.interestId },
      providerToken
    );
    expect(journey).toMatchObject({
      interest: {
        interestId: interest.interestId,
        opportunityId: opportunity.opportunityId,
        opportunityVersion: opportunity.opportunityVersion,
        taskDraftId: created.draft_id,
        routing: { outcome: 'ESTIMATE_REQUIRED' },
      },
      interestStatus: 'pending',
      opportunityCurrent: true,
      providerObservationCurrent: true,
      taskEligibility: { state: 'NOT_DECIDED', decisionId: null },
      processorEligibility: {
        decisionPresent: false,
        paymentEligibleObservation: false,
        payoutFundingEligibleObservation: false,
        positiveAuthority: 'NONE',
      },
      estimateInvitation: { state: 'BLOCKED_BY_TASK_ELIGIBILITY', invitationId: null },
      nextStep: 'AWAIT_APPROVED_INITIAL_ELIGIBILITY_COMMAND',
      blockerCodes: ['ACTOR_ATTESTATION_DECISION_REQUIRED'],
      commandMutationPerformed: false,
      authority: {
        databaseCallerIdentityAttested: false,
        initialEligibilityCommand: 'HELD_PENDING_APPROVED_ACTOR_ATTESTATION',
        mutationAuthority: 'NONE',
        assignmentAuthority: 'NONE',
        addressContactAuthority: 'NONE',
        financialAuthority: 'NONE',
      },
    });

    for (const [perspective, token] of [
      ['customer', posterToken],
      ['provider', providerToken],
    ] as const) {
      const occurrenceResponse = await app.request(
        `/trpc/universalOccurrence.${perspective}?input=${encodeURIComponent(JSON.stringify({
          task_draft_id: created.draft_id,
        }))}`,
        {
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            origin: 'http://localhost:5173',
            'x-real-ip': '127.0.0.1',
          },
        }
      );
      const occurrenceEnvelope = await occurrenceResponse.json();
      expect(occurrenceResponse.status).toBe(200);
      expect(occurrenceResponse.headers.get('cache-control')).toBe(
        'private, no-store, max-age=0'
      );
      expect(occurrenceResponse.headers.get('pragma')).toBe('no-cache');
      expect(occurrenceResponse.headers.get('vary')).toContain('Authorization');
      expect(trpcData<Record<string, unknown>>(occurrenceEnvelope)).toMatchObject({
        task_draft_id: created.draft_id,
        perspective: perspective.toUpperCase(),
        payment_creation_frozen: true,
        hard_assignment_created: false,
      });
    }

    const unrelatedUid = `hxos-local-hustler-api-unrelated-${randomUUID()}`;
    await userFixture('worker', 'ACTIVE', false, false, applicationPool, unrelatedUid);
    const privateOccurrencePath =
      `/trpc/universalOccurrence.provider?input=${encodeURIComponent(JSON.stringify({
        task_draft_id: created.draft_id,
      }))}`;
    const unauthorizedOccurrence = await app.request(privateOccurrencePath, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${localCertificationToken(unrelatedUid)}`,
        origin: 'http://localhost:5173',
        'x-real-ip': '127.0.0.1',
      },
    });
    expect(unauthorizedOccurrence.status).toBe(404);
    expect(unauthorizedOccurrence.headers.get('cache-control')).toBe(
      'private, no-store, max-age=0'
    );
    expect(unauthorizedOccurrence.headers.get('pragma')).toBe('no-cache');
    expect(unauthorizedOccurrence.headers.get('vary')).toContain('Authorization');

    const unauthenticatedOpsOccurrence = await app.request(
      '/trpc/universalOccurrence.operations',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-real-ip': '127.0.0.1',
        },
        body: JSON.stringify({
          task_draft_id: created.draft_id,
          purpose: 'Verify unauthenticated HTTP denial',
        }),
      }
    );
    expect(unauthenticatedOpsOccurrence.status).toBe(401);
    expect(unauthenticatedOpsOccurrence.headers.get('cache-control')).toBe(
      'private, no-store, max-age=0'
    );
    expect(unauthenticatedOpsOccurrence.headers.get('pragma')).toBe('no-cache');
    expect(unauthenticatedOpsOccurrence.headers.get('vary')).toContain('Authorization');

    assertRecursivelyPrivacyRedacted(
      { opportunity, interest, journey },
      [rawScopeSecret, exactAddress, leadEmailSecret, leadNameSecret, leadPhoneSecret]
    );

    const healthResponse = await app.request('/health', {
      headers: { 'x-real-ip': '127.0.0.1' },
    });
    const health = asRecord(await healthResponse.json());
    if (!health) throw new Error('/health returned a non-object payload');
    expect(healthResponse.status).toBe(health.status === 'healthy' ? 200 : 503);
    expect(health.build).toEqual(buildIdentity);
    expect(asRecord(health.releaseManifest)).toMatchObject({
      digest: releaseManifestEvidence.digest,
      source: releaseManifestEvidence.source,
    });
    expect(health.paymentCreation).toEqual({
      mode: 'frozen',
      acceptsNewCustomerMoney: false,
      permitsRealSettlement: false,
      permitsProviderPayouts: false,
      permitsConnectProvisioning: false,
      authority: 'UNDERWRITING_DECISIONS_UNRESOLVED',
    });

    const livenessResponse = await app.request('/health/liveness', {
      headers: { 'x-real-ip': '127.0.0.1' },
    });
    expect(livenessResponse.status).toBe(200);
    const liveness = asRecord(await livenessResponse.json());
    expect(liveness?.alive).toBe(true);
    expect(liveness?.build).toEqual(buildIdentity);
    expect(asRecord(liveness?.releaseManifest)).toMatchObject({
      digest: releaseManifestEvidence.digest,
      source: releaseManifestEvidence.source,
    });
    expect(liveness?.paymentCreation).toEqual(health.paymentCreation);

    expect(await consequentialState(applicationPool)).toEqual(before);
    const stored = await applicationPool.query<{
      id: string;
      task_id: string | null;
      authority: string;
      message: string | null;
      rejection_reason: string | null;
      eligibility_rows: number;
      invitation_rows: number;
    }>(
      `SELECT application.id, application.task_id, application.authority,
              application.message, application.rejection_reason,
              (SELECT COUNT(*)::INTEGER
               FROM public.task_provider_eligibility_decisions eligibility
               WHERE eligibility.interest_application_id = application.id) AS eligibility_rows,
              (SELECT COUNT(*)::INTEGER
               FROM public.task_provider_estimate_invitations invitation
               JOIN public.task_provider_eligibility_decisions eligibility
                 ON eligibility.id = invitation.eligibility_decision_id
               WHERE eligibility.interest_application_id = application.id) AS invitation_rows
       FROM public.task_applications application
       WHERE application.opportunity_contract_version = 1
         AND application.opportunity_id = $1
         AND application.hustler_id = $2`,
      [opportunity.opportunityId, provider.userId]
    );
    expect(stored.rows).toEqual([{
      id: interest.interestId,
      task_id: null,
      authority: 'EXPRESS_INTEREST',
      message: null,
      rejection_reason: null,
      eligibility_rows: 0,
      invitation_rows: 0,
    }]);
    const claimedOwner = await applicationPool.query<{
      poster_user_id: string;
      task_id: string | null;
    }>(
      `SELECT poster_user_id, task_id FROM public.task_drafts WHERE id = $1`,
      [created.draft_id]
    );
    expect(claimedOwner.rows).toEqual([{ poster_user_id: posterUserId, task_id: null }]);
  }, 60_000);

  it('lets general individuals and general businesses browse and express observation-only interest', async () => {
    const opportunity = await claimedOpportunityFixture('furniture_assembly', 'general-shapes');
    const individual = await generalIndividualFixture();
    const business = await generalBusinessFixture();
    const before = await consequentialState();

    for (const provider of [individual, business]) {
      const listing = await browse(provider, 'furniture_assembly');
      expect(listing.state).toBe('READY');
      if (listing.state !== 'READY') throw new Error('general provider browse was held');
      const visible = listing.opportunities.find(
        (candidate) => candidate.opportunityId === opportunity.opportunityId
      );
      expect(visible).toMatchObject({
        taskDraftId: opportunity.taskDraftId,
        opportunityVersion: opportunity.opportunityVersion,
        workCategoryCode: 'furniture_assembly',
        privacyPosture: 'ROUTE_CONTEXT_ALLOWLIST_ONLY',
        eligibilityStatus: 'PENDING',
        assignmentStatus: 'PENDING',
        assignmentAuthority: 'NONE',
        addressContactAuthority: 'NONE',
        financialAuthority: 'NONE',
        guaranteedEarningAuthority: 'NONE',
      });
      const interest = await express(provider, opportunity, `express-general:${randomUUID()}`);
      expect(interest).toMatchObject({
        providerClass: 'GENERAL_SERVICE_PROVIDER',
        opportunityId: opportunity.opportunityId,
        idempotencyReplayed: false,
        eligibilityStatus: 'PENDING',
        assignmentStatus: 'PENDING',
        reservationCreated: false,
        eligibilityDecisionCreated: false,
        assignmentCreated: false,
        addressContactAccessGranted: false,
        financialEventCreated: false,
        payableCreated: false,
        guaranteedEarning: false,
      });
      expect(interest.tradeQualificationSha256).toBeNull();
    }

    expect(await consequentialState()).toEqual(before);
    const rows = await pool.query<{
      task_id: string | null;
      provider_class_snapshot: string;
      observed_trade_credential_id: string | null;
      message: string | null;
      rejection_reason: string | null;
    }>(
      `SELECT task_id, provider_class_snapshot, observed_trade_credential_id,
              message, rejection_reason
       FROM public.task_applications
       WHERE opportunity_contract_version = 1
         AND opportunity_id = $1
       ORDER BY created_at`,
      [opportunity.opportunityId]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows).toEqual([
      {
        task_id: null,
        provider_class_snapshot: 'GENERAL_SERVICE_PROVIDER',
        observed_trade_credential_id: null,
        message: null,
        rejection_reason: null,
      },
      {
        task_id: null,
        provider_class_snapshot: 'GENERAL_SERVICE_PROVIDER',
        observed_trade_credential_id: null,
        message: null,
        rejection_reason: null,
      },
    ]);
  });

  it('binds a Verified Trade Business to the exact current qualification facts', async () => {
    const opportunity = await claimedOpportunityFixture('handyman', 'verified-trade');
    expect(opportunity.workCategoryCode).toBe('plumbing');
    const provider = await verifiedTradeBusinessFixture();
    const listing = await browse(provider, 'plumbing');
    expect(listing.state).toBe('READY');
    if (listing.state !== 'READY') throw new Error('trade browse was held');
    expect(
      listing.opportunities.some(
        (candidate) => candidate.opportunityId === opportunity.opportunityId
      )
    ).toBe(true);

    const interest = await express(provider, opportunity, `express-trade:${randomUUID()}`);
    expect(interest).toMatchObject({
      providerClass: 'VERIFIED_TRADE_BUSINESS',
      opportunityId: opportunity.opportunityId,
      workCategoryCode: 'plumbing',
      eligibilityStatus: 'PENDING',
      assignmentStatus: 'PENDING',
    });
    expect(interest.tradeQualificationSha256).toMatch(/^[a-f0-9]{64}$/u);

    const exact = await pool.query<{
      issuing_authority: string;
      jurisdiction_code: string;
      license_scope: string;
      license_status: string;
      expires_at: Date;
      permitted_work_categories: string[];
      expected_digest: string;
      recorded_digest: string;
    }>(
      `SELECT qualification.issuing_authority,
              qualification.jurisdiction_code,
              qualification.license_scope,
              qualification.license_status,
              qualification.expires_at,
              qualification.permitted_work_categories,
              encode(public.digest(jsonb_build_object(
                'credentialId', qualification.business_credential_id,
                'organizationId', qualification.organization_id,
                'issuingAuthority', qualification.issuing_authority,
                'jurisdictionCode', qualification.jurisdiction_code,
                'licenseScope', qualification.license_scope,
                'licenseStatus', qualification.license_status,
                'expiresAt', qualification.expires_at,
                'evidenceHash', qualification.evidence_hash,
                'verifiedAt', qualification.verified_at,
                'officialSourceCheckedAt', qualification.official_source_checked_at,
                'permittedCategory', 'plumbing'
              )::TEXT, 'sha256'), 'hex') AS expected_digest,
              btrim(application.trade_qualification_sha256) AS recorded_digest
       FROM public.current_verified_trade_qualifications qualification
       JOIN public.task_applications application
         ON application.observed_trade_credential_id = qualification.business_credential_id
       WHERE application.id = $1`,
      [interest.interestId]
    );
    expect(exact.rows[0]).toMatchObject({
      issuing_authority: 'XQ Trade Licensing Authority',
      jurisdiction_code: SYNTHETIC_SERVICE_CELL_REGION_CODE,
      license_scope: 'Residential plumbing installation and repair',
      license_status: 'ACTIVE',
      permitted_work_categories: ['plumbing'],
    });
    expect(exact.rows[0]?.expires_at).toBeInstanceOf(Date);
    expect(exact.rows[0]?.recorded_digest).toBe(exact.rows[0]?.expected_digest);
  });

  it('continues a real trade-provider interest to the truthful held dual-eligibility gate', async () => {
    const opportunity = await claimedOpportunityFixture('handyman', 'journey-gate');
    const provider = await verifiedTradeBusinessFixture();
    const unrelatedProvider = await generalIndividualFixture();
    const before = await consequentialState();
    const interest = await express(provider, opportunity, `express-journey:${randomUUID()}`);

    const journey = await service.getMyPreEstimateJourneyState(
      providerContext(provider.userId),
      { interestId: interest.interestId }
    );
    expect(journey).toMatchObject({
      interest: {
        interestId: interest.interestId,
        opportunityId: opportunity.opportunityId,
        routing: { outcome: 'ESTIMATE_REQUIRED' },
      },
      interestStatus: 'pending',
      opportunityCurrent: true,
      providerObservationCurrent: true,
      taskEligibility: {
        state: 'NOT_DECIDED',
        decisionId: null,
        decisionVersion: null,
        taskEligible: null,
        validUntil: null,
        current: false,
      },
      processorEligibility: {
        decisionPresent: false,
        paymentEligibleObservation: false,
        payoutFundingEligibleObservation: false,
        positiveAuthority: 'NONE',
      },
      estimateInvitation: {
        state: 'BLOCKED_BY_TASK_ELIGIBILITY',
        invitationId: null,
        quoteId: null,
        expectedQuoteVersion: null,
        validUntil: null,
      },
      nextStep: 'AWAIT_APPROVED_INITIAL_ELIGIBILITY_COMMAND',
      blockerCodes: ['ACTOR_ATTESTATION_DECISION_REQUIRED'],
      commandMutationPerformed: false,
      authority: {
        readModelOnly: true,
        databaseCallerIdentityAttested: false,
        initialEligibilityCommand: 'HELD_PENDING_APPROVED_ACTOR_ATTESTATION',
        mutationAuthority: 'NONE',
        assignmentAuthority: 'NONE',
        addressContactAuthority: 'NONE',
        financialAuthority: 'NONE',
      },
    });
    await expect(
      service.getMyPreEstimateJourneyState(providerContext(unrelatedProvider.userId), {
        interestId: interest.interestId,
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await consequentialState()).toEqual(before);

    const stored = await pool.query<{
      interest_rows: number;
      eligibility_rows: number;
      invitation_rows: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::INTEGER
          FROM public.task_applications application
          WHERE application.id = $1
            AND application.opportunity_contract_version = 1) AS interest_rows,
         (SELECT COUNT(*)::INTEGER
          FROM public.task_provider_eligibility_decisions eligibility
          WHERE eligibility.interest_application_id = $1) AS eligibility_rows,
         (SELECT COUNT(*)::INTEGER
          FROM public.task_provider_estimate_invitations invitation
          JOIN public.task_provider_eligibility_decisions eligibility
            ON eligibility.id = invitation.eligibility_decision_id
          WHERE eligibility.interest_application_id = $1) AS invitation_rows`,
      [interest.interestId]
    );
    expect(stored.rows[0]).toEqual({
      interest_rows: 1,
      eligibility_rows: 0,
      invitation_rows: 0,
    });
  });

  it('serializes identical interest and rejects divergent or different-key reuse', async () => {
    const opportunity = await claimedOpportunityFixture(
      'furniture_assembly',
      'concurrent-interest'
    );
    const provider = await generalIndividualFixture();
    const key = `express-concurrent:${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => express(provider, opportunity, key))
    );
    expect(results.filter((result) => !result.idempotencyReplayed)).toHaveLength(1);
    expect(results.filter((result) => result.idempotencyReplayed)).toHaveLength(7);
    expect(new Set(results.map((result) => result.interestId)).size).toBe(1);

    await expect(
      service.expressInterest(providerContext(provider.userId), {
        opportunityId: opportunity.opportunityId,
        expectedOpportunityVersion: opportunity.opportunityVersion + 1,
        idempotencyKey: key,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(
      express(provider, opportunity, `express-distinct-key:${randomUUID()}`)
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    const count = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::INTEGER AS count
       FROM public.task_applications
       WHERE opportunity_contract_version = 1
         AND opportunity_id = $1
         AND hustler_id = $2`,
      [opportunity.opportunityId, provider.userId]
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it('holds inactive, minor, banned, and revoked-business provider authority', async () => {
    const suspended = await userFixture('worker', 'SUSPENDED');
    const minor = await userFixture('worker', 'ACTIVE', true);
    const banned = await userFixture('worker', 'ACTIVE', false, true);
    for (const userId of [suspended, minor, banned]) {
      await capabilityFixture(userId, 'GENERAL_SERVICE_PROVIDER');
      const result = await browse({ userId, organizationId: null, credentialId: null });
      expect(result).toMatchObject({
        state: 'HELD',
        blockerCodes: ['PROVIDER_IDENTITY_UNAVAILABLE'],
        opportunities: [],
      });
    }

    const business = await generalBusinessFixture();
    const backupOwner = await userFixture();
    await pool.query(
      `INSERT INTO public.business_memberships(
         organization_id, user_id, role, status, invited_by, accepted_at
       ) VALUES ($1, $2, 'OWNER', 'ACTIVE', $3, clock_timestamp())`,
      [business.organizationId, backupOwner, business.userId]
    );
    await pool.query(
      `UPDATE public.business_memberships
       SET status = 'REVOKED'
       WHERE organization_id = $1 AND user_id = $2`,
      [business.organizationId, business.userId]
    );
    const revoked = await browse(business);
    expect(revoked).toMatchObject({
      state: 'HELD',
      blockerCodes: ['PROVIDER_BUSINESS_AUTHORITY_UNRESOLVED'],
      opportunities: [],
    });

    const active = await generalIndividualFixture();
    const opportunity = await claimedOpportunityFixture('furniture_assembly', 'state-recheck');
    await express(active, opportunity, `express-before-hold:${randomUUID()}`);
    await pool.query(`UPDATE public.users SET account_status = 'SUSPENDED' WHERE id = $1`, [
      active.userId,
    ]);
    await expect(
      service.listMine(providerContext(active.userId), {
        limit: 20,
        offset: 0,
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    await expect(
      express(active, opportunity, `express-after-hold:${randomUUID()}`)
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('rejects stale and directly forged route, origin, scope, and free-text fields', async () => {
    const opportunity = await claimedOpportunityFixture('furniture_assembly', 'forgery-rejection');
    const provider = await generalIndividualFixture();
    await expect(
      service.expressInterest(providerContext(provider.userId), {
        opportunityId: opportunity.opportunityId,
        expectedOpportunityVersion: opportunity.opportunityVersion + 1,
        idempotencyKey: `express-stale:${randomUUID()}`,
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    async function directInsert(overrides: {
      routeId?: string;
      originId?: string;
      scopeSha256?: string;
      message?: string | null;
      rejectionReason?: string | null;
    }): Promise<void> {
      const key = `direct-forged:${randomUUID()}`;
      await pool.query(
        `INSERT INTO public.task_applications(
           task_id, hustler_id, message, status, counter_offer_round,
           rejection_reason, universal_contract_version, authority,
           provider_organization_id, interest_scope_version_id,
           idempotency_key, request_sha256, opportunity_contract_version,
           opportunity_id, opportunity_version, interest_routing_decision_id,
           interest_relationship_origin_id, interest_scope_artifact_sha256
         ) VALUES (
           NULL, $1, $2, 'pending', 0, $3, 1, 'EXPRESS_INTEREST',
           NULL, NULL, $4,
           public.universal_v1_task_opportunity_interest_request_sha256(
             $1, $5, $6, NULL, NULL, $4
           ),
           1, $5, $6, $7, $8, $9
         )`,
        [
          provider.userId,
          overrides.message ?? null,
          overrides.rejectionReason ?? null,
          key,
          opportunity.opportunityId,
          opportunity.opportunityVersion,
          overrides.routeId ?? opportunity.routingDecisionId,
          overrides.originId ?? opportunity.relationshipOriginId,
          overrides.scopeSha256 ?? opportunity.scopeArtifactSha256,
        ]
      );
    }

    await expect(directInsert({ routeId: randomUUID() })).rejects.toThrow(/HXUV1-OPPORTUNITY-3/u);
    await expect(directInsert({ originId: randomUUID() })).rejects.toThrow(/HXUV1-OPPORTUNITY-3/u);
    await expect(directInsert({ scopeSha256: 'f'.repeat(64) })).rejects.toThrow(
      /HXUV1-OPPORTUNITY-3/u
    );
    await expect(directInsert({ message: 'private free-form provider message' })).rejects.toThrow(
      /HXUV1-OPPORTUNITY-1/u
    );
    await expect(directInsert({ rejectionReason: 'unbounded hidden text' })).rejects.toThrow(
      /HXUV1-OPPORTUNITY-1/u
    );
  });

  it('keeps provider and Ops reads privacy-redacted while exposing exact version witnesses', async () => {
    const opportunity = await claimedOpportunityFixture('handyman', 'privacy-proof');
    const provider = await verifiedTradeBusinessFixture();
    const listing = await browse(provider, 'plumbing');
    if (listing.state !== 'READY') throw new Error('trade browse was held');
    const visible = listing.opportunities.find(
      (candidate) => candidate.opportunityId === opportunity.opportunityId
    );
    expect(visible).toMatchObject({
      routing: {
        decisionId: opportunity.routingDecisionId,
        decisionVersion: opportunity.opportunityVersion,
      },
      relationshipOrigin: { id: opportunity.relationshipOriginId, version: 1 },
      scopeArtifact: {
        kind: 'TASK_DRAFT_ROUTE_CONTEXT_V1',
        id: opportunity.routingDecisionId,
        version: opportunity.opportunityVersion,
        sha256: opportunity.scopeArtifactSha256,
      },
    });
    const interest = await express(provider, opportunity, `express-privacy:${randomUUID()}`);
    const mine = await service.listMine(providerContext(provider.userId), {
      limit: 20,
      offset: 0,
    });
    const ops = await service.listForOps({} as any, {
      providerClass: 'VERIFIED_TRADE_BUSINESS',
      workCategoryCode: 'plumbing',
      limit: 100,
      offset: 0,
    });
    expect(mine.interests.some((candidate) => candidate.interestId === interest.interestId)).toBe(
      true
    );
    expect(ops.redaction).toEqual({
      customerIdentity: 'OMITTED',
      providerIdentity: 'DIGEST_ONLY',
      exactAddress: 'OMITTED',
      contact: 'OMITTED',
      freeFormScope: 'OMITTED',
    });

    for (const payload of [visible, interest, mine, ops]) {
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain(opportunity.posterUserId);
      expect(serialized).not.toContain(provider.userId);
      expect(serialized).not.toContain(provider.organizationId!);
      expect(serialized).not.toContain(opportunity.rawInputSecret);
      expect(serialized).not.toContain(opportunity.leadEmailSecret);
      expect(serialized.toLowerCase()).not.toContain('private customer');
    }

    const forbiddenColumns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'current_universal_v1_task_opportunities_v1'
         AND column_name = ANY($1::TEXT[])`,
      [
        [
          'poster_user_id',
          'lead_id',
          'email',
          'phone',
          'exact_address',
          'raw_input',
          'scope_summary',
          'provider_user_id',
          'provider_organization_id',
        ],
      ]
    );
    expect(forbiddenColumns.rows).toEqual([]);
  });

  it('preserves legacy task applications and post-estimate Universal interest semantics', async () => {
    const legacyPoster = await userFixture('poster');
    const legacyProvider = await userFixture('worker');
    const legacyTask = await createTestTask(pool, { posterId: legacyPoster });
    const legacy = await pool.query<{ id: string }>(
      `INSERT INTO public.task_applications(task_id, hustler_id, message, status)
       VALUES ($1, $2, 'legacy application remains mutable', 'pending')
       RETURNING id`,
      [legacyTask.id, legacyProvider]
    );
    await pool.query(
      `UPDATE public.task_applications
       SET status = 'withdrawn'
       WHERE id = $1`,
      [legacy.rows[0]!.id]
    );
    await expect(
      pool.query(`UPDATE public.task_applications SET task_id = NULL WHERE id = $1`, [
        legacy.rows[0]!.id,
      ])
    ).rejects.toThrow(/task_applications_interest_authority_check/u);

    const postEstimateDraft = await claimedOpportunityFixture(
      'furniture_assembly',
      'post-estimate-preservation'
    );
    const postEstimateProvider = await generalIndividualFixture();
    const task = await createTestTask(pool, { posterId: postEstimateDraft.posterUserId });
    const scopeId = randomUUID();
    await pool.query(
      `INSERT INTO public.task_scope_versions(
         id, task_id, version, scope_hash, title, description, checklist,
         customer_total_cents, hustler_payout_cents, source, change_summary,
         created_by
       ) VALUES (
         $1, $2, 1, $3, 'Preserved post-estimate scope',
         'Exact accepted synthetic scope', '[]'::JSONB,
         5000, 4000, 'INITIAL', 'Initial scope', $4
       )`,
      [scopeId, task.id, sha256(`scope:${scopeId}`), postEstimateDraft.posterUserId]
    );
    await pool.query(`UPDATE public.tasks SET active_scope_version_id = $2 WHERE id = $1`, [
      task.id,
      scopeId,
    ]);
    // Newer materialization authority correctly forbids committing an invented
    // TaskDraft-to-Task binding. Keep that guard intact: exercise the preserved
    // old post-estimate trigger inside one transaction, prove its allow/deny
    // semantics, and deliberately roll the synthetic antecedent back.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE public.task_drafts SET task_id = $2 WHERE id = $1`, [
        postEstimateDraft.taskDraftId,
        task.id,
      ]);
      const preserved = await client.query<{ id: string }>(
        `INSERT INTO public.task_applications(
           task_id, hustler_id, message, status, universal_contract_version,
           authority, interest_scope_version_id, idempotency_key, request_sha256,
           opportunity_contract_version
         ) VALUES (
           $1, $2, NULL, 'pending', 1, 'EXPRESS_INTEREST', $3, $4, $5, 0
         ) RETURNING id`,
        [
          task.id,
          postEstimateProvider.userId,
          scopeId,
          `post-estimate:${randomUUID()}`,
          sha256(`post-estimate:${task.id}`),
        ]
      );
      await client.query(`UPDATE public.task_applications SET status = 'withdrawn' WHERE id = $1`, [
        preserved.rows[0]!.id,
      ]);
      const status = await client.query<{
        status: string;
        opportunity_contract_version: number;
      }>(
        `SELECT status, opportunity_contract_version
         FROM public.task_applications WHERE id = $1`,
        [preserved.rows[0]!.id]
      );
      expect(status.rows[0]).toEqual({
        status: 'withdrawn',
        opportunity_contract_version: 0,
      });

      await client.query('SAVEPOINT invalid_post_estimate_scope');
      await expect(
        client.query(
          `INSERT INTO public.task_applications(
             task_id, hustler_id, message, status, universal_contract_version,
             authority, interest_scope_version_id, idempotency_key, request_sha256,
             opportunity_contract_version
           ) VALUES ($1, $2, NULL, 'pending', 1, 'EXPRESS_INTEREST', $3, $4, $5, 0)`,
          [
            task.id,
            postEstimateProvider.userId,
            randomUUID(),
            `post-estimate-forged:${randomUUID()}`,
            sha256(`post-estimate-forged:${task.id}`),
          ]
        )
      ).rejects.toThrow(/HXUV1-INTEREST-2/u);
      await client.query('ROLLBACK TO SAVEPOINT invalid_post_estimate_scope');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
