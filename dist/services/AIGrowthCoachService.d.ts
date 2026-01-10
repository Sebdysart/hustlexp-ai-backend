/**
 * AI Growth Coach Service
 *
 * The brain that knows your hustle better than you do.
 *
 * Features:
 * - Personalized growth plans
 * - Earnings projections
 * - Next best action recommendations
 * - Context-aware coaching tips
 * - Profile optimization suggestions
 */
import type { Task, TaskCategory } from '../types/index.js';
export type ActionType = 'complete_task' | 'accept_task' | 'optimize_profile' | 'unlock_badge' | 'complete_quest' | 'extend_streak' | 'try_new_category';
export type ActionPriority = 'high' | 'medium' | 'low';
export interface NextBestAction {
    type: ActionType;
    title: string;
    description: string;
    xpReward: number;
    moneyPotential?: number;
    priority: ActionPriority;
    taskId?: string;
    questId?: string;
    badgeId?: string;
    expiresIn?: string;
}
export interface EarningsProjection {
    daily: {
        min: number;
        max: number;
        likely: number;
    };
    weekly: {
        min: number;
        max: number;
        likely: number;
    };
    monthly: {
        min: number;
        max: number;
        likely: number;
    };
    topCategory: TaskCategory;
    avgTaskEarning: number;
    tasksPerDay: number;
    growthTrend: 'up' | 'stable' | 'down';
    tips: string[];
}
export interface LevelProgress {
    currentLevel: number;
    currentXP: number;
    xpToNextLevel: number;
    levelProgress: number;
    xpPerDay: number;
    estimatedLevelUpDate: string;
    tasksToLevelUp: number;
}
export interface GrowthPlan {
    userId: string;
    role: 'hustler' | 'poster' | 'both';
    timestamp: Date;
    level: LevelProgress;
    earnings: {
        today: number;
        thisWeek: number;
        thisMonth: number;
        allTime: number;
    };
    projection: EarningsProjection;
    streak: {
        current: number;
        longest: number;
        daysToNextMilestone: number;
        nextMilestoneBonus: number;
    };
    nextBestActions: NextBestAction[];
    suggestedTasks: Task[];
    stats: {
        topCategory: TaskCategory;
        tasksCompleted: number;
        avgRating: number;
        completionRate: number;
    };
    badgesUnlocked: number;
    badgesAvailable: number;
    activeQuests: number;
    questsCompleted: number;
    coachingTip: string;
    profileStrength: number;
    profileSuggestions: string[];
    upcomingUnlocks: {
        name: string;
        requirement: string;
        progress: number;
        maxProgress: number;
        reward: string;
        icon: string;
    }[];
}
export interface CoachingTip {
    tip: string;
    context: string;
    priority: ActionPriority;
    actionable: boolean;
    action?: string;
}
export interface PosterInsights {
    userId: string;
    tasksPosted: number;
    tasksCompleted: number;
    completionRate: number;
    avgTimeToAccept: string;
    avgRatingGiven: number;
    topCategories: TaskCategory[];
    suggestions: string[];
    tipToImprove: string;
}
interface UserStats {
    userId: string;
    role: 'hustler' | 'poster' | 'both';
    tasksCompleted: number;
    tasksByCategory: Record<TaskCategory, number>;
    tasksByDay: Record<string, number>;
    totalEarnings: number;
    earningsByDay: Record<string, number>;
    earningsByCategory: Record<TaskCategory, number>;
    avgTaskDuration: number;
    totalMinutesWorked: number;
    ratings: number[];
    avgRating: number;
    currentStreak: number;
    longestStreak: number;
    hasPhoto: boolean;
    hasBio: boolean;
    skillsCount: number;
    availabilitySet: boolean;
    totalXP: number;
    xpEvents: {
        date: string;
        amount: number;
    }[];
    joinedAt: Date;
    lastActiveAt: Date;
}
declare class AIGrowthCoachServiceClass {
    /**
     * Initialize or get user stats
     */
    private getUserStats;
    /**
     * Record task completion for analytics
     */
    recordTaskCompletion(userId: string, data: {
        category: TaskCategory;
        earnings: number;
        rating?: number;
        durationMinutes?: number;
    }): void;
    /**
     * Update XP for user
     */
    recordXP(userId: string, amount: number): void;
    /**
     * Update streak for user
     */
    updateStreak(userId: string, currentStreak: number): void;
    /**
     * Update profile completeness
     */
    updateProfile(userId: string, updates: Partial<{
        hasPhoto: boolean;
        hasBio: boolean;
        skillsCount: number;
        availabilitySet: boolean;
    }>): void;
    /**
     * Get full personalized growth plan
     */
    getGrowthPlan(userId: string): Promise<GrowthPlan>;
    /**
     * Calculate level progress
     */
    private calculateLevelProgress;
    /**
     * Calculate earnings projection
     */
    private calculateEarningsProjection;
    /**
     * Get earnings tips based on stats
     */
    private getEarningsTips;
    /**
     * Calculate streak info
     */
    private calculateStreakInfo;
    /**
     * Get next best actions for user
     */
    getNextBestActions(userId: string, stats?: UserStats): Promise<NextBestAction[]>;
    /**
     * Get single next best action
     */
    getNextBestAction(userId: string): Promise<NextBestAction | null>;
    /**
     * Get optimal tasks for this user
     */
    getOptimalTasks(userId: string, limit?: number): Promise<Task[]>;
    /**
     * Get context-aware coaching tip
     */
    getCoachingTip(userId: string, stats?: UserStats, context?: string): Promise<CoachingTip>;
    /**
     * Get poster insights (for clients)
     */
    getPosterInsights(userId: string): PosterInsights;
    /**
     * Get task listing optimization suggestions
     */
    getListingOptimization(task: Task): Promise<string[]>;
    private getTopCategory;
    private getWeekEarnings;
    private getMonthEarnings;
    private calculateProfileStrength;
    private getProfileSuggestions;
    private getUpcomingUnlocks;
}
export declare const AIGrowthCoachService: AIGrowthCoachServiceClass;
export {};
//# sourceMappingURL=AIGrowthCoachService.d.ts.map