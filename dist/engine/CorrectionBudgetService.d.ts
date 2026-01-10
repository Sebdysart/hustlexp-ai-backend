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
export type BudgetScope = 'global' | 'city' | 'zone' | 'category';
interface BudgetCheckResult {
    allowed: boolean;
    currentUsage: number;
    maxAllowed: number;
    remainingBudget: number;
    windowStart: Date;
}
export declare class CorrectionBudgetService {
    /**
     * CHECK BUDGET
     *
     * Returns whether a correction is allowed given current budget usage.
     * Does NOT consume budget - use consumeBudget after correction succeeds.
     */
    static checkBudget(scope: BudgetScope, scopeId: string): Promise<BudgetCheckResult>;
    /**
     * CHECK ALL BUDGETS
     *
     * Checks global + specific scope. Both must pass.
     */
    static checkAllBudgets(scope: BudgetScope, scopeId: string): Promise<{
        allowed: boolean;
        blockedBy?: BudgetScope;
        details: Record<BudgetScope, BudgetCheckResult>;
    }>;
    /**
     * CONSUME BUDGET
     *
     * Called AFTER correction succeeds to increment usage.
     */
    static consumeBudget(scope: BudgetScope, scopeId: string): Promise<void>;
    /**
     * GET CURRENT USAGE
     */
    private static getCurrentUsage;
    /**
     * GET WINDOW START
     *
     * Rounds current time down to nearest window boundary.
     */
    private static getWindowStart;
    /**
     * GET BUDGET STATUS (for monitoring)
     */
    static getBudgetStatus(): Promise<{
        global: BudgetCheckResult;
        exhausted: boolean;
        utilizationPercent: number;
    }>;
    /**
     * CLEANUP OLD WINDOWS
     *
     * Called periodically to remove old budget tracking rows.
     */
    static cleanupOldWindows(): Promise<number>;
}
export {};
//# sourceMappingURL=CorrectionBudgetService.d.ts.map