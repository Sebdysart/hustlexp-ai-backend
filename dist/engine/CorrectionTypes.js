/**
 * CORRECTION TYPES (Phase Ω-ACT)
 *
 * Individual correction implementations with per-type bounds.
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { CorrectionEngine } from './CorrectionEngine.js';
const logger = serviceLogger.child({ module: 'CorrectionTypes' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
export class TaskRoutingCorrection {
    static MAX_MAGNITUDE = 1.0;
    static MAX_EXPIRY_HOURS = 6;
    static MIN_REBOOSTING_HOURS = 6;
    static async apply(params) {
        const { taskId, adjustment, magnitude, reason, triggeredBy } = params;
        // Bound magnitude
        const boundedMagnitude = Math.min(Math.max(magnitude, 0), this.MAX_MAGNITUDE);
        // Check recent boost rule: max 1 per task per 6h
        const recentlyBoosted = await this.wasRecentlyBoosted(taskId);
        if (recentlyBoosted && adjustment === 'boost') {
            logger.warn({ taskId }, 'Task routing blocked - already boosted within 6h');
            return { success: false, correctionId: null, error: 'ALREADY_BOOSTED_RECENTLY' };
        }
        const correction = {
            type: 'task_routing',
            targetEntity: 'task',
            targetId: taskId,
            adjustment: {
                action: adjustment,
                magnitude: boundedMagnitude
            },
            reason,
            expiresAt: new Date(Date.now() + this.MAX_EXPIRY_HOURS * 60 * 60 * 1000),
            triggeredBy
        };
        const result = await CorrectionEngine.apply(correction);
        return {
            success: result.success,
            correctionId: result.correctionId,
            error: result.blockedReason
        };
    }
    static async wasRecentlyBoosted(taskId) {
        const db = getDb();
        if (!db)
            return false;
        try {
            const [row] = await db `
                SELECT 1 FROM correction_log
                WHERE correction_type = 'task_routing'
                AND target_id = ${taskId}
                AND (adjustment->>'action') = 'boost'
                AND applied_at > NOW() - INTERVAL '${this.MIN_REBOOSTING_HOURS} hours'
                AND NOT reversed
                LIMIT 1
            `;
            return !!row;
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to check recent boost');
            return false;
        }
    }
}
export class FrictionCorrection {
    static MAX_EXPIRY_HOURS = 12;
    static async apply(params) {
        const { targetEntity, entityId, adjustment, reason, expiresAt, triggeredBy } = params;
        // Enforce max expiry (12h, not 24)
        const maxExpiry = new Date(Date.now() + this.MAX_EXPIRY_HOURS * 60 * 60 * 1000);
        const boundedExpiry = expiresAt > maxExpiry ? maxExpiry : expiresAt;
        const correction = {
            type: 'friction',
            targetEntity,
            targetId: entityId,
            adjustment: { action: adjustment },
            reason,
            expiresAt: boundedExpiry,
            triggeredBy
        };
        const result = await CorrectionEngine.apply(correction);
        return {
            success: result.success,
            correctionId: result.correctionId,
            error: result.blockedReason
        };
    }
}
export class SupplyNudgeCorrection {
    static MAX_PER_USER_PER_DAY = 3;
    static ZONE_DAILY_CAP = 50;
    static LOW_OPEN_RATE_THRESHOLD = 0.15;
    static SUPPRESS_HOURS = 24;
    static async apply(params) {
        const { zone, category, hustlerIds, message, urgency, reason, triggeredBy } = params;
        // Check zone daily cap
        const zoneCount = await this.getZoneNudgeCount(zone);
        if (zoneCount >= this.ZONE_DAILY_CAP) {
            return { success: false, correctionId: null, nudgedCount: 0, error: 'ZONE_DAILY_CAP_REACHED' };
        }
        // Check zone suppression (low open rate)
        const suppressed = await this.isZoneSuppressed(zone);
        if (suppressed) {
            return { success: false, correctionId: null, nudgedCount: 0, error: 'ZONE_SUPPRESSED_LOW_OPEN_RATE' };
        }
        // Filter eligible hustlers
        const eligibleHustlers = await this.filterEligibleHustlers(hustlerIds);
        if (eligibleHustlers.length === 0) {
            return { success: false, correctionId: null, nudgedCount: 0, error: 'NO_ELIGIBLE_HUSTLERS' };
        }
        const correction = {
            type: 'supply_nudge',
            targetEntity: 'zone',
            targetId: zone,
            adjustment: {
                category,
                hustlerIds: eligibleHustlers,
                message,
                urgency
            },
            reason,
            expiresAt: new Date(Date.now() + 60 * 60 * 1000), // 1h for nudges
            triggeredBy
        };
        const result = await CorrectionEngine.apply(correction);
        if (result.success) {
            // Track nudges sent
            await this.recordNudgesSent(eligibleHustlers);
        }
        return {
            success: result.success,
            correctionId: result.correctionId,
            nudgedCount: eligibleHustlers.length,
            error: result.blockedReason
        };
    }
    static async getZoneNudgeCount(zone) {
        const db = getDb();
        if (!db)
            return 0;
        try {
            const [row] = await db `
                SELECT COUNT(*) as count FROM correction_log
                WHERE correction_type = 'supply_nudge'
                AND target_id = ${zone}
                AND applied_at > NOW() - INTERVAL '24 hours'
            `;
            return parseInt(row?.count || '0');
        }
        catch (error) {
            return 0;
        }
    }
    static async isZoneSuppressed(zone) {
        // TODO: Implement open rate tracking
        // For now, never suppressed
        return false;
    }
    static async filterEligibleHustlers(hustlerIds) {
        const db = getDb();
        if (!db)
            return hustlerIds.slice(0, 10); // Default limit
        try {
            // Find hustlers who haven't been nudged 3+ times today
            const nudgeCounts = await db `
                SELECT (adjustment->>'hustlerIds') as hustlers
                FROM correction_log
                WHERE correction_type = 'supply_nudge'
                AND applied_at > NOW() - INTERVAL '24 hours'
                AND NOT reversed
            `;
            // Count per hustler
            const counts = {};
            for (const row of nudgeCounts) {
                const ids = JSON.parse(row.hustlers || '[]');
                for (const id of ids) {
                    counts[id] = (counts[id] || 0) + 1;
                }
            }
            // Filter
            return hustlerIds.filter(id => (counts[id] || 0) < this.MAX_PER_USER_PER_DAY);
        }
        catch (error) {
            return hustlerIds.slice(0, 10);
        }
    }
    static async recordNudgesSent(hustlerIds) {
        // Tracking is implicit in correction_log
    }
}
export class ProofTimingCorrection {
    static MIN_DEADLINE_HOURS = 4;
    static MAX_DEADLINE_HOURS = 48;
    static MAX_ADJUSTMENTS_PER_TASK = 1;
    static async apply(params) {
        const { taskId, originalDeadlineHours, adjustedDeadlineHours, reason, triggeredBy } = params;
        // Check max adjustments per task
        const existingAdjustments = await this.getAdjustmentCount(taskId);
        if (existingAdjustments >= this.MAX_ADJUSTMENTS_PER_TASK) {
            return { success: false, correctionId: null, error: 'MAX_ADJUSTMENTS_REACHED' };
        }
        // Bound deadline
        const boundedDeadline = Math.min(Math.max(adjustedDeadlineHours, this.MIN_DEADLINE_HOURS), this.MAX_DEADLINE_HOURS);
        const correction = {
            type: 'proof_timing',
            targetEntity: 'task',
            targetId: taskId,
            adjustment: {
                original: originalDeadlineHours,
                adjusted: boundedDeadline
            },
            reason,
            expiresAt: new Date(Date.now() + boundedDeadline * 60 * 60 * 1000),
            triggeredBy
        };
        const result = await CorrectionEngine.apply(correction);
        return {
            success: result.success,
            correctionId: result.correctionId,
            error: result.blockedReason
        };
    }
    static async getAdjustmentCount(taskId) {
        const db = getDb();
        if (!db)
            return 0;
        try {
            const [row] = await db `
                SELECT COUNT(*) as count FROM correction_log
                WHERE correction_type = 'proof_timing'
                AND target_id = ${taskId}
                AND NOT reversed
            `;
            return parseInt(row?.count || '0');
        }
        catch (error) {
            return 0;
        }
    }
}
export class PricingGuidanceCorrection {
    static MIN_MULTIPLIER = 0.5;
    static MAX_MULTIPLIER = 1.5;
    static MAX_DELTA_PER_24H = 0.25;
    static async apply(params) {
        const { category, zone, confidenceMultiplier, reason, triggeredBy } = params;
        // Bound multiplier
        const boundedMultiplier = Math.min(Math.max(confidenceMultiplier, this.MIN_MULTIPLIER), this.MAX_MULTIPLIER);
        // Check 24h delta limit
        const recentDelta = await this.getRecentDelta(category, zone);
        const newDelta = Math.abs(boundedMultiplier - 1.0);
        if (recentDelta + newDelta > this.MAX_DELTA_PER_24H) {
            return { success: false, correctionId: null, error: 'DELTA_LIMIT_EXCEEDED' };
        }
        const correction = {
            type: 'pricing_guidance',
            targetEntity: 'category',
            targetId: `${category}:${zone}`,
            adjustment: {
                category,
                zone,
                multiplier: boundedMultiplier
            },
            reason,
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            triggeredBy
        };
        const result = await CorrectionEngine.apply(correction);
        return {
            success: result.success,
            correctionId: result.correctionId,
            error: result.blockedReason
        };
    }
    static async getRecentDelta(category, zone) {
        const db = getDb();
        if (!db)
            return 0;
        try {
            const rows = await db `
                SELECT adjustment FROM correction_log
                WHERE correction_type = 'pricing_guidance'
                AND target_id = ${`${category}:${zone}`}
                AND applied_at > NOW() - INTERVAL '24 hours'
                AND NOT reversed
            `;
            let totalDelta = 0;
            for (const row of rows) {
                const adj = JSON.parse(row.adjustment);
                totalDelta += Math.abs((adj.multiplier || 1.0) - 1.0);
            }
            return totalDelta;
        }
        catch (error) {
            return 0;
        }
    }
}
//# sourceMappingURL=CorrectionTypes.js.map