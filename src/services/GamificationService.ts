import { v4 as uuidv4 } from 'uuid';
import type { Quest, XPEvent } from '../types/index.js';
import { serviceLogger } from '../utils/logger.js';
import { routedGenerate } from '../ai/router.js';
import { sql, isDatabaseAvailable } from '../db/index.js';

// PHASE 6.2: Removed in-memory storage - using database now
// Fallback arrays only used when DB unavailable
const xpEventsFallback: XPEvent[] = [];
const questsFallback: Map<string, Quest[]> = new Map();

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

    /**
     * PHASE 6.2: Persist XP to database with idempotency
     */
    async awardXP(userId: string, amount: number, reason: string, taskId?: string): Promise<XPEvent> {
        const event: XPEvent = {
            userId,
            amount,
            reason,
            taskId,
            timestamp: new Date(),
        };

        // Persist to database if available
        if (isDatabaseAvailable() && sql) {
            try {
                // Use ON CONFLICT to enforce idempotency for task-based XP
                await sql`
                    INSERT INTO xp_events (user_id, amount, reason, task_id)
                    VALUES (${userId}::uuid, ${amount}, ${reason}, ${taskId ? taskId : null}::uuid)
                    ON CONFLICT (user_id, task_id) WHERE task_id IS NOT NULL DO NOTHING
                `;
                serviceLogger.info({ userId, amount, reason, taskId }, 'XP awarded (DB)');
            } catch (error) {
                serviceLogger.error({ error, userId, reason }, 'Failed to persist XP to DB, using fallback');
                xpEventsFallback.push(event);
            }
        } else {
            // Fallback to in-memory when DB unavailable
            xpEventsFallback.push(event);
            serviceLogger.info({ userId, amount, reason }, 'XP awarded (fallback)');
        }

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

    /**
     * PHASE 6.2: Get XP events from database with fallback
     */
    async getUserXPEvents(userId: string, limit = 20): Promise<XPEvent[]> {
        if (isDatabaseAvailable() && sql) {
            try {
                const rows = await sql`
                    SELECT user_id as "userId", amount, reason, task_id as "taskId", created_at as timestamp
                    FROM xp_events
                    WHERE user_id = ${userId}::uuid
                    ORDER BY created_at DESC
                    LIMIT ${limit}
                `;
                return rows as XPEvent[];
            } catch (error) {
                serviceLogger.error({ error, userId }, 'Failed to fetch XP events from DB');
            }
        }
        // Fallback to in-memory
        return xpEventsFallback
            .filter((e: XPEvent) => e.userId === userId)
            .slice(-limit)
            .reverse();
    }

    /**
     * PHASE 6.2: Get active quests from database with fallback
     */
    async getActiveQuests(userId: string): Promise<Quest[]> {
        if (isDatabaseAvailable() && sql) {
            try {
                const rows = await sql`
                    SELECT id, user_id as "userId", title, description, goal_condition as "goalCondition",
                           xp_reward as "xpReward", progress, target, is_completed as "isCompleted",
                           expires_at as "expiresAt", created_at as "createdAt"
                    FROM quests
                    WHERE user_id = ${userId}::uuid
                      AND is_completed = false
                      AND expires_at > NOW()
                `;
                return rows as Quest[];
            } catch (error) {
                serviceLogger.error({ error, userId }, 'Failed to fetch quests from DB');
            }
        }
        // Fallback to in-memory
        return questsFallback.get(userId)?.filter((q: Quest) => !q.isCompleted && q.expiresAt > new Date()) || [];
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

            // PHASE 6.2: Store quest in database with fallback
            if (isDatabaseAvailable() && sql) {
                try {
                    await sql`
                        INSERT INTO quests (id, user_id, title, description, goal_condition, xp_reward, progress, target, is_completed, expires_at)
                        VALUES (${quest.id}::uuid, ${userId}::uuid, ${quest.title}, ${quest.description}, ${quest.goalCondition}, ${quest.xpReward}, ${quest.progress}, ${quest.target}, ${quest.isCompleted}, ${quest.expiresAt})
                    `;
                } catch (error) {
                    serviceLogger.error({ error, userId }, 'Failed to persist quest to DB, using fallback');
                    const userQuests = questsFallback.get(userId) || [];
                    userQuests.push(quest);
                    questsFallback.set(userId, userQuests);
                }
            } else {
                const userQuests = questsFallback.get(userId) || [];
                userQuests.push(quest);
                questsFallback.set(userId, userQuests);
            }

            serviceLogger.info({ userId, questId: quest.id, title: quest.title }, 'Quest generated');
            return quest;
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to generate quest');
            return null;
        }
    }
}

export const GamificationService = new GamificationServiceClass();
