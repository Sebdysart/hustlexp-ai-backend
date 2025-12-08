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

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import type { TaskCategory } from '../types/index.js';

// ============================================
// Badge Types
// ============================================

export type BadgeCategory =
    | 'location'
    | 'speed'
    | 'consistency'
    | 'category'
    | 'earnings'
    | 'quality'
    | 'time'
    | 'seasonal'
    | 'special';

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
    timeRange?: { start: number; end: number }; // hours 0-23
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

// ============================================
// Badge Definitions
// ============================================

const BADGE_DEFINITIONS: BadgeDefinition[] = [
    // === LOCATION BADGES ===
    {
        id: 'seattle_pioneer',
        name: 'Seattle Pioneer',
        description: 'Completed tasks in 5 different Seattle neighborhoods',
        icon: '🗺️',
        category: 'location',
        rarity: 'rare',
        xpReward: 100,
        condition: { type: 'location', target: 5 },
    },
    {
        id: 'capitol_hill_regular',
        name: 'Capitol Hill Regular',
        description: 'Completed 10 tasks in Capitol Hill',
        icon: '🏔️',
        category: 'location',
        rarity: 'epic',
        xpReward: 150,
        condition: { type: 'count', target: 10, locations: ['capitol hill'] },
    },
    {
        id: 'downtown_hustler',
        name: 'Downtown Hustler',
        description: 'Completed 15 tasks in Downtown Seattle',
        icon: '🏙️',
        category: 'location',
        rarity: 'epic',
        xpReward: 150,
        condition: { type: 'count', target: 15, locations: ['downtown', 'belltown'] },
    },

    // === SPEED BADGES ===
    {
        id: 'lightning_level_up',
        name: 'Lightning Level Up',
        description: 'Completed 3 tasks in 24 hours',
        icon: '⚡',
        category: 'speed',
        rarity: 'rare',
        xpReward: 75,
        condition: { type: 'count', target: 3, timeWindow: 'day' },
    },
    {
        id: 'speed_demon',
        name: 'Speed Demon',
        description: 'Completed a task in under 30 minutes',
        icon: '💨',
        category: 'speed',
        rarity: 'common',
        xpReward: 25,
        condition: { type: 'time', target: 30 },
    },
    {
        id: 'task_machine',
        name: 'Task Machine',
        description: 'Completed 5 tasks in one day',
        icon: '🤖',
        category: 'speed',
        rarity: 'epic',
        xpReward: 150,
        condition: { type: 'count', target: 5, timeWindow: 'day' },
    },

    // === CONSISTENCY BADGES ===
    {
        id: 'streak_starter',
        name: 'Streak Starter',
        description: 'Maintained a 3-day task streak',
        icon: '🔥',
        category: 'consistency',
        rarity: 'common',
        xpReward: 25,
        condition: { type: 'streak', target: 3 },
    },
    {
        id: 'streak_master',
        name: 'Streak Master',
        description: 'Maintained a 7-day task streak',
        icon: '🔥🔥',
        category: 'consistency',
        rarity: 'epic',
        xpReward: 200,
        condition: { type: 'streak', target: 7 },
    },
    {
        id: 'monthly_legend',
        name: 'Monthly Legend',
        description: 'Maintained a 30-day task streak',
        icon: '👑',
        category: 'consistency',
        rarity: 'legendary',
        xpReward: 500,
        condition: { type: 'streak', target: 30 },
    },
    {
        id: 'never_miss',
        name: 'Never Miss',
        description: 'Maintained a 14-day task streak',
        icon: '🎯',
        category: 'consistency',
        rarity: 'epic',
        xpReward: 250,
        condition: { type: 'streak', target: 14 },
    },

    // === CATEGORY BADGES ===
    {
        id: 'verified_craftsman',
        name: 'Verified Craftsman',
        description: 'Completed 10 handyman tasks with 5-star ratings',
        icon: '🔧',
        category: 'category',
        rarity: 'epic',
        xpReward: 200,
        condition: { type: 'count', target: 10, taskCategory: 'handyman' },
    },
    {
        id: 'pet_whisperer',
        name: 'Pet Whisperer',
        description: 'Completed 10 pet care tasks',
        icon: '🐕',
        category: 'category',
        rarity: 'rare',
        xpReward: 100,
        condition: { type: 'count', target: 10, taskCategory: 'pet_care' },
    },
    {
        id: 'ikea_expert',
        name: 'IKEA Expert',
        description: 'Completed 5 furniture assembly tasks',
        icon: '🪑',
        category: 'category',
        rarity: 'rare',
        xpReward: 100,
        condition: { type: 'count', target: 5, taskCategory: 'handyman' },
    },
    {
        id: 'cleaning_pro',
        name: 'Cleaning Pro',
        description: 'Completed 15 cleaning tasks',
        icon: '✨',
        category: 'category',
        rarity: 'epic',
        xpReward: 150,
        condition: { type: 'count', target: 15, taskCategory: 'cleaning' },
    },
    {
        id: 'delivery_ace',
        name: 'Delivery Ace',
        description: 'Completed 20 delivery tasks',
        icon: '📦',
        category: 'category',
        rarity: 'epic',
        xpReward: 150,
        condition: { type: 'count', target: 20, taskCategory: 'delivery' },
    },
    {
        id: 'moving_master',
        name: 'Moving Master',
        description: 'Completed 10 moving tasks',
        icon: '🚚',
        category: 'category',
        rarity: 'epic',
        xpReward: 200,
        condition: { type: 'count', target: 10, taskCategory: 'moving' },
    },
    {
        id: 'jack_of_all_trades',
        name: 'Jack of All Trades',
        description: 'Completed tasks in 5 different categories',
        icon: '🃏',
        category: 'category',
        rarity: 'rare',
        xpReward: 125,
        condition: { type: 'count', target: 5 },
    },

    // === EARNINGS BADGES ===
    {
        id: 'first_hundred',
        name: 'First Hundred',
        description: 'Earned your first $100',
        icon: '💵',
        category: 'earnings',
        rarity: 'common',
        xpReward: 50,
        condition: { type: 'amount', target: 100, timeWindow: 'all' },
    },
    {
        id: 'hundred_club',
        name: 'Hundred Club',
        description: 'Earned $100 in a single day',
        icon: '💰',
        category: 'earnings',
        rarity: 'rare',
        xpReward: 75,
        condition: { type: 'amount', target: 100, timeWindow: 'day' },
    },
    {
        id: 'five_hundred_week',
        name: 'Weekly Warrior',
        description: 'Earned $500 in a week',
        icon: '🏆',
        category: 'earnings',
        rarity: 'epic',
        xpReward: 175,
        condition: { type: 'amount', target: 500, timeWindow: 'week' },
    },
    {
        id: 'grand_hustler',
        name: 'Grand Hustler',
        description: 'Earned $1,000 total on HustleXP',
        icon: '🎖️',
        category: 'earnings',
        rarity: 'legendary',
        xpReward: 300,
        condition: { type: 'amount', target: 1000, timeWindow: 'all' },
    },
    {
        id: 'five_grand',
        name: 'Five Grand Club',
        description: 'Earned $5,000 total on HustleXP',
        icon: '💎',
        category: 'earnings',
        rarity: 'legendary',
        xpReward: 500,
        condition: { type: 'amount', target: 5000, timeWindow: 'all' },
    },

    // === QUALITY BADGES ===
    {
        id: 'perfect_start',
        name: 'Perfect Start',
        description: 'Received a 5-star rating on your first task',
        icon: '⭐',
        category: 'quality',
        rarity: 'common',
        xpReward: 30,
        condition: { type: 'rating', target: 5 },
    },
    {
        id: 'perfect_five',
        name: 'Perfect Five',
        description: 'Received 10 consecutive 5-star ratings',
        icon: '🌟',
        category: 'quality',
        rarity: 'epic',
        xpReward: 150,
        condition: { type: 'count', target: 10 },
    },
    {
        id: 'client_favorite',
        name: 'Client Favorite',
        description: 'Completed tasks for 5 repeat clients',
        icon: '❤️',
        category: 'quality',
        rarity: 'rare',
        xpReward: 100,
        condition: { type: 'count', target: 5 },
    },
    {
        id: 'five_star_hustler',
        name: 'Five Star Hustler',
        description: 'Maintained 4.8+ rating across 20+ tasks',
        icon: '⭐⭐⭐⭐⭐',
        category: 'quality',
        rarity: 'legendary',
        xpReward: 250,
        condition: { type: 'rating', target: 4.8 },
    },

    // === TIME BADGES ===
    {
        id: 'golden_hour_hustler',
        name: 'Golden Hour Hustler',
        description: 'Completed 10 tasks between 5-8 PM',
        icon: '🌅',
        category: 'time',
        rarity: 'rare',
        xpReward: 75,
        condition: { type: 'count', target: 10, timeRange: { start: 17, end: 20 } },
    },
    {
        id: 'early_bird',
        name: 'Early Bird',
        description: 'Completed 10 tasks before 9 AM',
        icon: '🌅',
        category: 'time',
        rarity: 'rare',
        xpReward: 75,
        condition: { type: 'count', target: 10, timeRange: { start: 6, end: 9 } },
    },
    {
        id: 'night_owl',
        name: 'Night Owl',
        description: 'Completed 10 tasks after 8 PM',
        icon: '🦉',
        category: 'time',
        rarity: 'rare',
        xpReward: 75,
        condition: { type: 'count', target: 10, timeRange: { start: 20, end: 23 } },
    },
    {
        id: 'weekend_warrior',
        name: 'Weekend Warrior',
        description: 'Completed 20 tasks on weekends',
        icon: '🎉',
        category: 'time',
        rarity: 'epic',
        xpReward: 125,
        condition: { type: 'count', target: 20 },
    },

    // === SEASONAL BADGES ===
    {
        id: 'seattle_winter_2024',
        name: 'Seattle Winter Hustle 2024',
        description: 'Completed 50 tasks during Winter 2024',
        icon: '❄️',
        category: 'seasonal',
        rarity: 'epic',
        xpReward: 250,
        condition: { type: 'count', target: 50 },
    },
    {
        id: 'holiday_hero_2024',
        name: 'Holiday Hero 2024',
        description: 'Completed a task on Christmas Eve or Christmas Day',
        icon: '🎄',
        category: 'seasonal',
        rarity: 'legendary',
        xpReward: 300,
        condition: { type: 'special', target: 1 },
    },

    // === SPECIAL BADGES ===
    {
        id: 'beta_pioneer',
        name: 'Beta Pioneer',
        description: 'Joined during the Seattle Beta launch',
        icon: '🚀',
        category: 'special',
        rarity: 'legendary',
        xpReward: 100,
        condition: { type: 'special', target: 1 },
    },
    {
        id: 'first_task',
        name: 'First Hustle',
        description: 'Completed your very first task',
        icon: '🎯',
        category: 'special',
        rarity: 'common',
        xpReward: 25,
        condition: { type: 'count', target: 1 },
    },
    {
        id: 'ten_tasks',
        name: 'Getting Started',
        description: 'Completed 10 tasks',
        icon: '🔟',
        category: 'special',
        rarity: 'common',
        xpReward: 50,
        condition: { type: 'count', target: 10 },
    },
    {
        id: 'fifty_tasks',
        name: 'Hustle Mode',
        description: 'Completed 50 tasks',
        icon: '5️⃣0️⃣',
        category: 'special',
        rarity: 'rare',
        xpReward: 150,
        condition: { type: 'count', target: 50 },
    },
    {
        id: 'hundred_tasks',
        name: 'Centurion',
        description: 'Completed 100 tasks',
        icon: '💯',
        category: 'special',
        rarity: 'epic',
        xpReward: 300,
        condition: { type: 'count', target: 100 },
    },
];

// ============================================
// User Data Tracking
// ============================================

interface UserBadgeData {
    userId: string;
    badges: UserBadge[];

    // Stats for badge evaluation
    totalTasksCompleted: number;
    tasksByCategory: Record<TaskCategory, number>;
    tasksByLocation: Record<string, number>;
    uniqueLocations: Set<string>;
    uniqueCategories: Set<TaskCategory>;

    // Time-based stats
    tasksToday: number;
    tasksThisWeek: number;
    tasksByTimeRange: Record<string, number>;
    weekendTasks: number;

    // Earnings
    totalEarnings: number;
    earningsToday: number;
    earningsThisWeek: number;

    // Streaks
    currentStreak: number;
    longestStreak: number;

    // Quality
    totalRatings: number;
    averageRating: number;
    consecutiveFiveStars: number;
    repeatClients: Set<string>;

    // Timestamps
    joinedAt: Date;
    lastTaskCompletedAt?: Date;
}

// ============================================
// In-Memory Store
// ============================================

const userBadgeData = new Map<string, UserBadgeData>();

// ============================================
// Dynamic Badge Engine
// ============================================

class DynamicBadgeEngineClass {
    /**
     * Get all badge definitions
     */
    getAllBadges(): BadgeDefinition[] {
        return BADGE_DEFINITIONS;
    }

    /**
     * Get badges by category
     */
    getBadgesByCategory(category: BadgeCategory): BadgeDefinition[] {
        return BADGE_DEFINITIONS.filter(b => b.category === category);
    }

    /**
     * Get seasonal badges (currently active)
     */
    getSeasonalBadges(): BadgeDefinition[] {
        return BADGE_DEFINITIONS.filter(b => b.category === 'seasonal');
    }

    /**
     * Initialize or get user badge data
     */
    private getUserData(userId: string): UserBadgeData {
        if (!userBadgeData.has(userId)) {
            userBadgeData.set(userId, {
                userId,
                badges: [],
                totalTasksCompleted: 0,
                tasksByCategory: {} as Record<TaskCategory, number>,
                tasksByLocation: {},
                uniqueLocations: new Set(),
                uniqueCategories: new Set(),
                tasksToday: 0,
                tasksThisWeek: 0,
                tasksByTimeRange: {},
                weekendTasks: 0,
                totalEarnings: 0,
                earningsToday: 0,
                earningsThisWeek: 0,
                currentStreak: 0,
                longestStreak: 0,
                totalRatings: 0,
                averageRating: 0,
                consecutiveFiveStars: 0,
                repeatClients: new Set(),
                joinedAt: new Date(),
            });
        }
        return userBadgeData.get(userId)!;
    }

    /**
     * Record a task completion for badge evaluation
     */
    recordTaskCompletion(
        userId: string,
        taskData: {
            category: TaskCategory;
            location?: string;
            earnings: number;
            rating?: number;
            durationMinutes?: number;
            clientId?: string;
        }
    ): void {
        const data = this.getUserData(userId);
        const now = new Date();
        const hour = now.getHours();
        const dayOfWeek = now.getDay();

        // Update counts
        data.totalTasksCompleted++;
        data.tasksByCategory[taskData.category] = (data.tasksByCategory[taskData.category] || 0) + 1;
        data.uniqueCategories.add(taskData.category);
        data.tasksToday++;
        data.tasksThisWeek++;

        // Location
        if (taskData.location) {
            const normalizedLocation = taskData.location.toLowerCase();
            data.tasksByLocation[normalizedLocation] = (data.tasksByLocation[normalizedLocation] || 0) + 1;
            data.uniqueLocations.add(normalizedLocation);
        }

        // Time tracking
        const timeKey = `${hour}`;
        data.tasksByTimeRange[timeKey] = (data.tasksByTimeRange[timeKey] || 0) + 1;

        if (dayOfWeek === 0 || dayOfWeek === 6) {
            data.weekendTasks++;
        }

        // Earnings
        data.totalEarnings += taskData.earnings;
        data.earningsToday += taskData.earnings;
        data.earningsThisWeek += taskData.earnings;

        // Rating
        if (taskData.rating) {
            data.totalRatings++;
            data.averageRating = ((data.averageRating * (data.totalRatings - 1)) + taskData.rating) / data.totalRatings;

            if (taskData.rating === 5) {
                data.consecutiveFiveStars++;
            } else {
                data.consecutiveFiveStars = 0;
            }
        }

        // Repeat clients
        if (taskData.clientId) {
            data.repeatClients.add(taskData.clientId);
        }

        data.lastTaskCompletedAt = now;

        serviceLogger.debug({ userId, taskData }, 'Recorded task completion for badges');
    }

    /**
     * Update streak for user
     */
    updateStreak(userId: string, currentStreak: number): void {
        const data = this.getUserData(userId);
        data.currentStreak = currentStreak;
        if (currentStreak > data.longestStreak) {
            data.longestStreak = currentStreak;
        }
    }

    /**
     * Reset daily counters (call at midnight)
     */
    resetDailyCounters(userId: string): void {
        const data = this.getUserData(userId);
        data.tasksToday = 0;
        data.earningsToday = 0;
    }

    /**
     * Reset weekly counters (call on Sunday)
     */
    resetWeeklyCounters(userId: string): void {
        const data = this.getUserData(userId);
        data.tasksThisWeek = 0;
        data.earningsThisWeek = 0;
    }

    /**
     * Evaluate and award badges for a user
     */
    async evaluateBadges(userId: string): Promise<{
        newBadges: UserBadge[];
        totalXPAwarded: number;
    }> {
        const data = this.getUserData(userId);
        const newBadges: UserBadge[] = [];
        let totalXPAwarded = 0;

        const unlockedBadgeIds = new Set(data.badges.map(b => b.badgeId));

        for (const badge of BADGE_DEFINITIONS) {
            // Skip if already unlocked
            if (unlockedBadgeIds.has(badge.id)) continue;

            // Check if badge condition is met
            if (this.checkBadgeCondition(badge, data)) {
                const userBadge: UserBadge = {
                    badgeId: badge.id,
                    userId,
                    unlockedAt: new Date(),
                    xpAwarded: badge.xpReward,
                };

                data.badges.push(userBadge);
                newBadges.push(userBadge);
                totalXPAwarded += badge.xpReward;

                serviceLogger.info({
                    userId,
                    badge: badge.name,
                    xp: badge.xpReward,
                }, 'Badge unlocked');
            }
        }

        return { newBadges, totalXPAwarded };
    }

    /**
     * Check if a badge condition is met
     */
    private checkBadgeCondition(badge: BadgeDefinition, data: UserBadgeData): boolean {
        const { condition } = badge;

        switch (condition.type) {
            case 'count':
                if (condition.taskCategory) {
                    return (data.tasksByCategory[condition.taskCategory] || 0) >= condition.target;
                }
                if (condition.timeWindow === 'day') {
                    return data.tasksToday >= condition.target;
                }
                if (condition.timeWindow === 'week') {
                    return data.tasksThisWeek >= condition.target;
                }
                if (condition.locations) {
                    const locationCount = condition.locations.reduce((sum, loc) => {
                        return sum + (data.tasksByLocation[loc] || 0);
                    }, 0);
                    return locationCount >= condition.target;
                }
                if (condition.timeRange) {
                    const rangeCount = Object.entries(data.tasksByTimeRange)
                        .filter(([hour]) => {
                            const h = parseInt(hour);
                            return h >= condition.timeRange!.start && h <= condition.timeRange!.end;
                        })
                        .reduce((sum, [, count]) => sum + count, 0);
                    return rangeCount >= condition.target;
                }
                return data.totalTasksCompleted >= condition.target;

            case 'streak':
                return data.currentStreak >= condition.target;

            case 'amount':
                if (condition.timeWindow === 'day') {
                    return data.earningsToday >= condition.target;
                }
                if (condition.timeWindow === 'week') {
                    return data.earningsThisWeek >= condition.target;
                }
                return data.totalEarnings >= condition.target;

            case 'location':
                return data.uniqueLocations.size >= condition.target;

            case 'rating':
                if (badge.id === 'perfect_five') {
                    return data.consecutiveFiveStars >= condition.target;
                }
                return data.averageRating >= condition.target && data.totalRatings >= 20;

            case 'special':
                // Special badges are awarded manually or via specific triggers
                if (badge.id === 'beta_pioneer') {
                    return true; // All beta users get this
                }
                if (badge.id === 'first_task') {
                    return data.totalTasksCompleted >= 1;
                }
                return false;

            default:
                return false;
        }
    }

    /**
     * Get all badges with progress for a user
     */
    getBadgeProgress(userId: string): BadgeProgress[] {
        const data = this.getUserData(userId);
        const unlockedBadgeIds = new Set(data.badges.map(b => b.badgeId));

        return BADGE_DEFINITIONS.map(badge => {
            const isUnlocked = unlockedBadgeIds.has(badge.id);
            const userBadge = data.badges.find(b => b.badgeId === badge.id);
            const progress = this.calculateProgress(badge, data);

            return {
                badge,
                currentProgress: progress.current,
                maxProgress: progress.max,
                percentComplete: Math.min(100, Math.round((progress.current / progress.max) * 100)),
                isUnlocked,
                unlockedAt: userBadge?.unlockedAt,
            };
        });
    }

    /**
     * Calculate progress toward a badge
     */
    private calculateProgress(badge: BadgeDefinition, data: UserBadgeData): { current: number; max: number } {
        const { condition } = badge;

        switch (condition.type) {
            case 'count':
                if (condition.taskCategory) {
                    return {
                        current: data.tasksByCategory[condition.taskCategory] || 0,
                        max: condition.target,
                    };
                }
                if (condition.timeWindow === 'day') {
                    return { current: data.tasksToday, max: condition.target };
                }
                return { current: data.totalTasksCompleted, max: condition.target };

            case 'streak':
                return { current: data.currentStreak, max: condition.target };

            case 'amount':
                if (condition.timeWindow === 'day') {
                    return { current: data.earningsToday, max: condition.target };
                }
                if (condition.timeWindow === 'week') {
                    return { current: data.earningsThisWeek, max: condition.target };
                }
                return { current: data.totalEarnings, max: condition.target };

            case 'location':
                return { current: data.uniqueLocations.size, max: condition.target };

            case 'rating':
                if (badge.id === 'perfect_five') {
                    return { current: data.consecutiveFiveStars, max: condition.target };
                }
                return { current: data.totalRatings, max: 20 };

            default:
                return { current: 0, max: condition.target };
        }
    }

    /**
     * Get recently unlocked badges
     */
    getRecentBadges(userId: string, limit: number = 5): (UserBadge & { badge: BadgeDefinition })[] {
        const data = this.getUserData(userId);

        return data.badges
            .sort((a, b) => b.unlockedAt.getTime() - a.unlockedAt.getTime())
            .slice(0, limit)
            .map(ub => ({
                ...ub,
                badge: BADGE_DEFINITIONS.find(b => b.id === ub.badgeId)!,
            }));
    }

    /**
     * Get public showcase badges for a user's profile
     */
    getBadgeShowcase(userId: string): BadgeDefinition[] {
        const data = this.getUserData(userId);
        const unlockedBadgeIds = new Set(data.badges.map(b => b.badgeId));

        // Prioritize rarer badges for showcase
        const rarityOrder: BadgeRarity[] = ['legendary', 'epic', 'rare', 'common'];

        return BADGE_DEFINITIONS
            .filter(b => unlockedBadgeIds.has(b.id))
            .sort((a, b) => {
                const aIndex = rarityOrder.indexOf(a.rarity);
                const bIndex = rarityOrder.indexOf(b.rarity);
                return aIndex - bIndex;
            })
            .slice(0, 6); // Show top 6 badges on profile
    }

    /**
     * Get user's total badge count by rarity
     */
    getBadgeStats(userId: string): {
        total: number;
        byRarity: Record<BadgeRarity, number>;
        byCategory: Record<BadgeCategory, number>;
    } {
        const data = this.getUserData(userId);
        const unlockedBadgeIds = new Set(data.badges.map(b => b.badgeId));
        const unlockedBadges = BADGE_DEFINITIONS.filter(b => unlockedBadgeIds.has(b.id));

        const byRarity: Record<BadgeRarity, number> = {
            common: 0,
            rare: 0,
            epic: 0,
            legendary: 0,
        };

        const byCategory: Record<BadgeCategory, number> = {
            location: 0,
            speed: 0,
            consistency: 0,
            category: 0,
            earnings: 0,
            quality: 0,
            time: 0,
            seasonal: 0,
            special: 0,
        };

        for (const badge of unlockedBadges) {
            byRarity[badge.rarity]++;
            byCategory[badge.category]++;
        }

        return {
            total: unlockedBadges.length,
            byRarity,
            byCategory,
        };
    }

    /**
     * Award the Beta Pioneer badge to a user
     */
    awardBetaPioneer(userId: string): UserBadge | null {
        const data = this.getUserData(userId);
        const badge = BADGE_DEFINITIONS.find(b => b.id === 'beta_pioneer');

        if (!badge) return null;
        if (data.badges.some(b => b.badgeId === 'beta_pioneer')) return null;

        const userBadge: UserBadge = {
            badgeId: 'beta_pioneer',
            userId,
            unlockedAt: new Date(),
            xpAwarded: badge.xpReward,
        };

        data.badges.push(userBadge);
        serviceLogger.info({ userId }, 'Beta Pioneer badge awarded');

        return userBadge;
    }
}

export const DynamicBadgeEngine = new DynamicBadgeEngineClass();
