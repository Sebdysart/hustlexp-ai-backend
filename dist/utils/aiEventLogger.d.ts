import type { AIEvent, ModelProvider, ModelTaskType, Intent } from '../types/index.js';
export declare function calculateCost(provider: ModelProvider, tokensIn: number, tokensOut: number): number;
export interface LogAIEventInput {
    userId?: string;
    intent?: Intent;
    modelUsed: ModelProvider;
    taskType: ModelTaskType;
    tokensIn: number;
    tokensOut: number;
    latencyMs: number;
    success: boolean;
    errorMessage?: string;
}
export declare function logAIEvent(input: LogAIEventInput): AIEvent;
export declare function getAIEventsSummary(): {
    totalCalls: number;
    totalCost: number;
    byModel: Record<ModelProvider, {
        calls: number;
        cost: number;
    }>;
};
export declare function getRecentAIEvents(limit?: number): AIEvent[];
//# sourceMappingURL=aiEventLogger.d.ts.map