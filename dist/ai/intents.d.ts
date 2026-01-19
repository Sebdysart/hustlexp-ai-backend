import type { IntentClassification } from '../types/index.js';
/**
 * Classify user intent using fast model (Qwen/Groq)
 */
export declare function classifyIntent(message: string, mode: 'client_assistant' | 'hustler_assistant' | 'support'): Promise<IntentClassification>;
//# sourceMappingURL=intents.d.ts.map