/**
 * Identity Context API Routes
 * 
 * Provides identity context endpoints for AI onboarding personalization.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AIIdentityContextService } from '../services/AIIdentityContextService.js';
import { FraudDetectionService } from '../services/FraudDetectionService.js';
import { serviceLogger } from '../utils/logger.js';

export default async function identityContextRoutes(fastify: FastifyInstance) {
    /**
     * GET /api/onboarding/identity-context/:userId
     * 
     * Returns the full identity context for AI onboarding personalization.
     */
    fastify.get('/identity-context/:userId', async (request: FastifyRequest, reply: FastifyReply) => {
        const { userId } = request.params as { userId: string };

        try {
            // Get full identity context
            const context = await AIIdentityContextService.getOnboardingContext(userId);

            if (!context) {
                return {
                    trustScore: 0,
                    trustTier: 'new',
                    riskLevel: 'high',
                    suggestedTone: 'cautious',
                    skipIntro: false,
                    skipRedundantQuestions: false,
                    xpMultiplier: 1.0,
                    requireExtraVerification: true,
                    requireProofChallenge: false,
                    identity: null,
                };
            }

            // Get personalization settings
            const personalization = await AIIdentityContextService.getOnboardingPersonalization(userId);

            return {
                trustScore: context.trustScore,
                trustTier: context.trustTier,
                riskLevel: context.riskLevel,
                suggestedTone: context.suggestedTone,
                skipIntro: context.shouldSkipIntro,
                skipRedundantQuestions: context.skipRedundantQuestions,
                xpMultiplier: personalization.rewards.xpMultiplier,
                requireExtraVerification: context.shouldChallenge,
                requireProofChallenge: context.riskLevel === 'high' || context.riskLevel === 'critical',
                identity: {
                    emailVerified: context.emailVerified,
                    phoneVerified: context.phoneVerified,
                    verificationAge: context.verificationAge,
                    deviceTrust: context.deviceTrust,
                    isFullyVerified: context.identityVerified,
                },
                personalization: {
                    intro: personalization.intro,
                    flow: personalization.flow,
                },
            };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to get identity context');
            reply.status(500);
            return { error: 'Failed to get identity context' };
        }
    });

    /**
     * GET /api/onboarding/risk-assessment/:userId
     * 
     * Returns the fraud risk assessment for a user.
     */
    fastify.get('/risk-assessment/:userId', async (request: FastifyRequest, reply: FastifyReply) => {
        const { userId } = request.params as { userId: string };

        try {
            const identity = await FraudDetectionService.getIdentityContext(userId);

            if (!identity) {
                return {
                    riskScore: 75,
                    riskLevel: 'high',
                    recommendation: 'challenge',
                    signals: ['unverified_identity'],
                    reasons: ['User has not completed identity verification'],
                };
            }

            return {
                riskScore: identity.riskAssessment.riskScore,
                riskLevel: identity.riskAssessment.riskLevel,
                recommendation: identity.riskAssessment.recommendation,
                signals: Object.entries(identity.riskAssessment.signals)
                    .filter(([_, value]) => value === true)
                    .map(([key]) => key),
                reasons: identity.riskAssessment.reasons,
            };
        } catch (error) {
            serviceLogger.error({ error, userId }, 'Failed to get risk assessment');
            reply.status(500);
            return { error: 'Failed to get risk assessment' };
        }
    });

    /**
     * POST /api/onboarding/record-behavior
     * 
     * Records onboarding behavior for trust score adjustment.
     */
    fastify.post('/record-behavior', async (request: FastifyRequest, reply: FastifyReply) => {
        const body = request.body as {
            userId: string;
            behavior: 'completed' | 'skipped_questions' | 'abandoned' | 'suspicious_pattern';
        };

        if (!body.userId || !body.behavior) {
            reply.status(400);
            return { error: 'userId and behavior required' };
        }

        try {
            await AIIdentityContextService.recordOnboardingBehavior(body.userId, body.behavior);
            return { recorded: true };
        } catch (error) {
            serviceLogger.error({ error, body }, 'Failed to record behavior');
            reply.status(500);
            return { error: 'Failed to record behavior' };
        }
    });
}
