import type { Intent, IntentClassification } from '../types/index.js';
import { routedGenerate } from './router.js';
import { getIntentClassifierPrompt } from './prompts/intentClassifier.js';
import { aiLogger } from '../utils/logger.js';

/**
 * Classify user intent using fast model (Qwen/Groq)
 */
export async function classifyIntent(
    message: string,
    mode: 'client_assistant' | 'hustler_assistant' | 'support'
): Promise<IntentClassification> {
    try {
        const modeContext = {
            client_assistant: 'The user is a client who posts tasks for others to complete.',
            hustler_assistant: 'The user is a hustler who completes tasks for money.',
            support: 'The user is seeking help or has an issue to resolve.',
        };

        const result = await routedGenerate('intent', {
            system: getIntentClassifierPrompt(),
            messages: [
                {
                    role: 'user',
                    content: `${modeContext[mode]}

User message: "${message}"

Classify the intent.`,
                },
            ],
            json: true,
            maxTokens: 256,
            temperature: 0.1,
        });

        const parsed = JSON.parse(result.content);

        aiLogger.debug({
            message: message.slice(0, 50),
            intent: parsed.intent,
            confidence: parsed.confidence,
        }, 'Intent classified');

        return {
            intent: parsed.intent as Intent,
            confidence: parsed.confidence,
            extractedEntities: parsed.extractedEntities,
        };
    } catch (error) {
        aiLogger.error({ error }, 'Intent classification failed');

        // Fallback based on simple keyword matching
        return fallbackIntentClassification(message, mode);
    }
}

/**
 * Simple fallback intent classification when AI fails
 */
function fallbackIntentClassification(
    message: string,
    mode: 'client_assistant' | 'hustler_assistant' | 'support'
): IntentClassification {
    const lower = message.toLowerCase();

    // Client mode defaults
    if (mode === 'client_assistant') {
        if (lower.includes('need') || lower.includes('want') || lower.includes('help me') || lower.includes('looking for')) {
            return { intent: 'create_task', confidence: 0.6 };
        }
        if (lower.includes('price') || lower.includes('cost') || lower.includes('how much')) {
            return { intent: 'ask_pricing', confidence: 0.7 };
        }
    }

    // Hustler mode defaults  
    if (mode === 'hustler_assistant') {
        if (lower.includes('find') || lower.includes('search') || lower.includes('available')) {
            return { intent: 'search_tasks', confidence: 0.6 };
        }
        if (lower.includes('today') || lower.includes('suggest') || lower.includes('what should')) {
            return { intent: 'hustler_plan', confidence: 0.7 };
        }
        if (lower.includes('accept') || lower.includes('take') || lower.includes('claim')) {
            return { intent: 'accept_task', confidence: 0.7 };
        }
    }

    // Support mode defaults
    if (mode === 'support') {
        return { intent: 'ask_support', confidence: 0.8 };
    }

    return { intent: 'other', confidence: 0.5 };
}
