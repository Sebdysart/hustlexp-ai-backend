/**
 * Dynamic Badge Engine
 *
 * AI-generated badges that feel personal and earned.
 * Badges = digital flex + matching multiplier
 *
 * Categories:
 * - Location: Seattle Pioneer, Capitol Hill Regular
 * - Speed: Lightning Level Up, Speed Demon
 * - Consistency: Streak Master, Monthly Legend
 * - Category: Verified Craftsman, Pet Whisperer
 * - Earnings: Hundred Club, Grand Hustler
 * - Quality: Perfect Five, Client Favorite
 * - Time: Golden Hour Hustler, Early Bird
 * - Seasonal: Seattle Winter Hustle
 * - Special: Beta Pioneer
 */
import type { TaskCategory } from '../types/index.js';
export type BadgeCategory = 'location' | 'speed' | 'consistency' | 'category' | 'earnings' | 'quality' | 'time' | 'seasonal' | 'special';
export type BadgeRarity = 'common' | 'rare' | 'epic' | 'legendary';
export interface BadgeDefinition {
    id: string;
    name: string;
    description: string;
    icon: string;
    category: BadgeCategory;
    rarity: BadgeRarity;
    xpReward: number;
    condition: BadgeCondition;
}
export interface BadgeCondition {
    type: 'count' | 'streak' | 'amount' | 'time' | 'location' | 'rating' | 'special';
    target: number;
    taskCategory?: TaskCategory;
    timeWindow?: 'day' | 'week' | 'month' | 'all';
    locations?: string[];
    timeRange?: {
        start: number;
        end: number;
    };
}
export interface UserBadge {
    badgeId: string;
    userId: string;
    unlockedAt: Date;
    xpAwarded: number;
}
export interface BadgeProgress {
    badge: BadgeDefinition;
    currentProgress: number;
    maxProgress: number;
    percentComplete: number;
    isUnlocked: boolean;
    unlockedAt?: Date;
}
declare class DynamicBadgeEngineClass {
    /**
     * Get all badge definitions
     */
    getAllBadges(): BadgeDefinition[];
    /**
     * Get badges by category
     */
    getBadgesByCategory(category: BadgeCategory): BadgeDefinition[];
    /**
     * Get seasonal badges (currently active)
     */
    getSeasonalBadges(): BadgeDefinition[];
    /**
     * Initialize or get user badge data
     */
    private getUserData;
    /**
     * Record a task completion for badge evaluation
     */
    recordTaskCompletion(userId: string, taskData: {
        category: TaskCategory;
        location?: string;
        earnings: number;
        rating?: number;
        durationMinutes?: number;
        clientId?: string;
    }): void;
    /**
     * Update streak for user
     */
    updateStreak(userId: string, currentStreak: number): void;
    /**
     * Reset daily counters (call at midnight)
     */
    resetDailyCounters(userId: string): void;
    /**
     * Reset weekly counters (call on Sunday)
     */
    resetWeeklyCounters(userId: string): void;
    /**
     * Evaluate and award badges for a user
     */
    evaluateBadges(userId: string): Promise<{
        newBadges: UserBadge[];
        totalXPAwarded: number;
    }>;
    /**
     * Check if a badge condition is met
     */
    private checkBadgeCondition;
    /**
     * Get all badges with progress for a user
     */
    getBadgeProgress(userId: string): BadgeProgress[];
    /**
     * Calculate progress toward a badge
     */
    private calculateProgress;
    /**
     * Get recently unlocked badges
     */
    getRecentBadges(userId: string, limit?: number): (UserBadge & {
        badge: BadgeDefinition;
    })[];
    /**
     * Get public showcase badges for a user's profile
     */
    getBadgeShowcase(userId: string): BadgeDefinition[];
    /**
     * Get user's total badge count by rarity
     */
    getBadgeStats(userId: string): {
        total: number;
        byRarity: Record<BadgeRarity, number>;
        byCategory: Record<BadgeCategory, number>;
    };
    /**
     * Award the Beta Pioneer badge to a user
     */
    awardBetaPioneer(userId: string): UserBadge | null;
}
export declare const DynamicBadgeEngine: DynamicBadgeEngineClass;
export {};
//# sourceMappingURL=DynamicBadgeEngine.d.ts.map