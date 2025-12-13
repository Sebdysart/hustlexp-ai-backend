/**
 * Identity Verification API Routes
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdentityService } from '../services/IdentityService.js';
import { serviceLogger } from '../../utils/logger.js';

// ============================================
// SCHEMAS
// ============================================

const UserIdParam = z.object({
    userId: z.string().uuid(),
});

const SendEmailSchema = z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
});

const VerifyEmailSchema = z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
    code: z.string().length(6),
});

const SendPhoneSchema = z.object({
    userId: z.string().uuid(),
    phone: z.string().min(10).max(15),
});

const VerifyPhoneSchema = z.object({
    userId: z.string().uuid(),
    phone: z.string().min(10).max(15),
    code: z.string().length(6),
});

// ============================================
// ROUTES
// ============================================

export default async function identityRoutes(fastify: FastifyInstance) {
    /**
     * GET /identity/status/:userId
     * Get verification status
     */
    fastify.get('/status/:userId', async (request, reply) => {
        try {
            const { userId } = UserIdParam.parse(request.params);
            const status = await IdentityService.getStatus(userId);

            if (!status) {
                return {
                    emailVerified: false,
                    phoneVerified: false,
                    status: 'unverified',
                    isFullyVerified: false,
                };
            }

            return status;
        } catch (error) {
            serviceLogger.error({ error }, 'Status check failed');
            reply.status(500);
            return { error: 'Failed to get status' };
        }
    });

    /**
     * POST /identity/email/send
     * Send email verification code
     */
    fastify.post('/email/send', async (request, reply) => {
        try {
            const body = SendEmailSchema.parse(request.body);
            const ip = request.ip;

            const result = await IdentityService.sendEmailCode(body.userId, body.email, ip);

            if (!result.success) {
                reply.status(result.code === 'RATE_LIMITED' ? 429 : 400);
                return {
                    error: result.error,
                    code: result.code,
                    retryAfterMs: result.retryAfterMs,
                };
            }

            return { status: 'sent' };
        } catch (error) {
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            serviceLogger.error({ error }, 'Email send failed');
            reply.status(500);
            return { error: 'Failed to send code' };
        }
    });

    /**
     * POST /identity/email/verify
     * Verify email code
     */
    fastify.post('/email/verify', async (request, reply) => {
        try {
            const body = VerifyEmailSchema.parse(request.body);
            const ip = request.ip;

            const result = await IdentityService.verifyEmailCode(body.userId, body.email, body.code, ip);

            if (!result.verified) {
                reply.status(400);
                return {
                    verified: false,
                    error: result.error,
                    attemptsRemaining: result.attemptsRemaining,
                };
            }

            return {
                verified: true,
                event: result.event,
                message: 'Email verified! Now verify your phone.',
            };
        } catch (error) {
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            serviceLogger.error({ error }, 'Email verify failed');
            reply.status(500);
            return { error: 'Verification failed' };
        }
    });

    /**
     * POST /identity/phone/send
     * Send SMS verification code
     */
    fastify.post('/phone/send', async (request, reply) => {
        try {
            const body = SendPhoneSchema.parse(request.body);
            const ip = request.ip;

            const result = await IdentityService.sendSmsCode(body.userId, body.phone, ip);

            if (!result.success) {
                reply.status(result.code === 'RATE_LIMITED' ? 429 : 400);
                return {
                    error: result.error,
                    code: result.code,
                    retryAfterMs: result.retryAfterMs,
                };
            }

            return { status: 'sent' };
        } catch (error) {
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            serviceLogger.error({ error }, 'SMS send failed');
            reply.status(500);
            return { error: 'Failed to send code' };
        }
    });

    /**
     * POST /identity/phone/verify
     * Verify SMS code
     */
    fastify.post('/phone/verify', async (request, reply) => {
        try {
            const body = VerifyPhoneSchema.parse(request.body);
            const ip = request.ip;

            const result = await IdentityService.verifySmsCode(body.userId, body.phone, body.code, ip);

            if (!result.verified) {
                reply.status(400);
                return {
                    verified: false,
                    error: result.error,
                    attemptsRemaining: result.attemptsRemaining,
                };
            }

            return {
                verified: true,
                event: result.event,
                message: 'Identity fully verified! You can now start onboarding.',
            };
        } catch (error) {
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            serviceLogger.error({ error }, 'SMS verify failed');
            reply.status(500);
            return { error: 'Verification failed' };
        }
    });

    /**
     * GET /identity/health
     * Health check
     */
    fastify.get('/health', async () => {
        return {
            status: 'ok',
            service: 'hustlexp-identity-service',
            timestamp: new Date().toISOString(),
        };
    });
}
