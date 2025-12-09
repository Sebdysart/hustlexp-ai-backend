/**
 * User Brain Service
 * 
 * The "learned model" of each user that grows smarter over time.
 * Stores goals, constraints, preferences, and behavioral patterns.
 * 
 * Core insight: Every interaction → learning → better next response
 */

import { v4 as uuidv4 } from 'uuid';
import { serviceLogger } from '../utils/logger.js';
import type { TaskCategory } from '../types/index.js';

// ============================================
// Types
// ============================================

export interface UserGoals {
    monthlyIncomeTarget?: number;
    weeklyIncomeTarget?: number;
    shortTermGoal?: string;  // "pay_off_debt", "save_for_trip", "side_income"
    weeklyTaskTarget?: number;
    customGoalText?: string;
}

export interface UserConstraints {
    hasCar: boolean;
    petFriendly: boolean;
    maxDistanceKm?: number;
    canDoHeavyLifting: boolean;
    hasTools: boolean;
    availableTimes: AvailabilityTime[];
    unavailableDays: number[];  // 0-6, Sunday = 0
    locationPreference?: string;  // "Capitol Hill", "Downtown", etc.
}

export type AvailabilityTime = 'mornings' | 'afternoons' | 'evenings' | 'nights' | 'weekends';

export interface TaskPreferences {
    preferredCategories: TaskCategory[];
    avoidedCategories: TaskCategory[];
    preferredPriceRange: { min: number; max: number };
    prefersShortTasks: boolean;
    prefersIndoorTasks: boolean;
    maxTaskDurationMinutes?: number;
}

export interface EngagementStyle {
    respondsToQuests: boolean;
    maintainsStreak: boolean;
    activeHours: number[];  // Hour of day when most active (0-23)
    activeDays: number[];   // Days when most active (0-6)
    avgTasksPerWeek: number;
    avgResponseTimeMinutes: number;
    prefersChatCoaching: boolean;
}

export interface UserBrain {
    userId: string;
    role: 'hustler' | 'client' | 'both';

    // Learned from chat + behavior
    goals: UserGoals;
    constraints: UserConstraints;
    taskPreferences: TaskPreferences;
    engagementStyle: EngagementStyle;

    // AI conversation memory
    aiHistorySummary: string;
    recentFacts: string[];  // Key facts extracted from recent conversations

    // Stats
    totalInteractions: number;
    learningScore: number;  // 0-100, how well we know this user

    // Timestamps
    createdAt: Date;
    updatedAt: Date;
    lastActiveAt: Date;
}

export interface AIContext {
    userId: string;
    role: 'hustler' | 'client' | 'both';

    // Profile snapshot
    level: number;
    xp: number;
    streakDays: number;
    earningsLast7d: number;
    topCategories: TaskCategory[];

    // Learned preferences
    goals: UserGoals;
    constraints: UserConstraints;
    taskPreferences: TaskPreferences;

    // Memory
    aiHistorySummary: string;

    // Learning quality
    learningScore: number;
}

export type ScreenContext =
    | 'home'
    | 'feed'
    | 'task_create'
    | 'task_detail'
    | 'profile'
    | 'earnings'
    | 'quests'
    | 'badges'
    | 'settings'
    | 'onboarding'
    | 'wallet'
    | 'chat';

// ============================================
// In-Memory Storage (Redis/Postgres in production)
// ============================================

const userBrains = new Map<string, UserBrain>();

// ============================================
// User Brain Service
// ============================================

class UserBrainServiceClass {
    /**
     * Get or initialize a user's brain
     */
    getUserBrain(userId: string): UserBrain {
        let brain = userBrains.get(userId);

        if (!brain) {
            brain = this.initializeBrain(userId);
            userBrains.set(userId, brain);
        }

        return brain;
    }

    /**
     * Initialize a new brain with defaults
     */
    private initializeBrain(userId: string): UserBrain {
        return {
            userId,
            role: 'hustler',

            goals: {},

            constraints: {
                hasCar: true,  // Default assume yes
                petFriendly: true,
                canDoHeavyLifting: true,
                hasTools: false,
                availableTimes: [],
                unavailableDays: [],
            },

            taskPreferences: {
                preferredCategories: [],
                avoidedCategories: [],
                preferredPriceRange: { min: 20, max: 200 },
                prefersShortTasks: false,
                prefersIndoorTasks: false,
            },

            engagementStyle: {
                respondsToQuests: true,
                maintainsStreak: false,
                activeHours: [],
                activeDays: [],
                avgTasksPerWeek: 0,
                avgResponseTimeMinutes: 0,
                prefersChatCoaching: true,
            },

            aiHistorySummary: '',
            recentFacts: [],

            totalInteractions: 0,
            learningScore: 0,

            createdAt: new Date(),
            updatedAt: new Date(),
            lastActiveAt: new Date(),
        };
    }

    /**
     * Update brain from a chat message
     * Uses AIMemoryService for AI-powered extraction (Phase 2 upgrade)
     */
    async updateFromChat(userId: string, userMessage: string, aiResponse?: string): Promise<void> {
        const brain = this.getUserBrain(userId);
        brain.totalInteractions++;
        brain.lastActiveAt = new Date();

        // Phase 1: Quick regex extraction (fallback)
        const regexExtracted = this.extractPreferencesFromMessage(userMessage);

        // Update goals from regex
        if (regexExtracted.goals) {
            Object.assign(brain.goals, regexExtracted.goals);
        }

        // Update constraints from regex
        if (regexExtracted.constraints) {
            Object.assign(brain.constraints, regexExtracted.constraints);
        }

        // Update task preferences from regex
        if (regexExtracted.taskPreferences) {
            if (regexExtracted.taskPreferences.preferredCategories?.length) {
                brain.taskPreferences.preferredCategories = [
                    ...new Set([...brain.taskPreferences.preferredCategories, ...regexExtracted.taskPreferences.preferredCategories])
                ];
            }
            if (regexExtracted.taskPreferences.avoidedCategories?.length) {
                brain.taskPreferences.avoidedCategories = [
                    ...new Set([...brain.taskPreferences.avoidedCategories, ...regexExtracted.taskPreferences.avoidedCategories])
                ];
            }
            if (regexExtracted.taskPreferences.prefersShortTasks) {
                brain.taskPreferences.prefersShortTasks = true;
            }
            if (regexExtracted.taskPreferences.prefersIndoorTasks) {
                brain.taskPreferences.prefersIndoorTasks = true;
            }
        }

        // Add facts from regex
        if (regexExtracted.facts?.length) {
            brain.recentFacts = [...regexExtracted.facts, ...brain.recentFacts].slice(0, 20);
        }

        // Phase 2: AI-powered extraction (async, non-blocking)
        // Import dynamically to avoid circular dependency
        try {
            const { AIMemoryService } = await import('./AIMemoryService.js');

            // Add to conversation history and extract facts using AI
            const memoryResult = await AIMemoryService.addConversation(userId, userMessage, aiResponse);

            // If AI extracted facts, update brain with structured data
            if (memoryResult.factsExtracted > 0) {
                const structuredData = AIMemoryService.getStructuredData(userId);

                // Merge AI-extracted goals
                if (structuredData.goals.monthlyIncome) {
                    brain.goals.monthlyIncomeTarget = structuredData.goals.monthlyIncome;
                }
                if (structuredData.goals.weeklyIncome) {
                    brain.goals.weeklyIncomeTarget = structuredData.goals.weeklyIncome;
                }
                if (structuredData.goals.shortTermGoal) {
                    brain.goals.shortTermGoal = structuredData.goals.shortTermGoal;
                }

                // Merge AI-extracted constraints
                if (structuredData.constraints.hasCar !== undefined) {
                    brain.constraints.hasCar = structuredData.constraints.hasCar;
                }
                if (structuredData.constraints.petFriendly !== undefined) {
                    brain.constraints.petFriendly = structuredData.constraints.petFriendly;
                }
                if (structuredData.constraints.canDoHeavyLifting !== undefined) {
                    brain.constraints.canDoHeavyLifting = structuredData.constraints.canDoHeavyLifting;
                }
                if (structuredData.constraints.availableTimes) {
                    brain.constraints.availableTimes = structuredData.constraints.availableTimes;
                }

                // Merge AI-extracted preferences
                if (structuredData.preferences.preferredCategories) {
                    brain.taskPreferences.preferredCategories = [
                        ...new Set([...brain.taskPreferences.preferredCategories, ...structuredData.preferences.preferredCategories])
                    ];
                }
                if (structuredData.preferences.avoidedCategories) {
                    brain.taskPreferences.avoidedCategories = [
                        ...new Set([...brain.taskPreferences.avoidedCategories, ...structuredData.preferences.avoidedCategories])
                    ];
                }
                if (structuredData.preferences.prefersShortTasks) {
                    brain.taskPreferences.prefersShortTasks = true;
                }
                if (structuredData.preferences.prefersIndoorTasks) {
                    brain.taskPreferences.prefersIndoorTasks = true;
                }
            }

            // If new summary was generated, use it
            if (memoryResult.newSummary) {
                brain.aiHistorySummary = AIMemoryService.getSummary(userId);
            }

            serviceLogger.debug({
                userId,
                factsExtractedAI: memoryResult.factsExtracted,
                newSummary: memoryResult.newSummary,
            }, 'Brain updated with AI-powered extraction');

        } catch (error) {
            // AI extraction failed, fall back to regex only
            serviceLogger.debug({ userId, error }, 'AI extraction failed, using regex only');
        }

        // Update learning score
        brain.learningScore = this.calculateLearningScore(brain);

        // Generate summary from regex if no AI summary
        if (!brain.aiHistorySummary && brain.totalInteractions % 5 === 0) {
            brain.aiHistorySummary = this.generateSummary(brain);
        }

        brain.updatedAt = new Date();
        userBrains.set(userId, brain);

        serviceLogger.debug({ userId, learningScore: brain.learningScore }, 'Brain updated from chat');
    }

    /**
     * Extract structured preferences from a message
     */
    private extractPreferencesFromMessage(message: string): {
        goals?: Partial<UserGoals>;
        constraints?: Partial<UserConstraints>;
        taskPreferences?: Partial<TaskPreferences>;
        facts?: string[];
    } {
        const lowerMsg = message.toLowerCase();
        const result: {
            goals?: Partial<UserGoals>;
            constraints?: Partial<UserConstraints>;
            taskPreferences?: Partial<TaskPreferences>;
            facts?: string[];
        } = { facts: [] };

        // Income goals
        const incomeMatch = lowerMsg.match(/\$(\d+)\s*(per|a|\/)\s*(month|week)/);
        if (incomeMatch) {
            const amount = parseInt(incomeMatch[1]);
            const period = incomeMatch[3];
            if (period === 'month') {
                result.goals = { monthlyIncomeTarget: amount };
                result.facts!.push(`Wants to earn $${amount}/month`);
            } else if (period === 'week') {
                result.goals = { weeklyIncomeTarget: amount };
                result.facts!.push(`Wants to earn $${amount}/week`);
            }
        }

        // Car constraints
        if (lowerMsg.includes("don't have a car") || lowerMsg.includes("no car") || lowerMsg.includes("don't drive")) {
            result.constraints = { hasCar: false };
            result.facts!.push("Doesn't have a car");
        }

        // Pet constraints
        if (lowerMsg.includes("no pets") || lowerMsg.includes("allergic to") || lowerMsg.includes("don't like pets")) {
            result.constraints = { ...result.constraints, petFriendly: false };
            result.facts!.push("Prefers no pet tasks");
        }

        // Heavy lifting
        if (lowerMsg.includes("no heavy") || lowerMsg.includes("can't lift") || lowerMsg.includes("bad back")) {
            result.constraints = { ...result.constraints, canDoHeavyLifting: false };
            result.facts!.push("Can't do heavy lifting");
        }

        // Time preferences
        if (lowerMsg.includes("evening") || lowerMsg.includes("after work")) {
            result.constraints = { ...result.constraints, availableTimes: ['evenings'] };
            result.facts!.push("Prefers evening work");
        }
        if (lowerMsg.includes("weekend") || lowerMsg.includes("saturday") || lowerMsg.includes("sunday")) {
            result.constraints = { ...result.constraints, availableTimes: ['weekends'] };
            result.facts!.push("Works on weekends");
        }

        // Category preferences
        const categories: TaskCategory[] = ['delivery', 'cleaning', 'moving', 'pet_care', 'errands', 'handyman', 'yard_work'];
        for (const cat of categories) {
            const catName = cat.replace('_', ' ');
            if (lowerMsg.includes(`like ${catName}`) || lowerMsg.includes(`prefer ${catName}`) || lowerMsg.includes(`good at ${catName}`)) {
                result.taskPreferences = { preferredCategories: [cat] };
                result.facts!.push(`Likes ${catName} tasks`);
            }
            if (lowerMsg.includes(`hate ${catName}`) || lowerMsg.includes(`avoid ${catName}`) || lowerMsg.includes(`no ${catName}`)) {
                result.taskPreferences = { ...result.taskPreferences, avoidedCategories: [cat] };
                result.facts!.push(`Avoids ${catName} tasks`);
            }
        }

        // Indoor preference
        if (lowerMsg.includes("indoor") || lowerMsg.includes("inside")) {
            result.taskPreferences = { ...result.taskPreferences, prefersIndoorTasks: true };
            result.facts!.push("Prefers indoor tasks");
        }

        // Short tasks
        if (lowerMsg.includes("quick") || lowerMsg.includes("short") || lowerMsg.includes("fast")) {
            result.taskPreferences = { ...result.taskPreferences, prefersShortTasks: true };
            result.facts!.push("Prefers quick tasks");
        }

        // Goals
        if (lowerMsg.includes("debt") || lowerMsg.includes("pay off")) {
            result.goals = { ...result.goals, shortTermGoal: 'pay_off_debt' };
            result.facts!.push("Working to pay off debt");
        }
        if (lowerMsg.includes("save") || lowerMsg.includes("saving for")) {
            result.goals = { ...result.goals, shortTermGoal: 'saving' };
            result.facts!.push("Saving for something");
        }
        if (lowerMsg.includes("side hustle") || lowerMsg.includes("extra money") || lowerMsg.includes("part time")) {
            result.goals = { ...result.goals, shortTermGoal: 'side_income' };
            result.facts!.push("Looking for side income");
        }

        return result;
    }

    /**
     * Calculate how well we know this user (0-100)
     */
    private calculateLearningScore(brain: UserBrain): number {
        let score = 0;

        // Goals (20 points)
        if (brain.goals.monthlyIncomeTarget || brain.goals.weeklyIncomeTarget) score += 10;
        if (brain.goals.shortTermGoal) score += 10;

        // Constraints (20 points)
        if (brain.constraints.availableTimes.length > 0) score += 10;
        if (brain.constraints.maxDistanceKm !== undefined) score += 5;
        if (brain.constraints.hasCar !== undefined) score += 5;

        // Task preferences (30 points)
        if (brain.taskPreferences.preferredCategories.length > 0) score += 15;
        if (brain.taskPreferences.avoidedCategories.length > 0) score += 10;
        if (brain.taskPreferences.prefersShortTasks || brain.taskPreferences.prefersIndoorTasks) score += 5;

        // Engagement (20 points)
        if (brain.engagementStyle.activeHours.length > 0) score += 10;
        if (brain.engagementStyle.avgTasksPerWeek > 0) score += 10;

        // Interactions (10 points)
        if (brain.totalInteractions >= 5) score += 5;
        if (brain.totalInteractions >= 20) score += 5;

        return Math.min(100, score);
    }

    /**
     * Generate a compressed summary of what we know
     */
    private generateSummary(brain: UserBrain): string {
        const parts: string[] = [];

        // Goals
        if (brain.goals.monthlyIncomeTarget) {
            parts.push(`Targeting $${brain.goals.monthlyIncomeTarget}/month`);
        }
        if (brain.goals.shortTermGoal) {
            parts.push(`Goal: ${brain.goals.shortTermGoal.replace('_', ' ')}`);
        }

        // Constraints
        if (!brain.constraints.hasCar) {
            parts.push(`No car`);
        }
        if (!brain.constraints.petFriendly) {
            parts.push(`No pets`);
        }
        if (!brain.constraints.canDoHeavyLifting) {
            parts.push(`No heavy lifting`);
        }
        if (brain.constraints.availableTimes.length > 0) {
            parts.push(`Works ${brain.constraints.availableTimes.join(', ')}`);
        }

        // Preferences
        if (brain.taskPreferences.preferredCategories.length > 0) {
            parts.push(`Likes: ${brain.taskPreferences.preferredCategories.join(', ')}`);
        }
        if (brain.taskPreferences.avoidedCategories.length > 0) {
            parts.push(`Avoids: ${brain.taskPreferences.avoidedCategories.join(', ')}`);
        }
        if (brain.taskPreferences.prefersIndoorTasks) {
            parts.push(`Prefers indoor`);
        }
        if (brain.taskPreferences.prefersShortTasks) {
            parts.push(`Prefers quick tasks`);
        }

        return parts.join('. ') + (parts.length > 0 ? '.' : '');
    }

    /**
     * Build full context for AI orchestrator
     */
    async getContextForAI(userId: string): Promise<AIContext> {
        const brain = this.getUserBrain(userId);

        // In production, fetch real stats from GrowthCoachService
        // For now, return what we have
        return {
            userId,
            role: brain.role,

            // Would be fetched from real user data
            level: 1,
            xp: 0,
            streakDays: 0,
            earningsLast7d: 0,
            topCategories: brain.taskPreferences.preferredCategories,

            goals: brain.goals,
            constraints: brain.constraints,
            taskPreferences: brain.taskPreferences,

            aiHistorySummary: brain.aiHistorySummary || 'New user, still learning their preferences.',

            learningScore: brain.learningScore,
        };
    }

    /**
     * Update brain from behavioral action (task accepted, skipped, etc.)
     */
    updateFromAction(userId: string, action: {
        type: 'accepted_task' | 'skipped_task' | 'completed_task' | 'cancelled_task';
        category?: TaskCategory;
        price?: number;
        durationMinutes?: number;
    }): void {
        const brain = this.getUserBrain(userId);

        switch (action.type) {
            case 'accepted_task':
            case 'completed_task':
                // Learn they like this category
                if (action.category && !brain.taskPreferences.preferredCategories.includes(action.category)) {
                    // After 3 completions in a category, it becomes preferred
                    // For now, just track it
                }
                // Track active hour
                const hour = new Date().getHours();
                if (!brain.engagementStyle.activeHours.includes(hour)) {
                    brain.engagementStyle.activeHours.push(hour);
                }
                break;

            case 'skipped_task':
                // After multiple skips of a category, mark as avoided
                if (action.category) {
                    // Would need counter for production
                }
                break;

            case 'cancelled_task':
                // Track cancellation patterns
                break;
        }

        brain.updatedAt = new Date();
        brain.lastActiveAt = new Date();
        userBrains.set(userId, brain);
    }

    /**
     * Get raw brain data for debugging
     */
    getRawBrain(userId: string): UserBrain | undefined {
        return userBrains.get(userId);
    }

    /**
     * Reset a user's brain (for testing)
     */
    resetBrain(userId: string): void {
        userBrains.delete(userId);
        serviceLogger.info({ userId }, 'User brain reset');
    }

    /**
     * Get all brains for analytics
     */
    getAllBrains(): UserBrain[] {
        return Array.from(userBrains.values());
    }
}

export const UserBrainService = new UserBrainServiceClass();
