import OpenAI from 'openai';
import type { GenerateOptions, GenerateResult, Message } from '../../types/index.js';
import { logAIEvent } from '../../utils/aiEventLogger.js';
import { aiLogger } from '../../utils/logger.js';

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

/**
 * OpenAI GPT-4o client for high-stakes operations:
 * - Safety & moderation
 * - Dispute resolution
 * - High-stakes copy/messaging
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
    } catch (error) {
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

export const openaiClient = { generate };
