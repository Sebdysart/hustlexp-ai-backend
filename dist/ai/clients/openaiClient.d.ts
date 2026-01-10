import type { GenerateOptions, GenerateResult } from '../../types/index.js';
/**
 * Check if OpenAI is configured
 */
/**
 * Check if OpenAI is configured
 */
export declare function isConfigured(): boolean;
/**
 * OpenAI GPT-4o client for high-stakes operations:
 * - Safety & moderation
 * - Dispute resolution
 * - High-stakes copy/messaging
 */
export declare function generate(options: GenerateOptions): Promise<GenerateResult>;
export declare const openaiClient: {
    generate: typeof generate;
    isConfigured: typeof isConfigured;
};
//# sourceMappingURL=openaiClient.d.ts.map