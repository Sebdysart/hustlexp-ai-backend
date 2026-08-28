/**
 * HustleXP Test Setup
 *
 * Shared configuration for invariant tests using Neon PostgreSQL
 */

import { randomUUID } from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;

// Use environment variable — DATABASE_URL must be set in .env or CI
const DATABASE_URL = process.env.DATABASE_URL;

/**
 * True when DATABASE_URL is available.
 * Use with `describe.skipIf(!hasDb)` to gracefully skip DB tests in environments
 * without a database (e.g., local development without Neon, pure unit-test CI runs).
 */
export const hasDb = !!DATABASE_URL;

function databaseSsl(connectionString: string): false | { rejectUnauthorized: false } {
  const url = new URL(connectionString);
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const sslDisabled = url.searchParams.get('sslmode') === 'disable';
  return isLoopback || sslDisabled ? false : { rejectUnauthorized: false };
}

export function createTestPool(): pg.Pool {
  if (!DATABASE_URL) {
    throw new Error(
      'DATABASE_URL is not set. Set it in .env or as an environment variable.\n' +
        'Example: DATABASE_URL=postgresql://user:pass@host/db?sslmode=require'
    );
  }
  return new Pool({
    connectionString: DATABASE_URL,
    ssl: databaseSsl(DATABASE_URL),
    max: 5,
    idleTimeoutMillis: 30000,
  });
}

// Generate unique test run ID to avoid conflicts between test runs
const TEST_RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

/**
 * Get test email with unique run ID to avoid conflicts
 */
export function getTestEmail(name: string): string {
  return `test-${TEST_RUN_ID}-${name}@hustlexp.test`;
}

/**
 * Clean up test data from this specific test run
 * Note: Cannot delete from append-only tables (xp_ledger, badges) due to triggers
 * Using unique TEST_RUN_ID ensures no conflicts between runs
 */
export async function cleanupTestData(pool: pg.Pool): Promise<void> {
  const pattern = `test-${TEST_RUN_ID}-%@hustlexp.test`;

  // Delete in order that respects foreign keys
  // Skip xp_ledger and badges - they're append-only and uniqueness is guaranteed by TEST_RUN_ID
  await pool.query(
    'DELETE FROM trust_ledger WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [pattern]
  );
  await pool.query(
    'DELETE FROM proof_videos WHERE proof_id IN (SELECT p.id FROM proofs p JOIN tasks t ON p.task_id = t.id JOIN users u ON t.poster_id = u.id WHERE u.email LIKE $1)',
    [pattern]
  );
  await pool.query(
    'DELETE FROM proof_photos WHERE proof_id IN (SELECT p.id FROM proofs p JOIN tasks t ON p.task_id = t.id JOIN users u ON t.poster_id = u.id WHERE u.email LIKE $1)',
    [pattern]
  );
  await pool.query(
    'DELETE FROM proofs WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))',
    [pattern]
  );
  await pool.query(
    'DELETE FROM escrows WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))',
    [pattern]
  );
  await pool.query(
    'DELETE FROM disputes WHERE task_id IN (SELECT id FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1))',
    [pattern]
  );
  await pool.query(
    'DELETE FROM tasks WHERE poster_id IN (SELECT id FROM users WHERE email LIKE $1)',
    [pattern]
  );
  // Don't delete users if they have xp_ledger/badges entries (FK constraint)
  // await pool.query('DELETE FROM users WHERE email LIKE $1', [pattern]);
}

/**
 * Create a test user
 */
export function createTestUser(pool: pg.Pool): Promise<{ id: string }>;
export function createTestUser(pool: pg.Pool, email: string): Promise<string>;
export async function createTestUser(
  pool: pg.Pool,
  email?: string
): Promise<string | { id: string }> {
  const resolvedEmail = email ?? getTestEmail(`user-${crypto.randomUUID()}`);
  const result = await pool.query(
    `INSERT INTO users (
       email, full_name, default_mode, date_of_birth, is_minor, account_status
     ) VALUES ($1, $2, 'worker', DATE '1990-01-01', FALSE, 'ACTIVE')
     RETURNING id`,
    [resolvedEmail, 'Test User']
  );
  const id = result.rows[0].id as string;
  return email === undefined ? { id } : id;
}

/**
 * Promote a fixture user through every canonical trust tier under one
 * transaction-local policy witness. This helper never demotes and never skips
 * a tier, so fixture setup exercises the same database authority as runtime
 * trust progression instead of disabling its trigger.
 */
export async function promoteTestUserTrustSequentially(
  pool: pg.Pool,
  userId: string,
  targetTier: number
): Promise<void> {
  if (!Number.isInteger(targetTier) || targetTier < 0 || targetTier > 4) {
    throw new Error('Test trust target must be an integer from 0 through 4');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ trust_tier: number }>(
      'SELECT trust_tier FROM users WHERE id = $1 FOR UPDATE',
      [userId]
    );
    const currentTier = current.rows[0]?.trust_tier;
    if (currentTier === undefined) throw new Error(`Missing test user ${userId}`);
    if (currentTier < targetTier) {
      await client.query(
        `SELECT set_config(
           'hustlexp.trust_promotion_authority',
           $1,
           true
         )`,
        [`hustler-trust-progression-v1:${randomUUID()}`]
      );
      for (let tier = currentTier + 1; tier <= targetTier; tier += 1) {
        const promoted = await client.query(
          `UPDATE users
           SET trust_tier = $2
           WHERE id = $1 AND trust_tier = $3
           RETURNING trust_tier`,
          [userId, tier, tier - 1]
        );
        if (promoted.rowCount !== 1) {
          throw new Error(`Concurrent test trust promotion detected for ${userId}`);
        }
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export type TestIdentityEnvironment = 'CONTROLLED_TEST' | 'PRODUCTION';

const ATTESTED_PRODUCTION_IDENTITY_PROVIDER = 'hx_ci_attested_identity_fixture';
const ATTESTED_PRODUCTION_IDENTITY_POLICY = 'hx-ci-attested-production-identity-v1';

/**
 * Give a fixture user current provider-owned identity evidence for exactly one
 * environment. CONTROLLED_TEST uses the deterministic local provider service;
 * the explicit production-shaped fixture uses a separate synthetic provider
 * attestation through the canonical SECURITY DEFINER state machine. Neither
 * path writes the users.is_verified projection directly.
 */
export async function attestTestUserIdentity(
  pool: pg.Pool,
  userId: string,
  environment: TestIdentityEnvironment
): Promise<void> {
  const compactUserId = userId.replaceAll('-', '');
  if (environment === 'CONTROLLED_TEST') {
    const { LocalCertificationIdentityProvider } =
      await import('../src/services/LocalCertificationIdentityProvider.js');
    const key = `fixture-identity-${compactUserId}`;
    const prepared = await LocalCertificationIdentityProvider.prepare({
      userId,
      idempotencyKey: key,
    });
    if (!prepared.success) {
      throw new Error(`Controlled TEST identity preparation failed: ${prepared.error.code}`);
    }
    const completed = await LocalCertificationIdentityProvider.completeVerified({
      userId,
      caseId: prepared.data.caseId,
      actorId: userId,
      idempotencyKey: `${key}-verified`,
    });
    if (
      !completed.success ||
      completed.data.status !== 'VERIFIED' ||
      completed.data.environment !== 'CONTROLLED_TEST' ||
      completed.data.isTest !== true
    ) {
      const code = completed.success ? completed.data.status : completed.error.code;
      throw new Error(`Controlled TEST identity completion failed: ${code}`);
    }
  } else {
    const consentKey = `fixture-production-identity-consent:${userId}`;
    const providerCaseId = `idv_hx_ci_attested_${compactUserId}`;
    const providerEventId = `fixture-production-identity-verified:${userId}`;
    const attested = await pool.query<{
      case_status: string;
      identity_verified: boolean;
    }>(
      `WITH inserted_consent AS (
         INSERT INTO identity_verification_consents (
           user_id, provider, provider_environment, is_test, policy_version,
           disclosure_hash, purpose, idempotency_key
         ) VALUES (
           $1, $2, 'PRODUCTION', FALSE, $3, repeat('a', 64),
           'Synthetic provider-attested production-shaped identity evidence; isolated CI only.',
           $4
         )
         ON CONFLICT (user_id, idempotency_key) DO NOTHING
         RETURNING id
       ), consent AS (
         SELECT id FROM inserted_consent
         UNION ALL
         SELECT id
         FROM identity_verification_consents
         WHERE user_id = $1 AND idempotency_key = $4
         LIMIT 1
       ), identity_case AS MATERIALIZED (
         SELECT begun.*
         FROM consent
         CROSS JOIN LATERAL begin_identity_verification_case_v1(
           $1, consent.id, $2, $5, 'PRODUCTION', FALSE,
           $3, repeat('b', 64), NOW() + INTERVAL '90 days'
         ) begun
       )
       SELECT verified.case_status, verified.identity_verified
       FROM identity_case
       CROSS JOIN LATERAL record_identity_verification_event_v1(
         $1, identity_case.case_id, $6, 'VERIFIED', repeat('c', 64),
         repeat('d', 64), NOW(), NOW() + INTERVAL '90 days', $1
       ) verified`,
      [
        userId,
        ATTESTED_PRODUCTION_IDENTITY_PROVIDER,
        ATTESTED_PRODUCTION_IDENTITY_POLICY,
        consentKey,
        providerCaseId,
        providerEventId,
      ]
    );
    if (
      attested.rowCount !== 1 ||
      attested.rows[0]?.case_status !== 'VERIFIED' ||
      attested.rows[0]?.identity_verified !== true
    ) {
      throw new Error('Attested production-shaped identity fixture is unavailable');
    }
  }

  const current = await pool.query<{ is_current: boolean }>(
    `SELECT identity_verification_is_current_v1($1, $2) AS is_current`,
    [userId, environment]
  );
  if (current.rows[0]?.is_current !== true) {
    throw new Error(`Current ${environment} identity evidence is unavailable for ${userId}`);
  }
}

type FixtureServiceResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string } };

function fixtureServiceData<T>(result: FixtureServiceResult<T>, label: string): T {
  if (!result.success) {
    throw new Error(`${label} failed: ${result.error.code} ${result.error.message}`);
  }
  return result.data;
}

export interface ControlledTestOfferFixtureInput {
  taskId: string;
  workerId: string;
  serviceCity?: string;
  serviceState?: string;
  serviceRadiusMiles?: number;
}

/**
 * Build the complete, current controlled-test evidence chain for one worker
 * and task. This deliberately goes through the same local identity, screening,
 * payout, duration, capability, liquidity, review, and explicit offer-accept
 * services as the canonical lifecycle test. It never inserts an authoritative
 * offer or liquidity witness directly.
 */
export async function prepareControlledTestOfferFixture(
  pool: pg.Pool,
  input: ControlledTestOfferFixtureInput
): Promise<{ offerDecisionId: string }> {
  const serviceCity = input.serviceCity ?? 'Seattle';
  const serviceState = input.serviceState ?? 'WA';
  const serviceRadiusMiles = input.serviceRadiusMiles ?? 10;
  const taskResult = await pool.query<{
    category: string;
    required_tools: string[];
    estimated_duration_minutes: number;
    created_at: Date | string;
  }>(
    `SELECT category, required_tools, estimated_duration_minutes, created_at
     FROM tasks WHERE id = $1`,
    [input.taskId]
  );
  const task = taskResult.rows[0];
  if (!task) throw new Error(`Missing controlled TEST task ${input.taskId}`);

  const compactWorkerId = input.workerId.replaceAll('-', '');
  const compactTaskId = input.taskId.replaceAll('-', '');
  const workerKey = `fixture-worker-${compactWorkerId}`;
  const offerKey = `fixture-offer-${compactTaskId}-${compactWorkerId}`;
  const phone = `+1206${compactWorkerId.slice(0, 7)}`;
  const tools = task.required_tools.length > 0
    ? task.required_tools
    : [`${task.category}-fixture-tools`];
  const expectedMinutes = task.estimated_duration_minutes;
  const sourceExpiresAt = new Date(
    new Date(task.created_at).getTime() + 3 * 60 * 60 * 1000
  ).toISOString();

  await pool.query(
    `UPDATE users
     SET default_mode = 'worker', date_of_birth = DATE '1990-01-01',
         is_minor = FALSE, is_banned = FALSE, account_status = 'ACTIVE',
         phone = $2, location_city = $3, location_state = $4
     WHERE id = $1`,
    [input.workerId, phone, serviceCity, serviceState]
  );
  await attestTestUserIdentity(pool, input.workerId, 'CONTROLLED_TEST');

  const [
    { HustlerIdentityLinkService },
    { LocalCertificationScreeningProvider },
    { LocalCertificationPayoutProvider },
    { ControlledTestDurationEvidenceService },
    { ControlledTestProviderCapabilityService },
    { ControlledTestLiquidityService },
    { ControlledTestOfferReviewService },
    { grantScreeningConsent },
    screeningPolicy,
  ] = await Promise.all([
    import('../src/services/HustlerIdentityLinkService.js'),
    import('../src/services/LocalCertificationScreeningProvider.js'),
    import('../src/services/LocalCertificationPayoutProvider.js'),
    import('../src/services/ControlledTestDurationEvidenceService.js'),
    import('../src/services/ControlledTestProviderCapabilityService.js'),
    import('../src/services/ControlledTestLiquidityService.js'),
    import('../src/services/ControlledTestOfferReviewService.js'),
    import('../src/services/WorkerScreeningRightsService.js'),
    import('../src/services/WorkerScreeningRightsPolicy.js'),
  ]);

  fixtureServiceData(
    await HustlerIdentityLinkService.link({
      engineHustlerRef: input.workerId,
      phoneE164: phone,
      providerClaimId: input.workerId,
    }),
    'Controlled TEST worker identity link'
  );
  const consent = await grantScreeningConsent({
    workerId: input.workerId,
    provider: screeningPolicy.LOCAL_CERTIFICATION_SCREENING_PROVIDER,
    purpose: screeningPolicy.LOCAL_CERTIFICATION_SCREENING_PURPOSE,
    disclosureVersion: screeningPolicy.LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
    disclosureHash: screeningPolicy.LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
    disclosurePresentedStandalone: true,
    consentGranted: true,
    purposeAcknowledged: true,
    rightsSummaryAcknowledged: true,
    providerNamed: true,
    idempotencyKey: `${workerKey}-screening-consent`,
  });
  const screening = fixtureServiceData(
    await LocalCertificationScreeningProvider.initiate({
      workerId: input.workerId,
      consentId: consent.consentId,
      idempotencyKey: `${workerKey}-screening-start`,
    }),
    'Controlled TEST screening initiation'
  );
  fixtureServiceData(
    await LocalCertificationScreeningProvider.completeClear({
      backgroundCheckId: screening.backgroundCheckId,
      workerId: input.workerId,
      actorId: input.workerId,
      idempotencyKey: `${workerKey}-screening-clear`,
    }),
    'Controlled TEST screening completion'
  );
  fixtureServiceData(
    await LocalCertificationPayoutProvider.activateDestination(input.workerId, input.workerId),
    'Controlled TEST payout destination'
  );
  fixtureServiceData(
    await ControlledTestDurationEvidenceService.apply({
      taskId: input.taskId,
      actorId: input.workerId,
      sourceQuoteVersionId: input.taskId,
      minimumMinutes: Math.max(15, expectedMinutes - 15),
      expectedMinutes,
      maximumMinutes: expectedMinutes + 30,
      policyVersion: 'price-book-duration-v1',
      sourceEvidenceHash: 'b'.repeat(64),
      sourceEnvironment: 'TEST',
      idempotencyKey: `${offerKey}-duration`,
    }),
    'Controlled TEST duration evidence'
  );
  fixtureServiceData(
    await ControlledTestProviderCapabilityService.record({
      taskId: input.taskId,
      workerId: input.workerId,
      actorId: input.workerId,
      sourceHustlerId: input.workerId,
      category: task.category,
      tools,
      serviceCity,
      serviceState,
      serviceRadiusMiles,
      sourcePolicyVersion: 'hxos-shared-pg-fixture-capability-v1',
      sourceEvidenceHash: 'c'.repeat(64),
      sourceExpiresAt,
      idempotencyKey: `${offerKey}-capability`,
    }),
    'Controlled TEST provider capability'
  );
  fixtureServiceData(
    await ControlledTestLiquidityService.prepareAndBind({
      taskId: input.taskId,
      workerId: input.workerId,
      actorId: input.workerId,
      idempotencyKey: `${offerKey}-liquidity`,
    }),
    'Controlled TEST liquidity'
  );
  const reviewed = fixtureServiceData(
    await ControlledTestOfferReviewService.review({
      taskId: input.taskId,
      workerId: input.workerId,
      idempotencyKey: `${offerKey}-review`,
    }),
    'Controlled TEST offer review'
  );
  fixtureServiceData(
    await ControlledTestOfferReviewService.accept({
      taskId: input.taskId,
      workerId: input.workerId,
      offerDecisionId: reviewed.offerDecisionId,
      idempotencyKey: `${offerKey}-accept`,
    }),
    'Controlled TEST offer acceptance'
  );
  return { offerDecisionId: reviewed.offerDecisionId };
}

const GOVERNED_ISOLATED_POLICY_REGION = 'US-ZX';
const GOVERNED_ISOLATED_POLICY_VERSION = 'hx-ci-governed-production-shape-v1';

/**
 * Install one explicitly synthetic production-shaped policy through the same
 * immutable approval function used by the database contract. The evidence is
 * labeled as an isolated CI fixture and is never a real legal or release
 * approval. Direct writes to approval fields remain forbidden.
 */
async function ensureGovernedIsolatedProductionPolicy(
  pool: pg.Pool,
  actorId: string
): Promise<void> {
  await pool.query(
    `INSERT INTO region_policies (
       region_code, version, policy_state, production_enabled, approval_state,
       effective_from, policy_document, policy_hash
     )
     SELECT $1, $2, 'ACTIVE', FALSE, 'COUNSEL_APPROVAL_REQUIRED',
            TIMESTAMPTZ '2026-01-01 00:00:00+00',
            source.policy_document, source.policy_hash
     FROM region_policies source
     WHERE source.region_code = 'US-WA'
       AND source.policy_state = 'ACTIVE'
       AND source.effective_from <= clock_timestamp()
       AND (source.effective_until IS NULL OR source.effective_until > clock_timestamp())
     ORDER BY source.effective_from DESC, source.created_at DESC
     LIMIT 1
     ON CONFLICT (region_code, version) DO NOTHING`,
    [GOVERNED_ISOLATED_POLICY_REGION, GOVERNED_ISOLATED_POLICY_VERSION]
  );
  const activated = await pool.query(
    `WITH policy AS (
       SELECT * FROM region_policies
       WHERE region_code = $1 AND version = $2 AND policy_state = 'ACTIVE'
     ), approval_document AS (
       SELECT policy.id,
              jsonb_build_object(
                'schema_version', 1,
                'gate_id', 'EXT-LEGAL-001',
                'decision', 'APPROVED',
                'scope', jsonb_build_object(
                  'jurisdiction_code', policy.region_code,
                  'local_jurisdictions', jsonb_build_array('isolated-ci-only'),
                  'policy_version', policy.version,
                  'policy_hash', policy.policy_hash,
                  'permitted_categories', (
                    SELECT jsonb_agg(category ORDER BY category)
                    FROM jsonb_object_keys(policy.policy_document->'categories')
                      AS categories(category)
                  ),
                  'prohibited_scope', jsonb_build_array(
                    'All real production use; synthetic database contract only.'
                  )
                ),
                'release_bindings', jsonb_build_object(
                  'engine', jsonb_build_object(
                    'repository', 'Sebdysart/hustlexp-ai-backend',
                    'approved_revision', repeat('d', 40),
                    'deployed_revision', repeat('d', 40),
                    'deployment_id', 'isolated-ci-engine-fixture'
                  ),
                  'site', jsonb_build_object(
                    'repository', 'Sebdysart/hustlexp-site',
                    'approved_revision', repeat('e', 40),
                    'deployed_revision', repeat('e', 40),
                    'deployment_id', 'isolated-ci-site-fixture'
                  )
                ),
                'approval', jsonb_build_object(
                  'counsel', jsonb_build_object(
                    'name', 'Synthetic CI counsel field - not legal approval',
                    'organization', 'HustleXP isolated database contract fixture',
                    'licensed_jurisdictions', jsonb_build_array('WA')
                  ),
                  'policy_owner', 'Synthetic CI policy owner fixture',
                  'activation_owner', 'Synthetic CI activation owner fixture',
                  'approved_at', to_jsonb(TIMESTAMPTZ '2026-01-01 00:00:00+00'),
                  'effective_at', to_jsonb(TIMESTAMPTZ '2026-01-02 00:00:00+00'),
                  'review_at', to_jsonb(TIMESTAMPTZ '2099-01-01 00:00:00+00'),
                  'exceptions', '[]'::jsonb,
                  'determinations', jsonb_build_object(
                    'worker_classification', 'APPROVED',
                    'category_licensing', 'APPROVED',
                    'screening_and_adverse_action', 'APPROVED',
                    'privacy_and_retention', 'APPROVED',
                    'payments_payouts_and_tax', 'APPROVED',
                    'disputes_arbitration_and_liability', 'APPROVED',
                    'safety_location_and_recording', 'APPROVED'
                  ),
                  'evidence', jsonb_build_object(
                    'uri', 'https://evidence.example.test/isolated-ci/not-production-authority',
                    'sha256', repeat('c', 64),
                    'signature_method', 'synthetic-contract-fixture-not-a-legal-signature'
                  )
                )
              ) AS document
       FROM policy
     )
     SELECT activate_region_policy_with_legal_approval(
              approval_document.id,
              approval_document.document,
              encode(digest(approval_document.document::text, 'sha256'), 'hex'),
              $3
            ) AS approval_id
     FROM approval_document`,
    [GOVERNED_ISOLATED_POLICY_REGION, GOVERNED_ISOLATED_POLICY_VERSION, actorId]
  );
  if (activated.rowCount !== 1 || !activated.rows[0]?.approval_id) {
    throw new Error('Governed isolated production-shaped test policy is unavailable');
  }
}

/**
 * Create a test task
 */
type TestTaskInput = {
  posterId: string;
  workerId?: string;
  state?: string;
  roughLocation?: string;
  automationClassification?: 'PRODUCTION' | 'CONTROLLED_TEST';
  productionPolicyFixture?: 'GOVERNED_ISOLATED';
  trustTierRequired?: number;
  cancellationPolicyVersion?: string;
  mutualConsentRequired?: boolean;
  mutualConsentAccepted?: boolean;
};

export function createTestTask(pool: pg.Pool, input: TestTaskInput): Promise<{ id: string }>;
export function createTestTask(
  pool: pg.Pool,
  posterId: string,
  state?: string,
  requiresProof?: boolean
): Promise<string>;
export async function createTestTask(
  pool: pg.Pool,
  input: string | TestTaskInput,
  requestedState: string = 'OPEN',
  _requiresProof: boolean = false
): Promise<string | { id: string }> {
  const objectInput = typeof input === 'object';
  const posterId = objectInput ? input.posterId : input;
  const state = objectInput ? (input.state ?? 'OPEN') : requestedState;
  const automationClassification = objectInput
    ? (input.automationClassification ?? 'CONTROLLED_TEST')
    : 'CONTROLLED_TEST';
  const productionPolicyFixture = objectInput ? input.productionPolicyFixture : undefined;
  if (
    (automationClassification === 'PRODUCTION') !==
    (productionPolicyFixture === 'GOVERNED_ISOLATED')
  ) {
    throw new Error('PRODUCTION test tasks require the explicit GOVERNED_ISOLATED policy fixture');
  }
  const policyRegion =
    automationClassification === 'PRODUCTION' ? GOVERNED_ISOLATED_POLICY_REGION : 'US-WA';
  if (automationClassification === 'PRODUCTION') {
    await ensureGovernedIsolatedProductionPolicy(pool, posterId);
  }
  let workerId = objectInput ? (input.workerId ?? null) : null;
  if (state === 'ACCEPTED' && !workerId) {
    const worker = await createTestUser(pool);
    workerId = worker.id;
  }
  if (workerId) {
    await attestTestUserIdentity(pool, workerId, automationClassification);
  }
  if (state === 'ACCEPTED' && workerId) {
    await promoteTestUserTrustSequentially(pool, workerId, 2);
    await pool.query(
      `UPDATE users
       SET default_mode = 'worker',
           date_of_birth = DATE '1990-01-01', is_minor = FALSE,
           is_banned = FALSE, trust_hold = FALSE, trust_hold_until = NULL,
           account_status = 'ACTIVE',
           phone = COALESCE(phone, '+1206' || substr(replace(id::text, '-', ''), 1, 7)),
           location_state = 'WA', location_city = 'Seattle',
           stripe_connect_id = COALESCE(stripe_connect_id, 'acct_test_' || replace(id::text, '-', '')),
           payouts_enabled = TRUE
       WHERE id = $1`,
      [workerId]
    );
    await pool.query(
      `INSERT INTO capability_profiles (
         user_id, trust_tier, risk_clearance, location_state, location_city, updated_at
       )
       SELECT id, trust_tier,
              CASE WHEN trust_tier >= 3 THEN ARRAY['low','medium','high']::text[]
                   WHEN trust_tier = 2 THEN ARRAY['low','medium']::text[]
                   ELSE ARRAY['low']::text[] END,
              location_state, location_city, NOW()
       FROM users WHERE id = $1
       ON CONFLICT (user_id) DO UPDATE SET
         trust_tier = EXCLUDED.trust_tier,
         risk_clearance = EXCLUDED.risk_clearance,
         location_state = EXCLUDED.location_state,
         location_city = EXCLUDED.location_city,
         updated_at = NOW()`,
      [workerId]
    );
  }
  const requestedRoughLocation = objectInput
    ? (input.roughLocation ?? 'Seattle, WA')
    : 'Seattle, WA';
  const controlledAcceptedServiceCity =
    state === 'ACCEPTED' && automationClassification === 'CONTROLLED_TEST' && workerId
      ? `${requestedRoughLocation.split(',')[0]!.trim()} ${workerId.replaceAll('-', '').slice(0, 8)}`
      : undefined;
  const roughLocation = controlledAcceptedServiceCity
    ? `${controlledAcceptedServiceCity}, WA`
    : requestedRoughLocation;
  const insertState = state === 'ACCEPTED' ? 'OPEN' : state;
  const insertWorkerId = state === 'ACCEPTED' ? null : workerId;
  const result = await pool.query(
    `WITH seeded_cells AS (
       INSERT INTO zone_category_cells (
         geo_zone, geography_label, category, operating_window, state,
         policy_version, launch_cell_enabled, green_category,
         metrics_computed_at, evaluated_at, stable_since,
         state_reasons, completed_tasks_total, paid_tasks_30d, fill_rate_30d,
         active_verified_providers, anchor_demand_accounts,
         average_contribution_cents,
         minimum_provider_net_hourly_cents, provider_earnings_policy_version,
         provider_earnings_policy_state, provider_earnings_policy_reference,
         provider_earnings_sample_size, average_provider_net_hourly_cents,
         dispute_rate_30d, no_show_rate_30d,
         cancellation_rate_30d, repeat_demand_rate_30d,
         dispatch_allowed, public_instant_requests_allowed, expansion_eligible,
         max_concurrent_dispatches, environment, is_test
       ) SELECT * FROM (VALUES
         ('hx-test-wa', 'HX isolated test zone', 'yard', 'always', 'OPEN',
          'hx-test-v1', TRUE, TRUE, NOW(), NOW(), NOW(), '[]'::jsonb,
          100, 20, 1, 20, 2, 1000,
          2000, 'hxos-provider-economics-approved-test-v1', 'APPROVED',
          'local-shared-pg-fixture-only', 20, 3500,
          0, 0, 0, 1, TRUE, TRUE, FALSE, 1000, 'PRODUCTION', FALSE),
         ('hx-test-wa', 'HX isolated test zone', 'moving', 'always', 'OPEN',
          'hx-test-v1', TRUE, TRUE, NOW(), NOW(), NOW(), '[]'::jsonb,
          100, 20, 1, 20, 2, 1000,
          2000, 'hxos-provider-economics-approved-test-v1', 'APPROVED',
          'local-shared-pg-fixture-only', 20, 3500,
          0, 0, 0, 1, TRUE, TRUE, FALSE, 1000, 'PRODUCTION', FALSE)
       ) AS fixture_cell
       WHERE $8 = 'PRODUCTION'
       ON CONFLICT (geo_zone, category, operating_window) DO UPDATE SET
         state = 'OPEN', launch_cell_enabled = TRUE, green_category = TRUE,
         metrics_computed_at = NOW(), evaluated_at = NOW(),
         average_contribution_cents = 1000,
         minimum_provider_net_hourly_cents = 2000,
         provider_earnings_policy_version = 'hxos-provider-economics-approved-test-v1',
         provider_earnings_policy_state = 'APPROVED',
         provider_earnings_policy_reference = 'local-shared-pg-fixture-only',
         provider_earnings_sample_size = 20,
         average_provider_net_hourly_cents = 3500,
         dispatch_allowed = TRUE, max_concurrent_dispatches = 1000,
         environment = 'PRODUCTION', is_test = FALSE, updated_at = NOW()
       RETURNING id, geo_zone, category
     ), policy AS (
       SELECT id, region_code, version, policy_hash, policy_document
       FROM region_policies
       WHERE region_code = $9 AND policy_state = 'ACTIVE'
         AND effective_from <= clock_timestamp()
         AND (effective_until IS NULL OR effective_until > clock_timestamp())
       ORDER BY effective_from DESC, created_at DESC
       LIMIT 1
     ), yard_cell AS (
       SELECT id, geo_zone FROM seeded_cells WHERE category = 'yard'
       UNION ALL
       SELECT NULL::uuid, 'unmapped' WHERE $8 = 'CONTROLLED_TEST'
     )
     INSERT INTO tasks (
       poster_id, worker_id, title, description, price, state, requires_proof,
       category, risk_level, automation_classification,
       hustler_payout_cents, platform_margin_cents,
       template_slug, trust_tier_required, completion_criteria,
       content_release, mutual_consent_required, mutual_consent_accepted,
       cancellation_window_hours,
       late_cancel_pct, cancellation_policy_version, illegal_risk_score,
       compliance_guardian_notes, estimated_duration_minutes, scope_hash,
       rough_location,
       region_code, region_policy_id, region_policy_version, region_policy_hash,
       region_policy_snapshot, trade_type, location_state,
       license_required, insurance_required, background_check_required,
       proof_min_photos, proof_max_photos, proof_gps_required, currency,
       geo_zone, liquidity_cell_id
     )
     SELECT
       $1, $3, 'Test Task', 'Test Description', 5000, $2, TRUE,
       'yard', 'LOW', $8, 4000, 1000,
       'standard_physical', $4, '{"type":"photo_proof"}'::jsonb,
       FALSE, $6, $7, 24, 0, $5, 0,
       '{}'::jsonb, 60, repeat('e', 64), $10,
       p.region_code, p.id, p.version, p.policy_hash,
       jsonb_build_object(
         'policyId', p.id::text,
         'policyVersion', p.version,
         'policyHash', p.policy_hash,
         'regionCode', p.region_code,
         'locationState', split_part(p.region_code, '-', 2),
         'licenseRequired', (p.policy_document#>>'{categories,yard,credentials,licenseRequired}')::boolean,
         'insuranceRequired', (p.policy_document#>>'{categories,yard,credentials,insuranceRequired}')::boolean,
         'backgroundCheckRequired', (p.policy_document#>>'{categories,yard,credentials,backgroundCheckRequired}')::boolean,
         'proofRequired', (p.policy_document#>>'{categories,yard,evidence,proofRequired}')::boolean,
         'proofMinPhotos', (p.policy_document#>>'{categories,yard,evidence,minPhotos}')::integer,
         'proofMaxPhotos', (p.policy_document#>>'{categories,yard,evidence,maxPhotos}')::integer,
         'proofGpsRequired', (p.policy_document#>>'{categories,yard,evidence,gpsRequired}')::boolean,
         'recordingAllowed', (p.policy_document#>>'{recording,allowed}')::boolean,
         'recordingStandaloneConsentRequired', (p.policy_document#>>'{recording,standaloneConsentRequired}')::boolean,
         'screeningStandaloneConsentRequired', (p.policy_document#>>'{workerRights,standaloneScreeningConsentRequired}')::boolean,
         'screeningReportAccessRequired', (p.policy_document#>>'{workerRights,reportAccessRequired}')::boolean,
         'screeningDisputeAndAppealRequired', (p.policy_document#>>'{workerRights,disputeAndAppealRequired}')::boolean,
         'screeningAdverseActionNoticeRequired', (p.policy_document#>>'{workerRights,adverseActionNoticeRequired}')::boolean,
         'safetyIncidentIntakeRequired', (p.policy_document#>>'{safety,incidentIntakeRequired}')::boolean,
         'safetyTimedCheckinRequired', (p.policy_document#>'{safety,timedCheckinRiskLevels}') ? 'LOW',
         'safetyCheckinIntervalsMinutes', p.policy_document#>'{safety,checkinIntervalsMinutes}',
         'safetyLocationRetentionDays', (p.policy_document#>>'{safety,locationRetentionDays}')::integer,
         'safetyAlternateEmergencyActionRequired', (p.policy_document#>>'{safety,alternateEmergencyActionRequired}')::boolean,
         'currency', p.policy_document#>>'{financial,currency}'
       ),
       'yard', split_part(p.region_code, '-', 2),
       (p.policy_document#>>'{categories,yard,credentials,licenseRequired}')::boolean,
       (p.policy_document#>>'{categories,yard,credentials,insuranceRequired}')::boolean,
       (p.policy_document#>>'{categories,yard,credentials,backgroundCheckRequired}')::boolean,
       (p.policy_document#>>'{categories,yard,evidence,minPhotos}')::integer,
       (p.policy_document#>>'{categories,yard,evidence,maxPhotos}')::integer,
       (p.policy_document#>>'{categories,yard,evidence,gpsRequired}')::boolean,
       p.policy_document#>>'{financial,currency}',
       c.geo_zone, c.id
     FROM policy p CROSS JOIN yard_cell c
     RETURNING id`,
    [
      posterId,
      insertState,
      insertWorkerId,
      objectInput ? (input.trustTierRequired ?? 1) : 1,
      objectInput
        ? (input.cancellationPolicyVersion ?? 'task-template-v2:standard_physical:0')
        : 'task-template-v2:standard_physical:0',
      objectInput ? (input.mutualConsentRequired ?? false) : false,
      objectInput ? (input.mutualConsentAccepted ?? false) : false,
      automationClassification,
      policyRegion,
      roughLocation,
    ]
  );
  if (result.rowCount !== 1) throw new Error(`Active ${policyRegion} test policy is unavailable`);
  const id = result.rows[0].id as string;
  if (state === 'ACCEPTED') {
    if (!workerId) throw new Error('Accepted test task requires a worker');
    await pool.query(
      `INSERT INTO escrows (task_id, amount, state)
       VALUES ($1, 5000, 'FUNDED')`,
      [id]
    );
    if (automationClassification === 'CONTROLLED_TEST') {
      await prepareControlledTestOfferFixture(pool, {
        taskId: id,
        workerId,
        serviceCity: controlledAcceptedServiceCity,
      });
      const { TaskReservationService } =
        await import('../src/services/TaskReservationService.js');
      fixtureServiceData(
        await TaskReservationService.reserve({
          engineTaskId: id,
          hustlerRef: workerId,
          actorId: workerId,
          idempotencyKey: `fixture-reservation-${id.replaceAll('-', '')}`,
        }),
        'Controlled TEST task reservation'
      );
    } else {
      await pool.query(
        `INSERT INTO worker_offer_decisions (
            task_id, worker_id, policy_version, payload_hash, decision_ready,
            blocking_reasons, customer_total_cents, payout_cents,
            insurance_adjustment_cents, net_payout_cents,
            estimated_net_hourly_cents, distance_miles, estimated_duration_minutes,
            estimated_travel_time_minutes, travel_time_policy_version,
            minimum_net_hourly_cents, provider_earnings_policy_version,
            provider_earnings_floor_met, paid_promotion_affects_rank,
            passing_has_rank_penalty,
            scope_hash, cancellation_policy_version, rank_score, rank_reasons,
            snapshot, expires_at
          )
          SELECT task.id, $2, 'hxos-worker-offer-v3', repeat('a', 64), TRUE,
                 '[]', task.price, task.hustler_payout_cents,
                 ROUND(task.price * 0.02),
                 task.hustler_payout_cents - ROUND(task.price * 0.02),
                 task.hustler_payout_cents - ROUND(task.price * 0.02),
                 0, task.estimated_duration_minutes,
                 15, 'hxos-conservative-travel-v1',
                 cell.minimum_provider_net_hourly_cents,
                 cell.provider_earnings_policy_version,
                 TRUE, FALSE, FALSE,
                 task.scope_hash, task.cancellation_policy_version,
                 1, '[]', '{}', NOW() + INTERVAL '1 hour'
          FROM tasks task
          JOIN zone_category_cells cell ON cell.id = task.liquidity_cell_id
          WHERE task.id = $1`,
        [id, workerId]
      );
      await pool.query(
        `UPDATE tasks
         SET state = 'ACCEPTED', worker_id = $2, accepted_at = NOW()
         WHERE id = $1`,
        [id, workerId]
      );
    }
  }
  return objectInput ? { id } : id;
}

/**
 * Create a test escrow
 */
type TestEscrowInput = { taskId: string; state?: string };

export function createTestEscrow(pool: pg.Pool, input: TestEscrowInput): Promise<{ id: string }>;
export function createTestEscrow(pool: pg.Pool, taskId: string, state?: string): Promise<string>;
export async function createTestEscrow(
  pool: pg.Pool,
  input: string | TestEscrowInput,
  requestedState: string = 'PENDING'
): Promise<string | { id: string }> {
  const objectInput = typeof input === 'object';
  const taskId = objectInput ? input.taskId : input;
  const state = objectInput ? (input.state ?? 'PENDING') : requestedState;
  const existing = await pool.query<{ id: string; state: string }>(
    'SELECT id, state FROM escrows WHERE task_id = $1',
    [taskId]
  );
  if (existing.rows[0]?.state === state) {
    return objectInput ? { id: existing.rows[0].id } : existing.rows[0].id;
  }
  // REFUND_PARTIAL state requires refund_amount + release_amount = amount
  if (state === 'REFUND_PARTIAL') {
    const result = await pool.query(
      `INSERT INTO escrows (task_id, amount, state, refund_amount, release_amount)
       VALUES ($1, 5000, $2, 2500, 2500)
       RETURNING id`,
      [taskId, state]
    );
    const id = result.rows[0].id as string;
    return objectInput ? { id } : id;
  }

  const result = await pool.query(
    `INSERT INTO escrows (task_id, amount, state)
     VALUES ($1, 5000, $2)
     RETURNING id`,
    [taskId, state]
  );
  const id = result.rows[0].id as string;
  return objectInput ? { id } : id;
}

/**
 * Create a test proof
 */
export async function createTestProof(
  pool: pg.Pool,
  taskId: string,
  submitterId: string,
  state: string = 'PENDING'
): Promise<string> {
  const result = await pool.query(
    `INSERT INTO proofs (task_id, submitter_id, state, description)
     VALUES ($1, $2, $3, 'Test proof description')
     RETURNING id`,
    [taskId, submitterId, state]
  );
  return result.rows[0].id;
}

/**
 * Update escrow state directly (for testing)
 */
export async function setEscrowState(
  pool: pg.Pool,
  escrowId: string,
  state: string
): Promise<void> {
  await pool.query(`UPDATE escrows SET state = $1 WHERE id = $2`, [state, escrowId]);
}

/**
 * Update task state directly (for testing)
 */
export async function setTaskState(pool: pg.Pool, taskId: string, state: string): Promise<void> {
  await pool.query(`UPDATE tasks SET state = $1 WHERE id = $2`, [state, taskId]);
}

/**
 * Update proof state directly (for testing)
 */
export async function setProofState(pool: pg.Pool, proofId: string, state: string): Promise<void> {
  await pool.query(`UPDATE proofs SET state = $1 WHERE id = $2`, [state, proofId]);
}
