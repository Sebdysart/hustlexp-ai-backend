import OpenAI from 'openai';
import { logAIEvent } from '../../utils/aiEventLogger.js';
import { aiLogger } from '../../utils/logger.js';
import { env } from '../../config/env.js';
// Lazy initialization - only create client when needed
let client = null;
function getClient() {
    if (!client) {
        const apiKey = env.OPENAI_API_KEY;
        if (!apiKey) {
            throw new Error('OPENAI_API_KEY is not configured');
        }
        client = new OpenAI({ apiKey });
    }
    return client;
}
/**
 * Check if OpenAI is configured
 */
/**
 * Check if OpenAI is configured
 */
export function isConfigured() {
    return !!env.OPENAI_API_KEY;
}
/**
 * OpenAI GPT-4o client for high-stakes operations:
 * - Safety & moderation
 * - Dispute resolution
 * - High-stakes copy/messaging
 */
export async function generate(options) {
    const startTime = Date.now();
    // Check if configured before attempting
    if (!isConfigured()) {
        aiLogger.warn('OpenAI not configured, returning fallback response');
        return {
            content: 'AI service temporarily unavailable. Please try again later.',
            tokensUsed: { input: 0, output: 0 },
            latencyMs: 0,
        };
    }
    try {
        const openai = getClient();
        const messages = [
            { role: 'system', content: options.system },
            ...options.messages.map((m) => ({
                role: m.role,
                content: m.content,
            })),
        ];
        const response = await openai.chat.completions.create({
            model: 'gpt-4o',
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
            modelUsed: 'openai',
            taskType: 'safety', // Default, actual task type passed from caller
            tokensIn: tokensUsed.input,
            tokensOut: tokensUsed.output,
            latencyMs,
            success: true,
        });
        return { content, tokensUsed, latencyMs };
    }
    catch (error) {
        const latencyMs = Date.now() - startTime;
        aiLogger.error({ error, latencyMs }, 'OpenAI API call failed');
        logAIEvent({
            modelUsed: 'openai',
            taskType: 'safety',
            tokensIn: 0,
            tokensOut: 0,
            latencyMs,
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
    }
}
export const openaiClient = { generate, isConfigured };
//# sourceMappingURL=openaiClient.js.map