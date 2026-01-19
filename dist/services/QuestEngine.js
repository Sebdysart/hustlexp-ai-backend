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
import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import { routedGenerate } from '../ai/router.js';
// ============================================
// Quest Definitions
// ============================================
const DAILY_QUESTS = [
    // Easy (1 task, quick wins)
    {
        id: 'daily_first_task',
        title: 'First Task of the Day',
        description: 'Complete your first task today',
        frequency: 'daily',
        difficulty: 'easy',
        goalType: 'complete_tasks',
        goalValue: 1,
        xpReward: 25,
        icon: '☀️',
    },
    {
        id: 'daily_speed_demon',
        title: 'Speed Demon',
        description: 'Complete a task in under 45 minutes',
        frequency: 'daily',
        difficulty: 'easy',
        goalType: 'complete_fast',
        goalValue: 45,
        xpReward: 30,
        icon: '💨',
    },
    // Medium (2-3 tasks)
    {
        id: 'daily_double_down',
        title: 'Double Down',
        description: 'Complete 2 tasks today',
        frequency: 'daily',
        difficulty: 'medium',
        goalType: 'complete_tasks',
        goalValue: 2,
        xpReward: 50,
        icon: '✌️',
    },
    {
        id: 'daily_fifty_bucks',
        title: 'Fifty Bucks',
        description: 'Earn $50 today',
        frequency: 'daily',
        difficulty: 'medium',
        goalType: 'earn_amount',
        goalValue: 50,
        xpReward: 40,
        icon: '💵',
    },
    {
        id: 'daily_five_star',
        title: 'Five Star Day',
        description: 'Get a 5-star rating today',
        frequency: 'daily',
        difficulty: 'medium',
        goalType: 'get_rating',
        goalValue: 5,
        xpReward: 35,
        icon: '⭐',
    },
    // Hard (3+ tasks)
    {
        id: 'daily_triple_threat',
        title: 'Triple Threat',
        description: 'Complete 3 tasks today',
        frequency: 'daily',
        difficulty: 'hard',
        goalType: 'complete_tasks',
        goalValue: 3,
        xpReward: 75,
        icon: '🔥',
    },
    {
        id: 'daily_hundred_club',
        title: 'Daily Hundred',
        description: 'Earn $100 today',
        frequency: 'daily',
        difficulty: 'hard',
        goalType: 'earn_amount',
        goalValue: 100,
        xpReward: 100,
        icon: '💰',
    },
    // Epic (very challenging)
    {
        id: 'daily_task_machine',
        title: 'Task Machine',
        description: 'Complete 5 tasks in one day',
        frequency: 'daily',
        difficulty: 'epic',
        goalType: 'complete_tasks',
        goalValue: 5,
        xpReward: 150,
        bonusRewardType: 'badge',
        bonusRewardId: 'task_machine',
        icon: '🤖',
    },
];
const WEEKLY_QUESTS = [
    // Medium
    {
        id: 'weekly_starter',
        title: 'Weekly Starter',
        description: 'Complete 5 tasks this week',
        frequency: 'weekly',
        difficulty: 'medium',
        goalType: 'complete_tasks',
        goalValue: 5,
        xpReward: 150,
        icon: '📅',
    },
    {
        id: 'weekly_category_explorer',
        title: 'Category Explorer',
        description: 'Complete tasks in 3 different categories',
        frequency: 'weekly',
        difficulty: 'medium',
        goalType: 'complete_tasks',
        goalValue: 3,
        xpReward: 100,
        icon: '🧭',
    },
    // Hard
    {
        id: 'weekly_warrior',
        title: 'Weekly Warrior',
        description: 'Complete 10 tasks this week',
        frequency: 'weekly',
        difficulty: 'hard',
        goalType: 'complete_tasks',
        goalValue: 10,
        xpReward: 300,
        icon: '⚔️',
    },
    {
        id: 'weekly_three_hundred',
        title: 'Earn $300',
        description: 'Earn $300 this week',
        frequency: 'weekly',
        difficulty: 'hard',
        goalType: 'earn_amount',
        goalValue: 300,
        xpReward: 250,
        icon: '💎',
    },
    {
        id: 'weekly_streak_keeper',
        title: 'Streak Keeper',
        description: 'Maintain your streak all week (7 days)',
        frequency: 'weekly',
        difficulty: 'hard',
        goalType: 'maintain_streak',
        goalValue: 7,
        xpReward: 200,
        icon: '🔥',
    },
    // Epic
    {
        id: 'weekly_perfect_week',
        title: 'Perfect Week',
        description: 'Get 5-star ratings on all tasks this week',
        frequency: 'weekly',
        difficulty: 'epic',
        goalType: 'get_rating',
        goalValue: 5,
        xpReward: 400,
        bonusRewardType: 'badge',
        bonusRewardId: 'perfect_five',
        icon: '🌟',
    },
    {
        id: 'weekly_five_hundred',
        title: 'Five Hundred Club',
        description: 'Earn $500 this week',
        frequency: 'weekly',
        difficulty: 'epic',
        goalType: 'earn_amount',
        goalValue: 500,
        xpReward: 350,
        bonusRewardType: 'multiplier',
        bonusRewardId: '1.5x_next_task',
        icon: '🏆',
    },
];
const SEASONAL_QUESTS = [
    {
        id: 'seasonal_winter_2024',
        title: 'Seattle Winter Hustle 2024',
        description: 'Complete 50 tasks during Winter 2024',
        frequency: 'seasonal',
        difficulty: 'epic',
        goalType: 'complete_tasks',
        goalValue: 50,
        xpReward: 500,
        bonusRewardType: 'badge',
        bonusRewardId: 'seattle_winter_2024',
        icon: '❄️',
    },
    {
        id: 'seasonal_holiday_hero',
        title: 'Holiday Hero',
        description: 'Help the community during the holidays - complete 10 tasks Dec 20-31',
        frequency: 'seasonal',
        difficulty: 'hard',
        goalType: 'complete_tasks',
        goalValue: 10,
        xpReward: 300,
        bonusRewardType: 'badge',
        bonusRewardId: 'holiday_hero_2024',
        icon: '🎄',
    },
    {
        id: 'seasonal_new_year_push',
        title: 'New Year Push',
        description: 'Start 2025 strong - complete 20 tasks in January',
        frequency: 'seasonal',
        difficulty: 'hard',
        goalType: 'complete_tasks',
        goalValue: 20,
        xpReward: 400,
        icon: '🎆',
    },
];
// Category-specific quests
const CATEGORY_QUESTS = [
    {
        id: 'category_cleaning_5',
        title: 'Cleaning Specialist',
        description: 'Complete 5 cleaning tasks',
        frequency: 'one_time',
        difficulty: 'medium',
        goalType: 'complete_category',
        goalValue: 5,
        goalCategory: 'cleaning',
        xpReward: 100,
        icon: '🧹',
    },
    {
        id: 'category_delivery_10',
        title: 'Delivery Master',
        description: 'Complete 10 delivery tasks',
        frequency: 'one_time',
        difficulty: 'hard',
        goalType: 'complete_category',
        goalValue: 10,
        goalCategory: 'delivery',
        xpReward: 150,
        icon: '📦',
    },
    {
        id: 'category_handyman_5',
        title: 'Handy Helper',
        description: 'Complete 5 handyman tasks',
        frequency: 'one_time',
        difficulty: 'medium',
        goalType: 'complete_category',
        goalValue: 5,
        goalCategory: 'handyman',
        xpReward: 125,
        icon: '🔧',
    },
    {
        id: 'category_pet_care_5',
        title: 'Pet Pal',
        description: 'Complete 5 pet care tasks',
        frequency: 'one_time',
        difficulty: 'medium',
        goalType: 'complete_category',
        goalValue: 5,
        goalCategory: 'pet_care',
        xpReward: 100,
        icon: '🐕',
    },
];
// ============================================
// In-Memory Store
// ============================================
const userQuests = new Map();
const questCompletionHistory = new Map();
// ============================================
// Quest Engine
// ============================================
class QuestEngineClass {
    /**
     * Get all available quest definitions
     */
    getAllQuestDefinitions() {
        return [
            ...DAILY_QUESTS,
            ...WEEKLY_QUESTS,
            ...SEASONAL_QUESTS,
            ...CATEGORY_QUESTS,
        ];
    }
    /**
     * Initialize quests for a new user
     */
    initializeUserQuests(userId) {
        if (userQuests.has(userId))
            return;
        const quests = [];
        const now = new Date();
        // Add 3 random daily quests
        const dailyQuests = this.selectRandomQuests(DAILY_QUESTS, 3);
        for (const def of dailyQuests) {
            quests.push(this.createUserQuest(userId, def, this.getEndOfDay()));
        }
        // Add 2 random weekly quests
        const weeklyQuests = this.selectRandomQuests(WEEKLY_QUESTS, 2);
        for (const def of weeklyQuests) {
            quests.push(this.createUserQuest(userId, def, this.getEndOfWeek()));
        }
        // Add active seasonal quests
        for (const def of SEASONAL_QUESTS) {
            quests.push(this.createUserQuest(userId, def, this.getSeasonEnd()));
        }
        userQuests.set(userId, quests);
        serviceLogger.info({ userId, questCount: quests.length }, 'Initialized user quests');
    }
    /**
     * Create a user quest from a definition
     */
    createUserQuest(userId, def, expiresAt) {
        return {
            id: uuidv4(),
            questDefinitionId: def.id,
            userId,
            status: 'active',
            currentProgress: 0,
            goalValue: def.goalValue,
            xpReward: def.xpReward,
            bonusRewardType: def.bonusRewardType,
            bonusRewardId: def.bonusRewardId,
            createdAt: new Date(),
            expiresAt,
        };
    }
    /**
     * Select random quests from a list
     */
    selectRandomQuests(quests, count) {
        const shuffled = [...quests].sort(() => Math.random() - 0.5);
        return shuffled.slice(0, count);
    }
    /**
     * Get daily quests for a user
     */
    getDailyQuests(userId) {
        this.initializeUserQuests(userId);
        return this.getQuestsByFrequency(userId, 'daily');
    }
    /**
     * Get weekly quests for a user
     */
    getWeeklyQuests(userId) {
        this.initializeUserQuests(userId);
        return this.getQuestsByFrequency(userId, 'weekly');
    }
    /**
     * Get seasonal quests for a user
     */
    getSeasonalQuests(userId) {
        this.initializeUserQuests(userId);
        return this.getQuestsByFrequency(userId, 'seasonal');
    }
    /**
     * Get all active quests for a user
     */
    getAllActiveQuests(userId) {
        this.initializeUserQuests(userId);
        const quests = userQuests.get(userId) || [];
        const now = new Date();
        return quests
            .filter(q => q.status === 'active' && q.expiresAt > now)
            .map(q => this.enrichQuest(q));
    }
    /**
     * Get quests by frequency
     */
    getQuestsByFrequency(userId, frequency) {
        const quests = userQuests.get(userId) || [];
        const now = new Date();
        const allDefs = this.getAllQuestDefinitions();
        return quests
            .filter(q => {
            const def = allDefs.find(d => d.id === q.questDefinitionId);
            return def?.frequency === frequency && q.expiresAt > now;
        })
            .map(q => this.enrichQuest(q));
    }
    /**
     * Enrich a quest with its definition and computed fields
     */
    enrichQuest(quest) {
        const allDefs = this.getAllQuestDefinitions();
        const definition = allDefs.find(d => d.id === quest.questDefinitionId);
        const percentComplete = Math.min(100, Math.round((quest.currentProgress / quest.goalValue) * 100));
        const timeRemaining = this.formatTimeRemaining(quest.expiresAt);
        return {
            ...quest,
            definition,
            percentComplete,
            timeRemaining,
        };
    }
    /**
     * Format time remaining as human-readable string
     */
    formatTimeRemaining(expiresAt) {
        const now = new Date();
        const diff = expiresAt.getTime() - now.getTime();
        if (diff <= 0)
            return 'Expired';
        const hours = Math.floor(diff / (1000 * 60 * 60));
        const days = Math.floor(hours / 24);
        if (days > 0) {
            return `${days}d ${hours % 24}h left`;
        }
        if (hours > 0) {
            return `${hours}h left`;
        }
        const minutes = Math.floor(diff / (1000 * 60));
        return `${minutes}m left`;
    }
    /**
     * Update quest progress after task completion
     */
    updateProgress(userId, eventData) {
        this.initializeUserQuests(userId);
        const quests = userQuests.get(userId) || [];
        const allDefs = this.getAllQuestDefinitions();
        const updatedQuests = [];
        const completedQuests = [];
        for (const quest of quests) {
            if (quest.status !== 'active')
                continue;
            const def = allDefs.find(d => d.id === quest.questDefinitionId);
            if (!def)
                continue;
            let progressMade = false;
            // Check if this event contributes to the quest
            switch (def.goalType) {
                case 'complete_tasks':
                    if (eventData.type === 'task_completed') {
                        quest.currentProgress++;
                        progressMade = true;
                    }
                    break;
                case 'complete_category':
                    if (eventData.type === 'task_completed' && eventData.category === def.goalCategory) {
                        quest.currentProgress++;
                        progressMade = true;
                    }
                    break;
                case 'earn_amount':
                    if (eventData.type === 'earned') {
                        quest.currentProgress += eventData.value;
                        progressMade = true;
                    }
                    break;
                case 'get_rating':
                    if (eventData.type === 'rating' && eventData.value >= def.goalValue) {
                        quest.currentProgress++;
                        progressMade = true;
                    }
                    break;
                case 'complete_fast':
                    if (eventData.type === 'task_completed' &&
                        eventData.durationMinutes &&
                        eventData.durationMinutes <= def.goalValue) {
                        quest.currentProgress++;
                        progressMade = true;
                    }
                    break;
                case 'maintain_streak':
                    if (eventData.type === 'streak') {
                        quest.currentProgress = Math.max(quest.currentProgress, eventData.value);
                        progressMade = true;
                    }
                    break;
            }
            if (progressMade) {
                const enriched = this.enrichQuest(quest);
                updatedQuests.push(enriched);
                // Check if quest is now complete
                if (quest.currentProgress >= quest.goalValue && quest.status === 'active') {
                    quest.status = 'completed';
                    quest.completedAt = new Date();
                    completedQuests.push(enriched);
                    serviceLogger.info({
                        userId,
                        questId: quest.id,
                        quest: def.title,
                        xp: quest.xpReward,
                    }, 'Quest completed');
                }
            }
        }
        return { updatedQuests, completedQuests };
    }
    /**
     * Claim rewards for a completed quest
     */
    claimQuest(userId, questId) {
        const quests = userQuests.get(userId) || [];
        const quest = quests.find(q => q.id === questId);
        if (!quest) {
            return { success: false, xpAwarded: 0, message: 'Quest not found' };
        }
        if (quest.status !== 'completed') {
            return { success: false, xpAwarded: 0, message: 'Quest not completed' };
        }
        quest.status = 'claimed';
        quest.claimedAt = new Date();
        // Track completion history
        const history = questCompletionHistory.get(userId) || [];
        history.push({ questId: quest.questDefinitionId, completedAt: new Date() });
        questCompletionHistory.set(userId, history);
        const allDefs = this.getAllQuestDefinitions();
        const def = allDefs.find(d => d.id === quest.questDefinitionId);
        serviceLogger.info({
            userId,
            questId,
            quest: def?.title,
            xp: quest.xpReward,
        }, 'Quest reward claimed');
        return {
            success: true,
            xpAwarded: quest.xpReward,
            bonusReward: quest.bonusRewardType ? {
                type: quest.bonusRewardType,
                id: quest.bonusRewardId,
            } : undefined,
            message: `🎉 Quest complete! +${quest.xpReward} XP`,
        };
    }
    /**
     * Refresh daily quests (call at midnight)
     */
    refreshDailyQuests(userId) {
        const quests = userQuests.get(userId) || [];
        const allDefs = this.getAllQuestDefinitions();
        // Remove old daily quests
        const filtered = quests.filter(q => {
            const def = allDefs.find(d => d.id === q.questDefinitionId);
            return def?.frequency !== 'daily';
        });
        // Add new daily quests
        const dailyQuests = this.selectRandomQuests(DAILY_QUESTS, 3);
        for (const def of dailyQuests) {
            filtered.push(this.createUserQuest(userId, def, this.getEndOfDay()));
        }
        userQuests.set(userId, filtered);
        return this.getDailyQuests(userId);
    }
    /**
     * Refresh weekly quests (call on Sunday)
     */
    refreshWeeklyQuests(userId) {
        const quests = userQuests.get(userId) || [];
        const allDefs = this.getAllQuestDefinitions();
        // Remove old weekly quests
        const filtered = quests.filter(q => {
            const def = allDefs.find(d => d.id === q.questDefinitionId);
            return def?.frequency !== 'weekly';
        });
        // Add new weekly quests
        const weeklyQuests = this.selectRandomQuests(WEEKLY_QUESTS, 2);
        for (const def of weeklyQuests) {
            filtered.push(this.createUserQuest(userId, def, this.getEndOfWeek()));
        }
        userQuests.set(userId, filtered);
        return this.getWeeklyQuests(userId);
    }
    /**
     * Get quest completion stats
     */
    getQuestStats(userId) {
        const history = questCompletionHistory.get(userId) || [];
        const allDefs = this.getAllQuestDefinitions();
        let dailyCompleted = 0;
        let weeklyCompleted = 0;
        let seasonalCompleted = 0;
        let totalXP = 0;
        for (const entry of history) {
            const def = allDefs.find(d => d.id === entry.questId);
            if (!def)
                continue;
            totalXP += def.xpReward;
            switch (def.frequency) {
                case 'daily':
                    dailyCompleted++;
                    break;
                case 'weekly':
                    weeklyCompleted++;
                    break;
                case 'seasonal':
                    seasonalCompleted++;
                    break;
            }
        }
        return {
            totalCompleted: history.length,
            dailyCompleted,
            weeklyCompleted,
            seasonalCompleted,
            totalXPFromQuests: totalXP,
        };
    }
    /**
     * Generate a personalized quest using AI
     */
    async generatePersonalizedQuest(userId, userStats) {
        try {
            const result = await routedGenerate('planning', {
                system: `You are a quest designer for HustleXP, a gig marketplace app.
Create an engaging, achievable quest based on the user's stats.

Return JSON:
{
    "title": "Short catchy title",
    "description": "What they need to do", 
    "goalType": "complete_tasks | earn_amount | complete_category | maintain_streak",
    "goalValue": number,
    "goalCategory": "cleaning | delivery | handyman | etc" (only for complete_category),
    "difficulty": "easy | medium | hard",
    "xpReward": 50-200,
    "icon": "emoji"
}`,
                messages: [{
                        role: 'user',
                        content: `User stats:
- Top categories: ${userStats.topCategories.join(', ') || 'None yet'}
- Current streak: ${userStats.currentStreak} days
- Recent earnings: $${userStats.recentEarnings}
- Level: ${userStats.level}

Create a quest that:
1. Matches their skill or encourages trying something new
2. Is achievable but challenging
3. Feels rewarding`,
                    }],
                json: true,
                maxTokens: 256,
            });
            const questData = JSON.parse(result.content);
            const quest = {
                id: `ai_${uuidv4().slice(0, 8)}`,
                title: questData.title,
                description: questData.description,
                frequency: 'daily',
                difficulty: questData.difficulty,
                goalType: questData.goalType,
                goalValue: questData.goalValue,
                goalCategory: questData.goalCategory,
                xpReward: questData.xpReward,
                icon: questData.icon || '🎯',
            };
            serviceLogger.info({ userId, quest: quest.title }, 'Generated personalized quest');
            return quest;
        }
        catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to generate personalized quest');
            return null;
        }
    }
    // ============================================
    // Helper Functions
    // ============================================
    getEndOfDay() {
        const end = new Date();
        end.setHours(23, 59, 59, 999);
        return end;
    }
    getEndOfWeek() {
        const end = new Date();
        const daysUntilSunday = 7 - end.getDay();
        end.setDate(end.getDate() + daysUntilSunday);
        end.setHours(23, 59, 59, 999);
        return end;
    }
    getSeasonEnd() {
        // For Winter 2024, end is March 20, 2025
        return new Date('2025-03-20T23:59:59');
    }
}
export const QuestEngine = new QuestEngineClass();
//# sourceMappingURL=QuestEngine.js.map