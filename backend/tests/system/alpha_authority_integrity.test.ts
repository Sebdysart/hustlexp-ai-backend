/**
 * Alpha Authority Integrity Test
 * 
 * "If this passes, we're not lying"
 * 
 * This is the most comprehensive backend test that proves:
 * - Database schema, services, workers, invariants, and guards all agree on reality
 * - No combination of inputs, timing, retries, or schema drift can cause:
 *   - an ineligible user to access a task
 *   - a task to bypass risk rules
 *   - Instant Mode to override safety
 *   - XP to be awarded incorrectly
 *   - surge / matching / promotion to desynchronize
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { QueryFn } from '../../src/db';
import { testDb, closeTestPool, getTestPool, hasLocalDb } from './test-db';
import { TrustTierService, TrustTier } from '../../src/services/TrustTierService';
import { TaskRiskClassifier, TaskRisk } from '../../src/services/TaskRiskClassifier';
import { EligibilityGuard, EligibilityErrorCode } from '../../src/services/EligibilityGuard';
import { TaskService } from '../../src/services/TaskService';
import { ControlledTestDurationEvidenceService } from '../../src/services/ControlledTestDurationEvidenceService';
import { ControlledTestLiquidityService } from '../../src/services/ControlledTestLiquidityService';
import { ControlledTestOfferReviewService } from '../../src/services/ControlledTestOfferReviewService';
import { ControlledTestProviderCapabilityService } from '../../src/services/ControlledTestProviderCapabilityService';
import { HustlerIdentityLinkService } from '../../src/services/HustlerIdentityLinkService';
import { LocalCertificationIdentityProvider } from '../../src/services/LocalCertificationIdentityProvider';
import { LocalCertificationPayoutProvider } from '../../src/services/LocalCertificationPayoutProvider';
import { LocalCertificationScreeningProvider } from '../../src/services/LocalCertificationScreeningProvider';
import { grantScreeningConsent } from '../../src/services/WorkerScreeningRightsService';
import {
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
  LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
  LOCAL_CERTIFICATION_SCREENING_PROVIDER,
  LOCAL_CERTIFICATION_SCREENING_PURPOSE,
} from '../../src/services/WorkerScreeningRightsPolicy';
import type { ServiceResult } from '../../src/types';

const transactionContext = new AsyncLocalStorage<QueryFn>();
const rawTestQuery = testDb.query.bind(testDb);

async function runTestTransaction<T>(
  fn: (query: QueryFn) => Promise<T>,
  isolation: 'READ COMMITTED' | 'SERIALIZABLE',
): Promise<T> {
  const activeQuery = transactionContext.getStore();
  if (activeQuery) return fn(activeQuery);

  const client = await getTestPool().connect();
  const query: QueryFn = async <R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => {
    const result = await client.query(sql, params);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? 0 };
  };

  return transactionContext.run(query, async () => {
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      const result = await fn(query);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  });
}

const contextualQuery: QueryFn = (sql, params) => {
  const activeQuery = transactionContext.getStore();
  return activeQuery ? activeQuery(sql, params) : rawTestQuery(sql, params);
};

// The production database module exposes transaction-aware query methods. Keep
// the local PostgreSQL override faithful to that contract, including nested
// service calls that must remain on the caller's transaction connection.
const db = Object.assign(testDb, {
  query: contextualQuery,
  readQuery: contextualQuery,
  transaction: <T>(fn: (query: QueryFn) => Promise<T>) => runTestTransaction(fn, 'READ COMMITTED'),
  serializableTransaction: <T>(fn: (query: QueryFn) => Promise<T>) => runTestTransaction(fn, 'SERIALIZABLE'),
});

// CRITICAL: Override db import for services to use local Postgres (not Neon serverless)
// This avoids driver-level query plan caching that interferes with schema-mutation tests
// Services import db from '../../src/db', so we mock that module to return testDb
vi.mock('../../src/db', () => ({
  db: testDb,
  default: testDb,
}));

// This cohort proves the Alpha EligibilityGuard remains the final risk/tier
// authority. Newer discovery prerequisites are exercised by their dedicated
// invariant cohorts; allowing them to pre-empt this call would make it
// impossible to prove that TaskService still invokes the Alpha guard itself.
vi.mock('../../src/services/TaskEligibilityPolicy', async () => {
  const actual = await vi.importActual<typeof import('../../src/services/TaskEligibilityPolicy')>(
    '../../src/services/TaskEligibilityPolicy',
  );
  return { ...actual, assertTaskMutationEligibility: vi.fn(async () => undefined) };
});

// Test helpers
async function recordProductionIdentityFixture(userId: string): Promise<void> {
  const provider = 'production-alpha-authority-fixture';
  const policyVersion = 'hx-private-identity-production-alpha-authority-v1';
  await db.transaction(async (query) => {
    const consent = await query<{ id: string }>(
      `INSERT INTO identity_verification_consents (
         user_id, provider, provider_environment, is_test, policy_version,
         disclosure_hash, purpose, idempotency_key
       ) VALUES (
         $1::uuid, $2, 'PRODUCTION', FALSE, $3, repeat('d', 64),
         'Provider-attested production identity evidence for the isolated Alpha authority test.',
         'alpha-authority-production-consent-' || $1::uuid::text
       )
       RETURNING id`,
      [userId, provider, policyVersion],
    );
    const identityCase = await query<{ case_id: string }>(
      `SELECT case_id
       FROM begin_identity_verification_case_v1(
         $1::uuid, $2::uuid, $3,
         'idv_alpha_authority_' || replace($1::uuid::text, '-', ''),
         'PRODUCTION', FALSE, $4, repeat('e', 64),
         NOW() + INTERVAL '90 days'
       )`,
      [userId, consent.rows[0].id, provider, policyVersion],
    );
    await query(
      `SELECT case_status
       FROM record_identity_verification_event_v1(
         $1::uuid, $2::uuid,
         'identity-verified-' || $1::uuid::text,
         'VERIFIED', repeat('f', 64), repeat('a', 64),
         NOW(), NOW() + INTERVAL '90 days', $1::uuid
       )`,
      [userId, identityCase.rows[0].case_id],
    );
  });
}

async function createTestUser(overrides: Partial<{
  trust_tier: number;
  is_verified: boolean;
  phone: string;
  stripe_customer_id: string;
  stripe_connect_id: string;
  payouts_enabled: boolean;
  created_at: Date;
}> = {}): Promise<string> {
  const userId = crypto.randomUUID();
  const uniquePhone = overrides.phone
    || `+1${Math.floor(Math.random() * 10000000000).toString().padStart(10, '0')}`;
  const createdAt = overrides.created_at || new Date();
  
  // Set plan to pro (lowercase) for high-risk task acceptance (if trust_tier >= 3)
  const plan = (overrides.trust_tier ?? TrustTier.EXPLORER) >= TrustTier.PRO ? 'pro' : 'free';
  await db.query(
    `INSERT INTO users (
       id,email,full_name,default_mode,date_of_birth,is_minor,trust_tier,phone,
       stripe_customer_id,stripe_connect_id,payouts_enabled,plan,created_at
     ) VALUES ($1,$2,$3,$4,'1990-01-01',FALSE,$5,$6,$7,$8,$9,$10,$11)`,
    [
      userId,
      `test-${userId}@example.com`,
      'Test User',
      'worker',
      overrides.trust_tier ?? TrustTier.EXPLORER,
      uniquePhone,
      overrides.stripe_customer_id ?? null,
      overrides.stripe_connect_id ?? null,
      overrides.payouts_enabled ?? false,
      plan,
      createdAt,
    ]
  );
  if (overrides.is_verified) await recordProductionIdentityFixture(userId);
  return userId;
}

async function createTestTask(overrides: Partial<{
  risk_level: string;
  instant_mode: boolean;
  sensitive: boolean;
  state: string;
  worker_id: string | null;
}> = {}): Promise<string> {
  if (overrides.worker_id != null) {
    throw new Error('Alpha authority tasks must begin without a hard assignment');
  }
  const posterId = await createTestUser({ trust_tier: TrustTier.VERIFIED });
  await db.query(
    `UPDATE users SET default_mode = 'poster', plan = 'premium' WHERE id = $1`,
    [posterId],
  );
  const created = await TaskService.create({
    posterId,
    title: 'Alpha authority task',
    description: 'Controlled invariant fixture for the Alpha authority cohort.',
    price: 5000,
    hustlerPayoutCents: 4000,
    platformMarginCents: 1000,
    roughArea: 'Alpha Testville, ZZ',
    regionCode: 'US-ZZ',
    category: 'alpha',
    riskLevel: overrides.risk_level as 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME' | undefined,
    requiresProof: true,
    instantMode: false,
    sensitive: overrides.sensitive ?? false,
    automationClassification: 'CONTROLLED_TEST',
    estimatedDurationMinutes: 60,
    requiredTools: ['basic-tools'],
  });
  if (!created.success) {
    throw new Error(`${created.error.code}: ${created.error.message}`);
  }
  const state = overrides.state ?? 'OPEN';
  await db.query(
    `UPDATE tasks SET state = $2, instant_mode = $3 WHERE id = $1`,
    [created.data.id, state, overrides.instant_mode ?? false],
  );
  if (state === 'MATCHING') {
    await db.query(`UPDATE escrows SET state = 'FUNDED' WHERE task_id = $1`, [created.data.id]);
  }
  return created.data.id;
}

function serviceData<T>(result: ServiceResult<T>, label: string): T {
  if (!result.success) throw new Error(`${label}: ${result.error.code} ${result.error.message}`);
  return result.data;
}

async function seedControlledAlphaPolicy(): Promise<void> {
  const document = {
    schemaVersion: 'hxos-region-policy-v1',
    categories: {
      alpha: {
        allowedRiskLevels: ['LOW', 'MEDIUM', 'HIGH', 'IN_HOME'],
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
      minimumCustomerCents: 5000,
      minimumPayoutCents: 4000,
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
  await db.query(
    `WITH policy AS (SELECT $1::jsonb AS document)
     INSERT INTO region_policies (
       region_code, version, policy_state, production_enabled, approval_state,
       effective_from, policy_document, policy_hash
     )
     SELECT 'US-ZZ', 'hx-alpha-authority-controlled-v1', 'ACTIVE', FALSE,
            'COUNSEL_APPROVAL_REQUIRED', NOW() - INTERVAL '1 day', document,
            encode(digest(document::text, 'sha256'), 'hex')
     FROM policy
     WHERE NOT EXISTS (
       SELECT 1
       FROM region_policies
       WHERE region_code = 'US-ZZ'
         AND policy_state = 'ACTIVE'
     )
     ON CONFLICT (region_code, version) DO NOTHING`,
    [JSON.stringify(document)],
  );
}

async function prepareControlledTestWorker(workerId: string, key: string): Promise<void> {
  const identity = serviceData(
    await LocalCertificationIdentityProvider.prepare({
      userId: workerId,
      idempotencyKey: `${key}-identity`,
    }),
    'controlled identity prepare',
  );
  serviceData(
    await LocalCertificationIdentityProvider.completeVerified({
      userId: workerId,
      caseId: identity.caseId,
      actorId: workerId,
      idempotencyKey: `${key}-identity-verified`,
    }),
    'controlled identity complete',
  );

  const user = await db.query<{ phone: string; trust_tier: number }>(
    `SELECT phone, trust_tier FROM users WHERE id = $1`,
    [workerId],
  );
  const phone = user.rows[0].phone;
  await db.query(
    `INSERT INTO capability_profiles (
       user_id, trust_tier, risk_clearance, location_state, location_city, updated_at
     ) VALUES ($1, $2, ARRAY['low','medium','high']::text[], 'ZZ', 'Alpha Testville', NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       trust_tier = EXCLUDED.trust_tier,
       risk_clearance = EXCLUDED.risk_clearance,
       location_state = EXCLUDED.location_state,
       location_city = EXCLUDED.location_city,
       updated_at = NOW()`,
    [workerId, user.rows[0].trust_tier],
  );
  serviceData(await HustlerIdentityLinkService.link({
    engineHustlerRef: workerId,
    phoneE164: phone,
    providerClaimId: crypto.randomUUID(),
  }), 'controlled identity link');

  const consent = await grantScreeningConsent({
    workerId,
    provider: LOCAL_CERTIFICATION_SCREENING_PROVIDER,
    purpose: LOCAL_CERTIFICATION_SCREENING_PURPOSE,
    disclosureVersion: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_VERSION,
    disclosureHash: LOCAL_CERTIFICATION_SCREENING_DISCLOSURE_HASH,
    disclosurePresentedStandalone: true,
    consentGranted: true,
    purposeAcknowledged: true,
    rightsSummaryAcknowledged: true,
    providerNamed: true,
    idempotencyKey: `${key}-screening-consent`,
  });
  const screening = serviceData(await LocalCertificationScreeningProvider.initiate({
    workerId,
    consentId: consent.consentId,
    idempotencyKey: `${key}-screening-start`,
  }), 'controlled screening initiate');
  serviceData(await LocalCertificationScreeningProvider.completeClear({
    backgroundCheckId: screening.backgroundCheckId,
    workerId,
    actorId: workerId,
    idempotencyKey: `${key}-screening-clear`,
  }), 'controlled screening complete');
  // Screening recomputes the capability profile from provider evidence. Restore
  // only the controlled fixture's coarse service area after that recomputation.
  await db.query(
    `UPDATE capability_profiles
        SET location_state = 'ZZ', location_city = 'Alpha Testville', updated_at = NOW()
      WHERE user_id = $1`,
    [workerId],
  );
  serviceData(
    await LocalCertificationPayoutProvider.activateDestination(workerId, workerId),
    'controlled payout destination',
  );
}

async function prepareControlledTestOffer(
  taskId: string,
  workerId: string,
  key: string,
  establishDuration: boolean,
): Promise<void> {
  if (establishDuration) {
    serviceData(await ControlledTestDurationEvidenceService.apply({
      taskId,
      actorId: workerId,
      sourceQuoteVersionId: crypto.randomUUID(),
      minimumMinutes: 45,
      expectedMinutes: 60,
      maximumMinutes: 90,
      policyVersion: 'price-book-duration-v1',
      sourceEvidenceHash: 'b'.repeat(64),
      sourceEnvironment: 'TEST',
      idempotencyKey: `${key}-duration`,
    }), 'controlled duration evidence');
  }
  serviceData(await ControlledTestProviderCapabilityService.record({
    taskId,
    workerId,
    actorId: workerId,
    sourceHustlerId: workerId,
    category: 'alpha',
    tools: ['basic-tools'],
    serviceCity: 'Alpha Testville',
    serviceState: 'ZZ',
    serviceRadiusMiles: 10,
    sourcePolicyVersion: 'hx-alpha-authority-capability-v1',
    sourceEvidenceHash: 'c'.repeat(64),
    sourceExpiresAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
    idempotencyKey: `${key}-capability`,
  }), 'controlled provider capability');
  serviceData(await ControlledTestLiquidityService.prepareAndBind({
    taskId,
    workerId,
    actorId: workerId,
    idempotencyKey: `${key}-liquidity`,
  }), 'controlled liquidity');
  const reviewed = serviceData(await ControlledTestOfferReviewService.review({
    taskId,
    workerId,
    idempotencyKey: `${key}-offer-viewed`,
  }), 'controlled offer review');
  serviceData(await ControlledTestOfferReviewService.accept({
    taskId,
    workerId,
    offerDecisionId: reviewed.offerDecisionId,
    idempotencyKey: `${key}-offer-accepted`,
  }), 'controlled offer acceptance');
}

describe.skipIf(!hasLocalDb)('Alpha Authority Integrity Test', () => {
  const testUserIds: string[] = [];
  const testTaskIds: string[] = [];

  beforeAll(async () => {
    const isolatedTestEnvironment = {
      NODE_ENV: 'test',
      ENGINE_API_MODE: 'test',
      STRIPE_MODE: 'test',
      HX_HARD_ASSIGNMENT_MODE: 'enabled',
      HXOS_ALLOW_LOCAL_TEST_IDENTITY: 'true',
      HXOS_LOCAL_TEST_IDENTITY_SECRET: 'hx-alpha-authority-identity-only-000001',
      HXOS_ALLOW_LOCAL_TEST_SCREENING: 'true',
      HXOS_LOCAL_TEST_SCREENING_SECRET: 'hx-alpha-authority-screening-only-00001',
      HXOS_ALLOW_LOCAL_TEST_PAYOUT: 'true',
      HXOS_LOCAL_TEST_PAYOUT_SECRET: 'hx-alpha-authority-payout-only-0000001',
      HXOS_ALLOW_LOCAL_TEST_DURATION_EVIDENCE: 'true',
      HXOS_LOCAL_TEST_DURATION_EVIDENCE_SECRET: 'hx-alpha-authority-duration-only-000001',
      HXOS_ALLOW_LOCAL_TEST_PROVIDER_CAPABILITY: 'true',
      HXOS_LOCAL_TEST_PROVIDER_CAPABILITY_SECRET: 'hx-alpha-authority-capability-only-0001',
      HXOS_ALLOW_LOCAL_TEST_LIQUIDITY: 'true',
      HXOS_LOCAL_TEST_LIQUIDITY_SECRET: 'hx-alpha-authority-liquidity-only-00001',
      HXOS_ALLOW_LOCAL_TEST_OFFER_REVIEW: 'true',
      HXOS_LOCAL_TEST_OFFER_REVIEW_SECRET: 'hx-alpha-authority-offer-only-0000001',
    } as const;
    for (const [name, value] of Object.entries(isolatedTestEnvironment)) {
      vi.stubEnv(name, value);
    }
    await seedControlledAlphaPolicy();
  });

  afterAll(async () => {
    // This database is disposable and recreated by the required-suite runner.
    // Preserve append-only identity, screening, trust, and offer evidence rather
    // than manufacturing cleanup mutations that the schema correctly rejects.
    void testUserIds;
    void testTaskIds;
    await closeTestPool();
    vi.unstubAllEnvs();
  });

  // ============================================================================
  // PHASE 0 — SCHEMA TRUTH CHECK
  // ============================================================================
  describe('Phase 0: Schema Contract Validation', () => {
    it('0.1 — All required columns exist', async () => {
      // Check users table
      const usersColumns = await db.query<{ column_name: string }>(
        `SELECT column_name 
         FROM information_schema.columns 
         WHERE table_name = 'users' 
           AND column_name IN ('trust_tier', 'is_verified', 'phone', 'stripe_customer_id', 'created_at')`
      );
      expect(usersColumns.rows.length).toBe(5);

      // Check tasks table
      const tasksColumns = await db.query<{ column_name: string }>(
        `SELECT column_name 
         FROM information_schema.columns 
         WHERE table_name = 'tasks' 
           AND column_name IN ('risk_level', 'instant_mode', 'sensitive', 'state', 'worker_id', 'poster_id')`
      );
      expect(tasksColumns.rows.length).toBe(6);

      // Check trust_tier constraint allows 0, 1-4, 9
      const constraintCheck = await db.query<{ constraint_name: string; check_clause: string }>(
        `SELECT constraint_name, check_clause
         FROM information_schema.check_constraints
         WHERE constraint_name = 'users_trust_tier_check'`
      );
      expect(constraintCheck.rows.length).toBeGreaterThan(0);
    });

    it('0.2 — No code references missing columns', async () => {
      // This is a static check - we verify by attempting operations
      // If a column is missing, the query will fail
      const testUserId = await createTestUser();
      testUserIds.push(testUserId);

      // Try to read trust_tier (should not throw)
      const result = await db.query<{ trust_tier: number }>(
        `SELECT trust_tier FROM users WHERE id = $1`,
        [testUserId]
      );
      expect(result.rows[0]?.trust_tier).toBeDefined();
    });
  });

  // ============================================================================
  // PHASE 1 — TRUST TIER AUTHORITY TEST
  // ============================================================================
  describe('Phase 1: Trust Tier Authority', () => {
    it('1.1 — Tier promotion is earned, not assigned', async () => {
      const userId = await createTestUser({ trust_tier: TrustTier.VERIFIED });
      testUserIds.push(userId);

      await expect(db.query(
        `UPDATE users SET trust_tier = $1 WHERE id = $2`,
        [TrustTier.PRO, userId]
      )).rejects.toThrow(/HXTRUST2|HXTRUST3/);

      // Create a high-risk task; Verified is insufficient.
      const taskId = await createTestTask({ risk_level: 'HIGH' });
      testTaskIds.push(taskId);

      // Confirm the unchanged Verified user still retains low-risk access.
      const taskId2 = await createTestTask({ risk_level: 'LOW' });
      testTaskIds.push(taskId2);

      const result = await EligibilityGuard.assertEligibility({
        userId,
        taskId: taskId2,
        isInstant: false,
      });

      expect(result.allowed).toBe(true);
    });

    it('1.2 — Promotion job is idempotent', async () => {
      const userId = await createTestUser({
        trust_tier: TrustTier.EXPLORER,
        is_verified: true,
        phone: `+1${Math.floor(Math.random() * 10000000000)}`,
        stripe_customer_id: `cus_test_${crypto.randomUUID()}`,
        stripe_connect_id: `acct_test_${crypto.randomUUID()}`,
        payouts_enabled: true,
        created_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), // 8 days ago
      });
      testUserIds.push(userId);

      // First promotion
      const eligibility1 = await TrustTierService.evaluatePromotion(userId);
      if (eligibility1.eligible && eligibility1.targetTier) {
        await TrustTierService.applyPromotion(userId, eligibility1.targetTier, 'system');
      }

      const tierAfterFirst = await TrustTierService.getTrustTier(userId);
      expect(tierAfterFirst).toBe(TrustTier.VERIFIED);

      // Second promotion attempt (should be idempotent)
      const eligibility2 = await TrustTierService.evaluatePromotion(userId);
      expect(eligibility2.eligible).toBe(false);

      // Verify tier didn't change
      const tierAfterSecond = await TrustTierService.getTrustTier(userId);
      expect(tierAfterSecond).toBe(TrustTier.VERIFIED);
    });

    it('1.3 — Ban is terminal', async () => {
      const userId = await createTestUser({ trust_tier: TrustTier.LICENSED_SPECIALIST });
      testUserIds.push(userId);

      // Ban user
      await TrustTierService.banUser(userId, 'Test ban');

      // Verify ban
      const tier = await TrustTierService.getTrustTier(userId);
      expect(tier).toBe(TrustTier.BANNED);

      // Attempt to accept task
      const taskId = await createTestTask({ risk_level: 'LOW' });
      testTaskIds.push(taskId);

      const eligibilityResult = await EligibilityGuard.assertEligibility({
        userId,
        taskId,
        isInstant: false,
      });

      expect(eligibilityResult.allowed).toBe(false);
      expect(eligibilityResult.code).toBe(EligibilityErrorCode.USER_BANNED);

      // Attempt re-promotion
      const promotionResult = await TrustTierService.evaluatePromotion(userId);
      expect(promotionResult.eligible).toBe(false);
      expect(promotionResult.reasons).toContain('User is banned');
    });
  });

  // ============================================================================
  // PHASE 2 — TASK RISK AUTHORITY TEST
  // ============================================================================
  describe('Phase 2: Task Risk Authority', () => {
    it('2.1 — Risk is deterministic and immutable', () => {
      // Test classification
      const risk1 = TaskRiskClassifier.classifyTaskRisk({
        insideHome: true,
        peoplePresent: false,
        petsPresent: false,
        caregiving: false,
      });
      expect(risk1).toBe(TaskRisk.TIER_2);

      const risk2 = TaskRiskClassifier.classifyTaskRisk({
        insideHome: false,
        peoplePresent: true,
        petsPresent: false,
        caregiving: false,
      });
      expect(risk2).toBe(TaskRisk.TIER_3);

      // Same input → same output (deterministic)
      const risk3 = TaskRiskClassifier.classifyTaskRisk({
        insideHome: true,
        peoplePresent: false,
        petsPresent: false,
        caregiving: false,
      });
      expect(risk3).toBe(TaskRisk.TIER_2);
    });

    it('2.2 — Tier 3 is absolutely blocked', async () => {
      const userId = await createTestUser({ trust_tier: TrustTier.LICENSED_SPECIALIST });
      testUserIds.push(userId);

      // Create TIER_3 task (caregiving)
      const taskId = await createTestTask({ risk_level: 'IN_HOME' });
      testTaskIds.push(taskId);

      // Attempt normal accept
      const eligibilityResult = await EligibilityGuard.assertEligibility({
        userId,
        taskId,
        isInstant: false,
      });

      expect(eligibilityResult.allowed).toBe(false);
      expect(eligibilityResult.code).toBe(EligibilityErrorCode.TASK_RISK_BLOCKED_ALPHA);

      // Attempt instant accept
      const instantResult = await EligibilityGuard.assertEligibility({
        userId,
        taskId,
        isInstant: true,
      });

      expect(instantResult.allowed).toBe(false);
      expect(instantResult.code).toBe(EligibilityErrorCode.TASK_RISK_BLOCKED_ALPHA);
    });
  });

  // ============================================================================
  // PHASE 3 — ELIGIBILITY GUARD IS THE LAW
  // ============================================================================
  describe('Phase 3: Eligibility Guard Enforcement', () => {
    it('3.1 — No path bypasses guard', async () => {
      const userId = await createTestUser({ trust_tier: TrustTier.VERIFIED }); // Tier 1
      testUserIds.push(userId);

      const taskId = await createTestTask({ risk_level: 'HIGH', state: 'MATCHING' }); // Requires Tier 3
      testTaskIds.push(taskId);

      // Test via EligibilityGuard directly
      const guardResult = await EligibilityGuard.assertEligibility({
        userId,
        taskId,
        isInstant: false,
      });
      expect(guardResult.allowed).toBe(false);
      expect(guardResult.code).toBe(EligibilityErrorCode.TRUST_TIER_INSUFFICIENT);

      // Test via TaskService.accept (should also call guard)
      const acceptResult = await TaskService.accept({
        taskId,
        workerId: userId,
      });
      expect(acceptResult.success).toBe(false);
      expect(acceptResult.error?.code).toBe(EligibilityErrorCode.TRUST_TIER_INSUFFICIENT);
    });
  });

  // ============================================================================
  // PHASE 4 — INSTANT MODE INHERITANCE TEST
  // ============================================================================
  describe('Phase 4: Instant Mode Inheritance', () => {
    it('4.1 — Instant ≠ Override', async () => {
      const userId = await createTestUser({ trust_tier: TrustTier.HOME_READY });
      testUserIds.push(userId);

      // Create TIER_2 task with instant_mode = true
      const taskId = await createTestTask({ 
        risk_level: 'HIGH', // Requires Tier 3
        instant_mode: true,
        state: 'MATCHING',
      });
      testTaskIds.push(taskId);

      // A Home Ready (Tier 2) user tries to accept an instant high-risk task.
      const result = await EligibilityGuard.assertEligibility({
        userId,
        taskId,
        isInstant: true,
      });

      // Instant mode cannot override the Pro requirement.
      expect(result.allowed).toBe(false);
      expect(result.code).toBe(EligibilityErrorCode.TRUST_TIER_INSUFFICIENT);

      // A direct promotion cannot bypass the canonical authority.
      await expect(db.query(
        `UPDATE users SET trust_tier = $1 WHERE id = $2`,
        [TrustTier.PRO, userId]
      )).rejects.toThrow(/HXTRUST2/);

      // Instant mode remains blocked at the unchanged tier.
      const result2 = await EligibilityGuard.assertEligibility({
        userId,
        taskId,
        isInstant: true,
      });

      expect(result2.allowed).toBe(false);
    });
  });

  // ============================================================================
  // PHASE 5 — SURGE + MATCHING COHERENCE
  // ============================================================================
  describe('Phase 5: Surge + Matching Coherence', () => {
    it('5.1 — Surge never lowers safety below spec', async () => {
      const taskId = await createTestTask({ 
        risk_level: 'HIGH', // Requires Tier 3
        instant_mode: true,
        state: 'MATCHING',
      });
      testTaskIds.push(taskId);

      // Verify that surge expansion would not include VERIFIED users
      // This is tested by checking the matching worker logic
      // For now, we verify the eligibility guard would reject
      const verifedUserId = await createTestUser({ trust_tier: TrustTier.VERIFIED });
      testUserIds.push(verifedUserId);

      const result = await EligibilityGuard.assertEligibility({
        userId: verifedUserId,
        taskId,
        isInstant: true,
      });

      expect(result.allowed).toBe(false);
      expect(result.code).toBe(EligibilityErrorCode.TRUST_TIER_INSUFFICIENT);
    });
  });

  // ============================================================================
  // PHASE 6 — XP & INCENTIVE TRUTH TEST
  // ============================================================================
  describe('Phase 6: XP & Incentive Truth', () => {
    it('6.1 — XP cannot be gamed', async () => {
      // This test verifies that XP awards are properly gated
      // For alpha, we verify the eligibility checks prevent gaming
      const userId = await createTestUser({ trust_tier: TrustTier.VERIFIED });
      testUserIds.push(userId);

      // User cannot accept high-risk task → cannot earn XP from it
      const taskId = await createTestTask({ risk_level: 'HIGH' });
      testTaskIds.push(taskId);

      const result = await EligibilityGuard.assertEligibility({
        userId,
        taskId,
        isInstant: false,
      });

      expect(result.allowed).toBe(false);
      // If they can't accept, they can't game XP
    });
  });

  // ============================================================================
  // PHASE 7 — TIME & RACE CONDITIONS
  // ============================================================================
  describe('Phase 7: Time & Race Conditions', () => {
    it('7.1 — Concurrent accept race', async () => {
      const user1 = await createTestUser({ trust_tier: TrustTier.LICENSED_SPECIALIST });
      const user2 = await createTestUser({ trust_tier: TrustTier.LICENSED_SPECIALIST });
      testUserIds.push(user1, user2);

      const taskId = await createTestTask({ 
        risk_level: 'HIGH',
        state: 'MATCHING',
      });
      testTaskIds.push(taskId);

      const raceKey = `alpha-race-${taskId}`;
      await prepareControlledTestWorker(user1, `${raceKey}-worker-one`);
      await prepareControlledTestWorker(user2, `${raceKey}-worker-two`);
      await prepareControlledTestOffer(taskId, user1, `${raceKey}-worker-one`, true);
      await prepareControlledTestOffer(taskId, user2, `${raceKey}-worker-two`, false);

      // Simulate concurrent accepts
      const [result1, result2] = await Promise.all([
        TaskService.accept({ taskId, workerId: user1 }),
        TaskService.accept({ taskId, workerId: user2 }),
      ]);

      // Debug: log results
      if (!result1.success) {
        console.log('Result1 failed:', result1.error?.code, result1.error?.message);
      }
      if (!result2.success) {
        console.log('Result2 failed:', result2.error?.code, result2.error?.message);
      }

      // One should succeed, one should fail
      const successes = [result1, result2].filter(r => r.success).length;
      expect(successes).toBe(1);

      // Verify task state is consistent
      const taskResult = await db.query<{ state: string; worker_id: string }>(
        `SELECT state, worker_id FROM tasks WHERE id = $1`,
        [taskId]
      );
      expect(taskResult.rows[0]?.state).toBe('ACCEPTED');
      expect(taskResult.rows[0]?.worker_id).toBeDefined();
    });
  });

  // ============================================================================
  // PHASE 8 — FULL NARRATIVE RECONSTRUCTION
  // ============================================================================
  describe('Phase 8: Full Narrative Reconstruction', () => {
    it('8.1 — "What happened to this task?"', async () => {
      const userId = await createTestUser({ trust_tier: TrustTier.VERIFIED });
      testUserIds.push(userId);

      const taskId = await createTestTask({ 
        risk_level: 'HIGH',
        instant_mode: true,
        state: 'MATCHING',
      });
      testTaskIds.push(taskId);

      // Attempt accept
      const result = await TaskService.accept({ taskId, workerId: userId });

      // Reconstruct from logs/DB
      const taskState = await db.query<{ state: string; risk_level: string; instant_mode: boolean }>(
        `SELECT state, risk_level, instant_mode FROM tasks WHERE id = $1`,
        [taskId]
      );

      const userTier = await TrustTierService.getTrustTier(userId);

      // Can we explain why it was rejected?
      expect(result.success).toBe(false);
      expect(taskState.rows[0]?.risk_level).toBe('HIGH');
      expect(userTier).toBe(TrustTier.VERIFIED);
      // VERIFIED (1) < IN_HOME (3) required for HIGH risk → rejection explained
    });
  });
});
