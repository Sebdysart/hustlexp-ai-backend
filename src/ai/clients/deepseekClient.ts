import OpenAI from 'openai';
import type { GenerateOptions, GenerateResult } from '../../types/index.js';
import { logAIEvent } from '../../utils/aiEventLogger.js';
import { aiLogger } from '../../utils/logger.js';

// DeepSeek uses OpenAI-compatible API
const client = new OpenAI({
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: 'https://api.deepseek.com/v1',
});

/**
 * DeepSeek client for reasoning-heavy tasks:
 * - Task planning & composition
 * - Price calculation & optimization
 * - Matching logic & analysis
 */
export async function generate(options: GenerateOptions): Promise<GenerateResult> {
    const startTime = Date.now();

    try {
        const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
            { role: 'system', content: options.system },
            ...options.messages.map((m) => ({
                role: m.role as 'user' | 'assistant',
                content: m.content,
            })),
        ];

        const response = await client.chat.completions.create({
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
    } catch (error) {
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

export const deepseekClient = { generate };
