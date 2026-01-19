/**
 * PRIORITY SCORE SERVICE (staging/PRIORITY_MATH.md)
 *
 * Constitutional priority scoring for hustler task visibility.
 *
 * Formula:
 * priority_score = (xp_component × 0.5) + (trust_component × 0.3) + (streak_component × 0.2)
 *
 * Components:
 * - XP: min(100, sqrt(total_xp) × 2)
 * - Trust: trust_tier × 25
 * - Streak: min(100, current_streak × 3)
 *
 * @version 1.0.0 (PRIORITY_MATH.md aligned)
 */
import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
const logger = createLogger('PriorityScoreService');
// ============================================================================
// CONSTANTS (from PRIORITY_MATH.md)
// ============================================================================
const WEIGHTS = {
    XP: 0.5,
    TRUST: 0.3,
    STREAK: 0.2,
};
const XP_SCALE_FACTOR = 2;
const XP_CAP = 100;
const TRUST_TIER_VALUE = 25;
const STREAK_MULTIPLIER = 3;
const STREAK_CAP = 100;
// Decay constants
const DECAY_GRACE_HOURS = 48;
const DECAY_RATE_DAILY = 0.05;
const DECAY_FLOOR_PERCENT = 0.20;
const RECOVERY_RESTORE_PERCENT = 0.90;
const RECOVERY_FULL_TASKS = 3;
// Feedback constants
const PATTERN_THRESHOLD_30D = 3;
const PATTERN_THRESHOLD_90D = 5;
const PATTERN_PENALTY = 0.25;
const POSITIVE_BOOST = 0.02;
const POSITIVE_CAP = 0.10;
const LATE_PENALTY = 0.10;
const NOSHOW_PENALTY = 0.30;
const RECOVERY_PER_TASK = 0.02;
// ============================================================================
// COMPONENT CALCULATIONS
// ============================================================================
/**
 * Calculate XP component (0-100 scale)
 * xp_component = min(100, sqrt(total_xp) × 2)
 */
function calculateXPComponent(totalXP) {
    return Math.min(XP_CAP, Math.sqrt(totalXP) * XP_SCALE_FACTOR);
}
/**
 * Calculate Trust component (0-100 scale)
 * trust_component = trust_tier × 25
 */
function calculateTrustComponent(trustTier) {
    return trustTier * TRUST_TIER_VALUE;
}
/**
 * Calculate Streak component (0-100 scale)
 * streak_component = min(100, current_streak × 3)
 */
function calculateStreakComponent(currentStreak) {
    return Math.min(STREAK_CAP, currentStreak * STREAK_MULTIPLIER);
}
// ============================================================================
// PRIORITY SCORE SERVICE
// ============================================================================
class PriorityScoreServiceClass {
    /**
     * Calculate priority score for a user
     */
    async calculateScore(userId) {
        const sql = getSql();
        // Get user data
        const [userData] = await sql `
      SELECT 
        u.id,
        COALESCE(SUM(xl.amount), 0)::int as total_xp,
        COALESCE(tl.current_tier, 1)::int as trust_tier,
        COALESCE(g.streak_days, 0)::int as streak_days,
        COALESCE(g.last_task_at, NOW() - INTERVAL '999 days') as last_task_at
      FROM users u
      LEFT JOIN xp_ledger xl ON xl.user_id = u.id
      LEFT JOIN trust_ledger tl ON tl.user_id = u.id 
        AND tl.created_at = (SELECT MAX(created_at) FROM trust_ledger WHERE user_id = u.id)
      LEFT JOIN gamification_stats g ON g.user_id = u.id
      WHERE u.id = ${userId}
      GROUP BY u.id, tl.current_tier, g.streak_days, g.last_task_at
    `;
        if (!userData) {
            throw new Error(`User ${userId} not found`);
        }
        // Calculate components
        const xpComponent = calculateXPComponent(userData.total_xp);
        const trustComponent = calculateTrustComponent(userData.trust_tier);
        const streakComponent = calculateStreakComponent(userData.streak_days);
        // Calculate base score
        const baseScore = (xpComponent * WEIGHTS.XP) +
            (trustComponent * WEIGHTS.TRUST) +
            (streakComponent * WEIGHTS.STREAK);
        // Check for decay
        const hoursSinceLastTask = (Date.now() - new Date(userData.last_task_at).getTime()) / (1000 * 60 * 60);
        let decayApplied = false;
        let decayedScore = baseScore;
        if (hoursSinceLastTask > DECAY_GRACE_HOURS) {
            decayApplied = true;
            const daysIdle = (hoursSinceLastTask - DECAY_GRACE_HOURS) / 24;
            decayedScore = Math.max(baseScore * DECAY_FLOOR_PERCENT, baseScore * Math.pow(1 - DECAY_RATE_DAILY, daysIdle));
        }
        // Get penalties and bonuses
        const { penalties, bonuses } = await this.getFeedbackModifiers(userId);
        // Calculate effective score
        const effectiveScore = Math.max(0, decayedScore * (1 - penalties) * (1 + bonuses));
        const result = {
            userId,
            score: baseScore,
            xpComponent,
            trustComponent,
            streakComponent,
            decayApplied,
            decayedScore: decayApplied ? decayedScore : undefined,
            penalties,
            bonuses,
            effectiveScore,
            calculatedAt: new Date(),
        };
        logger.debug({ userId, effectiveScore, baseScore }, 'Priority score calculated');
        return result;
    }
    /**
     * Get feedback-based modifiers
     */
    async getFeedbackModifiers(userId) {
        const sql = getSql();
        // Get negative feedback in last 30 and 90 days
        const [negatives30] = await sql `
      SELECT COUNT(*)::int as cnt FROM feedback
      WHERE user_id = ${userId}
        AND rating < 3
        AND created_at > NOW() - INTERVAL '30 days'
    `;
        const [negatives90] = await sql `
      SELECT COUNT(*)::int as cnt FROM feedback
      WHERE user_id = ${userId}
        AND rating < 3
        AND created_at > NOW() - INTERVAL '90 days'
    `;
        // Get positive feedback
        const [positives] = await sql `
      SELECT COUNT(*)::int as cnt FROM feedback
      WHERE user_id = ${userId}
        AND rating = 5
        AND created_at > NOW() - INTERVAL '30 days'
    `;
        // Get SLA breaches
        const [breaches] = await sql `
      SELECT COUNT(*)::int as cnt FROM sla_breaches
      WHERE user_id = ${userId}
        AND breach_type = 'late_arrival'
        AND created_at > NOW() - INTERVAL '30 days'
    `;
        // Calculate penalties
        let penalties = 0;
        // Pattern detection
        if (negatives30.cnt >= PATTERN_THRESHOLD_30D || negatives90.cnt >= PATTERN_THRESHOLD_90D) {
            penalties += PATTERN_PENALTY;
        }
        // Individual negative feedback
        if (negatives30.cnt >= 2) {
            penalties += 0.05 * (negatives30.cnt - 1);
        }
        // Late arrivals
        penalties += breaches.cnt * LATE_PENALTY;
        // Cap penalties at 50%
        penalties = Math.min(0.5, penalties);
        // Calculate bonuses
        let bonuses = Math.min(POSITIVE_CAP, positives.cnt * POSITIVE_BOOST);
        return { penalties, bonuses };
    }
    /**
     * Compare two users for task visibility order
     * Returns -1 if userA should see task first, 1 if userB should
     */
    async compareUsers(userAId, userBId) {
        const [scoreA, scoreB] = await Promise.all([
            this.calculateScore(userAId),
            this.calculateScore(userBId),
        ]);
        // Primary: effective score
        if (scoreA.effectiveScore !== scoreB.effectiveScore) {
            return scoreB.effectiveScore - scoreA.effectiveScore;
        }
        // Tie-breaker 1: Trust tier (from trustComponent)
        if (scoreA.trustComponent !== scoreB.trustComponent) {
            return scoreB.trustComponent - scoreA.trustComponent;
        }
        // Tie-breaker 2: Streak (from streakComponent)
        if (scoreA.streakComponent !== scoreB.streakComponent) {
            return scoreB.streakComponent - scoreA.streakComponent;
        }
        // Tie-breaker 3: Account creation date (not available here, would need DB query)
        // Tie-breaker 4: Deterministic random from user ID
        return userAId.localeCompare(userBId);
    }
    /**
     * Record task completion and update decay recovery
     */
    async recordTaskCompletion(userId) {
        const sql = getSql();
        // Get current priority state
        const [current] = await sql `
      SELECT 
        score_before_decay,
        tasks_since_decay
      FROM priority_state
      WHERE user_id = ${userId}
    `;
        if (!current || !current.score_before_decay) {
            // No decay state, just update last task time
            await sql `
        INSERT INTO priority_state (user_id, last_task_at, tasks_since_decay)
        VALUES (${userId}, NOW(), 0)
        ON CONFLICT (user_id) DO UPDATE SET 
          last_task_at = NOW(),
          tasks_since_decay = 0
      `;
            const newScore = await this.calculateScore(userId);
            return { restored: false, newScore: newScore.effectiveScore };
        }
        const tasksSinceDecay = (current.tasks_since_decay || 0) + 1;
        // Check restoration
        if (tasksSinceDecay === 1) {
            // First task after decay: restore to 90%
            await sql `
        UPDATE priority_state
        SET last_task_at = NOW(),
            tasks_since_decay = 1,
            current_restoration = ${RECOVERY_RESTORE_PERCENT}
        WHERE user_id = ${userId}
      `;
        }
        else if (tasksSinceDecay >= RECOVERY_FULL_TASKS) {
            // Full restoration
            await sql `
        UPDATE priority_state
        SET last_task_at = NOW(),
            tasks_since_decay = ${tasksSinceDecay},
            current_restoration = 1.0,
            score_before_decay = NULL
        WHERE user_id = ${userId}
      `;
        }
        else {
            // Incremental restoration
            const restoration = RECOVERY_RESTORE_PERCENT +
                ((1 - RECOVERY_RESTORE_PERCENT) / RECOVERY_FULL_TASKS) * tasksSinceDecay;
            await sql `
        UPDATE priority_state
        SET last_task_at = NOW(),
            tasks_since_decay = ${tasksSinceDecay},
            current_restoration = ${restoration}
        WHERE user_id = ${userId}
      `;
        }
        const newScore = await this.calculateScore(userId);
        return { restored: tasksSinceDecay >= RECOVERY_FULL_TASKS, newScore: newScore.effectiveScore };
    }
    /**
     * Get feedback impact description
     */
    getFeedbackImpact(event) {
        switch (event) {
            case 'first_negative_30d':
                return { type: 'neutral', event, priorityChange: 0, recoveryTasks: 0 };
            case 'second_negative_30d':
                return { type: 'negative', event, priorityChange: -5, recoveryTasks: 3 };
            case 'third_negative_30d':
                return { type: 'negative', event, priorityChange: -15, recoveryTasks: 8 };
            case 'late_arrival':
                return { type: 'negative', event, priorityChange: -10, recoveryTasks: 5 };
            case 'no_show':
                return { type: 'negative', event, priorityChange: -30, recoveryTasks: 15 };
            case 'five_star':
                return { type: 'positive', event, priorityChange: 2, recoveryTasks: 0 };
            case 'repeat_booking':
                return { type: 'positive', event, priorityChange: 3, recoveryTasks: 0 };
            default:
                return { type: 'neutral', event, priorityChange: 0, recoveryTasks: 0 };
        }
    }
}
export const PriorityScoreService = new PriorityScoreServiceClass();
//# sourceMappingURL=PriorityScoreService.js.map