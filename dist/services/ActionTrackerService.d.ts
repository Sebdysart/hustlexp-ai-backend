/**
 * Action Tracker Service
 *
 * Records every user action and learns behavioral patterns.
 * The AI becomes aware of what you're doing in the app.
 *
 * Tracks: viewed, accepted, skipped, completed, cancelled tasks
 * Learns: patterns, preferences, active times
 */
import type { TaskCategory } from '../types/index.js';
import type { ScreenContext } from './UserBrainService.js';
export type ActionType = 'viewed_task' | 'accepted_task' | 'skipped_task' | 'rejected_task' | 'completed_task' | 'cancelled_task' | 'opened_screen' | 'sent_message' | 'claimed_quest' | 'adjusted_price' | 'updated_profile' | 'started_onboarding' | 'completed_onboarding' | 'viewed_badge' | 'shared_card';
export interface TrackedAction {
    id: string;
    userId: string;
    actionType: ActionType;
    screen: ScreenContext;
    metadata: {
        taskId?: string;
        taskCategory?: TaskCategory;
        taskPrice?: number;
        questId?: string;
        badgeId?: string;
        priceValue?: number;
        messageText?: string;
        [key: string]: unknown;
    };
    timestamp: Date;
}
export interface UserActionStats {
    userId: string;
    tasksViewed: number;
    tasksAccepted: number;
    tasksSkipped: number;
    tasksCompleted: number;
    tasksCancelled: number;
    categoryStats: Record<TaskCategory, {
        viewed: number;
        accepted: number;
        skipped: number;
        completed: number;
        acceptanceRate: number;
    }>;
    activeHours: Record<number, number>;
    activeDays: Record<number, number>;
    avgAcceptedPrice: number;
    priceRangeAccepted: {
        min: number;
        max: number;
    };
    mostVisitedScreens: ScreenContext[];
    lastActiveAt: Date;
}
declare class ActionTrackerServiceClass {
    /**
     * Track a user action
     */
    trackAction(userId: string, action: {
        actionType: ActionType;
        screen: ScreenContext;
        metadata?: TrackedAction['metadata'];
    }): TrackedAction;
    /**
     * Get recent actions for a user
     */
    getRecentActions(userId: string, limit?: number): TrackedAction[];
    /**
     * Get recent actions formatted for AI context
     */
    getRecentActionsForAI(userId: string, limit?: number): string[];
    /**
     * Get action stats for a user
     */
    getStats(userId: string): UserActionStats;
    /**
     * Initialize empty stats
     */
    private initializeStats;
    /**
     * Update stats from action
     */
    private updateStats;
    /**
     * Update category-specific stats
     */
    private updateCategoryStats;
    /**
     * Update price stats
     */
    private updatePriceStats;
    /**
     * Analyze behavioral patterns
     */
    analyzePatterns(userId: string): {
        preferredCategories: TaskCategory[];
        avoidedCategories: TaskCategory[];
        peakHours: number[];
        peakDays: number[];
        avgTasksPerDay: number;
        isActive: boolean;
    };
    /**
     * Get acceptance rate for a category
     */
    getCategoryAcceptanceRate(userId: string, category: TaskCategory): number;
    /**
     * Check if user is likely to accept a task
     */
    predictLikelyToAccept(userId: string, task: {
        category: TaskCategory;
        price: number;
    }): {
        likely: boolean;
        confidence: number;
        reason: string;
    };
    /**
     * Clear history for a user (testing)
     */
    clearHistory(userId: string): void;
    /**
     * Get all actions for analytics
     */
    getAllActions(): TrackedAction[];
}
export declare const ActionTrackerService: ActionTrackerServiceClass;
export {};
//# sourceMappingURL=ActionTrackerService.d.ts.map