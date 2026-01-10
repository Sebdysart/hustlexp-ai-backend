/**
 * Contextual Coach Service
 *
 * Tips that appear based on what the user is doing, creating
 * "wtf, this app knows me" moments.
 *
 * Context signals:
 * - Current screen
 * - Time of day (golden hour: 5-8 PM)
 * - Day of week (weekends = higher demand)
 * - User's level and XP
 * - Current streak
 * - Tasks completed today
 * - Earnings today
 */
import type { TaskCategory } from '../types/index.js';
export type ScreenContext = 'feed' | 'task_detail' | 'checkout' | 'profile' | 'earnings' | 'dispute' | 'onboarding' | 'quest_list' | 'badge_list' | 'accept_task' | 'complete_task' | 'home';
export type TipPriority = 'urgent' | 'high' | 'medium' | 'low';
export type TipCategory = 'streak' | 'earnings' | 'level' | 'opportunity' | 'profile' | 'quest' | 'badge' | 'time';
export interface ContextualTip {
    id: string;
    category: TipCategory;
    priority: TipPriority;
    icon: string;
    title: string;
    message: string;
    actionText?: string;
    actionDeepLink?: string;
    expiresAt?: Date;
    dismissible: boolean;
}
export interface UserContext {
    userId: string;
    screen: ScreenContext;
    hour: number;
    dayOfWeek: number;
    isWeekend: boolean;
    isGoldenHour: boolean;
    level: number;
    xp: number;
    xpToNextLevel: number;
    streak: number;
    tasksToday: number;
    earningsToday: number;
    earningsThisWeek: number;
    profileComplete: boolean;
    hasPhoto: boolean;
    hasBio: boolean;
    taskCategory?: TaskCategory;
    taskPrice?: number;
}
declare class ContextualCoachServiceClass {
    /**
     * Get or initialize user day stats
     */
    private getUserDayStats;
    /**
     * Record task completion for contextual awareness
     */
    recordActivity(userId: string, earnings: number): void;
    /**
     * Reset daily stats (call at midnight)
     */
    resetDailyStats(userId: string): void;
    /**
     * Reset weekly stats (call Sunday)
     */
    resetWeeklyStats(userId: string): void;
    /**
     * Build full user context
     */
    private buildContext;
    /**
     * Get contextual tip for current screen
     */
    getTipForScreen(userId: string, screen: ScreenContext, additionalContext?: Partial<UserContext>): ContextualTip | null;
    /**
     * Get the best contextual tip right now (any screen)
     */
    getContextualTip(userId: string, additionalContext?: Partial<UserContext>): ContextualTip | null;
    /**
     * Get time-sensitive tip
     */
    getTimeSensitiveTip(userId: string): ContextualTip | null;
    /**
     * Get streak-related tip
     */
    getStreakTip(userId: string, currentStreak: number): ContextualTip | null;
    /**
     * Get all relevant tips for user (for notification digest)
     */
    getAllRelevantTips(userId: string, limit?: number): ContextualTip[];
}
export declare const ContextualCoachService: ContextualCoachServiceClass;
export {};
//# sourceMappingURL=ContextualCoachService.d.ts.map