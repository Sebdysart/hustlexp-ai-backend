import type { ModelTaskType, ModelProvider, GenerateOptions, GenerateResult } from '../types/index.js';
/**
 * Get the appropriate model provider for a given task type
 */
export declare function getModelForTask(taskType: ModelTaskType): ModelProvider;
/**
 * Route a generation request to the appropriate model based on task type
 * PHASE 6.3: Now includes 30-second timeout
 */
export declare function routedGenerate(taskType: ModelTaskType, options: GenerateOptions): Promise<GenerateResult>;
/**
 * Generate with explicit provider selection (bypass routing)
 */
export declare function generateWithProvider(provider: ModelProvider, options: GenerateOptions): Promise<GenerateResult>;
export declare const router: {
    getModelForTask: typeof getModelForTask;
    routedGenerate: typeof routedGenerate;
    generateWithProvider: typeof generateWithProvider;
};
/**
 * Convenience wrapper for routed generation
 */
export declare const modelRouter: {
    generateRouted(taskType: ModelTaskType, systemPrompt: string, options?: {
        temperature?: number;
        maxTokens?: number;
    }): Promise<GenerateResult>;
};
//# sourceMappingURL=router.d.ts.map