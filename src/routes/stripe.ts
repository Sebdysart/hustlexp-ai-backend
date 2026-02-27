import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { StripeService, checkStripeEventIdempotency } from '../services/StripeService.js';
import { logger } from '../utils/logger.js';
import { requireAuth, requireFreshToken, requireRole } from '../middleware/firebaseAuth.js';
import { isDatabaseAvailable, sql } from '../db/index.js';

// ============================================
// Stripe Connect & Webhook Route Module
// ============================================

const CreateConnectAccountSchema = z.object({
    userId: z.string(),
    email: z.string().email(),
    name: z.string().optional(),
    phone: z.string().optional(),
});

export async function stripeRoutes(fastify: FastifyInstance): Promise<void> {
    // Create Stripe Connect account for hustler - HUSTLER ONLY (own account)
    fastify.post('/api/stripe/connect/create', { preHandler: [requireRole('hustler'), requireFreshToken] }, async (request, reply) => {
        try {
            if (!request.user) {
                reply.status(401);
                return { error: 'Authentication required' };
            }

            const body = CreateConnectAccountSchema.parse(request.body);

            // CRITICAL: User can only create Connect account for themselves
            if (body.userId !== request.user.uid) {
                reply.status(403);
                return { error: 'Cannot create Connect account for another user' };
            }

            const result = await StripeService.createConnectAccount(
                body.userId,
                body.email,
                { name: body.name, phone: body.phone }
            );

            if (!result.success) {
                reply.status(400);
                return { error: result.error };
            }

            return result;
        } catch (error) {
            logger.error({ error }, 'Create Connect account error');
            reply.status(500);
            return { error: 'Failed to create payment account' };
        }
    });

    // requireAuth only (not requireFreshToken) — read-only redirect/status; no financial state mutation
    fastify.get('/api/stripe/connect/:userId/onboard', { preHandler: [requireAuth] }, async (request, reply) => {
        if (!request.user) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        const { userId } = request.params as { userId: string };

        // CRITICAL: User can only access their own onboarding link
        if (userId !== request.user.uid) {
            reply.status(403);
            return { error: 'Cannot access another user onboarding' };
        }

        const accountId = await StripeService.getConnectAccountId(userId);

        if (!accountId) {
            reply.status(404);
            return { error: 'No payment account found' };
        }

        const url = await StripeService.createAccountLink(accountId);
        return { onboardingUrl: url };
    });

    // requireAuth only (not requireFreshToken) — read-only redirect/status; no financial state mutation
    fastify.get('/api/stripe/connect/:userId/status', { preHandler: [requireAuth] }, async (request, reply) => {
        if (!request.user) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        const { userId } = request.params as { userId: string };

        // CRITICAL: User can only view their own account status
        if (userId !== request.user.uid) {
            reply.status(403);
            return { error: 'Cannot view another user account status' };
        }

        const status = await StripeService.getAccountStatus(userId);

        if (!status) {
            return {
                status: 'none',
                chargesEnabled: false,
                payoutsEnabled: false,
                detailsSubmitted: false,
                requirements: [],
            };
        }

        return status;
    });

    // Check if Stripe is available
    fastify.get('/api/stripe/status', async () => {
        return {
            available: StripeService.isAvailable(),
        };
    });

    // Stripe webhook endpoint (verified)
    fastify.post('/api/stripe/webhook', {
        config: {
            rawBody: true,
        },
    }, async (request, reply) => {
        const signature = request.headers['stripe-signature'] as string;

        if (!signature) {
            reply.status(400);
            return { error: 'Missing stripe-signature header' };
        }

        if (!request.rawBody) {
            return reply.status(400).send({ error: 'Missing raw body for webhook verification' });
        }

        const event = StripeService.verifyWebhook(
            request.rawBody,
            signature
        );

        if (!event) {
            reply.status(400);
            return { error: 'Invalid webhook signature' };
        }

        await StripeService.handleWebhookEvent(event);

        return { received: true };
    });

    // Global Stripe webhook (legacy/supplemental handler)
    fastify.post('/webhooks/stripe', async (request, reply) => {
        // Minimal type for Stripe webhook payload — in production use Stripe.Event after
        // signature verification via stripe.webhooks.constructEvent(rawBody, sig, secret).
        interface StripeWebhookEvent {
            id: string;
            type: string;
            data?: {
                object?: {
                    id?: string;
                    metadata?: Record<string, string>;
                };
            };
        }
        const event = request.body as StripeWebhookEvent;

        try {
            // Idempotency guard: INSERT … ON CONFLICT DO NOTHING.
            // Stripe retries webhooks on non-2xx responses; we must return 200 for duplicates.
            if (isDatabaseAvailable() && sql) {
                try {
                    const isDuplicate = await checkStripeEventIdempotency(event.id, sql);
                    if (isDuplicate) {
                        logger.warn({ eventId: event.id, type: event.type }, 'Duplicate Stripe webhook received — skipping');
                        return reply.send({ received: true, duplicate: true });
                    }
                } catch (idempotencyErr) {
                    // Table may not exist yet — log and continue processing rather than dropping the event
                    logger.warn({ idempotencyErr, eventId: event.id }, 'Stripe idempotency check failed — continuing');
                }
            }

            if (event.type === 'payout.paid') {
                // payout.paid is a Stripe banking-layer confirmation that a transfer has settled
                // in the recipient's bank account. This is purely informational — the financial
                // state machine already transitioned to 'released' when RELEASE_PAYOUT was processed.
                //
                // NOTE: We intentionally do NOT call StripeMoneyEngine.handle() here because:
                //   1. 'WEBHOOK_PAYOUT_PAID' is not a valid MoneyEvent (only HOLD_ESCROW,
                //      RELEASE_PAYOUT, REFUND_ESCROW are valid)
                //   2. 'released' is a terminal state in the engine — no transitions out
                //   3. The payout settlement is a banking confirmation, not a state transition
                //
                // We log the event and optionally update a settlement timestamp for audit trails.
                const taskId = event.data?.object?.metadata?.taskId;
                if (taskId) {
                    logger.info({ taskId, eventId: event.id, payoutId: event.data?.object?.id },
                        'payout.paid webhook received — banking settlement confirmed');

                    // Optionally record settlement timestamp in the DB for audit trail
                    try {
                        await sql`
                            UPDATE money_state_lock
                            SET payout_settled_at = NOW(),
                                updated_at = NOW()
                            WHERE task_id = ${taskId}
                              AND current_state = 'released'
                        `;
                    } catch (dbErr) {
                        // Non-critical: settlement timestamp is informational only
                        logger.warn({ dbErr, taskId }, 'Failed to record payout settlement timestamp (non-critical)');
                    }
                } else {
                    logger.warn({ eventId: event.id }, 'Received payout.paid webhook without taskId');
                }
            }

            return reply.send({ received: true });

        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            logger.error({ err }, 'Webhook processing failed (Global Catch)');
            return reply.status(500).send(message);
        }
    });
}
