/**
 * CORRECTION BUDGET SERVICE (Phase Ω-ACT)
 *
 * Purpose: Prevent runaway intelligence.
 *
 * Budget levels:
 * - Global: 100 corrections per hour
 * - City: 30 corrections per hour
 * - Zone: 10 corrections per hour
 * - Category: 15 corrections per hour
 *
 * If budget exceeded → NO-OP + log
 * No exceptions.
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
const logger = serviceLogger.child({ module: 'CorrectionBudgetService' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// BUDGET CONFIGURATION
// ============================================================
const BUDGET_CONFIG = [
    { scope: 'global', windowMinutes: 60, maxCorrections: 100 },
    { scope: 'city', windowMinutes: 60, maxCorrections: 30 },
    { scope: 'zone', windowMinutes: 60, maxCorrections: 10 },
    { scope: 'category', windowMinutes: 60, maxCorrections: 15 }
];
// ============================================================
// CORRECTION BUDGET SERVICE
// ============================================================
export class CorrectionBudgetService {
    /**
     * CHECK BUDGET
     *
     * Returns whether a correction is allowed given current budget usage.
     * Does NOT consume budget - use consumeBudget after correction succeeds.
     */
    static async checkBudget(scope, scopeId) {
        const config = BUDGET_CONFIG.find(c => c.scope === scope);
        if (!config) {
            return {
                allowed: false,
                currentUsage: 0,
                maxAllowed: 0,
                remainingBudget: 0,
                windowStart: new Date()
            };
        }
        const windowStart = this.getWindowStart(config.windowMinutes);
        const currentUsage = await this.getCurrentUsage(scope, scopeId, windowStart);
        const allowed = currentUsage < config.maxCorrections;
        const remainingBudget = Math.max(0, config.maxCorrections - currentUsage);
        return {
            allowed,
            currentUsage,
            maxAllowed: config.maxCorrections,
            remainingBudget,
            windowStart
        };
    }
    /**
     * CHECK ALL BUDGETS
     *
     * Checks global + specific scope. Both must pass.
     */
    static async checkAllBudgets(scope, scopeId) {
        // Always check global
        const globalCheck = await this.checkBudget('global', 'all');
        const scopeCheck = scope !== 'global'
            ? await this.checkBudget(scope, scopeId)
            : globalCheck;
        const details = {
            global: globalCheck,
            [scope]: scopeCheck
        };
        if (!globalCheck.allowed) {
            return { allowed: false, blockedBy: 'global', details };
        }
        if (!scopeCheck.allowed) {
            return { allowed: false, blockedBy: scope, details };
        }
        return { allowed: true, details };
    }
    /**
     * CONSUME BUDGET
     *
     * Called AFTER correction succeeds to increment usage.
     */
    static async consumeBudget(scope, scopeId) {
        const db = getDb();
        if (!db)
            return;
        const config = BUDGET_CONFIG.find(c => c.scope === scope);
        if (!config)
            return;
        const windowStart = this.getWindowStart(config.windowMinutes);
        try {
            await db `
                INSERT INTO correction_budget_usage (scope, scope_id, window_start, count)
                VALUES (${scope}, ${scopeId}, ${windowStart}, 1)
                ON CONFLICT (scope, scope_id, window_start)
                DO UPDATE SET count = correction_budget_usage.count + 1
            `;
            // Also consume global budget if not already global
            if (scope !== 'global') {
                const globalConfig = BUDGET_CONFIG.find(c => c.scope === 'global');
                const globalWindowStart = this.getWindowStart(globalConfig.windowMinutes);
                await db `
                    INSERT INTO correction_budget_usage (scope, scope_id, window_start, count)
                    VALUES ('global', 'all', ${globalWindowStart}, 1)
                    ON CONFLICT (scope, scope_id, window_start)
                    DO UPDATE SET count = correction_budget_usage.count + 1
                `;
            }
        }
        catch (error) {
            logger.error({ error, scope, scopeId }, 'Failed to consume budget');
        }
    }
    /**
     * GET CURRENT USAGE
     */
    static async getCurrentUsage(scope, scopeId, windowStart) {
        const db = getDb();
        if (!db)
            return 0;
        try {
            const [row] = await db `
                SELECT COALESCE(count, 0) as count
                FROM correction_budget_usage
                WHERE scope = ${scope}
                AND scope_id = ${scopeId}
                AND window_start = ${windowStart}
            `;
            return parseInt(row?.count || '0');
        }
        catch (error) {
            logger.error({ error, scope, scopeId }, 'Failed to get budget usage');
            return 0;
        }
    }
    /**
     * GET WINDOW START
     *
     * Rounds current time down to nearest window boundary.
     */
    static getWindowStart(windowMinutes) {
        const now = new Date();
        const windowMs = windowMinutes * 60 * 1000;
        const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
        return windowStart;
    }
    /**
     * GET BUDGET STATUS (for monitoring)
     */
    static async getBudgetStatus() {
        const global = await this.checkBudget('global', 'all');
        return {
            global,
            exhausted: !global.allowed,
            utilizationPercent: Math.round((global.currentUsage / global.maxAllowed) * 100)
        };
    }
    /**
     * CLEANUP OLD WINDOWS
     *
     * Called periodically to remove old budget tracking rows.
     */
    static async cleanupOldWindows() {
        const db = getDb();
        if (!db)
            return 0;
        try {
            const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000); // 24h ago
            const result = await db `
                DELETE FROM correction_budget_usage
                WHERE window_start < ${cutoff}
            `;
            const deleted = result?.count || 0;
            logger.info({ deleted }, 'Cleaned up old budget windows');
            return deleted;
        }
        catch (error) {
            logger.error({ error }, 'Failed to cleanup old budget windows');
            return 0;
        }
    }
}
//# sourceMappingURL=CorrectionBudgetService.js.map