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
import { serviceLogger } from '../utils/logger.js';
import { DynamicBadgeEngine } from './DynamicBadgeEngine.js';
import { QuestEngine } from './QuestEngine.js';
import { GamificationService } from './GamificationService.js';
import { TaskService } from './TaskService.js';
// ============================================
// In-Memory Store
// ============================================
const userStats = new Map();
// ============================================
// AI Growth Coach Service
// ============================================
class AIGrowthCoachServiceClass {
    /**
     * Initialize or get user stats
     */
    getUserStats(userId) {
        if (!userStats.has(userId)) {
            userStats.set(userId, {
                userId,
                role: 'hustler',
                tasksCompleted: 0,
                tasksByCategory: {},
                tasksByDay: {},
                totalEarnings: 0,
                earningsByDay: {},
                earningsByCategory: {},
                avgTaskDuration: 45,
                totalMinutesWorked: 0,
                ratings: [],
                avgRating: 0,
                currentStreak: 0,
                longestStreak: 0,
                hasPhoto: false,
                hasBio: false,
                skillsCount: 0,
                availabilitySet: false,
                totalXP: 0,
                xpEvents: [],
                joinedAt: new Date(),
                lastActiveAt: new Date(),
            });
        }
        return userStats.get(userId);
    }
    /**
     * Record task completion for analytics
     */
    recordTaskCompletion(userId, data) {
        const stats = this.getUserStats(userId);
        const today = new Date().toISOString().split('T')[0];
        stats.tasksCompleted++;
        stats.tasksByCategory[data.category] = (stats.tasksByCategory[data.category] || 0) + 1;
        stats.tasksByDay[today] = (stats.tasksByDay[today] || 0) + 1;
        stats.totalEarnings += data.earnings;
        stats.earningsByDay[today] = (stats.earningsByDay[today] || 0) + data.earnings;
        stats.earningsByCategory[data.category] = (stats.earningsByCategory[data.category] || 0) + data.earnings;
        if (data.durationMinutes) {
            stats.totalMinutesWorked += data.durationMinutes;
            stats.avgTaskDuration = stats.totalMinutesWorked / stats.tasksCompleted;
        }
        if (data.rating) {
            stats.ratings.push(data.rating);
            stats.avgRating = stats.ratings.reduce((a, b) => a + b, 0) / stats.ratings.length;
        }
        stats.lastActiveAt = new Date();
        // Also record for badge evaluation
        DynamicBadgeEngine.recordTaskCompletion(userId, {
            category: data.category,
            earnings: data.earnings,
            rating: data.rating,
            durationMinutes: data.durationMinutes,
        });
        // Update quest progress
        QuestEngine.updateProgress(userId, {
            type: 'task_completed',
            value: 1,
            category: data.category,
            durationMinutes: data.durationMinutes,
        });
        if (data.earnings > 0) {
            QuestEngine.updateProgress(userId, {
                type: 'earned',
                value: data.earnings,
            });
        }
        if (data.rating) {
            QuestEngine.updateProgress(userId, {
                type: 'rating',
                value: data.rating,
            });
        }
        serviceLogger.debug({ userId, data }, 'Recorded task completion for growth coach');
    }
    /**
     * Update XP for user
     */
    recordXP(userId, amount) {
        const stats = this.getUserStats(userId);
        const today = new Date().toISOString().split('T')[0];
        stats.totalXP += amount;
        stats.xpEvents.push({ date: today, amount });
    }
    /**
     * Update streak for user
     */
    updateStreak(userId, currentStreak) {
        const stats = this.getUserStats(userId);
        stats.currentStreak = currentStreak;
        if (currentStreak > stats.longestStreak) {
            stats.longestStreak = currentStreak;
        }
        DynamicBadgeEngine.updateStreak(userId, currentStreak);
        QuestEngine.updateProgress(userId, { type: 'streak', value: currentStreak });
    }
    /**
     * Update profile completeness
     */
    updateProfile(userId, updates) {
        const stats = this.getUserStats(userId);
        Object.assign(stats, updates);
    }
    /**
     * Get full personalized growth plan
     */
    async getGrowthPlan(userId) {
        const stats = this.getUserStats(userId);
        const today = new Date().toISOString().split('T')[0];
        // Calculate level progress
        const level = this.calculateLevelProgress(stats);
        // Calculate earnings
        const todayEarnings = stats.earningsByDay[today] || 0;
        const weekEarnings = this.getWeekEarnings(stats);
        const monthEarnings = this.getMonthEarnings(stats);
        // Get earnings projection
        const projection = this.calculateEarningsProjection(stats);
        // Calculate streak info
        const streakInfo = this.calculateStreakInfo(stats);
        // Get next best actions
        const nextBestActions = await this.getNextBestActions(userId, stats);
        // Get suggested tasks
        const suggestedTasks = await this.getOptimalTasks(userId, 5);
        // Get top category
        const topCategory = this.getTopCategory(stats);
        // Get badge stats
        const badgeStats = DynamicBadgeEngine.getBadgeStats(userId);
        const totalBadges = DynamicBadgeEngine.getAllBadges().length;
        // Get quest stats
        const questStats = QuestEngine.getQuestStats(userId);
        const activeQuests = QuestEngine.getAllActiveQuests(userId);
        // Get coaching tip
        const coachingTip = await this.getCoachingTip(userId, stats);
        // Calculate profile strength
        const profileStrength = this.calculateProfileStrength(stats);
        const profileSuggestions = this.getProfileSuggestions(stats);
        // Get upcoming unlocks
        const upcomingUnlocks = this.getUpcomingUnlocks(userId, stats);
        return {
            userId,
            role: stats.role,
            timestamp: new Date(),
            level,
            earnings: {
                today: todayEarnings,
                thisWeek: weekEarnings,
                thisMonth: monthEarnings,
                allTime: stats.totalEarnings,
            },
            projection,
            streak: streakInfo,
            nextBestActions,
            suggestedTasks,
            stats: {
                topCategory,
                tasksCompleted: stats.tasksCompleted,
                avgRating: Math.round(stats.avgRating * 10) / 10,
                completionRate: 100, // TODO: track cancellations
            },
            badgesUnlocked: badgeStats.total,
            badgesAvailable: totalBadges,
            activeQuests: activeQuests.length,
            questsCompleted: questStats.totalCompleted,
            coachingTip: coachingTip.tip,
            profileStrength,
            profileSuggestions,
            upcomingUnlocks,
        };
    }
    /**
     * Calculate level progress
     */
    calculateLevelProgress(stats) {
        const currentLevel = GamificationService.calculateLevel(stats.totalXP);
        const xpInfo = GamificationService.getXPForNextLevel(stats.totalXP);
        // Calculate XP per day (last 7 days)
        const recentXP = stats.xpEvents
            .filter(e => {
            const date = new Date(e.date);
            const daysAgo = (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
            return daysAgo <= 7;
        })
            .reduce((sum, e) => sum + e.amount, 0);
        const xpPerDay = Math.round(recentXP / 7);
        // Estimate level up date
        const daysToLevelUp = xpPerDay > 0 ? Math.ceil(xpInfo.needed / xpPerDay) : 999;
        const levelUpDate = new Date();
        levelUpDate.setDate(levelUpDate.getDate() + daysToLevelUp);
        // Tasks needed (assuming ~100 XP per task)
        const tasksToLevelUp = Math.ceil(xpInfo.needed / 100);
        return {
            currentLevel,
            currentXP: stats.totalXP,
            xpToNextLevel: xpInfo.needed,
            levelProgress: Math.round(xpInfo.progress * 100),
            xpPerDay,
            estimatedLevelUpDate: daysToLevelUp < 999
                ? levelUpDate.toLocaleDateString()
                : 'Keep hustling!',
            tasksToLevelUp,
        };
    }
    /**
     * Calculate earnings projection
     */
    calculateEarningsProjection(stats) {
        const topCategory = this.getTopCategory(stats);
        const avgTaskEarning = stats.tasksCompleted > 0
            ? stats.totalEarnings / stats.tasksCompleted
            : 35;
        // Calculate tasks per day (last 14 days)
        const recentDays = Object.entries(stats.tasksByDay)
            .filter(([date]) => {
            const d = new Date(date);
            const daysAgo = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
            return daysAgo <= 14;
        });
        const tasksPerDay = recentDays.length > 0
            ? recentDays.reduce((sum, [, count]) => sum + count, 0) / 14
            : 0;
        // Calculate growth trend
        const firstWeekTasks = recentDays
            .filter(([date]) => {
            const d = new Date(date);
            const daysAgo = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
            return daysAgo > 7 && daysAgo <= 14;
        })
            .reduce((sum, [, count]) => sum + count, 0);
        const secondWeekTasks = recentDays
            .filter(([date]) => {
            const d = new Date(date);
            const daysAgo = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
            return daysAgo <= 7;
        })
            .reduce((sum, [, count]) => sum + count, 0);
        const growthTrend = secondWeekTasks > firstWeekTasks * 1.1 ? 'up' :
            secondWeekTasks < firstWeekTasks * 0.9 ? 'down' : 'stable';
        const dailyEarning = tasksPerDay * avgTaskEarning;
        return {
            daily: {
                min: Math.round(dailyEarning * 0.7),
                max: Math.round(dailyEarning * 1.5),
                likely: Math.round(dailyEarning),
            },
            weekly: {
                min: Math.round(dailyEarning * 5 * 0.7),
                max: Math.round(dailyEarning * 7 * 1.3),
                likely: Math.round(dailyEarning * 6),
            },
            monthly: {
                min: Math.round(dailyEarning * 20 * 0.7),
                max: Math.round(dailyEarning * 26 * 1.3),
                likely: Math.round(dailyEarning * 22),
            },
            topCategory,
            avgTaskEarning: Math.round(avgTaskEarning),
            tasksPerDay: Math.round(tasksPerDay * 10) / 10,
            growthTrend,
            tips: this.getEarningsTips(stats, growthTrend),
        };
    }
    /**
     * Get earnings tips based on stats
     */
    getEarningsTips(stats, trend) {
        const tips = [];
        if (trend === 'down') {
            tips.push('🔥 Your activity has dipped - completing just 1 more task today puts you back on track!');
        }
        if (stats.avgRating < 4.8 && stats.tasksCompleted > 5) {
            tips.push('⭐ Bump your rating to 4.8+ to unlock priority task visibility');
        }
        if (stats.currentStreak < 3) {
            tips.push('🎯 Build a 3-day streak to earn bonus XP');
        }
        const topCategory = this.getTopCategory(stats);
        if (topCategory && stats.tasksByCategory[topCategory] >= 5) {
            tips.push(`💪 You're crushing ${topCategory} tasks - keep building that specialty!`);
        }
        const uniqueCategories = Object.keys(stats.tasksByCategory).length;
        if (uniqueCategories < 3) {
            tips.push('🧭 Try a new category to increase your match rate by 50%');
        }
        return tips.slice(0, 3);
    }
    /**
     * Calculate streak info
     */
    calculateStreakInfo(stats) {
        const milestones = [3, 7, 14, 30];
        const nextMilestone = milestones.find(m => m > stats.currentStreak) || 30;
        const daysToNext = nextMilestone - stats.currentStreak;
        const bonusMap = { 3: 25, 7: 75, 14: 150, 30: 500 };
        const nextBonus = bonusMap[nextMilestone] || 0;
        return {
            current: stats.currentStreak,
            longest: stats.longestStreak,
            daysToNextMilestone: daysToNext,
            nextMilestoneBonus: nextBonus,
        };
    }
    /**
     * Get next best actions for user
     */
    async getNextBestActions(userId, stats) {
        const s = stats || this.getUserStats(userId);
        const actions = [];
        // Check active quests that are close to completion
        const quests = QuestEngine.getAllActiveQuests(userId);
        for (const quest of quests.slice(0, 2)) {
            if (quest.percentComplete >= 50 && quest.status === 'active') {
                actions.push({
                    type: 'complete_quest',
                    title: `Complete: ${quest.definition.title}`,
                    description: `${quest.percentComplete}% done - ${quest.definition.description}`,
                    xpReward: quest.xpReward,
                    priority: quest.percentComplete >= 80 ? 'high' : 'medium',
                    questId: quest.id,
                    expiresIn: quest.timeRemaining,
                });
            }
        }
        // Check badges close to unlocking
        const badgeProgress = DynamicBadgeEngine.getBadgeProgress(userId);
        const closeBadges = badgeProgress
            .filter(b => !b.isUnlocked && b.percentComplete >= 60)
            .sort((a, b) => b.percentComplete - a.percentComplete)
            .slice(0, 2);
        for (const badge of closeBadges) {
            actions.push({
                type: 'unlock_badge',
                title: `Unlock: ${badge.badge.name}`,
                description: `${badge.percentComplete}% complete - ${badge.badge.description}`,
                xpReward: badge.badge.xpReward,
                priority: badge.percentComplete >= 80 ? 'high' : 'medium',
                badgeId: badge.badge.id,
            });
        }
        // Streak maintenance
        if (s.currentStreak > 0) {
            const today = new Date().toISOString().split('T')[0];
            const tasksToday = s.tasksByDay[today] || 0;
            if (tasksToday === 0) {
                actions.push({
                    type: 'extend_streak',
                    title: `Keep your ${s.currentStreak}-day streak!`,
                    description: 'Complete at least 1 task today to maintain your streak',
                    xpReward: s.currentStreak >= 3 ? 25 : 0,
                    priority: 'high',
                });
            }
        }
        // Suggest accepting a task if they haven't done one today
        const today = new Date().toISOString().split('T')[0];
        if ((s.tasksByDay[today] || 0) === 0) {
            const tasks = await this.getOptimalTasks(userId, 1);
            if (tasks.length > 0) {
                actions.push({
                    type: 'accept_task',
                    title: 'Best task for you right now',
                    description: tasks[0].title,
                    xpReward: 100,
                    moneyPotential: tasks[0].recommendedPrice,
                    priority: 'high',
                    taskId: tasks[0].id,
                });
            }
        }
        // Profile optimization if incomplete
        const profileStrength = this.calculateProfileStrength(s);
        if (profileStrength < 80) {
            actions.push({
                type: 'optimize_profile',
                title: 'Boost your profile',
                description: 'Add photos, bio, or skills to increase match rate by 60%',
                xpReward: 50,
                priority: 'medium',
            });
        }
        // Try new category
        const uniqueCategories = Object.keys(s.tasksByCategory).length;
        if (uniqueCategories < 3 && s.tasksCompleted >= 5) {
            actions.push({
                type: 'try_new_category',
                title: 'Expand your skills',
                description: 'Try a new task category to unlock the Jack of All Trades badge',
                xpReward: 125,
                priority: 'low',
            });
        }
        // Sort by priority
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        return actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
    }
    /**
     * Get single next best action
     */
    async getNextBestAction(userId) {
        const actions = await this.getNextBestActions(userId);
        return actions[0] || null;
    }
    /**
     * Get optimal tasks for this user
     */
    async getOptimalTasks(userId, limit = 5) {
        const stats = this.getUserStats(userId);
        const topCategory = this.getTopCategory(stats);
        // Get open tasks
        const allTasks = await TaskService.searchTasks({ limit: 20 });
        // Score and rank tasks
        const scoredTasks = allTasks.map(task => {
            let score = 0;
            // Prefer tasks in top category
            if (task.category === topCategory) {
                score += 30;
            }
            // Prefer tasks in experienced categories
            if (stats.tasksByCategory[task.category] > 0) {
                score += 20;
            }
            // Prefer higher paying tasks
            score += task.recommendedPrice / 10;
            // Prefer tasks matching avg duration
            // (would need task duration estimate)
            return { task, score };
        });
        return scoredTasks
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(st => st.task);
    }
    /**
     * Get context-aware coaching tip
     */
    async getCoachingTip(userId, stats, context) {
        const s = stats || this.getUserStats(userId);
        // Rule-based tips for common situations
        const today = new Date().toISOString().split('T')[0];
        const tasksToday = s.tasksByDay[today] || 0;
        const hour = new Date().getHours();
        // No tasks today
        if (tasksToday === 0 && s.currentStreak > 0) {
            return {
                tip: `🔥 Keep your ${s.currentStreak}-day streak alive! Complete one task today.`,
                context: 'streak_at_risk',
                priority: 'high',
                actionable: true,
                action: 'Find a quick task',
            };
        }
        // Golden hour (5-8 PM)
        if (hour >= 17 && hour <= 20 && tasksToday < 2) {
            return {
                tip: '⚡ Peak earning hours! Tasks posted now get 40% more views.',
                context: 'golden_hour',
                priority: 'high',
                actionable: true,
                action: 'Browse available tasks',
            };
        }
        // Profile incomplete
        const profileStrength = this.calculateProfileStrength(s);
        if (profileStrength < 60) {
            return {
                tip: '📈 Complete your profile to increase task matches by 60%',
                context: 'profile_incomplete',
                priority: 'medium',
                actionable: true,
                action: 'Update profile',
            };
        }
        // Close to level up
        const level = GamificationService.calculateLevel(s.totalXP);
        const xpInfo = GamificationService.getXPForNextLevel(s.totalXP);
        if (xpInfo.needed <= 100) {
            return {
                tip: `🚀 You're ${xpInfo.needed} XP from Level ${level + 1}! One more task could do it.`,
                context: 'close_to_level_up',
                priority: 'high',
                actionable: true,
                action: 'Level up now',
            };
        }
        // Rating opportunity
        if (s.avgRating < 4.8 && s.avgRating >= 4.5 && s.tasksCompleted >= 10) {
            return {
                tip: '⭐ You\'re almost at 4.8 rating - unlock priority visibility to premium clients!',
                context: 'rating_improvement',
                priority: 'medium',
                actionable: true,
                action: 'Aim for 5 stars',
            };
        }
        // Default tips based on level
        const tips = [
            'Great progress today! Consistency is key to building your reputation.',
            'Pro tip: Tasks with photos get completed 3x faster.',
            'Weekend tasks often pay 20% more due to higher demand.',
            `You've completed ${s.tasksCompleted} tasks - you're crushing it!`,
        ];
        return {
            tip: tips[Math.floor(Math.random() * tips.length)],
            context: 'general',
            priority: 'low',
            actionable: false,
        };
    }
    /**
     * Get poster insights (for clients)
     */
    getPosterInsights(userId) {
        // This would track poster-specific metrics
        // For now, return mock data structure
        return {
            userId,
            tasksPosted: 0,
            tasksCompleted: 0,
            completionRate: 100,
            avgTimeToAccept: '2 hours',
            avgRatingGiven: 4.8,
            topCategories: [],
            suggestions: [
                'Add photos to your task listings to increase acceptance by 70%',
                'Setting a specific time window helps hustlers plan their day',
            ],
            tipToImprove: 'Verified hustlers complete tasks 95% of the time - use the "Verified Only" filter!',
        };
    }
    /**
     * Get task listing optimization suggestions
     */
    async getListingOptimization(task) {
        const suggestions = [];
        if (!task.locationText) {
            suggestions.push('📍 Add a specific location for 40% more hustler interest');
        }
        if (!task.timeWindow) {
            suggestions.push('⏰ Set a time window - hustlers prefer knowing when to arrive');
        }
        if (task.description.length < 50) {
            suggestions.push('📝 Add more details - detailed tasks get accepted 60% faster');
        }
        if (task.recommendedPrice < 25) {
            suggestions.push('💡 Tasks under $25 have lower acceptance - consider bundling');
        }
        return suggestions;
    }
    // ============================================
    // Helper Functions
    // ============================================
    getTopCategory(stats) {
        const entries = Object.entries(stats.tasksByCategory);
        if (entries.length === 0)
            return 'errands';
        return entries.sort((a, b) => b[1] - a[1])[0][0];
    }
    getWeekEarnings(stats) {
        const now = new Date();
        return Object.entries(stats.earningsByDay)
            .filter(([date]) => {
            const d = new Date(date);
            const daysAgo = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
            return daysAgo <= 7;
        })
            .reduce((sum, [, amount]) => sum + amount, 0);
    }
    getMonthEarnings(stats) {
        const now = new Date();
        return Object.entries(stats.earningsByDay)
            .filter(([date]) => {
            const d = new Date(date);
            const daysAgo = (now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24);
            return daysAgo <= 30;
        })
            .reduce((sum, [, amount]) => sum + amount, 0);
    }
    calculateProfileStrength(stats) {
        let score = 0;
        if (stats.hasPhoto)
            score += 30;
        if (stats.hasBio)
            score += 25;
        if (stats.skillsCount >= 3)
            score += 25;
        if (stats.availabilitySet)
            score += 20;
        return score;
    }
    getProfileSuggestions(stats) {
        const suggestions = [];
        if (!stats.hasPhoto)
            suggestions.push('Add a profile photo to increase trust (+30% matches)');
        if (!stats.hasBio)
            suggestions.push('Write a bio to stand out from other hustlers');
        if (stats.skillsCount < 3)
            suggestions.push('Add more skills to get matched with more tasks');
        if (!stats.availabilitySet)
            suggestions.push('Set your availability to get priority notifications');
        return suggestions;
    }
    getUpcomingUnlocks(userId, stats) {
        const unlocks = [];
        // Level unlocks
        const level = GamificationService.calculateLevel(stats.totalXP);
        if (level < 5) {
            unlocks.push({
                name: 'Instant Payout',
                requirement: 'Reach Level 5',
                progress: level,
                maxProgress: 5,
                reward: 'Get paid instantly after task completion',
                icon: '💸',
            });
        }
        // Badge unlocks from progress
        const badgeProgress = DynamicBadgeEngine.getBadgeProgress(userId);
        const closeBadges = badgeProgress
            .filter(b => !b.isUnlocked && b.percentComplete >= 40 && b.percentComplete < 100)
            .sort((a, b) => b.percentComplete - a.percentComplete)
            .slice(0, 3);
        for (const badge of closeBadges) {
            unlocks.push({
                name: badge.badge.name,
                requirement: badge.badge.description,
                progress: badge.currentProgress,
                maxProgress: badge.maxProgress,
                reward: `+${badge.badge.xpReward} XP`,
                icon: badge.badge.icon,
            });
        }
        return unlocks;
    }
}
export const AIGrowthCoachService = new AIGrowthCoachServiceClass();
//# sourceMappingURL=AIGrowthCoachService.js.map