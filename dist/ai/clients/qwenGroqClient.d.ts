import type { GenerateOptions, GenerateResult } from '../../types/index.js';
/**
 * Check if Groq is configured
 */
/**
 * Check if Groq is configured
 */
export declare function isConfigured(): boolean;
/**
 * Qwen via Groq client for fast, cheap operations:
 * - Intent classification
 * - Translation & text cleanup
 * - Categorization
 * - Quick aux tasks
 */
export declare function generate(options: GenerateOptions): Promise<GenerateResult>;
export declare const qwenGroqClient: {
    generate: typeof generate;
    isConfigured: typeof isConfigured;
};
//# sourceMappingURL=qwenGroqClient.d.ts.map