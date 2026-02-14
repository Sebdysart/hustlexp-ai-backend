/**
 * ReputationAIService v1.0.0
 *
 * CONSTITUTIONAL: Authority Level A2 (Proposal-Only)
 *
 * Dynamic trust scoring that goes beyond simple averages. Analyzes user behavior
 * patterns, rating trajectories, dispute history, and completion rates to produce
 * composite trust scores and anomaly detection.
 *
 * AI methods use AIClient 'fast' route for low-latency scoring.
 * shouldPromoteTier is fully deterministic (no AI).
 *
 * @see PRODUCT_SPEC.md §8.2 (Trust Tiers)
 * @see AI_INFRASTRUCTURE.md §6 (A2 Authority)
 * @see schema.sql (ai_agent_decisions, task_ratings, disputes)
 */

import { db } from '../db';
import type { ServiceResult } from '../types';
import { AIClient } from './AIClient';

// ============================================================================
// TYPES
// ============================================================================

export interface TrustScoreResult {
  trust_score: number;       // 0-100 composite score
  trend: 'improving' | 'stable' | 'declining';
  risk_factors: string[];    // e.g., "3 disputes in 7 days"
  strengths: string[];       // e.g., "100% completion rate"
  recommended_tier: number;  // 1-4 suggested trust tier
  tier_change_reason?: string;
}

export interface AnomalyResult {
  anomalies: Array<{
    type: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
    evidence: string;
  }>;
}

export interface UserInsightResult {
  summary: string; // 3-sentence summary
}

export interface TierPromotionResult {
  eligible: boolean;
  currentTier: number;
  nextTier: number;
  blockers: string[];
}

// Internal type for user profile data retrieved from DB
interface UserProfile {
  id: string;
  trust_tier: number;
  xp_total: number;
  current_streak: number;
  is_verified: boolean;
  account_status: string;
  created_at: Date;
}

// Internal type for aggregated rating data from the view
interface RatingSummary {
  user_id: string;
  total_ratings: string;
  avg_rating: string | null;
  five_star_count: string;
  four_star_count: string;
  three_star_count: string;
  two_star_count: string;
  one_star_count: string;
}

// Internal type for task stats
interface TaskStats {
  total_completed: string;
  total_cancelled: string;
  total_tasks: string;
  avg_completion_hours: string | null;
}

// Internal type for dispute stats
interface DisputeStats {
  total_disputes: string;
  open_disputes: string;
  recent_disputes: string;
}

// Internal type for recent rating rows
interface RecentRating {
  stars: number;
  created_at: Date;
}

// ============================================================================
// TIER PROMOTION THRESHOLDS (Deterministic)
// ============================================================================

const TIER_THRESHOLDS = {
  // Tier 1 -> 2: 3 tasks completed, 4.0+ rating, no disputes
  2: { minTasks: 3, minRating: 4.0, noDisputes: true, identityVerified: false },
  // Tier 2 -> 3: 10 tasks, 4.3+ rating, no active disputes, identity verified
  3: { minTasks: 10, minRating: 4.3, noDisputes: true, identityVerified: true },
  // Tier 3 -> 4: 25 tasks, 4.5+ rating, background check passed (is_verified)
  4: { minTasks: 25, minRating: 4.5, noDisputes: false, identityVerified: true },
} as const;

// The spec mentions tier 0->1, but schema uses tier 1-4. The first tier (1)
// is the starting tier. We map the spec's "0->1" as the initial promotion
// from a new user state (handled separately at onboarding).

// ============================================================================
// SERVICE
// ============================================================================

export const ReputationAIService = {
  // --------------------------------------------------------------------------
  // 1. calculateTrustScore — AI-powered composite scoring
  // --------------------------------------------------------------------------

  /**
   * Calculate a comprehensive trust score for a user.
   * Reads user profile, task history, ratings, disputes, and fraud data.
   * Uses AIClient 'fast' route for scoring with temperature 0.1.
   */
  calculateTrustScore: async (userId: string): Promise<ServiceResult<TrustScoreResult>> => {
    try {
      // Gather all data in parallel
      const [userResult, ratingsResult, taskStatsResult, disputeStatsResult, recentRatingsResult] =
        await Promise.all([
          db.query<UserProfile>(
            'SELECT id, trust_tier, xp_total, current_streak, is_verified, account_status, created_at FROM users WHERE id = $1',
            [userId]
          ),
          db.query<RatingSummary>(
            'SELECT * FROM user_rating_summary WHERE user_id = $1',
            [userId]
          ),
          db.query<TaskStats>(
            `SELECT
               COUNT(*) FILTER (WHERE state = 'COMPLETED') AS total_completed,
               COUNT(*) FILTER (WHERE state = 'CANCELLED') AS total_cancelled,
               COUNT(*) AS total_tasks,
               AVG(EXTRACT(EPOCH FROM (completed_at - accepted_at)) / 3600) FILTER (WHERE state = 'COMPLETED' AND completed_at IS NOT NULL AND accepted_at IS NOT NULL) AS avg_completion_hours
             FROM tasks
             WHERE worker_id = $1 OR poster_id = $1`,
            [userId]
          ),
          db.query<DisputeStats>(
            `SELECT
               COUNT(*) AS total_disputes,
               COUNT(*) FILTER (WHERE state IN ('OPEN', 'EVIDENCE_REQUESTED')) AS open_disputes,
               COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS recent_disputes
             FROM disputes
             WHERE initiated_by = $1 OR poster_id = $1 OR worker_id = $1`,
            [userId]
          ),
          db.query<RecentRating>(
            `SELECT stars, created_at
             FROM task_ratings
             WHERE ratee_id = $1
             ORDER BY created_at DESC
             LIMIT 20`,
            [userId]
          ),
        ]);

      if (userResult.rows.length === 0) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `User ${userId} not found` },
        };
      }

      const user = userResult.rows[0];
      const ratings = ratingsResult.rows[0] || null;
      const taskStats = taskStatsResult.rows[0];
      const disputeStats = disputeStatsResult.rows[0];
      const recentRatings = recentRatingsResult.rows;

      const avgRating = ratings?.avg_rating ? parseFloat(ratings.avg_rating) : 0;
      const totalRatings = ratings ? parseInt(ratings.total_ratings, 10) : 0;
      const totalCompleted = parseInt(taskStats.total_completed, 10);
      const totalCancelled = parseInt(taskStats.total_cancelled, 10);
      const totalTasks = parseInt(taskStats.total_tasks, 10);
      const totalDisputes = parseInt(disputeStats.total_disputes, 10);
      const openDisputes = parseInt(disputeStats.open_disputes, 10);
      const recentDisputes = parseInt(disputeStats.recent_disputes, 10);

      const completionRate = totalTasks > 0 ? totalCompleted / totalTasks : 0;
      const disputeRatio = totalCompleted > 0 ? totalDisputes / totalCompleted : 0;

      // Compute rating trend from recent ratings
      let trend: 'improving' | 'stable' | 'declining' = 'stable';
      if (recentRatings.length >= 6) {
        const recentHalf = recentRatings.slice(0, Math.floor(recentRatings.length / 2));
        const olderHalf = recentRatings.slice(Math.floor(recentRatings.length / 2));
        const recentAvg = recentHalf.reduce((s, r) => s + r.stars, 0) / recentHalf.length;
        const olderAvg = olderHalf.reduce((s, r) => s + r.stars, 0) / olderHalf.length;
        if (recentAvg - olderAvg > 0.3) trend = 'improving';
        else if (olderAvg - recentAvg > 0.3) trend = 'declining';
      }

      // Build context for AI scoring
      const context = {
        trust_tier: user.trust_tier,
        xp_total: user.xp_total,
        streak: user.current_streak,
        is_verified: user.is_verified,
        account_status: user.account_status,
        account_age_days: Math.floor(
          (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24)
        ),
        avg_rating: avgRating,
        total_ratings: totalRatings,
        total_completed: totalCompleted,
        total_cancelled: totalCancelled,
        completion_rate: Math.round(completionRate * 100),
        total_disputes: totalDisputes,
        open_disputes: openDisputes,
        recent_disputes_7d: recentDisputes,
        dispute_ratio: Math.round(disputeRatio * 100),
        rating_trend: trend,
        avg_completion_hours: taskStats.avg_completion_hours
          ? parseFloat(taskStats.avg_completion_hours).toFixed(1)
          : null,
      };

      // Attempt AI-powered scoring
      let trustScore: TrustScoreResult;

      if (AIClient.isConfigured()) {
        try {
          const aiResult = await AIClient.callJSON<TrustScoreResult>({
            route: 'fast',
            temperature: 0.1,
            timeoutMs: 10000,
            systemPrompt: `You are HustleXP's Reputation Agent (A2 authority - proposal only).
Analyze user behavior data and produce a composite trust score.
Your proposals are validated by deterministic constitutional rules - you cannot override them.

Return JSON with EXACTLY these fields:
- trust_score: number (0-100, composite trust score)
- trend: "improving" | "stable" | "declining"
- risk_factors: string[] (list specific concerns, e.g., "3 disputes in 7 days")
- strengths: string[] (list positive patterns, e.g., "100% completion rate")
- recommended_tier: number (1-4 suggested trust tier)
- tier_change_reason: string (optional, only if recommending a tier different from current)

SCORING GUIDELINES:
- Base score from avg_rating (0-50 points): (avg_rating / 5) * 50
- Completion rate bonus (0-20 points): completion_rate * 20
- Consistency bonus (0-15 points): based on streak, account age, volume
- Risk deductions: -5 per open dispute, -10 if dispute_ratio > 20%, -15 if declining trend
- Verification bonus: +5 if verified, +5 if account_age > 180 days`,
            prompt: `Analyze this user and calculate trust score:\n\n${JSON.stringify(context, null, 2)}`,
          });

          trustScore = aiResult.data;

          // Ensure trust_score is bounded
          trustScore.trust_score = Math.max(0, Math.min(100, trustScore.trust_score));
          // Ensure recommended_tier is 1-4
          trustScore.recommended_tier = Math.max(1, Math.min(4, trustScore.recommended_tier));
          // Override trend with our deterministic computation
          trustScore.trend = trend;

          console.log(
            `[ReputationAI] AI trust score: ${trustScore.trust_score}/100, tier=${trustScore.recommended_tier} (via ${aiResult.provider})`
          );
        } catch (aiError) {
          console.warn('[ReputationAI] AI call failed, using heuristic fallback:', aiError);
          trustScore = ReputationAIService._heuristicTrustScore(context, trend);
        }
      } else {
        trustScore = ReputationAIService._heuristicTrustScore(context, trend);
      }

      // Log to ai_agent_decisions
      await ReputationAIService._logDecision(
        userId,
        'trust_score',
        { ...trustScore },
        trustScore.trust_score / 100,
        `Trust score ${trustScore.trust_score}/100, trend=${trustScore.trend}, recommended_tier=${trustScore.recommended_tier}`
      );

      return { success: true, data: trustScore };
    } catch (error) {
      console.error('[ReputationAIService.calculateTrustScore] Error:', error);
      return {
        success: false,
        error: {
          code: 'TRUST_SCORE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to calculate trust score',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // 2. detectAnomalies — Identify suspicious behavior patterns
  // --------------------------------------------------------------------------

  /**
   * Detect anomalous behavior patterns for a user.
   * Checks: unusual rating patterns, rapid volume changes, frequent cancellations,
   * self-dealing detection (same poster/worker pairs).
   */
  detectAnomalies: async (userId: string): Promise<ServiceResult<AnomalyResult>> => {
    try {
      // Check user exists
      const userCheck = await db.query<{ id: string }>(
        'SELECT id FROM users WHERE id = $1',
        [userId]
      );
      if (userCheck.rows.length === 0) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `User ${userId} not found` },
        };
      }

      const anomalies: AnomalyResult['anomalies'] = [];

      // Check 1: Unusual rating patterns (only 5s or only 1s received)
      const ratingDistribution = await db.query<{
        stars: number;
        count: string;
      }>(
        `SELECT stars, COUNT(*) AS count
         FROM task_ratings
         WHERE ratee_id = $1
         GROUP BY stars
         ORDER BY stars`,
        [userId]
      );

      if (ratingDistribution.rows.length > 0) {
        const totalReceived = ratingDistribution.rows.reduce(
          (s, r) => s + parseInt(r.count, 10),
          0
        );
        if (totalReceived >= 5) {
          const fiveStars = ratingDistribution.rows.find((r) => r.stars === 5);
          const oneStars = ratingDistribution.rows.find((r) => r.stars === 1);
          const fiveCount = fiveStars ? parseInt(fiveStars.count, 10) : 0;
          const oneCount = oneStars ? parseInt(oneStars.count, 10) : 0;

          if (fiveCount / totalReceived > 0.95) {
            anomalies.push({
              type: 'suspicious_rating_pattern',
              severity: 'medium',
              description: 'User receives almost exclusively 5-star ratings',
              evidence: `${fiveCount}/${totalReceived} ratings are 5 stars (${Math.round(
                (fiveCount / totalReceived) * 100
              )}%)`,
            });
          }

          if (oneCount / totalReceived > 0.5) {
            anomalies.push({
              type: 'suspicious_rating_pattern',
              severity: 'high',
              description: 'User receives majority 1-star ratings',
              evidence: `${oneCount}/${totalReceived} ratings are 1 star (${Math.round(
                (oneCount / totalReceived) * 100
              )}%)`,
            });
          }
        }
      }

      // Check 2: Rapid task volume changes (compare last 7 days vs prior 7 days)
      const volumeCheck = await db.query<{
        recent_count: string;
        prior_count: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days') AS recent_count,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '14 days' AND created_at <= NOW() - INTERVAL '7 days') AS prior_count
         FROM tasks
         WHERE worker_id = $1`,
        [userId]
      );

      if (volumeCheck.rows.length > 0) {
        const recent = parseInt(volumeCheck.rows[0].recent_count, 10);
        const prior = parseInt(volumeCheck.rows[0].prior_count, 10);
        if (prior > 0 && recent > prior * 3) {
          anomalies.push({
            type: 'rapid_volume_change',
            severity: 'medium',
            description: 'Task volume increased dramatically in the last 7 days',
            evidence: `${recent} tasks in last 7 days vs ${prior} in prior 7 days (${Math.round(
              (recent / prior) * 100
            )}% increase)`,
          });
        }
      }

      // Check 3: Frequent cancellations in specific time windows
      const cancellationCheck = await db.query<{
        cancel_count: string;
        total_count: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE state = 'CANCELLED') AS cancel_count,
           COUNT(*) AS total_count
         FROM tasks
         WHERE worker_id = $1 AND created_at > NOW() - INTERVAL '14 days'`,
        [userId]
      );

      if (cancellationCheck.rows.length > 0) {
        const cancels = parseInt(cancellationCheck.rows[0].cancel_count, 10);
        const total = parseInt(cancellationCheck.rows[0].total_count, 10);
        if (total >= 3 && cancels / total > 0.4) {
          anomalies.push({
            type: 'high_cancellation_rate',
            severity: 'high',
            description: 'High cancellation rate in the last 14 days',
            evidence: `${cancels}/${total} tasks cancelled (${Math.round(
              (cancels / total) * 100
            )}%) in last 14 days`,
          });
        }
      }

      // Check 4: Self-dealing detection (same poster/worker pairs)
      const selfDealingCheck = await db.query<{
        partner_id: string;
        pair_count: string;
      }>(
        `SELECT
           CASE WHEN worker_id = $1 THEN poster_id ELSE worker_id END AS partner_id,
           COUNT(*) AS pair_count
         FROM tasks
         WHERE (worker_id = $1 OR poster_id = $1)
           AND state = 'COMPLETED'
           AND worker_id IS NOT NULL
         GROUP BY partner_id
         HAVING COUNT(*) >= 5
         ORDER BY pair_count DESC
         LIMIT 5`,
        [userId]
      );

      for (const row of selfDealingCheck.rows) {
        const pairCount = parseInt(row.pair_count, 10);
        if (pairCount >= 10) {
          anomalies.push({
            type: 'self_dealing',
            severity: 'critical',
            description: 'Unusually high task frequency with same partner',
            evidence: `${pairCount} completed tasks with partner ${row.partner_id}`,
          });
        } else if (pairCount >= 5) {
          anomalies.push({
            type: 'self_dealing',
            severity: 'medium',
            description: 'Repeated task pairing with same partner',
            evidence: `${pairCount} completed tasks with partner ${row.partner_id}`,
          });
        }
      }

      // Log to ai_agent_decisions
      await ReputationAIService._logDecision(
        userId,
        'anomaly_detection',
        { anomaly_count: anomalies.length, anomalies },
        anomalies.length === 0 ? 1.0 : Math.max(0.1, 1.0 - anomalies.length * 0.15),
        anomalies.length === 0
          ? 'No anomalies detected'
          : `${anomalies.length} anomalies detected: ${anomalies.map((a) => a.type).join(', ')}`
      );

      return { success: true, data: { anomalies } };
    } catch (error) {
      console.error('[ReputationAIService.detectAnomalies] Error:', error);
      return {
        success: false,
        error: {
          code: 'ANOMALY_DETECTION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to detect anomalies',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // 3. generateUserInsight — Admin dashboard summary
  // --------------------------------------------------------------------------

  /**
   * Generate a 3-sentence summary of user's platform behavior.
   * Highlights notable patterns (good or bad).
   * Uses AIClient 'fast' route.
   */
  generateUserInsight: async (userId: string): Promise<ServiceResult<UserInsightResult>> => {
    try {
      // Gather user data
      const [userResult, ratingsResult, taskStatsResult, disputeStatsResult] = await Promise.all([
        db.query<UserProfile>(
          'SELECT id, trust_tier, xp_total, current_streak, is_verified, account_status, created_at FROM users WHERE id = $1',
          [userId]
        ),
        db.query<RatingSummary>(
          'SELECT * FROM user_rating_summary WHERE user_id = $1',
          [userId]
        ),
        db.query<TaskStats>(
          `SELECT
             COUNT(*) FILTER (WHERE state = 'COMPLETED') AS total_completed,
             COUNT(*) FILTER (WHERE state = 'CANCELLED') AS total_cancelled,
             COUNT(*) AS total_tasks,
             AVG(EXTRACT(EPOCH FROM (completed_at - accepted_at)) / 3600) FILTER (WHERE state = 'COMPLETED' AND completed_at IS NOT NULL AND accepted_at IS NOT NULL) AS avg_completion_hours
           FROM tasks
           WHERE worker_id = $1 OR poster_id = $1`,
          [userId]
        ),
        db.query<DisputeStats>(
          `SELECT
             COUNT(*) AS total_disputes,
             COUNT(*) FILTER (WHERE state IN ('OPEN', 'EVIDENCE_REQUESTED')) AS open_disputes,
             COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS recent_disputes
           FROM disputes
           WHERE initiated_by = $1 OR poster_id = $1 OR worker_id = $1`,
          [userId]
        ),
      ]);

      if (userResult.rows.length === 0) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `User ${userId} not found` },
        };
      }

      const user = userResult.rows[0];
      const ratings = ratingsResult.rows[0] || null;
      const taskStats = taskStatsResult.rows[0];
      const disputeStats = disputeStatsResult.rows[0];

      const avgRating = ratings?.avg_rating ? parseFloat(ratings.avg_rating) : 0;
      const totalRatings = ratings ? parseInt(ratings.total_ratings, 10) : 0;
      const totalCompleted = parseInt(taskStats.total_completed, 10);
      const totalCancelled = parseInt(taskStats.total_cancelled, 10);
      const totalTasks = parseInt(taskStats.total_tasks, 10);
      const totalDisputes = parseInt(disputeStats.total_disputes, 10);
      const openDisputes = parseInt(disputeStats.open_disputes, 10);
      const accountAgeDays = Math.floor(
        (Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24)
      );

      const context = {
        trust_tier: user.trust_tier,
        xp_total: user.xp_total,
        streak: user.current_streak,
        is_verified: user.is_verified,
        account_status: user.account_status,
        account_age_days: accountAgeDays,
        avg_rating: avgRating,
        total_ratings: totalRatings,
        total_completed: totalCompleted,
        total_cancelled: totalCancelled,
        total_tasks: totalTasks,
        total_disputes: totalDisputes,
        open_disputes: openDisputes,
      };

      // Attempt AI-generated insight
      if (AIClient.isConfigured()) {
        try {
          const aiResult = await AIClient.callJSON<{ summary: string }>({
            route: 'fast',
            temperature: 0.3,
            timeoutMs: 8000,
            maxTokens: 300,
            systemPrompt: `You are HustleXP's Reputation Agent generating admin dashboard insights.
Write exactly 3 concise sentences summarizing this user's platform behavior.
Highlight notable patterns - both positive and concerning.
Be factual and specific. Reference actual numbers from the data.
Return JSON with a single field: { "summary": "..." }`,
            prompt: `Generate admin insight for this user:\n\n${JSON.stringify(context, null, 2)}`,
          });

          const summary = aiResult.data.summary;

          // Log to ai_agent_decisions
          await ReputationAIService._logDecision(
            userId,
            'user_insight',
            { summary },
            1.0,
            'Generated user insight for admin dashboard'
          );

          return { success: true, data: { summary } };
        } catch (aiError) {
          console.warn('[ReputationAI] AI insight generation failed, using heuristic:', aiError);
        }
      }

      // Heuristic fallback
      const completionRate = totalTasks > 0 ? Math.round((totalCompleted / totalTasks) * 100) : 0;
      const parts: string[] = [];

      parts.push(
        `Tier ${user.trust_tier} user with ${totalCompleted} completed tasks and ${avgRating.toFixed(1)} avg rating over ${accountAgeDays} days on platform.`
      );

      if (totalDisputes > 0) {
        parts.push(
          `Has ${totalDisputes} total dispute${totalDisputes === 1 ? '' : 's'}${openDisputes > 0 ? ` (${openDisputes} currently open)` : ''} and a ${completionRate}% completion rate.`
        );
      } else {
        parts.push(
          `Clean record with zero disputes and a ${completionRate}% task completion rate.`
        );
      }

      if (user.current_streak > 5) {
        parts.push(`Currently on a ${user.current_streak}-day streak, showing consistent engagement.`);
      } else if (totalCancelled > totalCompleted * 0.3) {
        parts.push(`Cancellation rate is elevated at ${totalCancelled} cancellations vs ${totalCompleted} completions.`);
      } else {
        parts.push(`${user.is_verified ? 'Verified account' : 'Unverified account'} with ${user.xp_total} total XP.`);
      }

      const summary = parts.join(' ');

      await ReputationAIService._logDecision(
        userId,
        'user_insight',
        { summary },
        0.7,
        'Heuristic insight (AI unavailable)'
      );

      return { success: true, data: { summary } };
    } catch (error) {
      console.error('[ReputationAIService.generateUserInsight] Error:', error);
      return {
        success: false,
        error: {
          code: 'INSIGHT_GENERATION_FAILED',
          message: error instanceof Error ? error.message : 'Failed to generate user insight',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // 4. shouldPromoteTier — Deterministic tier promotion check (NO AI)
  // --------------------------------------------------------------------------

  /**
   * Deterministic tier promotion eligibility check.
   * Pure rules-based: tasks_completed >= threshold AND rating >= threshold AND no active disputes.
   * NO AI is used for this method.
   */
  shouldPromoteTier: async (userId: string): Promise<ServiceResult<TierPromotionResult>> => {
    try {
      // Get current user tier
      const userResult = await db.query<{ trust_tier: number; is_verified: boolean; created_at: Date }>(
        'SELECT trust_tier, is_verified, created_at FROM users WHERE id = $1',
        [userId]
      );

      if (userResult.rows.length === 0) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: `User ${userId} not found` },
        };
      }

      const { trust_tier: currentTier, is_verified: isVerified, created_at: createdAt } =
        userResult.rows[0];

      // Max tier reached
      if (currentTier >= 4) {
        return {
          success: true,
          data: {
            eligible: false,
            currentTier,
            nextTier: 4,
            blockers: ['Already at maximum tier (4)'],
          },
        };
      }

      const nextTier = currentTier + 1;
      const threshold = TIER_THRESHOLDS[nextTier as keyof typeof TIER_THRESHOLDS];
      const blockers: string[] = [];

      // Get completed task count (as worker)
      const taskCountResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM tasks WHERE worker_id = $1 AND state = 'COMPLETED'`,
        [userId]
      );
      const completedTasks = parseInt(taskCountResult.rows[0].count, 10);

      // Get average rating
      const ratingResult = await db.query<{ avg_rating: string | null }>(
        'SELECT avg_rating FROM user_rating_summary WHERE user_id = $1',
        [userId]
      );
      const avgRating = ratingResult.rows[0]?.avg_rating
        ? parseFloat(ratingResult.rows[0].avg_rating)
        : 0;

      // Get active disputes
      const disputeResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM disputes
         WHERE (poster_id = $1 OR worker_id = $1)
           AND state IN ('OPEN', 'EVIDENCE_REQUESTED')`,
        [userId]
      );
      const activeDisputes = parseInt(disputeResult.rows[0].count, 10);

      // Check account age for tier 4 (6+ months)
      const accountAgeDays = Math.floor(
        (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24)
      );

      // Evaluate thresholds
      if (completedTasks < threshold.minTasks) {
        blockers.push(
          `Need ${threshold.minTasks} completed tasks (have ${completedTasks})`
        );
      }

      if (avgRating < threshold.minRating) {
        blockers.push(
          `Need ${threshold.minRating}+ average rating (have ${avgRating.toFixed(2)})`
        );
      }

      if (threshold.noDisputes && activeDisputes > 0) {
        blockers.push(`Must have no active disputes (have ${activeDisputes})`);
      }

      if (threshold.identityVerified && !isVerified) {
        blockers.push('Identity verification required');
      }

      // Tier 4 additional requirements
      if (nextTier === 4) {
        if (accountAgeDays < 180) {
          blockers.push(
            `Need 6+ months on platform (have ${accountAgeDays} days)`
          );
        }
      }

      return {
        success: true,
        data: {
          eligible: blockers.length === 0,
          currentTier,
          nextTier,
          blockers,
        },
      };
    } catch (error) {
      console.error('[ReputationAIService.shouldPromoteTier] Error:', error);
      return {
        success: false,
        error: {
          code: 'PROMOTION_CHECK_FAILED',
          message: error instanceof Error ? error.message : 'Failed to check tier promotion',
        },
      };
    }
  },

  // --------------------------------------------------------------------------
  // INTERNAL HELPERS
  // --------------------------------------------------------------------------

  /**
   * Heuristic trust score fallback when AI is unavailable.
   */
  _heuristicTrustScore: (
    context: Record<string, unknown>,
    trend: 'improving' | 'stable' | 'declining'
  ): TrustScoreResult => {
    const avgRating = (context.avg_rating as number) || 0;
    const completionRate = (context.completion_rate as number) || 0;
    const streak = (context.streak as number) || 0;
    const accountAgeDays = (context.account_age_days as number) || 0;
    const totalCompleted = (context.total_completed as number) || 0;
    const openDisputes = (context.open_disputes as number) || 0;
    const recentDisputes = (context.recent_disputes_7d as number) || 0;
    const disputeRatio = (context.dispute_ratio as number) || 0;
    const isVerified = (context.is_verified as boolean) || false;
    const currentTier = (context.trust_tier as number) || 1;

    // Base score from rating (0-50)
    const ratingScore = avgRating > 0 ? (avgRating / 5) * 50 : 25;

    // Completion rate bonus (0-20)
    const completionScore = (completionRate / 100) * 20;

    // Consistency bonus (0-15)
    let consistencyScore = 0;
    if (streak > 10) consistencyScore += 5;
    else if (streak > 3) consistencyScore += 3;
    if (accountAgeDays > 180) consistencyScore += 5;
    else if (accountAgeDays > 30) consistencyScore += 2;
    if (totalCompleted > 20) consistencyScore += 5;
    else if (totalCompleted > 5) consistencyScore += 2;
    consistencyScore = Math.min(15, consistencyScore);

    // Verification bonus (0-10)
    let verificationScore = 0;
    if (isVerified) verificationScore += 5;
    if (accountAgeDays > 180) verificationScore += 5;

    // Risk deductions
    let riskDeduction = 0;
    riskDeduction += openDisputes * 5;
    if (disputeRatio > 20) riskDeduction += 10;
    if (trend === 'declining') riskDeduction += 15;
    if (recentDisputes >= 3) riskDeduction += 10;

    const trustScore = Math.max(
      0,
      Math.min(100, Math.round(ratingScore + completionScore + consistencyScore + verificationScore - riskDeduction))
    );

    // Determine recommended tier
    let recommendedTier = currentTier;
    if (trustScore >= 85 && totalCompleted >= 25) recommendedTier = 4;
    else if (trustScore >= 70 && totalCompleted >= 10) recommendedTier = 3;
    else if (trustScore >= 50 && totalCompleted >= 3) recommendedTier = 2;
    else recommendedTier = 1;
    recommendedTier = Math.max(1, Math.min(4, recommendedTier));

    // Collect risk factors and strengths
    const risk_factors: string[] = [];
    const strengths: string[] = [];

    if (openDisputes > 0) risk_factors.push(`${openDisputes} open dispute${openDisputes > 1 ? 's' : ''}`);
    if (recentDisputes >= 3) risk_factors.push(`${recentDisputes} disputes in last 7 days`);
    if (disputeRatio > 20) risk_factors.push(`High dispute ratio (${disputeRatio}%)`);
    if (trend === 'declining') risk_factors.push('Rating trend is declining');
    if (completionRate < 70) risk_factors.push(`Low completion rate (${completionRate}%)`);

    if (completionRate >= 95) strengths.push(`${completionRate}% completion rate`);
    if (avgRating >= 4.5) strengths.push(`Excellent ${avgRating.toFixed(1)} avg rating`);
    if (streak > 5) strengths.push(`${streak}-day active streak`);
    if (isVerified) strengths.push('Identity verified');
    if (totalCompleted >= 50) strengths.push(`${totalCompleted} tasks completed`);

    return {
      trust_score: trustScore,
      trend,
      risk_factors,
      strengths,
      recommended_tier: recommendedTier,
      tier_change_reason:
        recommendedTier !== currentTier
          ? `Score ${trustScore}/100 suggests tier ${recommendedTier} (currently ${currentTier})`
          : undefined,
    };
  },

  /**
   * Log a reputation AI decision to the ai_agent_decisions table.
   * Uses agent_type='reputation'.
   */
  _logDecision: async (
    userId: string,
    actionType: string,
    proposal: Record<string, unknown>,
    confidenceScore: number,
    reasoning: string
  ): Promise<void> => {
    try {
      await db.query(
        `INSERT INTO ai_agent_decisions (
          agent_type, task_id, proposal, confidence_score, reasoning, authority_level
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          'reputation',
          null, // No task_id for reputation decisions; userId is in the proposal
          JSON.stringify({ user_id: userId, action: actionType, ...proposal }),
          confidenceScore,
          reasoning,
          'A2',
        ]
      );
    } catch (error) {
      // Non-fatal: log failure but don't break the main operation
      console.error('[ReputationAI] Failed to log decision:', error);
    }
  },
};

export default ReputationAIService;
