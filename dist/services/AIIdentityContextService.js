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
import { FraudDetectionService } from './FraudDetectionService.js';
import { serviceLogger } from '../utils/logger.js';
// ============================================
// HELPER FUNCTIONS
// ============================================
function formatVerificationAge(ms) {
    if (ms === 0)
        return 'never';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    if (days > 0)
        return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0)
        return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0)
        return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return 'just now';
}
function getTrustTier(score) {
    if (score >= 80)
        return 'verified';
    if (score >= 60)
        return 'high';
    if (score >= 40)
        return 'medium';
    if (score >= 20)
        return 'low';
    return 'new';
}
function getSuggestedTone(trustScore, riskLevel) {
    if (riskLevel === 'critical' || riskLevel === 'high')
        return 'cautious';
    if (trustScore >= 70)
        return 'enthusiastic';
    if (trustScore >= 40)
        return 'friendly';
    return 'neutral';
}
// ============================================
// AI IDENTITY CONTEXT SERVICE
// ============================================
class AIIdentityContextServiceClass {
    /**
     * Get full AI context for onboarding
     */
    async getOnboardingContext(userId) {
        const identity = await FraudDetectionService.getIdentityContext(userId);
        if (!identity) {
            // Return default context for unverified users
            return {
                identityVerified: false,
                emailVerified: false,
                phoneVerified: false,
                verificationAge: 'never',
                trustScore: 0,
                trustTier: 'new',
                riskLevel: 'high',
                riskScore: 75,
                riskSignals: ['unverified_identity'],
                shouldChallenge: true,
                shouldSkipIntro: false,
                suggestedTone: 'cautious',
                skipRedundantQuestions: false,
                isReturningUser: false,
                hasCompletedOnboarding: false,
                deviceTrust: 'new',
            };
        }
        const trustTier = getTrustTier(identity.trustScore);
        const suggestedTone = getSuggestedTone(identity.trustScore, identity.riskLevel);
        return {
            identityVerified: identity.isFullyVerified,
            emailVerified: identity.emailVerified,
            phoneVerified: identity.phoneVerified,
            verificationAge: formatVerificationAge(identity.verificationAge),
            trustScore: identity.trustScore,
            trustTier,
            riskLevel: identity.riskAssessment.riskLevel === 'critical' ? 'critical' : identity.riskLevel,
            riskScore: identity.riskAssessment.riskScore,
            riskSignals: identity.riskAssessment.reasons,
            shouldChallenge: identity.riskAssessment.recommendation === 'challenge',
            shouldSkipIntro: identity.trustScore >= 70 && identity.verificationAge < 60 * 60 * 1000,
            suggestedTone,
            skipRedundantQuestions: identity.trustScore >= 60,
            isReturningUser: identity.verificationAge > 0,
            hasCompletedOnboarding: false, // Would be fetched from onboarding service
            deviceTrust: identity.deviceFingerprint ? 'recognized' : 'new',
        };
    }
    /**
     * Get personalization settings for onboarding flow
     */
    async getOnboardingPersonalization(userId) {
        const context = await this.getOnboardingContext(userId);
        if (!context) {
            // Default strict personalization for unknown users
            return this.getDefaultPersonalization();
        }
        // Build personalization based on context
        const personalization = {
            intro: {
                message: this.getIntroMessage(context),
                tone: context.suggestedTone,
                skipPreamble: context.shouldSkipIntro,
            },
            questions: {
                skipRedundant: context.skipRedundantQuestions,
                requireExtraVerification: context.shouldChallenge,
                showSecurityNotice: context.riskLevel === 'high' || context.riskLevel === 'critical',
            },
            rewards: {
                xpMultiplier: this.getXpMultiplier(context.trustTier),
                showTrustBonus: context.trustScore >= 50,
            },
            flow: {
                accelerated: context.trustTier === 'verified' || context.trustTier === 'high',
                additionalSteps: this.getAdditionalSteps(context),
                blockedFeatures: this.getBlockedFeatures(context),
            },
        };
        serviceLogger.debug({
            userId,
            trustTier: context.trustTier,
            riskLevel: context.riskLevel,
            accelerated: personalization.flow.accelerated,
        }, 'Onboarding personalization generated');
        return personalization;
    }
    /**
     * Generate AI prompt context for identity-aware onboarding
     */
    async generateAIPromptContext(userId) {
        const context = await this.getOnboardingContext(userId);
        if (!context) {
            return `
User identity: UNVERIFIED
Trust level: NEW
Risk assessment: HIGH
Tone: Be cautious and professional.
Requirements: User must complete identity verification before proceeding.
`;
        }
        return `
User identity: ${context.identityVerified ? 'VERIFIED' : 'PARTIAL'}
Email verified: ${context.emailVerified ? 'Yes' : 'No'}
Phone verified: ${context.phoneVerified ? 'Yes' : 'No'}
Verification age: ${context.verificationAge}
Trust score: ${context.trustScore}/100 (${context.trustTier})
Risk level: ${context.riskLevel.toUpperCase()}
${context.riskSignals.length > 0 ? `Risk signals: ${context.riskSignals.join(', ')}` : ''}

AI BEHAVIOR INSTRUCTIONS:
- Tone: Use a ${context.suggestedTone} tone.
${context.shouldChallenge ? '- Extra verification: Ask clarifying questions about their identity.' : ''}
${context.skipRedundantQuestions ? '- Skip questions: Can skip obvious/redundant questions for trusted users.' : ''}
${context.trustTier === 'verified' ? '- Fast-track: This is a verified user, accelerate through basic steps.' : ''}
${context.riskLevel === 'high' || context.riskLevel === 'critical' ? '- Security notice: Mention that their account will be monitored for security.' : ''}
`;
    }
    /**
     * Update trust score based on onboarding behavior
     */
    async recordOnboardingBehavior(userId, behavior) {
        let adjustment = 0;
        let reason = '';
        switch (behavior) {
            case 'completed':
                adjustment = 10;
                reason = 'Completed onboarding';
                break;
            case 'skipped_questions':
                adjustment = -5;
                reason = 'Skipped multiple questions';
                break;
            case 'abandoned':
                adjustment = -10;
                reason = 'Abandoned onboarding';
                break;
            case 'suspicious_pattern':
                adjustment = -25;
                reason = 'Suspicious onboarding pattern';
                break;
        }
        if (adjustment !== 0) {
            await FraudDetectionService.updateTrustScore(userId, adjustment, reason);
        }
    }
    // ============================================
    // PRIVATE HELPERS
    // ============================================
    getDefaultPersonalization() {
        return {
            intro: {
                message: "Welcome to HustleXP! Let's get you started.",
                tone: 'neutral',
                skipPreamble: false,
            },
            questions: {
                skipRedundant: false,
                requireExtraVerification: true,
                showSecurityNotice: true,
            },
            rewards: {
                xpMultiplier: 1.0,
                showTrustBonus: false,
            },
            flow: {
                accelerated: false,
                additionalSteps: ['identity_verification'],
                blockedFeatures: ['instant_payout', 'high_value_tasks'],
            },
        };
    }
    getIntroMessage(context) {
        if (context.trustTier === 'verified') {
            return "Welcome back! Let's get you set up quickly.";
        }
        if (context.trustTier === 'high') {
            return "Great to see you! You're already on your way to becoming a top hustler.";
        }
        if (context.isReturningUser) {
            return "Welcome back! Let's continue where you left off.";
        }
        if (context.identityVerified) {
            return "Thanks for verifying! Now let's personalize your experience.";
        }
        return "Welcome to HustleXP! Let's build your profile.";
    }
    getXpMultiplier(trustTier) {
        switch (trustTier) {
            case 'verified': return 1.5;
            case 'high': return 1.25;
            case 'medium': return 1.1;
            default: return 1.0;
        }
    }
    getAdditionalSteps(context) {
        const steps = [];
        if (!context.identityVerified) {
            steps.push('identity_verification');
        }
        if (context.riskLevel === 'high' || context.riskLevel === 'critical') {
            steps.push('security_review');
        }
        if (context.shouldChallenge) {
            steps.push('extra_verification');
        }
        return steps;
    }
    getBlockedFeatures(context) {
        const blocked = [];
        if (!context.identityVerified) {
            blocked.push('payouts', 'high_value_tasks', 'instant_matching');
        }
        if (context.riskLevel === 'critical') {
            blocked.push('all_features');
        }
        if (context.trustScore < 30) {
            blocked.push('priority_matching', 'premium_tasks');
        }
        return blocked;
    }
}
export const AIIdentityContextService = new AIIdentityContextServiceClass();
//# sourceMappingURL=AIIdentityContextService.js.map