/**
 * Context-Aware AI Prompt
 *
 * Generates personalized system prompts that include
 * full user context - making HUSTLEAI truly aware.
 */
import type { ProfileSnapshot, RecentAction, ScreenContext } from '../../types/index.js';
import type { UserGoals, UserConstraints, TaskPreferences } from '../../services/UserBrainService.js';
export interface FullUserContext {
    userId: string;
    role: 'hustler' | 'client' | 'both';
    profile: ProfileSnapshot;
    screen: ScreenContext;
    recentActions: RecentAction[];
    goals: UserGoals;
    constraints: UserConstraints;
    taskPreferences: TaskPreferences;
    aiHistorySummary: string;
    learningScore: number;
}
/**
 * Generate the full context-aware system prompt
 */
export declare function getContextAwarePrompt(context: FullUserContext): string;
/**
 * Generate a minimal prompt for quick responses
 */
export declare function getMinimalContextPrompt(context: {
    role: 'hustler' | 'client';
    level: number;
    streak: number;
    screen: ScreenContext;
    aiHistorySummary?: string;
}): string;
/**
 * Extract key context for logging
 */
export declare function summarizeContext(context: FullUserContext): string;
//# sourceMappingURL=contextAwarePrompt.d.ts.map