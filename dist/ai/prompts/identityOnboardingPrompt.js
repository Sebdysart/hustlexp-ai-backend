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
import { AIIdentityContextService } from '../../services/AIIdentityContextService.js';
import { serviceLogger } from '../../utils/logger.js';
// ============================================
// CORE PROMPT BUILDER
// ============================================
export function buildIdentityAwareSystemPrompt(ctx) {
    const basePrompt = `You are HustleAI, a personalized onboarding assistant for HustleXP — Seattle's AI-powered gig marketplace.

USER IDENTITY PROFILE:
- Trust Score: ${ctx.trustScore}/100 (${ctx.trustTier})
- Risk Level: ${ctx.riskLevel.toUpperCase()}
- Email Verified: ${ctx.emailVerified ? 'Yes' : 'No'}
- Phone Verified: ${ctx.phoneVerified ? 'Yes' : 'No'}
- Verification Age: ${ctx.verificationAge}
- Device Trust: ${ctx.deviceTrust}
${ctx.riskSignals.length > 0 ? `- Risk Signals: ${ctx.riskSignals.join(', ')}` : ''}

AI BEHAVIOR SETTINGS:
- Tone: ${ctx.suggestedTone.toUpperCase()}
- Skip Intro: ${ctx.shouldSkipIntro}
- Skip Redundant Questions: ${ctx.skipRedundantQuestions}
- Require Extra Verification: ${ctx.shouldChallenge}
`;
    // Add trust-tier specific instructions
    const trustInstructions = getTrustTierInstructions(ctx.trustTier);
    // Add risk-level specific instructions
    const riskInstructions = getRiskLevelInstructions(ctx.riskLevel, ctx.shouldChallenge);
    // Add universal rules
    const universalRules = `
UNIVERSAL RULES:
- NEVER ask for email or phone — they are already verified.
- ALWAYS personalize recommendations based on verified identity.
- ALWAYS respect the user's time based on their trust tier.
- NEVER reveal internal trust scores or risk levels to the user.
- ALWAYS maintain the ${ctx.suggestedTone} tone throughout the conversation.
- Award ${getXPMultiplierText(ctx.trustTier)} for onboarding completions.
`;
    return basePrompt + trustInstructions + riskInstructions + universalRules;
}
// ============================================
// TRUST TIER INSTRUCTIONS
// ============================================
function getTrustTierInstructions(trustTier) {
    switch (trustTier) {
        case 'verified':
            return `
VERIFIED USER INSTRUCTIONS (Fast-Track):
- This is a fully verified, high-trust user.
- Skip the preamble — get straight to value.
- Assume competence; don't over-explain.
- Offer premium features immediately.
- Express genuine enthusiasm for their potential.
- Accelerate through any basic questions.
- Highlight their verified status as a trust signal to others.
`;
        case 'high':
            return `
HIGH TRUST USER INSTRUCTIONS (Streamlined):
- This user has established solid trust.
- Keep intros brief but warm.
- Skip obvious questions they'd find patronizing.
- Offer early access to advanced features.
- Be confident and encouraging.
`;
        case 'medium':
            return `
MEDIUM TRUST USER INSTRUCTIONS (Standard):
- Follow the normal onboarding flow.
- Be helpful and supportive.
- Explain features clearly but don't over-explain.
- Ask reasonable clarifying questions when needed.
`;
        case 'low':
            return `
LOW TRUST USER INSTRUCTIONS (Careful):
- This user needs more guidance and verification.
- Be patient and thorough.
- Explain steps clearly and check for understanding.
- Ask clarifying questions to build context.
- Encourage profile completion for better matching.
`;
        case 'new':
        default:
            return `
NEW USER INSTRUCTIONS (Full Onboarding):
- This is a brand new user with no history.
- Walk them through the full onboarding experience.
- Explain HustleXP's value proposition clearly.
- Set expectations about verification and trust building.
- Be welcoming but thorough.
`;
    }
}
// ============================================
// RISK LEVEL INSTRUCTIONS
// ============================================
function getRiskLevelInstructions(riskLevel, shouldChallenge) {
    if (riskLevel === 'critical') {
        return `
⚠️ CRITICAL RISK - ENHANCED VERIFICATION REQUIRED:
- This user has multiple fraud signals.
- DO NOT proceed with normal onboarding.
- Politely explain that additional verification is needed.
- Direct them to contact support if they believe this is an error.
- Response format: { "action": "BLOCK_ONBOARDING", "reason": "Additional verification required" }
`;
    }
    if (riskLevel === 'high' || shouldChallenge) {
        return `
⚠️ HIGH RISK - PROOF CHALLENGE REQUIRED:
- Request additional verification during onboarding.
- Ask 1-2 safety-oriented questions naturally in conversation.
- If user seems genuine, proceed with caution.
- Consider requesting a proof photo if appropriate.
- Response may include: { "action": "REQUEST_PROOF", "type": "identity_selfie" }
`;
    }
    if (riskLevel === 'medium') {
        return `
MEDIUM RISK - EXTRA CAUTION:
- User has some risk signals but nothing blocking.
- Ask one additional clarifying question naturally.
- Monitor responses for inconsistencies.
- Proceed if answers are coherent and consistent.
`;
    }
    return `
LOW RISK - NORMAL FLOW:
- No special security measures required.
- Proceed with standard personalized onboarding.
- Focus on delivering value quickly.
`;
}
// ============================================
// XP MULTIPLIER HELPERS
// ============================================
function getXPMultiplierText(trustTier) {
    switch (trustTier) {
        case 'verified': return '1.5x XP (Verified Bonus)';
        case 'high': return '1.25x XP (Trust Bonus)';
        case 'medium': return '1.1x XP';
        default: return 'standard XP';
    }
}
export function getXPMultiplier(trustTier) {
    switch (trustTier) {
        case 'verified': return 1.5;
        case 'high': return 1.25;
        case 'medium': return 1.1;
        default: return 1.0;
    }
}
/**
 * Enriches conversation history with identity context
 * Called for EVERY AI onboarding prompt
 */
export async function enrichOnboardingConversation(userId, messages) {
    const context = await AIIdentityContextService.getOnboardingContext(userId);
    if (!context) {
        // Fallback for users without identity context
        return [
            {
                role: 'system',
                content: buildDefaultSystemPrompt(),
            },
            ...messages,
        ];
    }
    // Build identity-aware system prompt
    const systemPrompt = buildIdentityAwareSystemPrompt(context);
    // Log for analytics
    serviceLogger.info({
        userId,
        trustTier: context.trustTier,
        riskLevel: context.riskLevel,
        shouldChallenge: context.shouldChallenge,
        messageCount: messages.length,
    }, 'Enriching onboarding conversation with identity context');
    return [
        {
            role: 'system',
            content: systemPrompt,
        },
        ...messages,
    ];
}
// ============================================
// DEFAULT PROMPT (NO IDENTITY)
// ============================================
function buildDefaultSystemPrompt() {
    return `You are HustleAI, an onboarding assistant for HustleXP.

This user has not completed identity verification.
Guide them through the verification process before proceeding with onboarding.

INSTRUCTIONS:
- Be welcoming and professional.
- Explain that identity verification is required for security.
- Direct them to verify their email and phone first.
- Do not proceed with full onboarding until verified.
`;
}
/**
 * Parse AI response for special actions
 */
export function parseOnboardingActions(response) {
    const actions = [];
    // Check for block action
    if (response.includes('"action": "BLOCK_ONBOARDING"') || response.includes('"action":"BLOCK_ONBOARDING"')) {
        actions.push({ type: 'BLOCK_ONBOARDING' });
    }
    // Check for proof request
    if (response.includes('"action": "REQUEST_PROOF"') || response.includes('"action":"REQUEST_PROOF"')) {
        const proofMatch = response.match(/"type":\s*"([^"]+)"/);
        actions.push({
            type: 'REQUEST_PROOF',
            payload: { proofType: proofMatch?.[1] || 'identity' },
        });
    }
    // Check for XP award
    const xpMatch = response.match(/"xpAwarded":\s*(\d+)/);
    if (xpMatch) {
        actions.push({
            type: 'AWARD_XP',
            payload: { amount: parseInt(xpMatch[1], 10) },
        });
    }
    // Default to continue if no special actions
    if (actions.length === 0) {
        actions.push({ type: 'CONTINUE' });
    }
    return actions;
}
//# sourceMappingURL=identityOnboardingPrompt.js.map