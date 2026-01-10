/**
 * Task Completion Service
 *
 * Orchestrates the complete task lifecycle:
 * Proof Verification → Task Completion → XP Award → Payout → Streak Update
 *
 * This is the "Smart Completion Flow" that connects all services.
 */
import type { Task } from '../types/index.js';
export type CompletionStatus = 'eligible' | 'proof_required' | 'already_completed' | 'not_found';
export type AnimationType = 'confetti' | 'xp_burst' | 'streak_fire' | 'level_up' | 'badge' | 'coins' | 'rating_stars';
export interface CompletionEligibility {
    taskId: string;
    status: CompletionStatus;
    eligible: boolean;
    proofComplete: boolean;
    missingProofs: string[];
    proofProgress: {
        completed: number;
        required: number;
        percent: number;
    };
}
export interface CompletionResult {
    success: boolean;
    taskId: string;
    hustlerId: string;
    task: Task | null;
    xpAwarded: number;
    xpBreakdown: {
        base: number;
        proofBonus: number;
        ratingBonus: number;
        streakBonus: number;
    };
    newTotalXP: number;
    levelUp: boolean;
    newLevel: number;
    payoutEligible: boolean;
    payoutAmount: number;
    streak: StreakStatus;
    animations: AnimationType[];
    message: string;
    celebrationMessage: string;
}
export interface StreakStatus {
    current: number;
    isActive: boolean;
    completedToday: boolean;
    daysUntilBonus: number;
    nextBonusAmount: number;
    longestStreak: number;
    lastCompletionDate: string | null;
}
export interface DailyStreak {
    hustlerId: string;
    currentStreak: number;
    longestStreak: number;
    lastCompletionDate: string;
    completionsToday: number;
    streakHistory: {
        date: string;
        count: number;
    }[];
}
declare class TaskCompletionServiceClass {
    /**
     * Check if a task is eligible for completion
     */
    getCompletionEligibility(taskId: string): Promise<CompletionEligibility>;
    /**
     * Smart complete a task with full reward flow
     */
    smartComplete(taskId: string, hustlerId: string, options?: {
        rating?: number;
        skipProofCheck?: boolean;
    }): Promise<CompletionResult>;
    /**
     * Update streak for a hustler
     */
    updateStreak(hustlerId: string): Promise<{
        streak: StreakStatus;
        bonusAwarded: number;
    }>;
    /**
     * Get current streak status for a hustler
     */
    getStreakStatus(hustlerId: string): StreakStatus;
    /**
     * Get completion history for a hustler
     */
    getCompletionHistory(hustlerId: string): {
        taskId: string;
        completedAt: Date;
        xpEarned: number;
    }[];
    private toStreakStatus;
    private createFailedResult;
    private buildCelebrationMessage;
}
export declare const TaskCompletionService: TaskCompletionServiceClass;
export {};
//# sourceMappingURL=TaskCompletionService.d.ts.map