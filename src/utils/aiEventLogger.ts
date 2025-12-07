import { v4 as uuidv4 } from 'uuid';
import type { AIEvent, ModelProvider, ModelTaskType, Intent } from '../types/index.js';
import { aiLogger } from './logger.js';

// In-memory store for now - replace with database later
const aiEvents: AIEvent[] = [];

// Cost per 1K tokens (approximate, adjust based on actual pricing)
const COST_PER_1K_TOKENS: Record<ModelProvider, { input: number; output: number }> = {
    deepseek: { input: 0.00014, output: 0.00028 }, // DeepSeek is very cheap
    qwen: { input: 0.00005, output: 0.00015 },     // Groq is extremely cheap
    openai: { input: 0.005, output: 0.015 },       // GPT-4o pricing
};

export function calculateCost(
    provider: ModelProvider,
    tokensIn: number,
    tokensOut: number
): number {
    const rates = COST_PER_1K_TOKENS[provider];
    return (tokensIn / 1000) * rates.input + (tokensOut / 1000) * rates.output;
}

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

export function logAIEvent(input: LogAIEventInput): AIEvent {
    const event: AIEvent = {
        id: uuidv4(),
        ...input,
        costEstimate: calculateCost(input.modelUsed, input.tokensIn, input.tokensOut),
        timestamp: new Date(),
    };

    aiEvents.push(event);

    // Log to structured logger
    aiLogger.info({
        event: 'ai_call',
        model: event.modelUsed,
        taskType: event.taskType,
        tokensIn: event.tokensIn,
        tokensOut: event.tokensOut,
        cost: event.costEstimate.toFixed(6),
        latencyMs: event.latencyMs,
        success: event.success,
    });

    return event;
}

export function getAIEventsSummary(): {
    totalCalls: number;
    totalCost: number;
    byModel: Record<ModelProvider, { calls: number; cost: number }>;
} {
    const summary = {
        totalCalls: aiEvents.length,
        totalCost: 0,
        byModel: {
            deepseek: { calls: 0, cost: 0 },
            qwen: { calls: 0, cost: 0 },
            openai: { calls: 0, cost: 0 },
        } as Record<ModelProvider, { calls: number; cost: number }>,
    };

    for (const event of aiEvents) {
        summary.totalCost += event.costEstimate;
        summary.byModel[event.modelUsed].calls += 1;
        summary.byModel[event.modelUsed].cost += event.costEstimate;
    }

    return summary;
}

export function getRecentAIEvents(limit = 50): AIEvent[] {
    return aiEvents.slice(-limit).reverse();
}
