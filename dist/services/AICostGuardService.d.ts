/**
 * AI Cost Guard Service
 *
 * Per-user rate limiting and cost control for AI calls.
 * Prevents budget overruns by limiting expensive model usage.
 */
import type { ModelProvider } from '../types/index.js';
export interface UserAIUsage {
    userId: string;
    date: string;
    openaiCalls: number;
    deepseekCalls: number;
    groqCalls: number;
    openaiCostUsd: number;
    deepseekCostUsd: number;
    groqCostUsd: number;
    lastCallAt: Date;
    warningIssued: boolean;
}
export interface CostLimits {
    maxOpenaiCallsPerDay: number;
    maxDeepseekCallsPerDay: number;
    maxGroqCallsPerDay: number;
    maxOpenaiCostPerDay: number;
    maxDeepseekCostPerDay: number;
    maxTotalCostPerDay: number;
    maxTotalOpenaiCallsPerHour: number;
    maxTotalCostPerHour: number;
}
export interface LimitCheckResult {
    allowed: boolean;
    reason?: string;
    remainingCalls?: number;
    suggestedFallback?: ModelProvider;
    warningMessage?: string;
}
declare class AICostGuardServiceClass {
    private limits;
    /**
     * Update cost limits
     */
    updateLimits(newLimits: Partial<CostLimits>): CostLimits;
    /**
     * Get current limits
     */
    getLimits(): CostLimits;
    /**
     * Get or create user usage record
     */
    private getUserUsage;
    /**
     * Check if a user can make an AI call
     */
    checkLimit(userId: string, provider: ModelProvider): LimitCheckResult;
    /**
     * Record an AI call
     */
    recordCall(userId: string, provider: ModelProvider, success?: boolean): void;
    /**
     * Get user's usage stats
     */
    getUserStats(userId: string): {
        usage: UserAIUsage;
        limits: CostLimits;
        percentUsed: {
            openai: number;
            deepseek: number;
            groq: number;
            totalCost: number;
        };
    };
    /**
     * Reset user's daily usage (for testing or admin)
     */
    resetUserUsage(userId: string): void;
    /**
     * Get system-wide stats
     */
    getSystemStats(): {
        hourly: {
            calls: number;
            cost: number;
        };
        daily: {
            calls: number;
            cost: number;
            users: number;
        };
    };
    private getTotalCalls;
    private getSuggestedFallback;
    private checkSystemHourlyLimit;
}
export declare const AICostGuardService: AICostGuardServiceClass;
export {};
//# sourceMappingURL=AICostGuardService.d.ts.map