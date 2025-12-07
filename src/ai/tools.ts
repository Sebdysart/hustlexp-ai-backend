/**
 * Tool layer - safe, controlled wrappers for business logic
 * The AI calls these functions instead of hitting the DB directly
 */

import { TaskService } from '../services/TaskService.js';
import { UserService } from '../services/UserService.js';
import { GamificationService } from '../services/GamificationService.js';
import { ModerationService } from '../services/ModerationService.js';
import type {
    Task,
    TaskDraft,
    TaskCategory,
    HustlerCandidate,
    ModerationResult,
    Quest,
    XPEvent
} from '../types/index.js';
import { aiLogger } from '../utils/logger.js';

// ============================================
// Task Tools
// ============================================

export interface CreateTaskArgs {
    clientId: string;
    draft: TaskDraft;
}

export interface SearchTasksArgs {
    category?: TaskCategory;
    maxDistance?: number;
    minPrice?: number;
    maxPrice?: number;
    limit?: number;
}

export interface AssignHustlerArgs {
    taskId: string;
    hustlerId: string;
}

// ============================================
// XP Tools
// ============================================

export interface AwardXPArgs {
    userId: string;
    amount: number;
    reason: string;
    taskId?: string;
}

// ============================================
// Moderation Tools
// ============================================

export interface ModerateContentArgs {
    content: string;
    context?: string;
}

// ============================================
// Tool Implementations
// ============================================

export const tools = {
    // === Task Tools ===

    async createTask(args: CreateTaskArgs): Promise<Task> {
        aiLogger.debug({ clientId: args.clientId }, 'Tool: createTask');
        return TaskService.createTaskFromDraft(args.clientId, args.draft);
    },

    async searchTasks(args: SearchTasksArgs): Promise<Task[]> {
        aiLogger.debug({ args }, 'Tool: searchTasks');
        return TaskService.searchTasks(args);
    },

    async getOpenTasksForHustler(hustlerId: string, limit = 20): Promise<Task[]> {
        aiLogger.debug({ hustlerId, limit }, 'Tool: getOpenTasksForHustler');
        return TaskService.getOpenTasksForHustler(hustlerId, limit);
    },

    async getCandidateHustlers(taskId: string): Promise<HustlerCandidate[]> {
        aiLogger.debug({ taskId }, 'Tool: getCandidateHustlers');
        const task = await TaskService.getTask(taskId);
        if (!task) return [];
        return TaskService.getCandidateHustlers(task);
    },

    async assignHustler(args: AssignHustlerArgs): Promise<Task | null> {
        aiLogger.debug({ args }, 'Tool: assignHustler');
        return TaskService.assignHustler(args.taskId, args.hustlerId);
    },

    async completeTask(taskId: string): Promise<Task | null> {
        aiLogger.debug({ taskId }, 'Tool: completeTask');
        return TaskService.completeTask(taskId);
    },

    // === User Tools ===

    async getUser(userId: string) {
        aiLogger.debug({ userId }, 'Tool: getUser');
        return UserService.getUser(userId);
    },

    async getUserStats(userId: string) {
        aiLogger.debug({ userId }, 'Tool: getUserStats');
        return UserService.getUserStats(userId);
    },

    async getHustlerProfile(userId: string) {
        aiLogger.debug({ userId }, 'Tool: getHustlerProfile');
        return UserService.getHustlerProfile(userId);
    },

    // === Gamification Tools ===

    async awardXP(args: AwardXPArgs): Promise<XPEvent> {
        aiLogger.debug({ args }, 'Tool: awardXP');
        return GamificationService.awardXP(args.userId, args.amount, args.reason, args.taskId);
    },

    async getActiveQuests(userId: string): Promise<Quest[]> {
        aiLogger.debug({ userId }, 'Tool: getActiveQuests');
        return GamificationService.getActiveQuests(userId);
    },

    async generateQuest(userId: string, recentCategories: string[], streak: number): Promise<Quest | null> {
        aiLogger.debug({ userId, streak }, 'Tool: generateQuest');
        return GamificationService.generateQuestForUser(userId, { recentCategories, streak });
    },

    // === Moderation Tools ===

    async moderateContent(args: ModerateContentArgs): Promise<ModerationResult> {
        aiLogger.debug({ contentLength: args.content.length }, 'Tool: moderateContent');
        return ModerationService.check(args.content, args.context);
    },
};

export type ToolName = keyof typeof tools;
