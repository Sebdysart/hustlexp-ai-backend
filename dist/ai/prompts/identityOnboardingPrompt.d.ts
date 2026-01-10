/**
 * Identity-Aware Onboarding System Prompt Builder
 *
 * Generates AI system prompts that are personalized based on:
 * - Trust tier (high/medium/low)
 * - Risk level (low/medium/high/critical)
 * - Verification status
 * - XP multiplier
 * - Challenge requirements
 */
import { AIOnboardingContext } from '../../services/AIIdentityContextService.js';
export declare function buildIdentityAwareSystemPrompt(ctx: AIOnboardingContext): string;
export declare function getXPMultiplier(trustTier: AIOnboardingContext['trustTier']): number;
export interface EnrichedMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}
/**
 * Enriches conversation history with identity context
 * Called for EVERY AI onboarding prompt
 */
export declare function enrichOnboardingConversation(userId: string, messages: EnrichedMessage[]): Promise<EnrichedMessage[]>;
export interface AIOnboardingAction {
    type: 'CONTINUE' | 'REQUEST_PROOF' | 'BLOCK_ONBOARDING' | 'COMPLETE' | 'AWARD_XP';
    payload?: Record<string, unknown>;
}
/**
 * Parse AI response for special actions
 */
export declare function parseOnboardingActions(response: string): AIOnboardingAction[];
//# sourceMappingURL=identityOnboardingPrompt.d.ts.map