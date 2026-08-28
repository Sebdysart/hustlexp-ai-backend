import { db } from '../db.js';
import { logger } from '../logger.js';
import type { ServiceResult } from '../types.js';
import {
  buildPublicReputation,
  preparePublicRecommendation,
  type CredentialStatus,
  type PublicProviderReputation,
  type ReputationSourceRow,
} from './MarketplaceReputationPolicy.js';

const log = logger.child({ service: 'MarketplaceReputationService' });

type Relationship = 'NEIGHBOR' | 'CUSTOMER' | 'COMMUNITY_MEMBER';
type ModerationDecision = 'PUBLISHED' | 'REJECTED' | 'REMOVED';

interface ReputationViewRow {
  provider_user_id: string;
  category: string;
  region_code: string;
  verified_assignments: string | number;
  verified_completions: string | number;
  completion_rate: string | number | null;
  cancellation_rate: string | number | null;
  proof_completeness_rate: string | number | null;
  dispute_rate: string | number | null;
  repeat_customer_count: string | number;
  transaction_review_count: string | number;
  weighted_overall_rating: string | number | null;
  communication: string | number | null;
  scope_accuracy: string | number | null;
  punctuality: string | number | null;
  care: string | number | null;
  result_quality: string | number | null;
  value: string | number | null;
  nearby_recommendation_count: string | number;
  confirmed_risk_flags: string | number;
  license_status: CredentialStatus | null;
  insurance_status: CredentialStatus | null;
  background_check_status: CredentialStatus | null;
}

export interface SubmitLocalRecommendationParams {
  recommenderId: string;
  providerUserId: string;
  category: string;
  regionCode: string;
  body: string;
  relationship: Relationship;
  idempotencyKey: string;
}

interface LocalRecommendationRow {
  id: string;
  recommender_id?: string;
  provider_user_id?: string;
  category?: string;
  region_code?: string;
  body?: string;
  relationship?: Relationship;
  idempotency_key?: string;
  state: string;
  collusion_hold: boolean;
}

function failure<T>(code: string, message: string): ServiceResult<T> {
  return { success: false, error: { code, message } };
}

function integer(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function decimal(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function viewSource(row: ReputationViewRow): ReputationSourceRow {
  return {
    providerUserId: row.provider_user_id,
    category: row.category,
    regionCode: row.region_code,
    verifiedAssignments: integer(row.verified_assignments),
    verifiedCompletions: integer(row.verified_completions),
    completionRate: decimal(row.completion_rate),
    cancellationRate: decimal(row.cancellation_rate),
    proofCompletenessRate: decimal(row.proof_completeness_rate),
    disputeRate: decimal(row.dispute_rate),
    repeatCustomerCount: integer(row.repeat_customer_count),
    transactionReviewCount: integer(row.transaction_review_count),
    weightedOverallRating: decimal(row.weighted_overall_rating),
    communication: decimal(row.communication),
    scopeAccuracy: decimal(row.scope_accuracy),
    punctuality: decimal(row.punctuality),
    care: decimal(row.care),
    resultQuality: decimal(row.result_quality),
    value: decimal(row.value),
    nearbyRecommendationCount: integer(row.nearby_recommendation_count),
    confirmedRiskFlags: integer(row.confirmed_risk_flags),
    licenseStatus: row.license_status ?? 'UNVERIFIED',
    insuranceStatus: row.insurance_status ?? 'UNVERIFIED',
    backgroundCheckStatus: row.background_check_status ?? 'UNVERIFIED',
  };
}

function emptySource(providerUserId: string, category: string, regionCode: string): ReputationSourceRow {
  return {
    providerUserId, category, regionCode, verifiedAssignments: 0, verifiedCompletions: 0,
    completionRate: null, cancellationRate: null, proofCompletenessRate: null,
    disputeRate: null, repeatCustomerCount: 0, transactionReviewCount: 0,
    weightedOverallRating: null, communication: null, scopeAccuracy: null,
    punctuality: null, care: null, resultQuality: null, value: null,
    nearbyRecommendationCount: 0, confirmedRiskFlags: 0,
    licenseStatus: 'UNVERIFIED', insuranceStatus: 'UNVERIFIED', backgroundCheckStatus: 'UNVERIFIED',
  };
}

function sameIdempotentPayload(row: LocalRecommendationRow, params: SubmitLocalRecommendationParams, body: string): boolean {
  return row.recommender_id === params.recommenderId
    && row.provider_user_id === params.providerUserId
    && row.category === params.category
    && row.region_code === params.regionCode
    && row.body === body
    && row.relationship === params.relationship;
}

export const MarketplaceReputationService = {
  getPublicSummary: async (
    providerUserId: string,
    category: string,
    regionCode: string,
  ): Promise<ServiceResult<PublicProviderReputation>> => {
    try {
      const result = await db.query<ReputationViewRow>(
        `SELECT * FROM provider_reputation_public
         WHERE provider_user_id = $1 AND category = $2 AND region_code = $3`,
        [providerUserId, category, regionCode],
      );
      return {
        success: true,
        data: buildPublicReputation(result.rows[0]
          ? viewSource(result.rows[0])
          : emptySource(providerUserId, category, regionCode)),
      };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Public reputation read failed');
      return failure('DB_ERROR', 'Could not load verified reputation safely.');
    }
  },

  submitLocalRecommendation: async (
    params: SubmitLocalRecommendationParams,
  ): Promise<ServiceResult<LocalRecommendationRow>> => {
    try {
      if (params.recommenderId === params.providerUserId) {
        return failure('FORBIDDEN', 'A provider cannot recommend themselves.');
      }
      const body = preparePublicRecommendation(params.body);
      return await db.transaction(async (query) => {
        await query('SELECT pg_advisory_xact_lock(hashtext($1))', [
          `local-recommendation:${params.recommenderId}:${params.idempotencyKey}`,
        ]);
        const existing = await query<LocalRecommendationRow>(
          `SELECT * FROM local_provider_recommendations
           WHERE recommender_id = $1 AND idempotency_key = $2`,
          [params.recommenderId, params.idempotencyKey],
        );
        if (existing.rows[0]) {
          return sameIdempotentPayload(existing.rows[0], params, body)
            ? { success: true, data: existing.rows[0] }
            : failure('IDEMPOTENCY_CONFLICT', 'This recommendation key was already used for different content.');
        }

        const membership = await query<{ region_code: string }>(
          `SELECT region_code FROM verified_region_memberships
           WHERE user_id = $1 AND region_code = $2 AND state = 'ACTIVE'
             AND (expires_at IS NULL OR expires_at > NOW())`,
          [params.recommenderId, params.regionCode],
        );
        if (!membership.rows[0]) {
          return failure('LOCALITY_NOT_VERIFIED', 'An active verified-local membership is required.');
        }

        const reciprocal = await query<{ id: string }>(
          `SELECT id FROM local_provider_recommendations
           WHERE recommender_id = $1 AND provider_user_id = $2
             AND category = $3 AND region_code = $4
             AND state IN ('PUBLISHED', 'PENDING_MODERATION', 'HELD_FOR_REVIEW')
           LIMIT 1`,
          [params.providerUserId, params.recommenderId, params.category, params.regionCode],
        );
        const collusionHold = reciprocal.rows.length > 0;
        const state = collusionHold ? 'HELD_FOR_REVIEW' : 'PENDING_MODERATION';
        const inserted = await query<LocalRecommendationRow>(
          `INSERT INTO local_provider_recommendations (
             recommender_id, provider_user_id, category, region_code, body,
             relationship, idempotency_key, state, collusion_hold
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING *`,
          [
            params.recommenderId, params.providerUserId, params.category, params.regionCode,
            body, params.relationship, params.idempotencyKey, state, collusionHold,
          ],
        );
        if (collusionHold) {
          await query(
            `INSERT INTO reputation_signal_flags (
               provider_user_id, related_user_id, category, region_code, signal_type,
               source_id, reason_code, evidence, status
             ) VALUES ($1,$2,$3,$4,'LOCAL_RECOMMENDATION',$5,'RECIPROCAL_RECOMMENDATION',$6::jsonb,'OPEN')
             ON CONFLICT (signal_type, source_id, reason_code) DO NOTHING
             RETURNING id`,
            [
              params.providerUserId, params.recommenderId, params.category, params.regionCode,
              inserted.rows[0].id,
              JSON.stringify({ reciprocalRecommendationId: reciprocal.rows[0].id }),
            ],
          );
        }
        return { success: true, data: inserted.rows[0] };
      });
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Local recommendation write failed');
      return failure('DB_ERROR', 'Could not record this recommendation safely.');
    }
  },

  appealSignal: async (params: {
    signalId: string;
    providerUserId: string;
    reason: string;
  }): Promise<ServiceResult<{ id: string; status: string }>> => {
    try {
      const signal = await db.query<{ id: string; provider_user_id: string; status: string }>(
        `SELECT id, provider_user_id, status FROM reputation_signal_flags WHERE id = $1`,
        [params.signalId],
      );
      if (!signal.rows[0]) return failure('NOT_FOUND', 'Reputation signal not found.');
      if (signal.rows[0].provider_user_id !== params.providerUserId) {
        return failure('FORBIDDEN', 'Only the affected provider can appeal this signal.');
      }
      if (!['OPEN', 'CONFIRMED'].includes(signal.rows[0].status)) {
        return failure('INVALID_STATE', 'This signal is not appealable.');
      }
      const appeal = await db.query<{ id: string; status: string }>(
        `INSERT INTO reputation_signal_appeals (signal_id, provider_user_id, reason)
         VALUES ($1,$2,$3) RETURNING id, status`,
        [params.signalId, params.providerUserId, params.reason.trim()],
      );
      return { success: true, data: appeal.rows[0] };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Reputation appeal failed');
      return failure('DB_ERROR', 'Could not submit this appeal safely.');
    }
  },

  verifyRegionMembership: async (params: {
    userId: string;
    regionCode: string;
    verificationMethod: 'ADDRESS_PROVIDER' | 'DOCUMENT_REVIEW';
    verificationRefHash: string;
    verifiedBy: string;
    expiresAt?: string;
  }): Promise<ServiceResult<{ user_id: string; region_code: string; state: string }>> => {
    try {
      const result = await db.query<{ user_id: string; region_code: string; state: string }>(
        `INSERT INTO verified_region_memberships (
           user_id, region_code, verification_method, verification_ref_hash, verified_by, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (user_id, region_code) DO UPDATE SET
           verification_method = EXCLUDED.verification_method,
           verification_ref_hash = EXCLUDED.verification_ref_hash,
           verified_by = EXCLUDED.verified_by,
           verified_at = NOW(), expires_at = EXCLUDED.expires_at, state = 'ACTIVE'
         RETURNING user_id, region_code, state`,
        [
          params.userId, params.regionCode, params.verificationMethod,
          params.verificationRefHash, params.verifiedBy, params.expiresAt ?? null,
        ],
      );
      return { success: true, data: result.rows[0] };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Region membership verification failed');
      return failure('DB_ERROR', 'Could not verify regional membership.');
    }
  },

  moderateRecommendation: async (params: {
    recommendationId: string;
    moderatorId: string;
    decision: ModerationDecision;
    reason: string;
  }): Promise<ServiceResult<LocalRecommendationRow>> => {
    try {
      const result = await db.query<LocalRecommendationRow>(
        `UPDATE local_provider_recommendations
         SET state = $2, moderated_by = $3, moderation_reason = $4, moderated_at = NOW()
         WHERE id = $1
           AND (($2 IN ('PUBLISHED','REJECTED') AND state IN ('PENDING_MODERATION','HELD_FOR_REVIEW'))
             OR ($2 = 'REMOVED' AND state = 'PUBLISHED'))
         RETURNING *`,
        [params.recommendationId, params.decision, params.moderatorId, params.reason.trim()],
      );
      return result.rows[0]
        ? { success: true, data: result.rows[0] }
        : failure('INVALID_STATE', 'Recommendation cannot make that moderation transition.');
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Recommendation moderation failed');
      return failure('DB_ERROR', 'Could not moderate this recommendation.');
    }
  },

  resolveAppeal: async (params: {
    appealId: string;
    reviewerId: string;
    decision: 'UPHELD' | 'OVERTURNED';
    reason: string;
  }): Promise<ServiceResult<{ id: string; status: string }>> => {
    try {
      const result = await db.transaction(async (query) => {
        const appeal = await query<{ id: string; signal_id: string; status: string }>(
          `SELECT id, signal_id, status FROM reputation_signal_appeals WHERE id = $1 FOR UPDATE`,
          [params.appealId],
        );
        if (!appeal.rows[0] || appeal.rows[0].status !== 'PENDING') {
          return failure<{ id: string; status: string }>('INVALID_STATE', 'Appeal is not pending.');
        }
        const updated = await query<{ id: string; status: string }>(
          `UPDATE reputation_signal_appeals SET status = $2, reviewed_by = $3,
             review_reason = $4, reviewed_at = NOW() WHERE id = $1 RETURNING id, status`,
          [params.appealId, params.decision, params.reviewerId, params.reason.trim()],
        );
        if (params.decision === 'OVERTURNED') {
          await query(
            `UPDATE reputation_signal_flags SET status = 'DISMISSED', reviewed_by = $2,
               review_reason = $3, reviewed_at = NOW() WHERE id = $1`,
            [appeal.rows[0].signal_id, params.reviewerId, params.reason.trim()],
          );
        }
        return { success: true, data: updated.rows[0] } as ServiceResult<{ id: string; status: string }>;
      });
      return result;
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Reputation appeal review failed');
      return failure('DB_ERROR', 'Could not resolve this appeal.');
    }
  },
};
