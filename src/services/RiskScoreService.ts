/**
 * RISK SCORE SERVICE (Phase 14D-1)
 * 
 * Control Plane Component - READ ONLY
 * 
 * Purpose: Score risk BEFORE money is ever at risk.
 * 
 * This service:
 * - Scores tasks, posters, and hustlers
 * - Provides explainable reasons
 * - Logs all scores for learning
 * - NEVER touches payouts or ledger
 * 
 * Inputs:
 * - User history (completions, disputes, cancellations)
 * - Task characteristics (category, price, time)
 * - Behavioral signals (latency, patterns)
 * 
 * Outputs:
 * - Risk scores (0-100)
 * - Confidence levels
 * - Explainable reasons
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';

const logger = serviceLogger.child({ module: 'RiskScoreService' });

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

// ============================================================
// TYPES
// ============================================================

export interface RiskScore {
    score: number;           // 0-100 (0 = safe, 100 = highest risk)
    tier: RiskTier;          // Categorized tier
    confidence: number;      // 0-1 (how confident we are)
    reasons: RiskReason[];   // Explainable factors
    evaluatedAt: Date;
    evaluationId: string;
}

export type RiskTier = 'minimal' | 'low' | 'medium' | 'high' | 'critical';

export interface RiskReason {
    factor: string;
    impact: 'positive' | 'negative' | 'neutral';
    weight: number;          // How much this affected the score
    description: string;
}

export interface TaskRiskContext {
    taskId: string;
    category: string;
    price: number;
    posterId: string;
    hustlerId?: string;
    isFirstTimeMatch?: boolean;
}

export interface UserRiskProfile {
    userId: string;
    role: 'poster' | 'hustler';
    score: RiskScore;
    history: {
        totalTasks: number;
        completedTasks: number;
        disputesInvolved: number;
        disputesLost: number;
        proofRejections: number;
        cancellations: number;
        avgCompletionTimeHours: number;
        accountAgeDays: number;
        consecutiveSuccesses: number;
    };
}

export interface FullRiskAssessment {
    taskRisk: RiskScore;
    posterRisk: RiskScore;
    hustlerRisk: RiskScore | null;
    combinedRisk: RiskScore;
    recommendation: RiskRecommendation;
}

export type RiskRecommendation =
    | 'PROCEED_NORMAL'
    | 'REQUIRE_PROOF'
    | 'REQUIRE_ENHANCED_PROOF'
    | 'FLAG_FOR_REVIEW'
    | 'HIGH_FRICTION';

// ============================================================
// SCORING WEIGHTS (v1 - Deterministic)
// ============================================================

const WEIGHTS = {
    // User history
    DISPUTES_LOST: 25,           // Per dispute lost
    DISPUTES_INVOLVED: 10,       // Per dispute (even if won)
    PROOF_REJECTIONS: 15,        // Per rejected proof
    CANCELLATIONS: 8,            // Per cancellation
    LOW_COMPLETION_RATE: 20,     // If < 80% completion

    // Positive factors (reduce risk)
    CONSECUTIVE_SUCCESSES: -3,   // Per consecutive success (caps at -30)
    ACCOUNT_AGE_BONUS: -5,       // Per 30 days (caps at -20)
    HIGH_COMPLETION_RATE: -15,   // If > 95% completion
    VERIFIED_IDENTITY: -10,      // If identity verified

    // Task factors
    HIGH_VALUE_TASK: 15,         // If price > $100
    VERY_HIGH_VALUE: 25,         // If price > $200
    NEW_CATEGORY_FOR_USER: 10,   // First time in this category
    FIRST_TIME_MATCH: 15,        // First time poster + hustler pairing

    // Category risk (inherent)
    CATEGORY_RISK: {
        moving: 10,              // Higher dispute rate
        handyman: 15,            // Quality disputes
        cleaning: 5,             // Moderate
        pet_care: 5,             // Trust-sensitive
        delivery: 3,             // Simple verification
        errands: 2,              // Low complexity
        tech_help: 8,            // Quality disputes
        tutoring: 5,             // Relationship-based
        event_help: 10,          // Time-sensitive
        general: 5               // Default
    } as Record<string, number>,

    // Time factors
    NIGHT_TASK: 5,               // 10pm - 6am
    WEEKEND_RUSH: 3,             // Saturday surge

    // New user penalty
    NEW_USER_POSTER: 20,         // < 7 days
    NEW_USER_HUSTLER: 15,        // < 7 days
} as const;

// ============================================================
// RISK SCORE SERVICE
// ============================================================

export class RiskScoreService {

    /**
     * SCORE A USER (Poster or Hustler)
     */
    static async scoreUser(userId: string, role: 'poster' | 'hustler'): Promise<UserRiskProfile> {
        const evaluationId = ulid();
        const db = getDb();

        const history = await this.getUserHistory(userId, role);
        const score = this.calculateUserScore(history, role, evaluationId);

        await this.logScore('user', userId, score);

        return {
            userId,
            role,
            score,
            history
        };
    }

    /**
     * SCORE A TASK
     */
    static async scoreTask(context: TaskRiskContext): Promise<RiskScore> {
        const evaluationId = ulid();
        const reasons: RiskReason[] = [];
        let baseScore = 0;

        // Category risk
        const categoryRisk = WEIGHTS.CATEGORY_RISK[context.category] || WEIGHTS.CATEGORY_RISK.general;
        baseScore += categoryRisk;
        reasons.push({
            factor: 'category',
            impact: categoryRisk > 5 ? 'negative' : 'neutral',
            weight: categoryRisk,
            description: `Category '${context.category}' has ${categoryRisk > 10 ? 'elevated' : 'normal'} risk profile`
        });

        // Price risk
        if (context.price > 200) {
            baseScore += WEIGHTS.VERY_HIGH_VALUE;
            reasons.push({
                factor: 'high_value',
                impact: 'negative',
                weight: WEIGHTS.VERY_HIGH_VALUE,
                description: `Very high value task ($${context.price}) increases dispute likelihood`
            });
        } else if (context.price > 100) {
            baseScore += WEIGHTS.HIGH_VALUE_TASK;
            reasons.push({
                factor: 'high_value',
                impact: 'negative',
                weight: WEIGHTS.HIGH_VALUE_TASK,
                description: `High value task ($${context.price}) increases scrutiny need`
            });
        }

        // First time match
        if (context.isFirstTimeMatch) {
            baseScore += WEIGHTS.FIRST_TIME_MATCH;
            reasons.push({
                factor: 'first_match',
                impact: 'negative',
                weight: WEIGHTS.FIRST_TIME_MATCH,
                description: 'First time pairing between poster and hustler'
            });
        }

        // Time factors
        const hour = new Date().getHours();
        if (hour >= 22 || hour < 6) {
            baseScore += WEIGHTS.NIGHT_TASK;
            reasons.push({
                factor: 'night_task',
                impact: 'negative',
                weight: WEIGHTS.NIGHT_TASK,
                description: 'Late night task has reduced verification options'
            });
        }

        const dayOfWeek = new Date().getDay();
        if (dayOfWeek === 6) { // Saturday
            baseScore += WEIGHTS.WEEKEND_RUSH;
            reasons.push({
                factor: 'weekend_rush',
                impact: 'neutral',
                weight: WEIGHTS.WEEKEND_RUSH,
                description: 'Weekend tasks have higher volume, moderate risk increase'
            });
        }

        const score = this.buildScore(baseScore, reasons, evaluationId, 0.9);
        await this.logScore('task', context.taskId, score);

        return score;
    }

    /**
     * FULL RISK ASSESSMENT (Task + Both Parties)
     */
    static async assessFullRisk(context: TaskRiskContext): Promise<FullRiskAssessment> {
        const [taskRisk, posterProfile] = await Promise.all([
            this.scoreTask(context),
            this.scoreUser(context.posterId, 'poster')
        ]);

        let hustlerProfile: UserRiskProfile | null = null;
        if (context.hustlerId) {
            hustlerProfile = await this.scoreUser(context.hustlerId, 'hustler');
        }

        // Combined risk calculation
        const combinedScore = this.calculateCombinedRisk(
            taskRisk,
            posterProfile.score,
            hustlerProfile?.score || null
        );

        // Generate recommendation
        const recommendation = this.generateRecommendation(combinedScore.score);

        logger.info({
            taskId: context.taskId,
            taskRisk: taskRisk.score,
            posterRisk: posterProfile.score.score,
            hustlerRisk: hustlerProfile?.score.score,
            combinedRisk: combinedScore.score,
            recommendation
        }, 'Full risk assessment completed');

        return {
            taskRisk,
            posterRisk: posterProfile.score,
            hustlerRisk: hustlerProfile?.score || null,
            combinedRisk: combinedScore,
            recommendation
        };
    }

    // -----------------------------------------------------------
    // INTERNAL: History Fetching
    // -----------------------------------------------------------

    private static async getUserHistory(userId: string, role: 'poster' | 'hustler'): Promise<UserRiskProfile['history']> {
        const db = getDb();

        const defaultHistory = {
            totalTasks: 0,
            completedTasks: 0,
            disputesInvolved: 0,
            disputesLost: 0,
            proofRejections: 0,
            cancellations: 0,
            avgCompletionTimeHours: 0,
            accountAgeDays: 0,
            consecutiveSuccesses: 0
        };

        if (!db) return defaultHistory;

        try {
            // Get user account age
            const [user] = await db`
                SELECT created_at FROM users WHERE id = ${userId}::uuid
            ` as any[];

            const accountAgeDays = user
                ? Math.floor((Date.now() - new Date(user.created_at).getTime()) / (1000 * 60 * 60 * 24))
                : 0;

            // Get task stats based on role
            const taskField = role === 'poster' ? 'client_id' : 'assigned_hustler_id';
            const [taskStats] = await db`
                SELECT 
                    COUNT(*) as total,
                    COUNT(*) FILTER (WHERE status = 'completed') as completed,
                    COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
                FROM tasks 
                WHERE ${db.unsafe(taskField)} = ${userId}::uuid
            ` as any[];

            // Get dispute stats
            const disputeField = role === 'poster' ? 'poster_id' : 'hustler_id';
            const [disputeStats] = await db`
                SELECT 
                    COUNT(*) as involved,
                    COUNT(*) FILTER (WHERE status = 'refunded' AND ${db.unsafe(disputeField)} = ${userId}::uuid) as lost
                FROM disputes 
                WHERE ${db.unsafe(disputeField)} = ${userId}::uuid
            ` as any[];

            // Get proof rejections (for hustlers)
            let proofRejections = 0;
            if (role === 'hustler') {
                const [proofStats] = await db`
                    SELECT COUNT(*) as rejections
                    FROM proof_submissions
                    WHERE submitted_by = ${userId}::uuid
                    AND state = 'rejected'
                ` as any[];
                proofRejections = parseInt(proofStats?.rejections || '0');
            }

            // Calculate consecutive successes (recent streak)
            const recentTasks = await db`
                SELECT status FROM tasks 
                WHERE ${db.unsafe(taskField)} = ${userId}::uuid
                ORDER BY updated_at DESC
                LIMIT 10
            ` as any[];

            let consecutiveSuccesses = 0;
            for (const task of recentTasks) {
                if (task.status === 'completed') {
                    consecutiveSuccesses++;
                } else if (task.status === 'cancelled' || task.status === 'disputed') {
                    break;
                }
            }

            return {
                totalTasks: parseInt(taskStats?.total || '0'),
                completedTasks: parseInt(taskStats?.completed || '0'),
                disputesInvolved: parseInt(disputeStats?.involved || '0'),
                disputesLost: parseInt(disputeStats?.lost || '0'),
                proofRejections,
                cancellations: parseInt(taskStats?.cancelled || '0'),
                avgCompletionTimeHours: 0, // Would need more complex query
                accountAgeDays,
                consecutiveSuccesses
            };
        } catch (error) {
            logger.error({ error, userId }, 'Failed to fetch user history for risk scoring');
            return defaultHistory;
        }
    }

    // -----------------------------------------------------------
    // INTERNAL: Score Calculation
    // -----------------------------------------------------------

    private static calculateUserScore(
        history: UserRiskProfile['history'],
        role: 'poster' | 'hustler',
        evaluationId: string
    ): RiskScore {
        const reasons: RiskReason[] = [];
        let baseScore = 0;

        // New user penalty
        if (history.accountAgeDays < 7) {
            const penalty = role === 'poster' ? WEIGHTS.NEW_USER_POSTER : WEIGHTS.NEW_USER_HUSTLER;
            baseScore += penalty;
            reasons.push({
                factor: 'new_user',
                impact: 'negative',
                weight: penalty,
                description: `Account is ${history.accountAgeDays} days old (< 7 days)`
            });
        }

        // Disputes lost
        if (history.disputesLost > 0) {
            const impact = history.disputesLost * WEIGHTS.DISPUTES_LOST;
            baseScore += impact;
            reasons.push({
                factor: 'disputes_lost',
                impact: 'negative',
                weight: impact,
                description: `Lost ${history.disputesLost} dispute(s)`
            });
        }

        // Disputes involved (even if won)
        if (history.disputesInvolved > 0) {
            const impact = history.disputesInvolved * WEIGHTS.DISPUTES_INVOLVED;
            baseScore += impact;
            reasons.push({
                factor: 'disputes_involved',
                impact: 'negative',
                weight: impact,
                description: `Involved in ${history.disputesInvolved} dispute(s)`
            });
        }

        // Proof rejections (hustlers)
        if (history.proofRejections > 0) {
            const impact = history.proofRejections * WEIGHTS.PROOF_REJECTIONS;
            baseScore += impact;
            reasons.push({
                factor: 'proof_rejections',
                impact: 'negative',
                weight: impact,
                description: `Had ${history.proofRejections} proof rejection(s)`
            });
        }

        // Cancellations
        if (history.cancellations > 0) {
            const impact = history.cancellations * WEIGHTS.CANCELLATIONS;
            baseScore += impact;
            reasons.push({
                factor: 'cancellations',
                impact: 'negative',
                weight: impact,
                description: `Cancelled ${history.cancellations} task(s)`
            });
        }

        // Completion rate
        if (history.totalTasks > 5) {
            const completionRate = history.completedTasks / history.totalTasks;
            if (completionRate < 0.8) {
                baseScore += WEIGHTS.LOW_COMPLETION_RATE;
                reasons.push({
                    factor: 'low_completion',
                    impact: 'negative',
                    weight: WEIGHTS.LOW_COMPLETION_RATE,
                    description: `Completion rate is ${Math.round(completionRate * 100)}% (< 80%)`
                });
            } else if (completionRate > 0.95) {
                baseScore += WEIGHTS.HIGH_COMPLETION_RATE; // Negative weight = bonus
                reasons.push({
                    factor: 'high_completion',
                    impact: 'positive',
                    weight: Math.abs(WEIGHTS.HIGH_COMPLETION_RATE),
                    description: `Excellent completion rate: ${Math.round(completionRate * 100)}%`
                });
            }
        }

        // Consecutive successes bonus
        if (history.consecutiveSuccesses > 0) {
            const bonus = Math.max(history.consecutiveSuccesses * WEIGHTS.CONSECUTIVE_SUCCESSES, -30);
            baseScore += bonus;
            if (bonus < 0) {
                reasons.push({
                    factor: 'success_streak',
                    impact: 'positive',
                    weight: Math.abs(bonus),
                    description: `${history.consecutiveSuccesses} consecutive successful tasks`
                });
            }
        }

        // Account age bonus
        const ageBonus = Math.max(Math.floor(history.accountAgeDays / 30) * WEIGHTS.ACCOUNT_AGE_BONUS, -20);
        if (ageBonus < 0) {
            baseScore += ageBonus;
            reasons.push({
                factor: 'account_age',
                impact: 'positive',
                weight: Math.abs(ageBonus),
                description: `Account age: ${history.accountAgeDays} days`
            });
        }

        // Confidence based on data availability
        const confidence = this.calculateConfidence(history);

        return this.buildScore(baseScore, reasons, evaluationId, confidence);
    }

    private static calculateCombinedRisk(
        taskRisk: RiskScore,
        posterRisk: RiskScore,
        hustlerRisk: RiskScore | null
    ): RiskScore {
        const evaluationId = ulid();

        // Weighted combination
        // Task: 30%, Poster: 35%, Hustler: 35% (or 50% poster if no hustler)
        let combinedScore: number;
        let confidence: number;

        if (hustlerRisk) {
            combinedScore = (taskRisk.score * 0.3) + (posterRisk.score * 0.35) + (hustlerRisk.score * 0.35);
            confidence = (taskRisk.confidence * 0.3) + (posterRisk.confidence * 0.35) + (hustlerRisk.confidence * 0.35);
        } else {
            combinedScore = (taskRisk.score * 0.4) + (posterRisk.score * 0.6);
            confidence = (taskRisk.confidence * 0.4) + (posterRisk.confidence * 0.6);
        }

        // Combine reasons (top 5)
        const allReasons = [
            ...taskRisk.reasons,
            ...posterRisk.reasons,
            ...(hustlerRisk?.reasons || [])
        ].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)).slice(0, 5);

        return this.buildScore(combinedScore, allReasons, evaluationId, confidence);
    }

    private static buildScore(
        rawScore: number,
        reasons: RiskReason[],
        evaluationId: string,
        confidence: number
    ): RiskScore {
        // Clamp score to 0-100
        const score = Math.max(0, Math.min(100, rawScore));

        // Determine tier
        let tier: RiskTier;
        if (score < 15) tier = 'minimal';
        else if (score < 30) tier = 'low';
        else if (score < 50) tier = 'medium';
        else if (score < 75) tier = 'high';
        else tier = 'critical';

        return {
            score: Math.round(score),
            tier,
            confidence: Math.round(confidence * 100) / 100,
            reasons,
            evaluatedAt: new Date(),
            evaluationId
        };
    }

    private static calculateConfidence(history: UserRiskProfile['history']): number {
        // More data = higher confidence
        if (history.totalTasks === 0) return 0.3;  // No history
        if (history.totalTasks < 3) return 0.5;    // Limited history
        if (history.totalTasks < 10) return 0.7;   // Some history
        if (history.totalTasks < 25) return 0.85;  // Good history
        return 0.95;                                // Strong history
    }

    private static generateRecommendation(combinedScore: number): RiskRecommendation {
        if (combinedScore < 15) return 'PROCEED_NORMAL';
        if (combinedScore < 30) return 'REQUIRE_PROOF';
        if (combinedScore < 50) return 'REQUIRE_ENHANCED_PROOF';
        if (combinedScore < 75) return 'FLAG_FOR_REVIEW';
        return 'HIGH_FRICTION';
    }

    // -----------------------------------------------------------
    // INTERNAL: Logging (for learning loop)
    // -----------------------------------------------------------

    private static async logScore(
        entityType: 'user' | 'task',
        entityId: string,
        score: RiskScore
    ): Promise<void> {
        const db = getDb();
        if (!db) return;

        try {
            await db`
                INSERT INTO risk_score_log (
                    evaluation_id, entity_type, entity_id, 
                    score, tier, confidence, reasons, evaluated_at
                ) VALUES (
                    ${score.evaluationId}, ${entityType}, ${entityId},
                    ${score.score}, ${score.tier}, ${score.confidence},
                    ${JSON.stringify(score.reasons)}, ${score.evaluatedAt}
                )
            `;
        } catch (error) {
            // Table might not exist yet - just warn
            logger.warn({ error, entityId }, 'Failed to log risk score - table may not exist');
        }
    }
}
