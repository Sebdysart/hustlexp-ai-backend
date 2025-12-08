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

import { serviceLogger } from '../utils/logger.js';
import { GamificationService } from './GamificationService.js';
import { DynamicBadgeEngine } from './DynamicBadgeEngine.js';
import { QuestEngine } from './QuestEngine.js';
import { AIGrowthCoachService } from './AIGrowthCoachService.js';
import type { TaskCategory } from '../types/index.js';

// ============================================
// Types
// ============================================

export type ScreenContext =
    | 'feed'           // Browsing available tasks
    | 'task_detail'    // Viewing a specific task
    | 'checkout'       // About to pay/post
    | 'profile'        // Viewing their profile
    | 'earnings'       // Viewing earnings dashboard
    | 'dispute'        // In dispute resolution
    | 'onboarding'     // Still onboarding
    | 'quest_list'     // Viewing quests
    | 'badge_list'     // Viewing badges
    | 'accept_task'    // About to accept a task
    | 'complete_task'  // Completing a task
    | 'home';          // Main home screen

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

    // Time context
    hour: number;
    dayOfWeek: number;
    isWeekend: boolean;
    isGoldenHour: boolean; // 5-8 PM

    // User state
    level: number;
    xp: number;
    xpToNextLevel: number;
    streak: number;
    tasksToday: number;
    earningsToday: number;
    earningsThisWeek: number;

    // Profile
    profileComplete: boolean;
    hasPhoto: boolean;
    hasBio: boolean;

    // Task context (if on task screen)
    taskCategory?: TaskCategory;
    taskPrice?: number;
}

// ============================================
// Tip Templates by Screen
// ============================================

const SCREEN_TIPS: Record<ScreenContext, (ctx: UserContext) => ContextualTip | null> = {
    feed: (ctx) => {
        // Golden hour tip
        if (ctx.isGoldenHour && ctx.tasksToday < 2) {
            return {
                id: 'feed_golden_hour',
                category: 'time',
                priority: 'high',
                icon: '⚡',
                title: 'Peak Hours Active!',
                message: 'Tasks posted now get 40% more hustler interest. Best time to earn!',
                actionText: 'Find Tasks',
                dismissible: true,
            };
        }

        // Weekend tip
        if (ctx.isWeekend && ctx.tasksToday === 0) {
            return {
                id: 'feed_weekend',
                category: 'opportunity',
                priority: 'medium',
                icon: '🎉',
                title: 'Weekend Rush!',
                message: 'Weekend tasks often pay 20% more. Great time to hustle!',
                dismissible: true,
            };
        }

        // Low activity tip
        if (ctx.tasksToday === 0 && ctx.streak > 0) {
            return {
                id: 'feed_streak_risk',
                category: 'streak',
                priority: 'urgent',
                icon: '🔥',
                title: `Keep Your ${ctx.streak}-Day Streak!`,
                message: 'Complete at least 1 task today to maintain your streak.',
                actionText: 'Find Quick Task',
                dismissible: false,
            };
        }

        return null;
    },

    task_detail: (ctx) => {
        // Close to level up
        if (ctx.xpToNextLevel <= 100) {
            return {
                id: 'task_level_up',
                category: 'level',
                priority: 'high',
                icon: '🚀',
                title: 'Almost There!',
                message: `Complete this task and you'll be ${ctx.xpToNextLevel} XP from Level ${ctx.level + 1}!`,
                dismissible: true,
            };
        }

        return null;
    },

    checkout: (ctx) => {
        return {
            id: 'checkout_tip',
            category: 'opportunity',
            priority: 'medium',
            icon: '💡',
            title: 'Pro Tip',
            message: 'Adding a $5 tip increases acceptance rate by 40%.',
            dismissible: true,
        };
    },

    profile: (ctx) => {
        if (!ctx.hasPhoto) {
            return {
                id: 'profile_photo',
                category: 'profile',
                priority: 'high',
                icon: '📸',
                title: 'Add a Profile Photo',
                message: 'Profiles with photos get 60% more task matches.',
                actionText: 'Add Photo',
                dismissible: true,
            };
        }

        if (!ctx.hasBio) {
            return {
                id: 'profile_bio',
                category: 'profile',
                priority: 'medium',
                icon: '✏️',
                title: 'Write Your Bio',
                message: 'Stand out from other hustlers with a compelling bio.',
                actionText: 'Write Bio',
                dismissible: true,
            };
        }

        return null;
    },

    earnings: (ctx) => {
        // Close to personal record
        const weeklyGoal = 500; // TODO: personalize
        const remaining = weeklyGoal - ctx.earningsThisWeek;

        if (remaining > 0 && remaining < 100) {
            return {
                id: 'earnings_close',
                category: 'earnings',
                priority: 'high',
                icon: '💰',
                title: 'So Close!',
                message: `You're $${remaining.toFixed(0)} away from $${weeklyGoal} this week!`,
                actionText: 'Find Tasks',
                dismissible: true,
            };
        }

        if (ctx.earningsToday >= 100) {
            return {
                id: 'earnings_congrats',
                category: 'earnings',
                priority: 'low',
                icon: '🎉',
                title: 'Great Day!',
                message: `You've earned $${ctx.earningsToday.toFixed(0)} today. Keep it up!`,
                dismissible: true,
            };
        }

        return null;
    },

    dispute: (ctx) => {
        return {
            id: 'dispute_tip',
            category: 'profile',
            priority: 'urgent',
            icon: '📷',
            title: 'Strengthen Your Case',
            message: 'Upload photos and detailed notes to support your dispute.',
            actionText: 'Add Evidence',
            dismissible: false,
        };
    },

    onboarding: (ctx) => {
        return {
            id: 'onboarding_welcome',
            category: 'profile',
            priority: 'medium',
            icon: '👋',
            title: 'Welcome to HustleXP!',
            message: 'Complete your profile to start earning and unlock bonuses.',
            dismissible: false,
        };
    },

    quest_list: (ctx) => {
        return {
            id: 'quest_tip',
            category: 'quest',
            priority: 'medium',
            icon: '🎯',
            title: 'Daily Quests Reset at Midnight',
            message: 'Complete them before they expire for bonus XP!',
            dismissible: true,
        };
    },

    badge_list: (ctx) => {
        return {
            id: 'badge_tip',
            category: 'badge',
            priority: 'low',
            icon: '🏆',
            title: 'Badges = Recognition',
            message: 'Rare badges appear on your profile and attract more clients.',
            dismissible: true,
        };
    },

    accept_task: (ctx) => {
        if (ctx.taskPrice && ctx.taskPrice >= 75) {
            return {
                id: 'accept_high_value',
                category: 'opportunity',
                priority: 'high',
                icon: '💎',
                title: 'High Value Task!',
                message: 'This is above your average earnings per task. Great opportunity!',
                dismissible: true,
            };
        }

        return null;
    },

    complete_task: (ctx) => {
        // Streak bonus coming
        const nextMilestones = [3, 7, 14, 30];
        const nextMilestone = nextMilestones.find(m => m === ctx.streak + 1);

        if (nextMilestone) {
            const bonuses: Record<number, number> = { 3: 25, 7: 75, 14: 150, 30: 500 };
            return {
                id: 'complete_streak_bonus',
                category: 'streak',
                priority: 'high',
                icon: '🔥',
                title: 'Streak Bonus Incoming!',
                message: `Complete this task to hit ${nextMilestone}-day streak and earn +${bonuses[nextMilestone]} XP!`,
                dismissible: false,
            };
        }

        return null;
    },

    home: (ctx) => {
        // Morning tip
        if (ctx.hour >= 6 && ctx.hour < 10) {
            return {
                id: 'home_morning',
                category: 'opportunity',
                priority: 'low',
                icon: '☀️',
                title: 'Good Morning!',
                message: 'Early birds catch the best tasks. Check what\'s available!',
                actionText: 'Browse Tasks',
                dismissible: true,
            };
        }

        // Golden hour tip
        if (ctx.isGoldenHour) {
            return {
                id: 'home_golden',
                category: 'time',
                priority: 'high',
                icon: '⚡',
                title: 'Golden Hours!',
                message: 'Peak earning time is NOW. 5-8 PM has highest demand.',
                actionText: 'Find Tasks',
                dismissible: true,
            };
        }

        // Level up close
        if (ctx.xpToNextLevel <= 50) {
            return {
                id: 'home_level_close',
                category: 'level',
                priority: 'urgent',
                icon: '🚀',
                title: `${ctx.xpToNextLevel} XP to Level ${ctx.level + 1}!`,
                message: 'One quick task could push you over!',
                actionText: 'Level Up',
                dismissible: false,
            };
        }

        return null;
    },
};

// ============================================
// User Context Store (in production, from DB)
// ============================================

interface UserDayStats {
    tasksToday: number;
    earningsToday: number;
    earningsThisWeek: number;
    lastActiveHour: number;
}

const userDayStats = new Map<string, UserDayStats>();

// ============================================
// Contextual Coach Service
// ============================================

class ContextualCoachServiceClass {
    /**
     * Get or initialize user day stats
     */
    private getUserDayStats(userId: string): UserDayStats {
        if (!userDayStats.has(userId)) {
            userDayStats.set(userId, {
                tasksToday: 0,
                earningsToday: 0,
                earningsThisWeek: 0,
                lastActiveHour: new Date().getHours(),
            });
        }
        return userDayStats.get(userId)!;
    }

    /**
     * Record task completion for contextual awareness
     */
    recordActivity(userId: string, earnings: number): void {
        const stats = this.getUserDayStats(userId);
        stats.tasksToday++;
        stats.earningsToday += earnings;
        stats.earningsThisWeek += earnings;
        stats.lastActiveHour = new Date().getHours();
    }

    /**
     * Reset daily stats (call at midnight)
     */
    resetDailyStats(userId: string): void {
        const stats = this.getUserDayStats(userId);
        stats.tasksToday = 0;
        stats.earningsToday = 0;
    }

    /**
     * Reset weekly stats (call Sunday)
     */
    resetWeeklyStats(userId: string): void {
        const stats = this.getUserDayStats(userId);
        stats.earningsThisWeek = 0;
    }

    /**
     * Build full user context
     */
    private buildContext(
        userId: string,
        screen: ScreenContext,
        additionalContext?: Partial<UserContext>
    ): UserContext {
        const now = new Date();
        const hour = now.getHours();
        const dayOfWeek = now.getDay();
        const stats = this.getUserDayStats(userId);

        // Get XP info
        const xp = 0; // TODO: get from user service
        const level = GamificationService.calculateLevel(xp);
        const xpInfo = GamificationService.getXPForNextLevel(xp);

        return {
            userId,
            screen,
            hour,
            dayOfWeek,
            isWeekend: dayOfWeek === 0 || dayOfWeek === 6,
            isGoldenHour: hour >= 17 && hour <= 20,
            level,
            xp,
            xpToNextLevel: xpInfo.needed,
            streak: 0, // TODO: get from user service
            tasksToday: stats.tasksToday,
            earningsToday: stats.earningsToday,
            earningsThisWeek: stats.earningsThisWeek,
            profileComplete: true, // TODO: calculate
            hasPhoto: true,
            hasBio: true,
            ...additionalContext,
        };
    }

    /**
     * Get contextual tip for current screen
     */
    getTipForScreen(
        userId: string,
        screen: ScreenContext,
        additionalContext?: Partial<UserContext>
    ): ContextualTip | null {
        const context = this.buildContext(userId, screen, additionalContext);
        const tipGenerator = SCREEN_TIPS[screen];

        if (!tipGenerator) {
            return null;
        }

        const tip = tipGenerator(context);

        if (tip) {
            serviceLogger.debug({ userId, screen, tipId: tip.id }, 'Generated contextual tip');
        }

        return tip;
    }

    /**
     * Get the best contextual tip right now (any screen)
     */
    getContextualTip(userId: string, additionalContext?: Partial<UserContext>): ContextualTip | null {
        const context = this.buildContext(userId, 'home', additionalContext);

        // Check for urgent tips first
        const tips: ContextualTip[] = [];

        // Streak at risk
        if (context.streak > 0 && context.tasksToday === 0) {
            tips.push({
                id: 'urgent_streak',
                category: 'streak',
                priority: 'urgent',
                icon: '🔥',
                title: `${context.streak}-Day Streak at Risk!`,
                message: 'Complete 1 task today to keep your streak alive.',
                actionText: 'Save Streak',
                dismissible: false,
            });
        }

        // Close to level up
        if (context.xpToNextLevel <= 50) {
            tips.push({
                id: 'urgent_level',
                category: 'level',
                priority: 'urgent',
                icon: '🚀',
                title: 'Level Up is 1 Task Away!',
                message: `${context.xpToNextLevel} XP to Level ${context.level + 1}. So close!`,
                actionText: 'Level Up',
                dismissible: false,
            });
        }

        // Golden hour
        if (context.isGoldenHour && context.tasksToday < 3) {
            tips.push({
                id: 'time_golden',
                category: 'time',
                priority: 'high',
                icon: '⚡',
                title: 'Peak Earning Hours!',
                message: '5-8 PM is the busiest time. Maximize your earnings now!',
                actionText: 'Find Tasks',
                dismissible: true,
            });
        }

        // Weekend opportunity
        if (context.isWeekend && context.tasksToday === 0) {
            tips.push({
                id: 'opportunity_weekend',
                category: 'opportunity',
                priority: 'medium',
                icon: '🎉',
                title: 'Weekend = More Money!',
                message: 'Weekend tasks pay 15-20% more on average.',
                actionText: 'Browse Tasks',
                dismissible: true,
            });
        }

        // Profile incomplete
        if (!context.hasPhoto || !context.hasBio) {
            tips.push({
                id: 'profile_incomplete',
                category: 'profile',
                priority: 'medium',
                icon: '📝',
                title: 'Complete Your Profile',
                message: 'Hustlers with complete profiles earn 40% more.',
                actionText: 'Update Profile',
                dismissible: true,
            });
        }

        // Sort by priority and return top
        const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 };
        tips.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

        return tips[0] || null;
    }

    /**
     * Get time-sensitive tip
     */
    getTimeSensitiveTip(userId: string): ContextualTip | null {
        const now = new Date();
        const hour = now.getHours();
        const dayOfWeek = now.getDay();

        // Golden hour (5-8 PM)
        if (hour >= 17 && hour <= 20) {
            return {
                id: 'time_golden_hour',
                category: 'time',
                priority: 'high',
                icon: '🌅',
                title: 'Golden Hour Active!',
                message: 'Peak demand right now. Best time to accept high-paying tasks.',
                actionText: 'See Tasks',
                dismissible: true,
            };
        }

        // Early morning (6-9 AM)
        if (hour >= 6 && hour < 9) {
            return {
                id: 'time_early_bird',
                category: 'time',
                priority: 'medium',
                icon: '☀️',
                title: 'Early Bird Gets the Tasks',
                message: 'Morning hustlers get first pick of new tasks.',
                dismissible: true,
            };
        }

        // Friday evening
        if (dayOfWeek === 5 && hour >= 16) {
            return {
                id: 'time_friday',
                category: 'opportunity',
                priority: 'medium',
                icon: '🎊',
                title: 'Weekend Rush Starting!',
                message: 'Prep for busy weekend - tasks posted now get snapped up fast.',
                dismissible: true,
            };
        }

        // Sunday evening
        if (dayOfWeek === 0 && hour >= 18) {
            return {
                id: 'time_sunday',
                category: 'quest',
                priority: 'high',
                icon: '⏰',
                title: 'Quests Reset Tonight!',
                message: 'Complete any unfinished weekly quests before midnight.',
                actionText: 'View Quests',
                dismissible: true,
            };
        }

        return null;
    }

    /**
     * Get streak-related tip
     */
    getStreakTip(userId: string, currentStreak: number): ContextualTip | null {
        const stats = this.getUserDayStats(userId);

        // Streak at risk
        if (currentStreak > 0 && stats.tasksToday === 0) {
            return {
                id: 'streak_at_risk',
                category: 'streak',
                priority: 'urgent',
                icon: '🔥',
                title: `Save Your ${currentStreak}-Day Streak!`,
                message: 'Complete at least 1 task today or lose your streak.',
                actionText: 'Find Task',
                dismissible: false,
            };
        }

        // Close to milestone
        const milestones = [3, 7, 14, 30];
        const nextMilestone = milestones.find(m => m > currentStreak);
        const daysToMilestone = nextMilestone ? nextMilestone - currentStreak : 0;

        if (daysToMilestone > 0 && daysToMilestone <= 2) {
            const bonuses: Record<number, number> = { 3: 25, 7: 75, 14: 150, 30: 500 };
            return {
                id: 'streak_milestone_close',
                category: 'streak',
                priority: 'high',
                icon: '🎯',
                title: `${daysToMilestone} Day(s) to Bonus!`,
                message: `${nextMilestone}-day streak unlocks +${bonuses[nextMilestone!]} XP bonus.`,
                dismissible: true,
            };
        }

        // Just hit milestone
        if (milestones.includes(currentStreak)) {
            const bonuses: Record<number, number> = { 3: 25, 7: 75, 14: 150, 30: 500 };
            return {
                id: 'streak_milestone_hit',
                category: 'streak',
                priority: 'low',
                icon: '🎉',
                title: 'Streak Bonus Earned!',
                message: `${currentStreak}-day streak! +${bonuses[currentStreak]} XP awarded.`,
                dismissible: true,
            };
        }

        return null;
    }

    /**
     * Get all relevant tips for user (for notification digest)
     */
    getAllRelevantTips(userId: string, limit: number = 3): ContextualTip[] {
        const tips: ContextualTip[] = [];

        // Get contextual tip
        const contextual = this.getContextualTip(userId);
        if (contextual) tips.push(contextual);

        // Get time sensitive tip
        const timeTip = this.getTimeSensitiveTip(userId);
        if (timeTip && !tips.some(t => t.id === timeTip.id)) tips.push(timeTip);

        // Get streak tip
        const streakTip = this.getStreakTip(userId, 0); // TODO: get actual streak
        if (streakTip && !tips.some(t => t.id === streakTip.id)) tips.push(streakTip);

        return tips.slice(0, limit);
    }
}

export const ContextualCoachService = new ContextualCoachServiceClass();
