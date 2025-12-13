import Groq from 'groq-sdk';
import type { GenerateOptions, GenerateResult } from '../../types/index.js';
import { logAIEvent } from '../../utils/aiEventLogger.js';
import { aiLogger } from '../../utils/logger.js';

import { env } from '../../config/env.js';

// Lazy initialization - only create client when needed
let client: Groq | null = null;

function getClient(): Groq {
    if (!client) {
        const apiKey = env.GROQ_API_KEY;
        if (!apiKey) {
            throw new Error('GROQ_API_KEY is not configured');
        }
        client = new Groq({ apiKey });
    }
    return client;
}

/**
 * Check if Groq is configured
 */
/**
 * Check if Groq is configured
 */
export function isConfigured(): boolean {
    return !!env.GROQ_API_KEY;
}

/**
 * Qwen via Groq client for fast, cheap operations:
 * - Intent classification
 * - Translation & text cleanup
 * - Categorization
 * - Quick aux tasks
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
    const startTime = Date.now();

    if (!isConfigured()) {
        aiLogger.warn('Groq not configured, returning fallback response');
        return {
            content: 'AI service temporarily unavailable. Please try again later.',
            tokensUsed: { input: 0, output: 0 },
            latencyMs: 0,
        };
    }

    try {
        const groq = getClient();
        const messages: Groq.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: options.system },
            ...options.messages.map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            })),
        ];

        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile', // Using Llama on Groq which is very fast
            messages,
            max_tokens: options.maxTokens || 1024,
            temperature: options.temperature ?? 0.3,
            response_format: options.json ? { type: 'json_object' } : undefined,
        });

        const latencyMs = Date.now() - startTime;
        const content = response.choices[0]?.message?.content || '';
        const tokensUsed = {
            input: response.usage?.prompt_tokens || 0,
            output: response.usage?.completion_tokens || 0,
        };

        logAIEvent({
            modelUsed: 'qwen',
            taskType: 'intent',
            tokensIn: tokensUsed.input,
            tokensOut: tokensUsed.output,
            latencyMs,
            success: true,
        });

        return { content, tokensUsed, latencyMs };
    } catch (error) {
        const latencyMs = Date.now() - startTime;
        aiLogger.error({ error, latencyMs }, 'Groq API call failed');

        logAIEvent({
            modelUsed: 'qwen',
            taskType: 'intent',
            tokensIn: 0,
            tokensOut: 0,
            latencyMs,
            success: false,
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
        });

        throw error;
    }
}

export const qwenGroqClient = { generate, isConfigured };

