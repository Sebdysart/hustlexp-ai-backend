/**
 * User Brain Service
 *
 * The "learned model" of each user that grows smarter over time.
 * Stores goals, constraints, preferences, and behavioral patterns.
 *
 * Core insight: Every interaction → learning → better next response
 */
import type { TaskCategory } from '../types/index.js';
export interface UserGoals {
    monthlyIncomeTarget?: number;
    weeklyIncomeTarget?: number;
    shortTermGoal?: string;
    weeklyTaskTarget?: number;
    customGoalText?: string;
}
export interface UserConstraints {
    hasCar: boolean;
    petFriendly: boolean;
    maxDistanceKm?: number;
    canDoHeavyLifting: boolean;
    hasTools: boolean;
    availableTimes: AvailabilityTime[];
    unavailableDays: number[];
    locationPreference?: string;
}
export type AvailabilityTime = 'mornings' | 'afternoons' | 'evenings' | 'nights' | 'weekends';
export interface TaskPreferences {
    preferredCategories: TaskCategory[];
    avoidedCategories: TaskCategory[];
    preferredPriceRange: {
        min: number;
        max: number;
    };
    prefersShortTasks: boolean;
    prefersIndoorTasks: boolean;
    maxTaskDurationMinutes?: number;
}
export interface EngagementStyle {
    respondsToQuests: boolean;
    maintainsStreak: boolean;
    activeHours: number[];
    activeDays: number[];
    avgTasksPerWeek: number;
    avgResponseTimeMinutes: number;
    prefersChatCoaching: boolean;
}
export interface UserBrain {
    userId: string;
    role: 'hustler' | 'client' | 'both';
    goals: UserGoals;
    constraints: UserConstraints;
    taskPreferences: TaskPreferences;
    engagementStyle: EngagementStyle;
    aiHistorySummary: string;
    recentFacts: string[];
    totalInteractions: number;
    learningScore: number;
    createdAt: Date;
    updatedAt: Date;
    lastActiveAt: Date;
}
export interface AIContext {
    userId: string;
    role: 'hustler' | 'client' | 'both';
    level: number;
    xp: number;
    streakDays: number;
    earningsLast7d: number;
    topCategories: TaskCategory[];
    goals: UserGoals;
    constraints: UserConstraints;
    taskPreferences: TaskPreferences;
    aiHistorySummary: string;
    learningScore: number;
}
export type ScreenContext = 'home' | 'feed' | 'task_create' | 'task_detail' | 'profile' | 'earnings' | 'quests' | 'badges' | 'settings' | 'onboarding' | 'wallet' | 'chat';
declare class UserBrainServiceClass {
    /**
     * Get or initialize a user's brain
     */
    getUserBrain(userId: string): UserBrain;
    /**
     * Initialize a new brain with defaults
     */
    private initializeBrain;
    /**
     * Update brain from a chat message
     * Uses AIMemoryService for AI-powered extraction (Phase 2 upgrade)
     */
    updateFromChat(userId: string, userMessage: string, aiResponse?: string): Promise<void>;
    /**
     * Extract structured preferences from a message
     */
    private extractPreferencesFromMessage;
    /**
     * Calculate how well we know this user (0-100)
     */
    private calculateLearningScore;
    /**
     * Generate a compressed summary of what we know
     */
    private generateSummary;
    /**
     * Build full context for AI orchestrator
     */
    getContextForAI(userId: string): Promise<AIContext>;
    /**
     * Update brain from behavioral action (task accepted, skipped, etc.)
     */
    updateFromAction(userId: string, action: {
        type: 'accepted_task' | 'skipped_task' | 'completed_task' | 'cancelled_task';
        category?: TaskCategory;
        price?: number;
        durationMinutes?: number;
    }): void;
    /**
     * Get raw brain data for debugging
     */
    getRawBrain(userId: string): UserBrain | undefined;
    /**
     * Reset a user's brain (for testing)
     */
    resetBrain(userId: string): void;
    /**
     * Get all brains for analytics
     */
    getAllBrains(): UserBrain[];
}
export declare const UserBrainService: UserBrainServiceClass;
export {};
//# sourceMappingURL=UserBrainService.d.ts.map