import type { GenerateOptions, GenerateResult } from '../../types/index.js';
/**
 * Check if DeepSeek is configured
 */
/**
 * Check if DeepSeek is configured
 */
export declare function isConfigured(): boolean;
/**
 * DeepSeek client for reasoning-heavy tasks:
 * - Task planning & composition
 * - Price calculation & optimization
 * - Matching logic & analysis
 */
export declare function generate(options: GenerateOptions): Promise<GenerateResult>;
export declare const deepseekClient: {
    generate: typeof generate;
    isConfigured: typeof isConfigured;
};
//# sourceMappingURL=deepseekClient.d.ts.map