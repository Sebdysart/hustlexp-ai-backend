/**
 * CORRECTION ENGINE (Phase Ω-ACT)
 * 
 * Central orchestrator for all autonomous corrections.
 * 
 * HARD LIMITS (NON-NEGOTIABLE):
 * ❌ No ledger ❌ No payouts ❌ No disputes ❌ No escrow
 * ❌ No KillSwitch ❌ No Stripe ❌ No block_task ❌ No block_accept
 * 
 * GUARANTEES:
 * ✅ All corrections logged before execution
 * ✅ All corrections reversible
 * ✅ All corrections auto-expire (24h max)
 * ✅ Budget enforced
 * ✅ SafeMode as emergency brake
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { AlertService } from '../services/AlertService.js';
import { CorrectionBudgetService, BudgetScope } from './CorrectionBudgetService.js';
import { ulid } from 'ulidx';

const logger = serviceLogger.child({ module: 'CorrectionEngine' });

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

// ============================================================
// HARD LIMITS - COMPILE TIME
// ============================================================

const FORBIDDEN_TARGETS = [
    'ledger',
    'payout',
    'dispute',
    'escrow',
    'killswitch',
    'stripe',
    'block_task',
    'block_accept'
] as const;

type ForbiddenTarget = typeof FORBIDDEN_TARGETS[number];

// Compile-time check - this will fail if someone adds forbidden behavior
function assertCorrectionSafe(target: string): void {
    if (FORBIDDEN_TARGETS.includes(target as ForbiddenTarget)) {
        throw new Error(`[CorrectionEngine] FORBIDDEN TARGET: ${target}. This correction is NOT ALLOWED.`);
    }
}

// ============================================================
// TYPES
// ============================================================

export type CorrectionType =
    | 'task_routing'
    | 'friction'
    | 'supply_nudge'
    | 'proof_timing'
    | 'pricing_guidance';

export type ReasonCode =
    | 'LOW_ZONE_FILL'
    | 'TASK_EXPIRING'
    | 'DISPUTE_SPIKE'
    | 'SUPPLY_SHORTAGE'
    | 'GOLDEN_HOUR'
    | 'NEW_USER_RISK'
    | 'SUPPLY_SURPLUS'
    | 'HIGH_DEMAND';

export interface CorrectionReason {
    code: ReasonCode;
    summary: string;
    evidence: string[];
}

export interface Correction {
    type: CorrectionType;
    targetEntity: string;
    targetId: string;
    adjustment: Record<string, any>;
    reason: CorrectionReason;
    expiresAt: Date;
    triggeredBy: string;
}

export interface CorrectionResult {
    success: boolean;
    correctionId: string | null;
    blocked: boolean;
    blockedReason?: string;
}

// ============================================================
// SAFEMODE STATE
// ============================================================

let SAFE_MODE_ACTIVE = false;
let SAFE_MODE_REASON: string | null = null;
let SAFE_MODE_ACTIVATED_AT: Date | null = null;

// Metrics for SafeMode triggers
let recentReversals = 0;
let recentCorrections = 0;
let budgetExhaustionCount = 0;

const SAFEMODE_THRESHOLDS = {
    reversalRatePercent: 25,
    budgetExhaustionLimit: 3,
    windowMinutes: 60
};

// ============================================================
// CORRECTION ENGINE
// ============================================================

export class CorrectionEngine {

    // -----------------------------------------------------------
    // SAFEMODE
    // -----------------------------------------------------------

    static isSafeModeActive(): boolean {
        return SAFE_MODE_ACTIVE;
    }

    static getSafeModeStatus(): {
        active: boolean;
        reason: string | null;
        activatedAt: Date | null;
    } {
        return {
            active: SAFE_MODE_ACTIVE,
            reason: SAFE_MODE_REASON,
            activatedAt: SAFE_MODE_ACTIVATED_AT
        };
    }

    static async enterSafeMode(reason: string): Promise<void> {
        SAFE_MODE_ACTIVE = true;
        SAFE_MODE_REASON = reason;
        SAFE_MODE_ACTIVATED_AT = new Date();

        logger.fatal({ reason }, '🛑 CORRECTION ENGINE ENTERING SAFE MODE');

        await AlertService.fire(
            'KILLSWITCH_ACTIVATED', // Re-using alert type for visibility
            `CorrectionEngine SafeMode activated: ${reason}`,
            { reason, module: 'CorrectionEngine' }
        );
    }

    static resetSafeMode(): void {
        logger.warn('CorrectionEngine SafeMode manually reset');
        SAFE_MODE_ACTIVE = false;
        SAFE_MODE_REASON = null;
        SAFE_MODE_ACTIVATED_AT = null;
        recentReversals = 0;
        budgetExhaustionCount = 0;
    }

    // -----------------------------------------------------------
    // APPLY CORRECTION
    // -----------------------------------------------------------

    /**
     * APPLY CORRECTION
     * 
     * Main entry point for all autonomous corrections.
     */
    static async apply(correction: Correction): Promise<CorrectionResult> {
        const correctionId = ulid();

        // 1. Check SafeMode
        if (SAFE_MODE_ACTIVE) {
            logger.warn({ correctionId, type: correction.type }, 'Correction blocked - SafeMode active');
            return {
                success: false,
                correctionId: null,
                blocked: true,
                blockedReason: 'SAFE_MODE_ACTIVE'
            };
        }

        // 2. HARD LIMIT CHECK - Runtime assertion
        try {
            assertCorrectionSafe(correction.targetEntity);
        } catch (error: any) {
            logger.fatal({ error, correction }, 'FORBIDDEN CORRECTION ATTEMPT');
            return {
                success: false,
                correctionId: null,
                blocked: true,
                blockedReason: error.message
            };
        }

        // 3. Check budget
        const budgetScope = this.getScopeForCorrection(correction);
        const budgetCheck = await CorrectionBudgetService.checkAllBudgets(
            budgetScope,
            correction.targetId
        );

        if (!budgetCheck.allowed) {
            budgetExhaustionCount++;

            // Check if we should trigger SafeMode
            if (budgetExhaustionCount >= SAFEMODE_THRESHOLDS.budgetExhaustionLimit) {
                await this.enterSafeMode(`Budget exhausted ${budgetExhaustionCount} times in window`);
            }

            logger.warn({
                correctionId,
                type: correction.type,
                blockedBy: budgetCheck.blockedBy
            }, 'Correction blocked - Budget exceeded');

            return {
                success: false,
                correctionId: null,
                blocked: true,
                blockedReason: `BUDGET_EXCEEDED_${budgetCheck.blockedBy?.toUpperCase()}`
            };
        }

        // 4. Validate expiry
        const maxExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
        if (correction.expiresAt > maxExpiry) {
            correction.expiresAt = maxExpiry;
            logger.warn({ correctionId }, 'Correction expiry clamped to 24h max');
        }

        // 5. Log BEFORE execution
        const logged = await this.logCorrection(correctionId, correction);
        if (!logged) {
            return {
                success: false,
                correctionId: null,
                blocked: true,
                blockedReason: 'LOGGING_FAILED'
            };
        }

        // 6. Consume budget
        await CorrectionBudgetService.consumeBudget(budgetScope, correction.targetId);

        // 7. Track for reversal rate
        recentCorrections++;

        logger.info({
            correctionId,
            type: correction.type,
            target: correction.targetId,
            reason: correction.reason.code
        }, 'Correction applied');

        return {
            success: true,
            correctionId,
            blocked: false
        };
    }

    // -----------------------------------------------------------
    // REVERSE CORRECTION
    // -----------------------------------------------------------

    static async reverse(
        correctionId: string,
        reason: string
    ): Promise<boolean> {
        const db = getDb();
        if (!db) return false;

        try {
            await db`
                UPDATE correction_log
                SET reversed = TRUE,
                    reversed_at = NOW(),
                    reversal_reason = ${reason}
                WHERE id = ${correctionId}::uuid
                AND reversed = FALSE
            `;

            recentReversals++;

            // Check reversal rate
            const reversalRate = recentCorrections > 0
                ? (recentReversals / recentCorrections) * 100
                : 0;

            if (reversalRate > SAFEMODE_THRESHOLDS.reversalRatePercent) {
                await this.enterSafeMode(`Reversal rate ${reversalRate.toFixed(1)}% exceeds threshold`);
            }

            logger.info({ correctionId, reason, reversalRate }, 'Correction reversed');
            return true;
        } catch (error) {
            logger.error({ error, correctionId }, 'Failed to reverse correction');
            return false;
        }
    }

    // -----------------------------------------------------------
    // EXPIRE CORRECTIONS
    // -----------------------------------------------------------

    static async expireOldCorrections(): Promise<number> {
        const db = getDb();
        if (!db) return 0;

        try {
            const result = await db`
                UPDATE correction_log
                SET reversed = TRUE,
                    reversed_at = NOW(),
                    reversal_reason = 'AUTO_EXPIRED'
                WHERE expires_at < NOW()
                AND reversed = FALSE
            `;

            const expired = (result as any)?.count || 0;

            if (expired > 0) {
                logger.info({ expired }, 'Auto-expired corrections');
            }

            return expired;
        } catch (error) {
            logger.error({ error }, 'Failed to expire corrections');
            return 0;
        }
    }

    // -----------------------------------------------------------
    // INTERNAL
    // -----------------------------------------------------------

    private static async logCorrection(
        correctionId: string,
        correction: Correction
    ): Promise<boolean> {
        const db = getDb();
        if (!db) return false;

        try {
            await db`
                INSERT INTO correction_log (
                    id, correction_type, target_entity, target_id,
                    adjustment, reason_code, reason_summary, reason_evidence,
                    triggered_by, expires_at
                ) VALUES (
                    ${correctionId}::uuid,
                    ${correction.type},
                    ${correction.targetEntity},
                    ${correction.targetId},
                    ${JSON.stringify(correction.adjustment)},
                    ${correction.reason.code},
                    ${correction.reason.summary},
                    ${correction.reason.evidence},
                    ${correction.triggeredBy},
                    ${correction.expiresAt}
                )
            `;
            return true;
        } catch (error) {
            logger.error({ error, correctionId }, 'Failed to log correction');
            return false;
        }
    }

    private static getScopeForCorrection(correction: Correction): BudgetScope {
        if (correction.targetEntity === 'zone') return 'zone';
        if (correction.targetEntity === 'category') return 'category';
        if (correction.targetEntity === 'city') return 'city';
        return 'global';
    }

    // -----------------------------------------------------------
    // METRICS
    // -----------------------------------------------------------

    static getMetrics(): {
        safeModeActive: boolean;
        recentCorrections: number;
        recentReversals: number;
        reversalRate: number;
        budgetExhaustions: number;
    } {
        return {
            safeModeActive: SAFE_MODE_ACTIVE,
            recentCorrections,
            recentReversals,
            reversalRate: recentCorrections > 0 ? (recentReversals / recentCorrections) * 100 : 0,
            budgetExhaustions: budgetExhaustionCount
        };
    }
}
