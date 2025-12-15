/**
 * ESCROW TIMEOUT SWEEPER (Phase Ω-OPS-4)
 * 
 * Purpose: No escrow stuck forever.
 * 
 * DETERMINISTIC LOGIC (CORRECTION #1):
 * 
 * AUTO-RELEASE ONLY IF ALL THREE:
 * - task.status === 'completed'
 * - !dispute.active
 * - (proof.notRequired || proof.verified)
 * 
 * Otherwise: AUTO-REFUND
 * 
 * No heuristics. No best guess.
 * 
 * CONSTRAINTS:
 * - Timeout: 48 hours
 * - All actions logged to money_events_audit
 * - Users notified via NotificationService
 * - Alerts on every action
 */

import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { AlertService } from '../services/AlertService.js';
import Stripe from 'stripe';
import { env } from '../config/env.js';

const logger = serviceLogger.child({ module: 'EscrowTimeoutSweeper' });

let sql: ReturnType<typeof neon> | null = null;
let stripe: Stripe | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

function getStripe(): Stripe | null {
    if (!stripe && env.STRIPE_SECRET_KEY) {
        stripe = new Stripe(env.STRIPE_SECRET_KEY, {
            apiVersion: '2025-11-17.clover' as any,
        });
    }
    return stripe;
}

// ============================================================
// TYPES
// ============================================================

interface StuckEscrow {
    escrowId: string;
    taskId: string;
    posterId: string | null;
    hustlerId: string | null;
    paymentIntentId: string;
    grossAmountCents: number;
    createdAt: Date;
}

interface TaskState {
    status: string;
    hasActiveDispute: boolean;
    proofRequired: boolean;
    proofVerified: boolean;
}

interface TimeoutResult {
    escrowId: string;
    action: 'released' | 'refunded' | 'skipped';
    reason: string;
}

// ============================================================
// ESCROW TIMEOUT SWEEPER
// ============================================================

export class EscrowTimeoutSweeper {

    private static readonly TIMEOUT_HOURS = 48;

    /**
     * RUN SWEEPER
     * 
     * Called by cron. Finds and resolves timed-out escrows.
     */
    static async run(): Promise<TimeoutResult[]> {
        const db = getDb();
        if (!db) {
            logger.warn('Database not available, skipping sweep');
            return [];
        }

        logger.info('Starting escrow timeout sweep');

        // 1. Find stuck escrows
        const stuckEscrows = await this.findStuckEscrows(db);

        if (stuckEscrows.length === 0) {
            logger.info('No timed-out escrows found');
            return [];
        }

        logger.warn({ count: stuckEscrows.length }, 'Found timed-out escrows');

        // 2. Resolve each
        const results: TimeoutResult[] = [];
        for (const escrow of stuckEscrows) {
            const result = await this.resolveEscrow(db, escrow);
            results.push(result);
        }

        logger.info({ results }, 'Escrow timeout sweep complete');

        return results;
    }

    /**
     * FIND STUCK ESCROWS
     */
    private static async findStuckEscrows(db: ReturnType<typeof neon>): Promise<StuckEscrow[]> {
        try {
            const rows = await db`
                SELECT 
                    id as escrow_id,
                    task_id,
                    poster_id,
                    hustler_id,
                    payment_intent_id,
                    gross_amount_cents,
                    created_at
                FROM escrow_holds
                WHERE status = 'held'
                AND created_at < NOW() - INTERVAL '${this.TIMEOUT_HOURS} hours'
                ORDER BY created_at ASC
                LIMIT 50
            `;

            return (rows as any[]).map((row: any) => ({
                escrowId: row.escrow_id,
                taskId: row.task_id,
                posterId: row.poster_id,
                hustlerId: row.hustler_id,
                paymentIntentId: row.payment_intent_id,
                grossAmountCents: parseInt(row.gross_amount_cents) || 0,
                createdAt: row.created_at
            }));
        } catch (error) {
            logger.error({ error }, 'Failed to find stuck escrows');
            return [];
        }
    }

    /**
     * RESOLVE ESCROW
     * 
     * DETERMINISTIC LOGIC:
     * AUTO-RELEASE ONLY IF ALL THREE:
     * - task.status === 'completed'
     * - !dispute.active
     * - (proof.notRequired || proof.verified)
     * 
     * Otherwise: AUTO-REFUND
     */
    private static async resolveEscrow(
        db: ReturnType<typeof neon>,
        escrow: StuckEscrow
    ): Promise<TimeoutResult> {
        const { escrowId, taskId, paymentIntentId, grossAmountCents } = escrow;

        // Get task state
        const taskState = await this.getTaskState(db, taskId);

        // DETERMINISTIC DECISION
        const canRelease =
            taskState.status === 'completed' &&
            !taskState.hasActiveDispute &&
            (!taskState.proofRequired || taskState.proofVerified);

        if (canRelease) {
            // AUTO-RELEASE to hustler
            const success = await this.executeRelease(db, escrow);
            if (success) {
                await this.notifyUsers(db, escrow, 'released');
                await AlertService.fire(
                    'ESCROW_TIMEOUT_ACTION',
                    `Escrow ${escrowId} auto-released to hustler after ${this.TIMEOUT_HOURS}h`,
                    { escrowId, taskId, action: 'released', amount: grossAmountCents }
                );
                return { escrowId, action: 'released', reason: 'Task completed, no dispute, proof valid' };
            } else {
                return { escrowId, action: 'skipped', reason: 'Release execution failed' };
            }
        } else {
            // AUTO-REFUND to poster
            const success = await this.executeRefund(db, escrow);
            if (success) {
                await this.notifyUsers(db, escrow, 'refunded');
                await AlertService.fire(
                    'ESCROW_TIMEOUT_ACTION',
                    `Escrow ${escrowId} auto-refunded to poster after ${this.TIMEOUT_HOURS}h`,
                    {
                        escrowId,
                        taskId,
                        action: 'refunded',
                        amount: grossAmountCents,
                        reason: this.getRefundReason(taskState)
                    }
                );
                return { escrowId, action: 'refunded', reason: this.getRefundReason(taskState) };
            } else {
                return { escrowId, action: 'skipped', reason: 'Refund execution failed' };
            }
        }
    }

    /**
     * GET TASK STATE
     */
    private static async getTaskState(
        db: ReturnType<typeof neon>,
        taskId: string
    ): Promise<TaskState> {
        try {
            // Get task status
            const [task] = await db`
                SELECT status FROM tasks WHERE id = ${taskId}::uuid
            ` as any[];

            // Check for active dispute
            const [dispute] = await db`
                SELECT id FROM disputes 
                WHERE task_id = ${taskId}::uuid 
                AND status IN ('pending', 'under_review')
                LIMIT 1
            ` as any[];

            // Check proof status
            const [proof] = await db`
                SELECT verified FROM proof_photos
                WHERE task_id = ${taskId}::uuid
                AND photo_type = 'after'
                ORDER BY created_at DESC
                LIMIT 1
            ` as any[];

            // Determine if proof is required (for now, assume required for all)
            // TODO: Connect to AdaptiveProofPolicy when enforcement mode is on
            const proofRequired = true;

            return {
                status: task?.status || 'unknown',
                hasActiveDispute: !!dispute,
                proofRequired,
                proofVerified: !!proof?.verified
            };
        } catch (error) {
            logger.error({ error, taskId }, 'Failed to get task state');
            return {
                status: 'unknown',
                hasActiveDispute: true, // Fail safe
                proofRequired: true,
                proofVerified: false
            };
        }
    }

    /**
     * GET REFUND REASON
     */
    private static getRefundReason(taskState: TaskState): string {
        if (taskState.status !== 'completed') {
            return `Task not completed (status: ${taskState.status})`;
        }
        if (taskState.hasActiveDispute) {
            return 'Active dispute exists';
        }
        if (taskState.proofRequired && !taskState.proofVerified) {
            return 'Proof not verified';
        }
        return 'Unknown';
    }

    /**
     * EXECUTE RELEASE (to hustler)
     */
    private static async executeRelease(
        db: ReturnType<typeof neon>,
        escrow: StuckEscrow
    ): Promise<boolean> {
        const stripeClient = getStripe();
        if (!stripeClient) {
            logger.error('Stripe not configured, cannot release');
            return false;
        }

        try {
            // TODO: Execute Stripe transfer to hustler
            // For now, just update database state

            await db`
                UPDATE escrow_holds
                SET status = 'released',
                    updated_at = NOW()
                WHERE id = ${escrow.escrowId}
            `;

            await db`
                INSERT INTO money_events_audit (
                    event_id, task_id, event_type, previous_state, new_state, raw_context, created_at
                ) VALUES (
                    ${'timeout_release_' + Date.now()}, ${escrow.taskId}::uuid, 'escrow_timeout_release',
                    'held', 'released', ${{ timeout: true, hours: this.TIMEOUT_HOURS }}, NOW()
                )
            `;

            logger.info({ escrowId: escrow.escrowId }, 'Escrow released via timeout');
            return true;
        } catch (error) {
            logger.error({ error, escrow }, 'Failed to execute release');
            return false;
        }
    }

    /**
     * EXECUTE REFUND (to poster)
     */
    private static async executeRefund(
        db: ReturnType<typeof neon>,
        escrow: StuckEscrow
    ): Promise<boolean> {
        const stripeClient = getStripe();
        if (!stripeClient) {
            logger.error('Stripe not configured, cannot refund');
            return false;
        }

        try {
            // Execute Stripe refund
            await stripeClient.refunds.create({
                payment_intent: escrow.paymentIntentId,
            });

            await db`
                UPDATE escrow_holds
                SET status = 'refunded',
                    refund_status = 'refunded',
                    updated_at = NOW(),
                    refund_completed_at = NOW()
                WHERE id = ${escrow.escrowId}
            `;

            await db`
                INSERT INTO money_events_audit (
                    event_id, task_id, event_type, previous_state, new_state, raw_context, created_at
                ) VALUES (
                    ${'timeout_refund_' + Date.now()}, ${escrow.taskId}::uuid, 'escrow_timeout_refund',
                    'held', 'refunded', ${{ timeout: true, hours: this.TIMEOUT_HOURS }}, NOW()
                )
            `;

            logger.info({ escrowId: escrow.escrowId }, 'Escrow refunded via timeout');
            return true;
        } catch (error) {
            logger.error({ error, escrow }, 'Failed to execute refund');
            return false;
        }
    }

    /**
     * NOTIFY USERS
     */
    private static async notifyUsers(
        db: ReturnType<typeof neon>,
        escrow: StuckEscrow,
        action: 'released' | 'refunded'
    ): Promise<void> {
        try {
            const amountDollars = (escrow.grossAmountCents / 100).toFixed(2);

            if (action === 'released' && escrow.hustlerId) {
                await db`
                    INSERT INTO notifications (user_id, type, channel, payload, status, created_at)
                    SELECT id, 'escrow_released', 'push', ${JSON.stringify({
                    title: 'Payment Released',
                    body: `$${amountDollars} has been released to your account`,
                    taskId: escrow.taskId
                })}, 'pending', NOW()
                    FROM users WHERE firebase_uid = ${escrow.hustlerId}
                `;
            }

            if (action === 'refunded' && escrow.posterId) {
                await db`
                    INSERT INTO notifications (user_id, type, channel, payload, status, created_at)
                    SELECT id, 'escrow_refunded', 'push', ${JSON.stringify({
                    title: 'Payment Refunded',
                    body: `$${amountDollars} has been refunded due to timeout`,
                    taskId: escrow.taskId
                })}, 'pending', NOW()
                    FROM users WHERE firebase_uid = ${escrow.posterId}
                `;
            }
        } catch (error) {
            logger.error({ error, escrow }, 'Failed to notify users');
        }
    }
}
