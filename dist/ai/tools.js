/**
 * Tool layer - safe, controlled wrappers for business logic
 * The AI calls these functions instead of hitting the DB directly
 */
import { TaskService } from '../services/TaskService.js';
import { UserService } from '../services/UserService.js';
import { GamificationService } from '../services/GamificationService.js';
import { ModerationService } from '../services/ModerationService.js';
import { aiLogger } from '../utils/logger.js';
// ============================================
// Tool Implementations
// ============================================
export const tools = {
    // === Task Tools ===
    async createTask(args) {
        aiLogger.debug({ clientId: args.clientId }, 'Tool: createTask');
        return TaskService.createTaskFromDraft(args.clientId, args.draft);
    },
    async searchTasks(args) {
        aiLogger.debug({ args }, 'Tool: searchTasks');
        return TaskService.searchTasks(args);
    },
    async getOpenTasksForHustler(hustlerId, limit = 20) {
        aiLogger.debug({ hustlerId, limit }, 'Tool: getOpenTasksForHustler');
        return TaskService.getOpenTasksForHustler(hustlerId, limit);
    },
    async getCandidateHustlers(taskId) {
        aiLogger.debug({ taskId }, 'Tool: getCandidateHustlers');
        const task = await TaskService.getTask(taskId);
        if (!task)
            return [];
        return TaskService.getCandidateHustlers(task);
    },
    async assignHustler(args) {
        aiLogger.debug({ args }, 'Tool: assignHustler');
        return TaskService.assignHustler(args.taskId, args.hustlerId);
    },
    async completeTask(taskId) {
        aiLogger.debug({ taskId }, 'Tool: completeTask');
        return TaskService.completeTask(taskId);
    },
    // === User Tools ===
    async getUser(userId) {
        aiLogger.debug({ userId }, 'Tool: getUser');
        return UserService.getUser(userId);
    },
    async getUserStats(userId) {
        aiLogger.debug({ userId }, 'Tool: getUserStats');
        return UserService.getUserStats(userId);
    },
    async getHustlerProfile(userId) {
        aiLogger.debug({ userId }, 'Tool: getHustlerProfile');
        return UserService.getHustlerProfile(userId);
    },
    // === Gamification Tools ===
    async awardXP(args) {
        aiLogger.debug({ args }, 'Tool: awardXP');
        return GamificationService.awardXP(args.userId, args.amount, args.reason, args.taskId);
    },
    async getActiveQuests(userId) {
        aiLogger.debug({ userId }, 'Tool: getActiveQuests');
        return GamificationService.getActiveQuests(userId);
    },
    async generateQuest(userId, recentCategories, streak) {
        aiLogger.debug({ userId, streak }, 'Tool: generateQuest');
        return GamificationService.generateQuestForUser(userId, { recentCategories, streak });
    },
    // === Moderation Tools ===
    async moderateContent(args) {
        aiLogger.debug({ contentLength: args.content.length }, 'Tool: moderateContent');
        return ModerationService.check(args.content, args.context);
    },
};
//# sourceMappingURL=tools.js.map