/**
 * Trust Tier Alpha Gate Tests
 *
 * PostgreSQL-backed proof for the authoritative 0-4 trust model, terminal ban
 * flag, immutable task risk, and centralized eligibility guard.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { db, hasDb } from '../../src/db';
import { EligibilityErrorCode, EligibilityGuard } from '../../src/services/EligibilityGuard';
import { TaskRisk, TaskRiskClassifier } from '../../src/services/TaskRiskClassifier';
import { TaskService } from '../../src/services/TaskService';
import { TrustTier, TrustTierService } from '../../src/services/TrustTierService';
import { createTestPool, createTestTask as createPolicyTask } from '../setup';

let pool: pg.Pool;

type UserOverrides = {
  trustTier?: TrustTier;
  isBanned?: boolean;
  isVerified?: boolean;
  phone?: string;
  stripeCustomerId?: string;
};

async function createAlphaUser(overrides: UserOverrides = {}): Promise<string> {
  const id = crypto.randomUUID();
  const verified = overrides.isVerified ?? false;
  await db.query(
    `INSERT INTO users (
       id, email, full_name, default_mode, trust_tier, is_banned,
       is_verified, verified_at, phone, stripe_customer_id, created_at
     ) VALUES ($1, $2, 'Test User', 'worker', $3, $4, $5,
               CASE WHEN $5 THEN NOW() ELSE NULL END, $6, $7, NOW())`,
    [
      id,
      `test-alpha-${id}@hustlexp.test`,
      overrides.trustTier ?? TrustTier.EXPLORER,
      overrides.isBanned ?? false,
      verified,
      overrides.phone ?? null,
      overrides.stripeCustomerId ?? null,
    ]
  );
  return id;
}

async function recordProductionIdentityFixture(userId: string): Promise<void> {
  const provider = 'production-test-provider';
  const policyVersion = 'hx-private-identity-production-test-v1';
  const providerCaseId = `idv_production_fixture_${userId.replaceAll('-', '')}`;

  await db.transaction(async (query) => {
    const consent = await query<{ id: string }>(
      `INSERT INTO identity_verification_consents (
         user_id, provider, provider_environment, is_test, policy_version,
         disclosure_hash, purpose, idempotency_key
       ) VALUES (
         $1::uuid, $2, 'PRODUCTION', FALSE, $3, repeat('d', 64),
         'Provider-attested production identity eligibility fixture.',
         'alpha-production-identity-consent-' || $1::uuid::text
       )
       RETURNING id`,
      [userId, provider, policyVersion],
    );

    const identityCase = await query<{ case_id: string }>(
      `SELECT case_id
       FROM begin_identity_verification_case_v1(
         $1::uuid, $2::uuid, $3, $4, 'PRODUCTION', FALSE,
         $5, repeat('e', 64), NOW() + INTERVAL '90 days'
       )`,
      [userId, consent.rows[0].id, provider, providerCaseId, policyVersion],
    );

    await query(
      `SELECT case_status
       FROM record_identity_verification_event_v1(
         $1::uuid, $2::uuid, $3, 'VERIFIED', repeat('f', 64),
         repeat('a', 64), NOW(), NOW() + INTERVAL '90 days', $1::uuid
       )`,
      [userId, identityCase.rows[0].case_id, `identity-verified-${userId}`],
    );
  });
}

async function createAlphaTask(riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME'): Promise<string> {
  const posterId = await createAlphaUser({ trustTier: TrustTier.LICENSED_SPECIALIST });
  await db.query(`UPDATE users SET default_mode = 'poster', plan = 'premium' WHERE id = $1`, [posterId]);
  const result = await TaskService.create({
    posterId,
    title: 'Alpha eligibility task',
    description: 'Controlled invariant fixture',
    price: 5000,
    hustlerPayoutCents: 4000,
    platformMarginCents: 1000,
    regionCode: 'US-ZZ',
    category: 'alpha',
    riskLevel,
    requiresProof: true,
    automationClassification: 'CONTROLLED_TEST',
  });
  if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.data.id;
}

beforeAll(async () => {
  if (!hasDb) return;
  pool = createTestPool();
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
  await pool.query(
    `WITH policy AS (SELECT $1::jsonb AS document)
     INSERT INTO region_policies (
       region_code, version, policy_state, production_enabled, approval_state,
       effective_from, policy_document, policy_hash
     )
     SELECT 'US-ZZ', 'hx-alpha-controlled-v1', 'ACTIVE', FALSE,
            'COUNSEL_APPROVAL_REQUIRED', NOW() - INTERVAL '1 day', document,
            encode(digest(document::text, 'sha256'), 'hex')
     FROM policy
     ON CONFLICT (region_code, version) DO NOTHING`,
    [JSON.stringify(document)]
  );
});

afterAll(async () => {
  if (pool) await pool.end();
});

describe.skipIf(!hasDb)('Trust Tier Alpha Gate Tests', () => {
  describe('TrustTierService', () => {
    it('does not promote an Explorer without verification requirements', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.EXPLORER });
      const eligibility = await TrustTierService.evaluatePromotion(userId);
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.reasons.length).toBeGreaterThan(0);
    });

    it('does not allow skipping tiers', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.VERIFIED });
      await expect(
        TrustTierService.applyPromotion(userId, TrustTier.LICENSED_SPECIALIST, 'system')
      ).rejects.toThrow('preconditions not met');
    });

    it('does not promote a terminally banned user', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.VERIFIED, isBanned: true });
      const eligibility = await TrustTierService.evaluatePromotion(userId);
      expect(eligibility).toEqual({ eligible: false, reasons: ['User is banned'] });
    });

    it('applies Verified to Home Ready once with current production screening and five completions', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.VERIFIED });
      await db.query(
        `WITH consent AS (
           INSERT INTO worker_screening_consents(
             worker_id, provider, disclosure_version, disclosure_hash,
             policy_version, purpose, consent_granted,
             disclosure_presented_standalone, purpose_acknowledged,
             rights_summary_acknowledged, request_hash, idempotency_key
           ) VALUES (
             $1::uuid, 'production-test-provider', 'hx-worker-screening-rights-v1',
             '61d054648dabd5b3533337363e87f2a8c628c60878aff6c25f4d2a1fbf88df4f',
             'hx-alpha-controlled-v1', 'Trust-tier promotion eligibility proof',
             TRUE, TRUE, TRUE, TRUE, repeat('a', 64),
             'alpha-screening-consent-' || $1::uuid::text
           )
           RETURNING id
         )
         INSERT INTO background_checks(
           user_id, provider, status, provider_environment, is_test,
           screening_consent_id, initiated_at, expires_at
         )
         SELECT $1::uuid, 'production-test-provider', 'CLEAR', 'PRODUCTION', FALSE,
                id, NOW(), NOW() + INTERVAL '1 year'
         FROM consent`,
        [userId],
      );
      await recordProductionIdentityFixture(userId);
      const posterId = await createAlphaUser({ trustTier: TrustTier.LICENSED_SPECIALIST });
      await db.query(`UPDATE users SET default_mode = 'poster' WHERE id = $1`, [posterId]);
      for (let index = 0; index < 5; index += 1) {
        await createPolicyTask(pool, {
          posterId,
          workerId: userId,
          state: 'COMPLETED',
          automationClassification: 'PRODUCTION',
          productionPolicyFixture: 'GOVERNED_ISOLATED',
        });
      }

      const eligibility = await TrustTierService.evaluatePromotion(userId);
      expect(eligibility).toEqual({ eligible: true, targetTier: TrustTier.HOME_READY, reasons: [] });
      await TrustTierService.applyPromotion(userId, TrustTier.HOME_READY, 'system');
      await expect(
        TrustTierService.applyPromotion(userId, TrustTier.HOME_READY, 'system')
      ).rejects.toThrow('Cannot promote');

      expect(await TrustTierService.getTrustTier(userId)).toBe(TrustTier.HOME_READY);
      const ledger = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM trust_ledger
         WHERE user_id=$1 AND old_tier=1 AND new_tier=2
           AND reason_details->>'policyVersion'='hustler-trust-progression-v1'`,
        [userId]
      );
      expect(Number(ledger.rows[0].count)).toBe(1);
    });
  });

  describe('Task Risk Classification', () => {
    it('classifies inside-home work as TIER_2', () => {
      expect(TaskRiskClassifier.classifyTaskRisk({
        insideHome: true, peoplePresent: false, petsPresent: false, caregiving: false,
      })).toBe(TaskRisk.TIER_2);
    });

    it('classifies people, pets, or caregiving as TIER_3', () => {
      expect(TaskRiskClassifier.classifyTaskRisk({
        insideHome: false, peoplePresent: true, petsPresent: false, caregiving: false,
      })).toBe(TaskRisk.TIER_3);
      expect(TaskRiskClassifier.classifyTaskRisk({
        insideHome: false, peoplePresent: false, petsPresent: true, caregiving: false,
      })).toBe(TaskRisk.TIER_3);
      expect(TaskRiskClassifier.classifyTaskRisk({
        insideHome: false, peoplePresent: false, petsPresent: false, caregiving: true,
      })).toBe(TaskRisk.TIER_3);
    });

    it('rejects risk-level mutation after creation', async () => {
      const taskId = await createAlphaTask('LOW');
      await expect(
        db.query(`UPDATE tasks SET risk_level = 'HIGH' WHERE id = $1`, [taskId])
      ).rejects.toThrow();
      const task = await db.query<{ risk_level: string }>(
        `SELECT risk_level FROM tasks WHERE id = $1`, [taskId]
      );
      expect(task.rows[0].risk_level).toBe('LOW');
    });
  });

  describe('EligibilityGuard', () => {
    it('rejects when tier is below the HIGH-risk requirement', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.VERIFIED });
      const taskId = await createAlphaTask('HIGH');
      const result = await EligibilityGuard.assertEligibility({ userId, taskId, isInstant: false });
      expect(result).toMatchObject({ allowed: false, code: EligibilityErrorCode.TRUST_TIER_INSUFFICIENT });
    });

    it('allows Pro users on HIGH-risk tasks', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.PRO });
      const taskId = await createAlphaTask('HIGH');
      expect(await EligibilityGuard.assertEligibility({ userId, taskId, isInstant: false }))
        .toEqual({ allowed: true });
    });

    it('blocks IN_HOME tasks during alpha even for Licensed Specialist users', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.LICENSED_SPECIALIST });
      const taskId = await createAlphaTask('IN_HOME');
      const result = await EligibilityGuard.assertEligibility({ userId, taskId, isInstant: false });
      expect(result).toMatchObject({ allowed: false, code: EligibilityErrorCode.TASK_RISK_BLOCKED_ALPHA });
    });

    it('does not let Instant Mode bypass the HIGH-risk tier gate', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.VERIFIED });
      const taskId = await createAlphaTask('HIGH');
      const result = await EligibilityGuard.assertEligibility({ userId, taskId, isInstant: true });
      expect(result).toMatchObject({ allowed: false, code: EligibilityErrorCode.TRUST_TIER_INSUFFICIENT });
    });

    it('rejects users whose terminal ban flag is set', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.LICENSED_SPECIALIST, isBanned: true });
      const taskId = await createAlphaTask('LOW');
      const result = await EligibilityGuard.assertEligibility({ userId, taskId, isInstant: false });
      expect(result).toMatchObject({ allowed: false, code: EligibilityErrorCode.USER_BANNED });
    });
  });

  describe('Adversarial database constraints', () => {
    it('rejects an out-of-range tier below Explorer', async () => {
      const userId = await createAlphaUser();
      await expect(db.query(`UPDATE users SET trust_tier = -1 WHERE id = $1`, [userId]))
        .rejects.toThrow();
    });

    it('rejects a sentinel tier and requires the separate ban flag', async () => {
      const userId = await createAlphaUser({ trustTier: TrustTier.LICENSED_SPECIALIST });
      await expect(db.query(`UPDATE users SET trust_tier = 9 WHERE id = $1`, [userId]))
        .rejects.toThrow();
      await db.query(`UPDATE users SET is_banned = TRUE WHERE id = $1`, [userId]);
      expect(await TrustTierService.getTrustTier(userId)).toBe(TrustTier.BANNED);
    });
  });
});
