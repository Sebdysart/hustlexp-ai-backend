/**
 * AI Identity Context Service
 *
 * Provides identity-aware context to AI onboarding and personalization.
 *
 * Uses:
 * - Trust score for interaction tone
 * - Risk level for verification depth
 * - Verification timestamps for session context
 * - Device fingerprint for security decisions
 */
export interface AIOnboardingContext {
    identityVerified: boolean;
    emailVerified: boolean;
    phoneVerified: boolean;
    verificationAge: string;
    trustScore: number;
    trustTier: 'new' | 'low' | 'medium' | 'high' | 'verified';
    riskLevel: 'low' | 'medium' | 'high' | 'critical';
    riskScore: number;
    riskSignals: string[];
    shouldChallenge: boolean;
    shouldSkipIntro: boolean;
    suggestedTone: 'cautious' | 'neutral' | 'friendly' | 'enthusiastic';
    skipRedundantQuestions: boolean;
    isReturningUser: boolean;
    hasCompletedOnboarding: boolean;
    deviceTrust: 'new' | 'recognized' | 'trusted';
}
export interface OnboardingPersonalization {
    intro: {
        message: string;
        tone: string;
        skipPreamble: boolean;
    };
    questions: {
        skipRedundant: boolean;
        requireExtraVerification: boolean;
        showSecurityNotice: boolean;
    };
    rewards: {
        xpMultiplier: number;
        showTrustBonus: boolean;
    };
    flow: {
        accelerated: boolean;
        additionalSteps: string[];
        blockedFeatures: string[];
    };
}
declare class AIIdentityContextServiceClass {
    /**
     * Get full AI context for onboarding
     */
    getOnboardingContext(userId: string): Promise<AIOnboardingContext | null>;
    /**
     * Get personalization settings for onboarding flow
     */
    getOnboardingPersonalization(userId: string): Promise<OnboardingPersonalization>;
    /**
     * Generate AI prompt context for identity-aware onboarding
     */
    generateAIPromptContext(userId: string): Promise<string>;
    /**
     * Update trust score based on onboarding behavior
     */
    recordOnboardingBehavior(userId: string, behavior: 'completed' | 'skipped_questions' | 'abandoned' | 'suspicious_pattern'): Promise<void>;
    private getDefaultPersonalization;
    private getIntroMessage;
    private getXpMultiplier;
    private getAdditionalSteps;
    private getBlockedFeatures;
}
export declare const AIIdentityContextService: AIIdentityContextServiceClass;
export {};
//# sourceMappingURL=AIIdentityContextService.d.ts.map