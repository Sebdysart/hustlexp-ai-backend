import type { ModelTaskType, ModelProvider, GenerateOptions, GenerateResult } from '../types/index.js';
import { openaiClient } from './clients/openaiClient.js';
import { deepseekClient } from './clients/deepseekClient.js';
import { qwenGroqClient } from './clients/qwenGroqClient.js';
import { aiLogger } from '../utils/logger.js';

/**
 * Model routing policy:
 * - planning, pricing, matching_logic → DeepSeek (reasoning)
 * - translate, title_cleanup, categorization, intent, small_aux → Qwen/Groq (fast)
 * - safety, dispute, high_stakes_copy → GPT-4o (reliable/safe)
 */
const ROUTING_POLICY: Record<ModelTaskType, ModelProvider> = {
    // DeepSeek for reasoning-heavy tasks
    planning: 'deepseek',
    pricing: 'deepseek',
    matching_logic: 'deepseek',

    // Qwen/Groq for fast, cheap tasks
    translate: 'qwen',
    title_cleanup: 'qwen',
    categorization: 'qwen',
    intent: 'qwen',
    small_aux: 'qwen',

    // OpenAI GPT-4o for safety-critical tasks
    safety: 'openai',
    dispute: 'openai',
    high_stakes_copy: 'openai',
};

/**
 * Get the appropriate model provider for a given task type
 */
export function getModelForTask(taskType: ModelTaskType): ModelProvider {
    return ROUTING_POLICY[taskType];
}

/**
 * PHASE 6.3: Timeout wrapper for AI calls
 */
const AI_TIMEOUT_MS = 30000; // 30 seconds

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });

    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId!);
        return result;
    } catch (error) {
        clearTimeout(timeoutId!);
        throw error;
    }
}

/**
 * Route a generation request to the appropriate model based on task type
 * PHASE 6.3: Now includes 30-second timeout
 */
export async function routedGenerate(
    taskType: ModelTaskType,
    options: GenerateOptions
): Promise<GenerateResult> {
    const provider = getModelForTask(taskType);

    aiLogger.debug({ taskType, provider }, 'Routing AI request');

    let aiCall: Promise<GenerateResult>;

    switch (provider) {
        case 'openai':
            aiCall = openaiClient.generate(options);
            break;
        case 'deepseek':
            aiCall = deepseekClient.generate(options);
            break;
        case 'qwen':
            aiCall = qwenGroqClient.generate(options);
            break;
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }

    // Wrap with timeout
    return withTimeout(
        aiCall,
        AI_TIMEOUT_MS,
        `AI request to ${provider} timed out after ${AI_TIMEOUT_MS / 1000}s`
    );
}

/**
 * Generate with explicit provider selection (bypass routing)
 */
export async function generateWithProvider(
    provider: ModelProvider,
    options: GenerateOptions
): Promise<GenerateResult> {
    switch (provider) {
        case 'openai':
            return openaiClient.generate(options);
        case 'deepseek':
            return deepseekClient.generate(options);
        case 'qwen':
            return qwenGroqClient.generate(options);
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

export const router = {
    getModelForTask,
    routedGenerate,
    generateWithProvider,
};

/**
 * Convenience wrapper for routed generation
 */
export const modelRouter = {
    async generateRouted(
        taskType: ModelTaskType,
        systemPrompt: string,
        options: { temperature?: number; maxTokens?: number } = {}
    ): Promise<GenerateResult> {
        return routedGenerate(taskType, {
            system: systemPrompt,
            messages: [{ role: 'user', content: 'Execute the system instruction.' }],
            temperature: options.temperature,
            maxTokens: options.maxTokens,
        });
    },
};
