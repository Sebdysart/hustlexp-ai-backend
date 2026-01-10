import type { Task, TaskDraft, TaskCategory, TaskFlag, HustlerCandidate } from '../types/index.js';
export interface CreateTaskArgs {
    clientId: string;
    title: string;
    description: string;
    category: TaskCategory;
    minPrice?: number;
    recommendedPrice: number;
    maxPrice?: number;
    locationText?: string;
    latitude?: number;
    longitude?: number;
    timeWindow?: {
        start: Date;
        end: Date;
    };
    flags?: TaskFlag[];
}
export interface SearchTasksArgs {
    category?: TaskCategory;
    maxDistance?: number;
    minPrice?: number;
    maxPrice?: number;
    limit?: number;
}
declare class TaskServiceClass {
    createTask(args: CreateTaskArgs): Promise<Task>;
    createTaskFromDraft(clientId: string, draft: TaskDraft): Promise<Task>;
    getTask(taskId: string): Promise<Task | null>;
    searchTasks(args: SearchTasksArgs): Promise<Task[]>;
    getOpenTasksForHustler(hustlerId: string, limit?: number): Promise<Task[]>;
    getCandidateHustlers(task: Task, limit?: number): Promise<HustlerCandidate[]>;
    assignHustler(taskId: string, hustlerId: string): Promise<Task | null>;
    completeTask(taskId: string): Promise<Task | null>;
    cancelTask(taskId: string, userId: string, reason: string): Promise<Task>;
    abandonTask(taskId: string, hustlerId: string, reason: string): Promise<Task>;
    private rowToTask;
    private rowToHustlerProfile;
    private calculateDistance;
    private toRad;
    private getMatchReasons;
    getTaskWithEscrow(taskId: string): Promise<Task & {
        hustlerPayout: number;
        posterId: string;
    }>;
}
export declare const TaskService: TaskServiceClass;
export {};
//# sourceMappingURL=TaskService.d.ts.map