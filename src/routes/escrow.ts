import 'crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TaskService } from '../services/TaskService.js';
import { StripeService } from '../services/StripeService.js';
import { StripeMoneyEngine } from '../services/StripeMoneyEngine.js';
import { UserService } from '../services/UserService.js';
import { logger } from '../utils/logger.js';
import { requireAuth, requireFreshToken, requireRole } from '../middleware/firebaseAuth.js';

// ============================================
// Escrow & Payout Route Module
// ============================================

const CreateEscrowSchema = z.object({
    taskId: z.string(),
    hustlerId: z.string(),
    amount: z.number().positive(),
    paymentMethodId: z.string(),
});

const RefundSchema = z.object({
    amount: z.number().positive(),
    reason: z.string().optional(),
});

const ApproveTaskSchema = z.object({
    rating: z.number().min(1).max(5).optional(),
    tip: z.number().min(0).optional(),
    instantPayout: z.boolean().optional().default(false),
});

const RejectTaskSchema = z.object({
    reason: z.string().min(10).max(500),
    requestedAction: z.enum(['refund', 'dispute', 'redo']).optional().default('dispute'),
});

// ============================================
// MONEY ENGINE CONTEXT PACKERS
// ============================================

/** Minimal task shape needed by the release/refund context packers */
interface TaskWithEscrowShape {
    id: string;
    posterId: string;
    assignedHustlerId?: string | null;
    hustlerPayout?: number;
    status?: string;
}

function packHoldEscrowContext(body: z.infer<typeof CreateEscrowSchema>, posterId: string) {
    return {
        eventId: crypto.randomUUID(),
        amountCents: Math.round(body.amount * 100),
        paymentMethodId: body.paymentMethodId,
        posterId,
        hustlerId: body.hustlerId,
        taskId: body.taskId
    };
}

function packReleaseContext(task: TaskWithEscrowShape, hustlerStripeAccountId: string) {
    return {
        eventId: crypto.randomUUID(),
        payoutAmountCents: Math.round((task.hustlerPayout ?? 0) * 100),
        hustlerStripeAccountId,
        taskId: task.id
    };
}

function packRefundContext(task: TaskWithEscrowShape, amount: number, reason?: string) {
    return {
        eventId: crypto.randomUUID(),
        refundAmountCents: Math.round(amount * 100),
        reason: reason || 'requested_by_customer',
        taskId: task.id
    };
}

export async function escrowRoutes(fastify: FastifyInstance): Promise<void> {
    // Create escrow hold when task is accepted - POSTER ONLY
    fastify.post('/api/escrow/create', { preHandler: [requireRole('poster'), requireFreshToken] }, async (request, reply) => {
        try {
            if (!request.user) {
                reply.status(401);
                return { error: 'Authentication required' };
            }

            const posterId = request.user.uid;
            const body = CreateEscrowSchema.parse(request.body);

            const ctx = packHoldEscrowContext(body, posterId);

            const result = await StripeMoneyEngine.handle(body.taskId, 'HOLD_ESCROW', ctx);

            return { success: true, state: result.state };
        } catch (error) {
            logger.error({ error }, 'Create escrow error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: error instanceof Error ? error.message : 'Failed to create escrow hold' };
        }
    });

    // Get escrow for a task - REQUIRES AUTH
    fastify.get('/api/escrow/:taskId', { preHandler: [requireAuth] }, async (request, reply) => {
        if (!request.user) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        const { taskId } = request.params as { taskId: string };
        const escrow = await StripeService.getEscrow(taskId);

        if (!escrow) {
            reply.status(404);
            return { error: 'No escrow found for this task' };
        }

        // Only poster or hustler can view escrow
        if (escrow.posterId !== request.user.uid && escrow.hustlerId !== request.user.uid) {
            reply.status(403);
            return { error: 'Not authorized to view this escrow' };
        }

        return escrow;
    });

    // Refund escrow (task cancelled) - POSTER (held) or ADMIN (any)
    fastify.post('/api/escrow/:taskId/refund', { preHandler: [requireAuth, requireFreshToken] }, async (request, reply) => {
        if (!request.user) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        const { taskId } = request.params as { taskId: string };

        let body;
        try {
            body = RefundSchema.parse(request.body);
        } catch (_e) {
            reply.status(400);
            return { error: 'Invalid body: amount required' };
        }

        let task;
        try {
            task = await TaskService.getTaskWithEscrow(taskId);
        } catch (_e) {
            reply.status(404);
            return { error: 'Task not found' };
        }

        const isAdmin = request.user.role === 'admin';
        const isPoster = request.user.uid === task.posterId;

        if (!isPoster && !isAdmin) {
            reply.status(403);
            return { error: 'Not authorized to refund this escrow' };
        }

        if (task.status === 'completed') {
            reply.status(400);
            return {
                error: 'Cannot refund a completed task — funds have already been released to the hustler. ' +
                       'Post-payout refunds must be processed via Stripe Dashboard or admin tools.',
            };
        }

        const ctx = packRefundContext(task, body.amount, body.reason);

        try {
            const result = await StripeMoneyEngine.handle(taskId, 'REFUND_ESCROW', ctx);
            return { success: true, state: result.state };
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            reply.status(400);
            return { error: message };
        }
    });

    // Poster approves task completion - POSTER ONLY
    fastify.post('/api/tasks/:taskId/approve', { preHandler: [requireRole('poster')] }, async (request, reply) => {
        try {
            if (!request.user) {
                reply.status(401);
                return { error: 'Authentication required' };
            }

            const { taskId } = request.params as { taskId: string };
            ApproveTaskSchema.parse(request.body); // validate body shape

            const task = await TaskService.getTaskWithEscrow(taskId);

            if (!request.dbUser) {
                reply.status(401);
                return { error: 'Database record required for approval' };
            }

            const callerId = request.dbUser.id;

            if (task.posterId !== callerId) {
                reply.status(403);
                return { error: 'Only the task poster can approve completion' };
            }

            if (!task.assignedHustlerId) {
                reply.status(400);
                return { error: 'Task has no assigned hustler to pay' };
            }

            let hustlerStripeAccountId;
            try {
                hustlerStripeAccountId = await UserService.getStripeConnectId(task.assignedHustlerId);
            } catch (_err) {
                reply.status(400);
                return { error: 'Hustler has no Stripe Connect account connected' };
            }

            const ctx = packReleaseContext(task, hustlerStripeAccountId);

            const result = await StripeMoneyEngine.handle(taskId, 'RELEASE_PAYOUT', ctx);

            return { success: true, state: result.state };

        } catch (error) {
            logger.error({ error }, 'Task approval error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: error instanceof Error ? error.message : 'Failed to approve task' };
        }
    });

    // Poster rejects task completion - POSTER ONLY
    fastify.post('/api/tasks/:taskId/reject', { preHandler: [requireRole('poster')] }, async (request, reply) => {
        try {
            if (!request.user) {
                reply.status(401);
                return { error: 'Authentication required' };
            }

            const { taskId } = request.params as { taskId: string };
            const body = RejectTaskSchema.parse(request.body);

            const escrow = await StripeService.getEscrow(taskId);
            if (!escrow) {
                reply.status(404);
                return { error: 'No escrow found for this task' };
            }

            if (escrow.status !== 'held') {
                reply.status(400);
                return { error: `Cannot reject task - escrow status is ${escrow.status}` };
            }

            if (escrow.posterId !== request.user.uid) {
                reply.status(403);
                return { error: 'Only the task poster can reject completion' };
            }

            if (body.requestedAction === 'refund') {
                logger.info({ taskId, reason: body.reason }, 'Poster rejecting task - initiating refund');
                const result = await StripeService.refundEscrow(taskId, false);
                if (!result.success) {
                    reply.status(500);
                    return { error: 'Failed to process refund' };
                }

                return {
                    success: true,
                    action: 'refund',
                    message: 'Task rejected, payment refunded',
                };
            } else {
                logger.warn({
                    taskId,
                    action: body.requestedAction,
                    reason: body.reason,
                }, 'Task rejection - dispute created');

                return {
                    success: true,
                    action: body.requestedAction,
                    message: `Task rejected, ${body.requestedAction} initiated. Support will review.`,
                    disputeId: `dispute_${Date.now()}`,
                };
            }
        } catch (error) {
            logger.error({ error }, 'Task rejection error');
            if (error instanceof z.ZodError) {
                reply.status(400);
                return { error: 'Invalid request', details: error.errors };
            }
            reply.status(500);
            return { error: 'Failed to reject task' };
        }
    });

    // Get real payout history for a hustler - HUSTLER ONLY (own payouts)
    fastify.get('/api/payouts/:hustlerId', { preHandler: [requireAuth, requireFreshToken] }, async (request, reply) => {
        if (!request.user) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        const { hustlerId } = request.params as { hustlerId: string };

        if (hustlerId !== request.user.uid) {
            reply.status(403);
            return { error: 'Not authorized to view these payouts' };
        }

        const payouts = await StripeService.getPayoutHistory(hustlerId);
        return {
            payouts,
            count: payouts.length,
            totalEarned: payouts
                .filter(p => p.status === 'completed')
                .reduce((sum, p) => sum + p.netAmount, 0),
        };
    });

    // Get single payout details - AUTH REQUIRED (own payout or related party)
    fastify.get('/api/payouts/detail/:payoutId', { preHandler: [requireAuth, requireFreshToken] }, async (request, reply) => {
        if (!request.user) {
            reply.status(401);
            return { error: 'Authentication required' };
        }

        const { payoutId } = request.params as { payoutId: string };
        const payout = await StripeService.getPayout(payoutId);

        if (!payout) {
            reply.status(404);
            return { error: 'Payout not found' };
        }

        if (payout.hustlerId !== request.user.uid) {
            reply.status(403);
            return { error: 'Not authorized to view this payout' };
        }

        return payout;
    });
}
