/**
 * HIVS — Identity Verification Routes
 * 
 * Email + Phone verification endpoints.
 * Must be completed BEFORE AI onboarding can start.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VerificationService } from '../services/VerificationService.js';
import { logger } from '../utils/logger.js';

// ============================================
// REQUEST SCHEMAS
// ============================================

const SendEmailCodeSchema = z.object({
    email: z.string().email(),
});

const VerifyEmailCodeSchema = z.object({
    email: z.string().email(),
    code: z.string().length(6),
});

const SendSmsCodeSchema = z.object({
    phone: z.string().min(10).max(15),
});

const VerifySmsCodeSchema = z.object({
    phone: z.string().min(10).max(15),
    code: z.string().length(6),
});

// ============================================
// ROUTE REGISTRATION
// ============================================

export default async function verificationRoutes(fastify: FastifyInstance) {
    /**
     * GET /api/verify/status
     * Get current verification status for the authenticated user
     */
    fastify.get('/status', async (request, reply) => {
        const userId = request.user?.uid;

        if (!userId) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        const status = await VerificationService.getStatus(userId);

        if (!status) {
            return {
                emailVerified: false,
                phoneVerified: false,
                nextRequired: 'email',
                canProceedToOnboarding: false,
            };
        }

        return status;
    });

    /**
     * POST /api/verify/email/send
     * Send email verification code
     */
    fastify.post('/email/send', async (request, reply) => {
        const userId = request.user?.uid;

        if (!userId) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        try {
            const body = SendEmailCodeSchema.parse(request.body);
            const ip = request.ip;

            const result = await VerificationService.sendEmailCode(userId, body.email, ip);

            if (!result.success) {
                reply.status(result.code === 'RATE_LIMITED' ? 429 : 400);
                return {
                    error: result.error,
                    code: result.code,
                    retryAfterMs: result.retryAfterMs,
                };
            }

            return { status: 'sent', message: 'Verification code sent to your email' };
        } catch (error) {
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid email format', details: error.errors };
            }
            logger.error({ error }, 'Email send error');
            reply.status(500);
            return { error: 'Failed to send verification code' };
        }
    });

    /**
     * POST /api/verify/email/confirm
     * Verify email code
     */
    fastify.post('/email/confirm', async (request, reply) => {
        const userId = request.user?.uid;

        if (!userId) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        try {
            const body = VerifyEmailCodeSchema.parse(request.body);

            const result = await VerificationService.verifyEmailCode(userId, body.email, body.code);

            if (!result.verified) {
                reply.status(result.code === 'LOCKED' ? 423 : 400);
                return {
                    verified: false,
                    error: result.error,
                    code: result.code,
                    attemptsRemaining: result.attemptsRemaining,
                };
            }

            return {
                verified: true,
                next: result.next,
                message: 'Email verified! Now verify your phone number.',
            };
        } catch (error) {
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            logger.error({ error }, 'Email verify error');
            reply.status(500);
            return { error: 'Verification failed' };
        }
    });

    /**
     * POST /api/verify/phone/send
     * Send SMS verification code
     */
    fastify.post('/phone/send', async (request, reply) => {
        const userId = request.user?.uid;

        if (!userId) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        try {
            const body = SendSmsCodeSchema.parse(request.body);
            const ip = request.ip;

            const result = await VerificationService.sendSmsCode(userId, body.phone, ip);

            if (!result.success) {
                reply.status(result.code === 'RATE_LIMITED' ? 429 : 400);
                return {
                    error: result.error,
                    code: result.code,
                    retryAfterMs: result.retryAfterMs,
                };
            }

            return { status: 'sent', message: 'Verification code sent to your phone' };
        } catch (error) {
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid phone format', details: error.errors };
            }
            logger.error({ error }, 'SMS send error');
            reply.status(500);
            return { error: 'Failed to send verification code' };
        }
    });

    /**
     * POST /api/verify/phone/confirm
     * Verify SMS code
     */
    fastify.post('/phone/confirm', async (request, reply) => {
        const userId = request.user?.uid;

        if (!userId) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        try {
            const body = VerifySmsCodeSchema.parse(request.body);

            const result = await VerificationService.verifySmsCode(userId, body.phone, body.code);

            if (!result.verified) {
                reply.status(result.code === 'LOCKED' ? 423 : 400);
                return {
                    verified: false,
                    error: result.error,
                    code: result.code,
                    attemptsRemaining: result.attemptsRemaining,
                };
            }

            return {
                verified: true,
                next: result.next,
                message: 'Phone verified! You can now start AI onboarding.',
            };
        } catch (error) {
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            logger.error({ error }, 'SMS verify error');
            reply.status(500);
            return { error: 'Verification failed' };
        }
    });
}
