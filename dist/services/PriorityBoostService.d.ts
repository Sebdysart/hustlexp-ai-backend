import type { TaskCategory } from '../types/index.js';
export type BoostTier = 'normal' | 'priority' | 'rush' | 'vip';
export interface BoostConfig {
    tier: BoostTier;
    name: string;
    feeMultiplier: number;
    hustlerXPBoost: number;
    matchingPriority: number;
    searchRadiusBoost: number;
    acceptancePriority: boolean;
    instantMatch: boolean;
    topHustlersOnly: boolean;
    color: string;
    icon: string;
}
export declare const BOOST_TIERS: Record<BoostTier, BoostConfig>;
export interface BoostedTask {
    taskId: string;
    boostTier: BoostTier;
    boostConfig: BoostConfig;
    originalPrice: number;
    boostedPrice: number;
    platformFee: number;
    hustlerPayout: number;
    hustlerXPBoost: number;
    expiresAt: Date;
    createdAt: Date;
}
export type ObjectiveStatus = 'pending' | 'in_progress' | 'completed' | 'skipped';
export type CheckpointType = 'arrival' | 'progress' | 'completion' | 'photo' | 'signature';
export interface MicroObjective {
    id: string;
    order: number;
    title: string;
    description: string;
    estimatedMinutes: number;
    xpReward: number;
    status: ObjectiveStatus;
    requiresPhoto: boolean;
    photoUrl?: string;
    completedAt?: Date;
    notes?: string;
}
export interface SafetyNote {
    type: 'warning' | 'tip' | 'required';
    message: string;
    icon: string;
}
export interface ToolRecommendation {
    name: string;
    reason: string;
    required: boolean;
    icon: string;
}
export interface TaskPlan {
    planId: string;
    taskId: string;
    hustlerId: string;
    taskTitle: string;
    taskCategory: TaskCategory;
    estimatedDuration: number;
    objectives: MicroObjective[];
    completedObjectives: number;
    totalObjectives: number;
    progressPercent: number;
    safetyNotes: SafetyNote[];
    recommendedTools: ToolRecommendation[];
    preArrivalTips: string[];
    baseXP: number;
    bonusXP: number;
    boostMultiplier: number;
    currentXP: number;
    potentialXP: number;
    punctualityBonus: boolean;
    communicationScore: number;
    qualityCheckpoints: {
        type: CheckpointType;
        completed: boolean;
        xpBonus: number;
    }[];
    acceptedAt: Date;
    startedAt?: Date;
    estimatedCompletionAt: Date;
    completedAt?: Date;
    status: 'accepted' | 'en_route' | 'in_progress' | 'completed' | 'cancelled';
}
declare class PriorityBoostServiceClass {
    /**
     * Calculate boost options for a task
     */
    getBoostOptions(basePrice: number): {
        tier: BoostTier;
        config: BoostConfig;
        totalPrice: number;
        platformFee: number;
        hustlerPayout: number;
        hustlerXPBoost: string;
    }[];
    /**
     * Apply boost to a task
     */
    applyBoost(taskId: string, basePrice: number, tier: BoostTier): BoostedTask;
    /**
     * Get boost info for a task
     */
    getTaskBoost(taskId: string): BoostedTask | null;
    /**
     * Check if task should be shown to hustler based on boost level
     */
    shouldShowToHustler(taskId: string, hustlerLevel: number): {
        show: boolean;
        priority: number;
        badges: string[];
    };
}
declare class HustlerTaskPlannerClass {
    /**
     * Generate a task plan for a hustler
     */
    generatePlan(taskId: string, hustlerId: string, task: {
        title: string;
        category: TaskCategory;
        description: string;
        durationMinutes: number;
        location: string;
        baseXP: number;
    }, boostMultiplier?: number): Promise<TaskPlan>;
    /**
     * Update objective status
     */
    updateObjective(planId: string, objectiveId: string, status: ObjectiveStatus, photoUrl?: string, notes?: string): Promise<{
        plan: TaskPlan;
        xpAwarded: number;
    }>;
    /**
     * Record checkpoint (arrival, photo, etc.)
     */
    recordCheckpoint(planId: string, checkpointType: CheckpointType): Promise<{
        plan: TaskPlan;
        xpAwarded: number;
    }>;
    /**
     * Get plan by ID
     */
    getPlan(planId: string): TaskPlan | null;
    /**
     * Get plans for a hustler
     */
    getHustlerPlans(hustlerId: string): TaskPlan[];
    /**
     * Generate fallback plan
     */
    private generateFallbackPlan;
}
export declare const PriorityBoostService: PriorityBoostServiceClass;
export declare const HustlerTaskPlanner: HustlerTaskPlannerClass;
export {};
//# sourceMappingURL=PriorityBoostService.d.ts.map