/**
 * Quest Engine
 *
 * Daily/Weekly/Seasonal quests with rewards.
 * Quests = dopamine loops for daily retention.
 *
 * Quest Types:
 * - Daily: Reset at midnight, quick wins
 * - Weekly: Bigger goals, better rewards
 * - Seasonal: Epic challenges, legendary badges
 * - Chains: Complete one to unlock next
 */
import type { TaskCategory } from '../types/index.js';
export type QuestFrequency = 'daily' | 'weekly' | 'seasonal' | 'one_time';
export type QuestDifficulty = 'easy' | 'medium' | 'hard' | 'epic';
export type QuestStatus = 'active' | 'completed' | 'expired' | 'claimed';
export interface QuestDefinition {
    id: string;
    title: string;
    description: string;
    frequency: QuestFrequency;
    difficulty: QuestDifficulty;
    goalType: QuestGoalType;
    goalValue: number;
    goalCategory?: TaskCategory;
    xpReward: number;
    bonusRewardType?: 'badge' | 'perk' | 'multiplier';
    bonusRewardId?: string;
    chainId?: string;
    chainStep?: number;
    icon: string;
}
export type QuestGoalType = 'complete_tasks' | 'complete_category' | 'earn_amount' | 'maintain_streak' | 'get_rating' | 'complete_fast' | 'complete_time_range';
export interface UserQuest {
    id: string;
    questDefinitionId: string;
    userId: string;
    status: QuestStatus;
    currentProgress: number;
    goalValue: number;
    xpReward: number;
    bonusRewardType?: string;
    bonusRewardId?: string;
    createdAt: Date;
    expiresAt: Date;
    completedAt?: Date;
    claimedAt?: Date;
}
export interface QuestWithDefinition extends UserQuest {
    definition: QuestDefinition;
    percentComplete: number;
    timeRemaining: string;
}
declare class QuestEngineClass {
    /**
     * Get all available quest definitions
     */
    getAllQuestDefinitions(): QuestDefinition[];
    /**
     * Initialize quests for a new user
     */
    initializeUserQuests(userId: string): void;
    /**
     * Create a user quest from a definition
     */
    private createUserQuest;
    /**
     * Select random quests from a list
     */
    private selectRandomQuests;
    /**
     * Get daily quests for a user
     */
    getDailyQuests(userId: string): QuestWithDefinition[];
    /**
     * Get weekly quests for a user
     */
    getWeeklyQuests(userId: string): QuestWithDefinition[];
    /**
     * Get seasonal quests for a user
     */
    getSeasonalQuests(userId: string): QuestWithDefinition[];
    /**
     * Get all active quests for a user
     */
    getAllActiveQuests(userId: string): QuestWithDefinition[];
    /**
     * Get quests by frequency
     */
    private getQuestsByFrequency;
    /**
     * Enrich a quest with its definition and computed fields
     */
    private enrichQuest;
    /**
     * Format time remaining as human-readable string
     */
    private formatTimeRemaining;
    /**
     * Update quest progress after task completion
     */
    updateProgress(userId: string, eventData: {
        type: 'task_completed' | 'earned' | 'rating' | 'streak';
        value: number;
        category?: TaskCategory;
        durationMinutes?: number;
    }): {
        updatedQuests: QuestWithDefinition[];
        completedQuests: QuestWithDefinition[];
    };
    /**
     * Claim rewards for a completed quest
     */
    claimQuest(userId: string, questId: string): {
        success: boolean;
        xpAwarded: number;
        bonusReward?: {
            type: string;
            id: string;
        };
        message: string;
    };
    /**
     * Refresh daily quests (call at midnight)
     */
    refreshDailyQuests(userId: string): QuestWithDefinition[];
    /**
     * Refresh weekly quests (call on Sunday)
     */
    refreshWeeklyQuests(userId: string): QuestWithDefinition[];
    /**
     * Get quest completion stats
     */
    getQuestStats(userId: string): {
        totalCompleted: number;
        dailyCompleted: number;
        weeklyCompleted: number;
        seasonalCompleted: number;
        totalXPFromQuests: number;
    };
    /**
     * Generate a personalized quest using AI
     */
    generatePersonalizedQuest(userId: string, userStats: {
        topCategories: TaskCategory[];
        currentStreak: number;
        recentEarnings: number;
        level: number;
    }): Promise<QuestDefinition | null>;
    private getEndOfDay;
    private getEndOfWeek;
    private getSeasonEnd;
}
export declare const QuestEngine: QuestEngineClass;
export {};
//# sourceMappingURL=QuestEngine.d.ts.map