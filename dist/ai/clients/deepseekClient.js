import OpenAI from 'openai';
import { logAIEvent } from '../../utils/aiEventLogger.js';
import { aiLogger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
// Lazy initialization - only create client when needed
let client = null;
function getClient() {
    if (!client) {
        const apiKey = env.DEEPSEEK_API_KEY;
        if (!apiKey) {
            throw new Error('DEEPSEEK_API_KEY is not configured');
        }
        client = new OpenAI({
            apiKey,
            baseURL: 'https://api.deepseek.com/v1',
        });
    }
    return client;
}
/**
 * Check if DeepSeek is configured
 */
/**
 * Check if DeepSeek is configured
 */
export function isConfigured() {
    return !!env.DEEPSEEK_API_KEY;
}
/**
 * DeepSeek client for reasoning-heavy tasks:
 * - Task planning & composition
 * - Price calculation & optimization
 * - Matching logic & analysis
 */
export async function generate(options) {
    const startTime = Date.now();
    if (!isConfigured()) {
        aiLogger.warn('DeepSeek not configured, returning fallback response');
        return {
            content: 'AI service temporarily unavailable. Please try again later.',
            tokensUsed: { input: 0, output: 0 },
            latencyMs: 0,
        };
    }
    try {
        const deepseek = getClient();
        const messages = [
            { role: 'system', content: options.system },
            ...options.messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        ];
        const response = await deepseek.chat.completions.create({
            model: 'deepseek-chat',
            messages,
            max_tokens: options.maxTokens || 2048,
            temperature: options.temperature ?? 0.7,
            response_format: options.json ? { type: 'json_object' } : undefined,
        });
        const latencyMs = Date.now() - startTime;
        const content = response.choices[0]?.message?.content || '';
        const tokensUsed = {
            input: response.usage?.prompt_tokens || 0,
            output: response.usage?.completion_tokens || 0,
        };
        logAIEvent({
            modelUsed: 'deepseek',
            taskType: 'planning',
            tokensIn: tokensUsed.input,
            tokensOut: tokensUsed.output,
            latencyMs,
            success: true,
        });
        return { content, tokensUsed, latencyMs };
    }
    catch (error) {
        const latencyMs = Date.now() - startTime;
        aiLogger.error({ error, latencyMs }, 'DeepSeek API call failed');
        logAIEvent({
            modelUsed: 'deepseek',
            taskType: 'planning',
            tokensIn: 0,
            tokensOut: 0,
            latencyMs,
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
    }
}
export const deepseekClient = { generate, isConfigured };
//# sourceMappingURL=deepseekClient.js.map