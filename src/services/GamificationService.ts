import { v4 as uuidv4 } from 'uuid';
import type { Quest, XPEvent } from '../types/index.js';
import { serviceLogger } from '../utils/logger.js';
import { routedGenerate } from '../ai/router.js';

// In-memory stores
const xpEvents: XPEvent[] = [];
const quests: Map<string, Quest[]> = new Map();

// XP amounts for different actions
const XP_AMOUNTS = {
    task_completed: 100,
    five_star_review: 50,
    streak_bonus_3: 25,
    streak_bonus_7: 75,
    streak_bonus_14: 150,
    quest_completed: 50, // Base, actual amount from quest
    first_task_category: 30,
};

// Level thresholds
const LEVEL_THRESHOLDS = [
    0, 100, 250, 500, 850, 1300, 1900, 2600, 3500, 4600, 6000, 7700, 9700, 12000, 15000
];

class GamificationServiceClass {
    calculateLevel(xp: number): number {
        for (let i = LEVEL_THRESHOLDS.length - 1; i >= 0; i--) {
            if (xp >= LEVEL_THRESHOLDS[i]) {
                return i + 1;
            }
        }
        return 1;
    }

    getXPForNextLevel(currentXP: number): { needed: number; progress: number } {
        const currentLevel = this.calculateLevel(currentXP);
        const currentThreshold = LEVEL_THRESHOLDS[currentLevel - 1] || 0;
        const nextThreshold = LEVEL_THRESHOLDS[currentLevel] || LEVEL_THRESHOLDS[LEVEL_THRESHOLDS.length - 1];

        return {
            needed: nextThreshold - currentXP,
            progress: (currentXP - currentThreshold) / (nextThreshold - currentThreshold),
        };
    }

    async awardXP(userId: string, amount: number, reason: string, taskId?: string): Promise<XPEvent> {
        const event: XPEvent = {
            userId,
            amount,
            reason,
            taskId,
            timestamp: new Date(),
        };

        xpEvents.push(event);
        serviceLogger.info({ userId, amount, reason }, 'XP awarded');

        return event;
    }

    async awardTaskCompletionXP(userId: string, taskId: string, rating?: number): Promise<number> {
        let totalXP = XP_AMOUNTS.task_completed;

        // Award base XP
        await this.awardXP(userId, XP_AMOUNTS.task_completed, 'Task completed', taskId);

        // Bonus for 5-star rating
        if (rating === 5) {
            await this.awardXP(userId, XP_AMOUNTS.five_star_review, 'Five star review', taskId);
            totalXP += XP_AMOUNTS.five_star_review;
        }

        return totalXP;
    }

    async checkAndAwardStreakBonus(userId: string, streak: number): Promise<number> {
        let bonus = 0;

        if (streak === 3) {
            bonus = XP_AMOUNTS.streak_bonus_3;
        } else if (streak === 7) {
            bonus = XP_AMOUNTS.streak_bonus_7;
        } else if (streak === 14) {
            bonus = XP_AMOUNTS.streak_bonus_14;
        }

        if (bonus > 0) {
            await this.awardXP(userId, bonus, `${streak}-day streak bonus`);
        }

        return bonus;
    }

    async getUserXPEvents(userId: string, limit = 20): Promise<XPEvent[]> {
        return xpEvents
            .filter(e => e.userId === userId)
            .slice(-limit)
            .reverse();
    }

    async getActiveQuests(userId: string): Promise<Quest[]> {
        return quests.get(userId)?.filter(q => !q.isCompleted && q.expiresAt > new Date()) || [];
    }

    async generateQuestForUser(userId: string, userStats: { recentCategories: string[]; streak: number }): Promise<Quest | null> {
        try {
            const prompt = `Generate a simple, achievable quest for a gig worker.

User context:
- Recent task categories: ${userStats.recentCategories.join(', ') || 'none yet'}
- Current streak: ${userStats.streak} days

Create a quest that encourages them to:
1. Try a new category they haven't done much of, OR
2. Maintain/extend their streak, OR  
3. Complete a certain number of tasks

Return JSON:
{
  "title": "Quest title (short, catchy)",
  "description": "What they need to do",
  "goalCondition": "e.g., complete_tasks:3 or category:cleaning",
  "xpReward": 50-150,
  "durationHours": 24-72
}`;

            const result = await routedGenerate('planning', {
                system: 'You are a gamification designer. Create engaging but achievable quests. Return only valid JSON.',
                messages: [{ role: 'user', content: prompt }],
                json: true,
                maxTokens: 256,
            });

            const questData = JSON.parse(result.content);

            const quest: Quest = {
                id: uuidv4(),
                userId,
                title: questData.title,
                description: questData.description,
                goalCondition: questData.goalCondition,
                xpReward: questData.xpReward,
                progress: 0,
                target: 1,
                isCompleted: false,
                expiresAt: new Date(Date.now() + questData.durationHours * 60 * 60 * 1000),
                createdAt: new Date(),
            };

            // Store quest
            const userQuests = quests.get(userId) || [];
            userQuests.push(quest);
            quests.set(userId, userQuests);

            serviceLogger.info({ userId, questId: quest.id, title: quest.title }, 'Quest generated');
            return quest;
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to generate quest');
            return null;
        }
    }
}

export const GamificationService = new GamificationServiceClass();
