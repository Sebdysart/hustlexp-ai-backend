/**
 * IVS Webhook Receiver
 * 
 * Receives identity verification events from the IVS microservice.
 * - HMAC signature verification
 * - Timestamp check (2 min max)
 * - Replay protection via Redis
 * - User status update
 */

import crypto from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { sql, isDatabaseAvailable } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';

// ============================================
// CONFIGURATION
// ============================================

const WEBHOOK_SECRET = process.env.IVS_WEBHOOK_SECRET;
const MAX_TIMESTAMP_DRIFT_MS = 2 * 60 * 1000; // 2 minutes

// In-memory replay protection (use Redis in production)
const processedEvents = new Map<string, number>();
const REPLAY_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

// ============================================
// TYPES
// ============================================

interface IdentityWebhookPayload {
    type: 'email.verified' | 'phone.verified' | 'identity.fully_verified';
    userId: string;
    timestamp: string;
    data?: {
        email?: string;
        phone?: string;
    };
    eventId?: string;
}

// ============================================
// SIGNATURE VERIFICATION
// ============================================

function verifySignature(payload: string, signature: string | undefined): boolean {
    if (!WEBHOOK_SECRET) {
        serviceLogger.warn('IVS_WEBHOOK_SECRET not configured - skipping verification');
        return true; // Allow in dev
    }

    if (!signature) {
        return false;
    }

    const expectedSignature = `sha256=${crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(payload)
        .digest('hex')}`;

    return crypto.timingSafeEqual(
        Buffer.from(signature),
        Buffer.from(expectedSignature)
    );
}

// ============================================
// REPLAY PROTECTION
// ============================================

function checkReplay(eventId: string): boolean {
    // Clean old entries
    const now = Date.now();
    for (const [id, timestamp] of processedEvents.entries()) {
        if (now - timestamp > REPLAY_WINDOW_MS) {
            processedEvents.delete(id);
        }
    }

    if (processedEvents.has(eventId)) {
        return true; // Replay detected
    }

    processedEvents.set(eventId, now);
    return false;
}

// ============================================
// EVENT HANDLERS
// ============================================

async function handleEmailVerified(userId: string, email?: string): Promise<void> {
    if (!isDatabaseAvailable() || !sql) return;

    await sql`
        UPDATE users 
        SET email_verified = true, email_verified_at = NOW(), updated_at = NOW()
        WHERE id = ${userId}::uuid OR firebase_uid = ${userId}
    `;

    serviceLogger.info({ userId, email }, 'User email marked verified via IVS webhook');
}

async function handlePhoneVerified(userId: string, phone?: string): Promise<void> {
    if (!isDatabaseAvailable() || !sql) return;

    await sql`
        UPDATE users 
        SET phone_verified = true, phone_verified_at = NOW(), updated_at = NOW()
        WHERE id = ${userId}::uuid OR firebase_uid = ${userId}
    `;

    serviceLogger.info({ userId, phone }, 'User phone marked verified via IVS webhook');
}

async function handleFullyVerified(userId: string): Promise<void> {
    if (!isDatabaseAvailable() || !sql) return;

    await sql`
        UPDATE users 
        SET verification_status = 'verified', 
            trust_score = COALESCE(trust_score, 0) + 50,
            onboarding_unlocked = true,
            fully_verified_at = NOW(),
            updated_at = NOW()
        WHERE id = ${userId}::uuid OR firebase_uid = ${userId}
    `;

    serviceLogger.info({ userId }, 'User fully verified - onboarding unlocked');
}

// ============================================
// ROUTE HANDLER
// ============================================

export default async function ivsWebhookRoutes(fastify: FastifyInstance) {
    fastify.post('/webhooks/identity', async (request: FastifyRequest, reply: FastifyReply) => {
        const signature = request.headers['x-hustle-sig'] as string | undefined;
        const rawBody = JSON.stringify(request.body);

        // Verify signature
        if (!verifySignature(rawBody, signature)) {
            serviceLogger.warn({ signature }, 'Invalid webhook signature');
            reply.status(401);
            return { error: 'Invalid signature' };
        }

        const payload = request.body as IdentityWebhookPayload;

        // Validate timestamp
        const eventTime = new Date(payload.timestamp).getTime();
        const now = Date.now();
        if (Math.abs(now - eventTime) > MAX_TIMESTAMP_DRIFT_MS) {
            serviceLogger.warn({ eventTime, now }, 'Webhook timestamp too old');
            reply.status(400);
            return { error: 'Timestamp too old' };
        }

        // Replay protection
        const eventId = payload.eventId || `${payload.type}-${payload.userId}-${payload.timestamp}`;
        if (checkReplay(eventId)) {
            serviceLogger.warn({ eventId }, 'Replay detected');
            reply.status(409);
            return { error: 'Event already processed' };
        }

        // Handle event
        try {
            switch (payload.type) {
                case 'email.verified':
                    await handleEmailVerified(payload.userId, payload.data?.email);
                    break;
                case 'phone.verified':
                    await handlePhoneVerified(payload.userId, payload.data?.phone);
                    break;
                case 'identity.fully_verified':
                    await handleFullyVerified(payload.userId);
                    break;
                default:
                    serviceLogger.warn({ type: payload.type }, 'Unknown event type');
            }

            return { received: true, type: payload.type };
        } catch (error) {
            serviceLogger.error({ error, payload }, 'Webhook processing failed');
            reply.status(500);
            return { error: 'Processing failed' };
        }
    });
}
