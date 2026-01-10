/**
 * TASK CHAINING ENGINE (Phase 17 - Component 2)
 *
 * Purpose: Detect when HustleXP becomes a workday, not a task.
 *
 * Multi-task chaining happens when hustlers naturally perform
 * sequences of tasks:
 *   Moving → Cleanup → Furniture Assembly
 *
 * This creates:
 * - Compound earnings loops
 * - Psychological commitment
 * - Switching cost through routine
 *
 * CONSTRAINTS:
 * - ADVISORY ONLY: No forced routing
 * - NO KERNEL: Financial layer frozen
 * - READ-ONLY: Detection and measurement only
 */
export interface TaskChain {
    id: string;
    hustlerId: string;
    zone: string;
    date: Date;
    tasks: {
        taskId: string;
        category: string;
        earnings: number;
        completedAt: Date;
    }[];
    chainLength: number;
    totalEarnings: number;
    durationHours: number;
    categorySequence: string[];
    isRecurringPattern: boolean;
}
export interface ZoneChainingMetrics {
    zone: string;
    generatedAt: Date;
    chainStrength: number;
    avgChainLength: number;
    maxChainLength: number;
    earningsUpliftPct: number;
    topPatterns: {
        sequence: string[];
        frequency: number;
        avgEarnings: number;
    }[];
    chainingHustlerPct: number;
    superChainerCount: number;
    workdayConversion: string;
    dominanceContribution: string;
}
export declare class TaskChainingEngine {
    /**
     * DETECT CHAINS FOR ZONE
     */
    static getZoneChainingMetrics(zone: string): Promise<ZoneChainingMetrics>;
    /**
     * GET HUSTLER CHAINS
     */
    static getHustlerChains(hustlerId: string): Promise<{
        totalChains: number;
        avgChainLength: number;
        totalChainEarnings: number;
        favoritePattern: string[];
        isWorkdayHustler: boolean;
    }>;
    /**
     * SUGGEST CHAIN OPPORTUNITIES
     */
    static suggestChainOpportunities(hustlerId: string, zone: string): Promise<{
        currentTasks: string[];
        suggestedNext: {
            category: string;
            reason: string;
            estimatedEarnings: number;
        }[];
    }>;
    private static detectChains;
    private static detectHustlerChains;
    private static getTotalHustlers;
    private static getSingleTaskAvgEarnings;
    private static findTopPatterns;
    private static assessWorkdayConversion;
    private static assessDominanceContribution;
    private static generateMockChains;
}
//# sourceMappingURL=TaskChainingEngine.d.ts.map