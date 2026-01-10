/**
 * Tool layer - safe, controlled wrappers for business logic
 * The AI calls these functions instead of hitting the DB directly
 */
import type { Task, TaskDraft, TaskCategory, HustlerCandidate, ModerationResult, Quest, XPEvent } from '../types/index.js';
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
export interface AwardXPArgs {
    userId: string;
    amount: number;
    reason: string;
    taskId?: string;
}
export interface ModerateContentArgs {
    content: string;
    context?: string;
}
export declare const tools: {
    createTask(args: CreateTaskArgs): Promise<Task>;
    searchTasks(args: SearchTasksArgs): Promise<Task[]>;
    getOpenTasksForHustler(hustlerId: string, limit?: number): Promise<Task[]>;
    getCandidateHustlers(taskId: string): Promise<HustlerCandidate[]>;
    assignHustler(args: AssignHustlerArgs): Promise<Task | null>;
    completeTask(taskId: string): Promise<Task | null>;
    getUser(userId: string): Promise<import("../types/index.js").User | null>;
    getUserStats(userId: string): Promise<{
        xp: number;
        level: number;
        streak: number;
        tasksCompleted: number;
        rating: number;
        totalEarnings: number;
    } | null>;
    getHustlerProfile(userId: string): Promise<import("../types/index.js").HustlerProfile | null>;
    awardXP(args: AwardXPArgs): Promise<XPEvent>;
    getActiveQuests(userId: string): Promise<Quest[]>;
    generateQuest(userId: string, recentCategories: string[], streak: number): Promise<Quest | null>;
    moderateContent(args: ModerateContentArgs): Promise<ModerationResult>;
};
export type ToolName = keyof typeof tools;
//# sourceMappingURL=tools.d.ts.map