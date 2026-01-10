import type { Quest, XPEvent } from '../types/index.js';
declare class GamificationServiceClass {
    calculateLevel(xp: number): number;
    getXPForNextLevel(currentXP: number): {
        needed: number;
        progress: number;
    };
    /**
     * PHASE 6.2: Persist XP to database with idempotency
     */
    awardXP(userId: string, amount: number, reason: string, taskId?: string): Promise<XPEvent>;
    awardTaskCompletionXP(userId: string, taskId: string, rating?: number): Promise<number>;
    checkAndAwardStreakBonus(userId: string, streak: number): Promise<number>;
    /**
     * PHASE 6.2: Get XP events from database with fallback
     */
    getUserXPEvents(userId: string, limit?: number): Promise<XPEvent[]>;
    /**
     * PHASE 6.2: Get active quests from database with fallback
     */
    getActiveQuests(userId: string): Promise<Quest[]>;
    generateQuestForUser(userId: string, userStats: {
        recentCategories: string[];
        streak: number;
    }): Promise<Quest | null>;
}
export declare const GamificationService: GamificationServiceClass;
export {};
//# sourceMappingURL=GamificationService.d.ts.map