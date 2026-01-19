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
const ROUTING_POLICY = {
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
export function getModelForTask(taskType) {
    return ROUTING_POLICY[taskType];
}
/**
 * PHASE 6.3: Timeout wrapper for AI calls
 */
const AI_TIMEOUT_MS = 30000; // 30 seconds
async function withTimeout(promise, timeoutMs, errorMessage) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(errorMessage)), timeoutMs);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId);
        return result;
    }
    catch (error) {
        clearTimeout(timeoutId);
        throw error;
    }
}
/**
 * Route a generation request to the appropriate model based on task type
 * PHASE 6.3: Now includes 30-second timeout
 */
export async function routedGenerate(taskType, options) {
    const provider = getModelForTask(taskType);
    aiLogger.debug({ taskType, provider }, 'Routing AI request');
    let aiCall;
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
    // Wrap with timeout and fallback logic
    try {
        return await withTimeout(aiCall, AI_TIMEOUT_MS, `AI request to ${provider} timed out after ${AI_TIMEOUT_MS / 1000}s`);
    }
    catch (error) {
        aiLogger.warn({ error, taskType, provider }, 'Primary AI provider failed - Initiating Fallback');
        // Fallback Strategy
        let fallbackProvider = 'openai'; // Default safe fallback
        // Use faster fallback for low-latency tasks if possible (future optimization)
        if (['intent', 'categorization'].includes(taskType)) {
            // Could use gpt-4o-mini here via openai client if configured
        }
        try {
            return await withTimeout(openaiClient.generate(options), // Fallback to OpenAI
            AI_TIMEOUT_MS, `Fallback AI request to ${fallbackProvider} timed out`);
        }
        catch (fallbackError) {
            aiLogger.error({ fallbackError, originalError: error }, 'AI Critical Failure: Both Primary and Fallback failed');
            throw fallbackError; // Re-throw if even fallback dies
        }
    }
}
/**
 * Generate with explicit provider selection (bypass routing)
 */
export async function generateWithProvider(provider, options) {
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
    async generateRouted(taskType, systemPrompt, options = {}) {
        return routedGenerate(taskType, {
            system: systemPrompt,
            messages: [{ role: 'user', content: 'Execute the system instruction.' }],
            temperature: options.temperature,
            maxTokens: options.maxTokens,
        });
    },
};
//# sourceMappingURL=router.js.map