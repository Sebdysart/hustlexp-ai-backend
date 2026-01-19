/**
 * ATOMIC XP AWARD SERVICE (BUILD_GUIDE Aligned)
 *
 * This module enforces BUILD_GUIDE invariants:
 * - INV-5: XP idempotent per money_state_lock (one award per escrow, ever)
 * - INV-XP-2: XP requires RELEASED money state
 * - FIX 1: Escrow release + XP award in single transaction
 * - AUDIT-5: Fixed-point arithmetic via Decimal.js
 * - AUDIT-6: Streak day boundary (UTC + 2h grace)
 *
 * ALIGNS WITH REPO:
 * - Uses `users` table directly (xp, level, streak columns)
 * - Uses `money_state_lock` for escrow state
 * - Uses `xp_ledger` for audit trail
 * - Uses `tasks` for task reference
 *
 * CONSTITUTIONAL: This code enforces law. Do not modify without review.
 */
/**
 * Level thresholds from BUILD_GUIDE
 */
export declare const LEVEL_THRESHOLDS: readonly [{
    readonly level: 1;
    readonly xpRequired: 0;
}, {
    readonly level: 2;
    readonly xpRequired: 100;
}, {
    readonly level: 3;
    readonly xpRequired: 300;
}, {
    readonly level: 4;
    readonly xpRequired: 700;
}, {
    readonly level: 5;
    readonly xpRequired: 1500;
}, {
    readonly level: 6;
    readonly xpRequired: 2700;
}, {
    readonly level: 7;
    readonly xpRequired: 4500;
}, {
    readonly level: 8;
    readonly xpRequired: 7000;
}, {
    readonly level: 9;
    readonly xpRequired: 10500;
}, {
    readonly level: 10;
    readonly xpRequired: 18500;
}];
/**
 * Streak multipliers from BUILD_GUIDE
 */
export declare const STREAK_MULTIPLIERS: readonly [{
    readonly minDays: 0;
    readonly maxDays: 2;
    readonly multiplier: "1.0";
}, {
    readonly minDays: 3;
    readonly maxDays: 6;
    readonly multiplier: "1.1";
}, {
    readonly minDays: 7;
    readonly maxDays: 13;
    readonly multiplier: "1.2";
}, {
    readonly minDays: 14;
    readonly maxDays: 29;
    readonly multiplier: "1.3";
}, {
    readonly minDays: 30;
    readonly maxDays: number;
    readonly multiplier: "1.5";
}];
/**
 * Calculate XP decay factor based on total XP (BUILD_GUIDE formula)
 * Formula: 1 / (1 + log₁₀(1 + totalXP/1000))
 */
export declare function calculateDecayFactor(totalXP: number): Decimal;
/**
 * Calculate effective XP after decay
 */
export declare function calculateEffectiveXP(baseXP: number, totalXP: number): number;
/**
 * Get streak multiplier for given streak days
 */
export declare function getStreakMultiplier(streakDays: number): Decimal;
/**
 * Calculate base XP from task price (cents)
 * Base: 10 XP per $10, minimum 10 XP
 */
export declare function calculateBaseXP(amountCents: number): number;
/**
 * Calculate level from total XP
 */
export declare function calculateLevel(totalXP: number): number;
/**
 * Check if a timestamp is within the same "streak day"
 * Streak day = UTC day with 2-hour grace period
 */
export declare function isWithinStreakGrace(lastActiveAt: Date | null): boolean;
/**
 * Calculate new streak based on last active date
 */
export declare function calculateNewStreak(currentStreak: number, lastActiveAt: Date | null): number;
export interface XPAwardResult {
    success: boolean;
    xpAwarded: number;
    baseXP: number;
    decayFactor: string;
    effectiveXP: number;
    streakMultiplier: string;
    finalXP: number;
    newTotalXP: number;
    newLevel: number;
    previousLevel: number;
    leveledUp: boolean;
    newStreak: number;
    alreadyAwarded: boolean;
    error?: string;
}
/**
 * Award XP for a released escrow — ATOMIC TRANSACTION
 *
 * INVARIANTS ENFORCED:
 * - INV-5: XP idempotent per money_state_lock (UNIQUE constraint on money_state_lock_task_id)
 * - INV-XP-2: Requires RELEASED money state (state check)
 * - FIX 1: Single transaction for all operations
 *
 * ALIGNS WITH REPO:
 * - Uses `users` table for xp, level, streak
 * - Uses `money_state_lock` for escrow state
 * - Uses `xp_ledger` for audit trail
 *
 * @param taskId - The task ID (also the key in money_state_lock)
 * @param hustlerId - The hustler's user ID (UUID)
 * @returns XPAwardResult
 */
export declare function awardXPForTask(taskId: string, hustlerId: string): Promise<XPAwardResult>;
/**
 * Get XP ledger history for a user
 */
export declare function getXPHistory(userId: string, limit?: number): Promise<Array<{
    taskId: string | null;
    baseXP: number;
    finalXP: number;
    reason: string;
    createdAt: Date;
}>>;
export declare const __test__: {
    calculateDecayFactor: typeof calculateDecayFactor;
    calculateEffectiveXP: typeof calculateEffectiveXP;
    getStreakMultiplier: typeof getStreakMultiplier;
    calculateBaseXP: typeof calculateBaseXP;
    calculateLevel: typeof calculateLevel;
    isWithinStreakGrace: typeof isWithinStreakGrace;
    calculateNewStreak: typeof calculateNewStreak;
};
//# sourceMappingURL=AtomicXPService.d.ts.map