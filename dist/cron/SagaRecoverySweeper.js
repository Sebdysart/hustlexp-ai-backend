/**
 * SAGA RECOVERY SWEEPER (Phase Ω-OPS-3)
 *
 * Purpose: No transaction stuck in 'executing' forever.
 *
 * CRITICAL: Ledger-first recovery, Stripe-second.
 *
 * Recovery order (STRICT):
 * 1. Inspect money_state_lock
 * 2. Inspect money_events_audit for outbound intent
 * 3. Query Stripe ONLY IF outbound intent exists
 *
 * CONSTRAINTS:
 * - Max 3 recovery attempts before KillSwitch
 * - All actions logged to money_events_audit
 * - Alerts on every recovery action
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { AlertService } from '../services/AlertService.js';
import { KillSwitch } from '../infra/KillSwitch.js';
import Stripe from 'stripe';
import { env } from '../config/env.js';
const logger = serviceLogger.child({ module: 'SagaRecoverySweeper' });
let sql = null;
let stripe = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
function getStripe() {
    if (!stripe && env.STRIPE_SECRET_KEY) {
        stripe = new Stripe(env.STRIPE_SECRET_KEY, {
            apiVersion: '2025-11-17.clover',
        });
    }
    return stripe;
}
// ============================================================
// SAGA RECOVERY SWEEPER
// ============================================================
export class SagaRecoverySweeper {
    static STUCK_THRESHOLD_MINUTES = 15;
    static MAX_RECOVERY_ATTEMPTS = 3;
    /**
     * RUN SWEEPER
     *
     * Called by cron. Finds and recovers stuck sagas.
     */
    static async run(options) {
        const db = getDb();
        if (!db) {
            logger.warn('Database not available, skipping sweep');
            return [];
        }
        const stripeClient = options?.stripeClient;
        logger.info('Starting saga recovery sweep');
        // 1. Find stuck sagas
        const stuckSagas = await this.findStuckSagas(db);
        if (stuckSagas.length === 0) {
            logger.info('No stuck sagas found');
            return [];
        }
        logger.warn({ count: stuckSagas.length }, 'Found stuck sagas');
        // 2. Recover each
        const results = [];
        for (const saga of stuckSagas) {
            const result = await this.recoverSaga(db, saga, stripeClient);
            results.push(result);
        }
        logger.info({ results }, 'Saga recovery sweep complete');
        return results;
    }
    /**
     * FIND STUCK SAGAS
     */
    static async findStuckSagas(db) {
        try {
            const cutoff = new Date(Date.now() - this.STUCK_THRESHOLD_MINUTES * 60 * 1000);
            const rows = await db `
                SELECT 
                    task_id,
                    current_state,
                    stripe_payment_intent_id as pi_id,
                    stripe_charge_id as charge_id,
                    stripe_transfer_id as transfer_id,
                    last_transition_at,
                    COALESCE(recovery_attempts, 0) as recovery_attempts
                FROM money_state_lock
                WHERE current_state LIKE '%executing%'
                AND last_transition_at < ${cutoff}
                ORDER BY last_transition_at ASC
                LIMIT 50
            `;
            return rows.map((row) => ({
                taskId: row.task_id,
                currentState: row.current_state,
                piId: row.pi_id,
                chargeId: row.charge_id,
                transferId: row.transfer_id,
                lastTransitionAt: row.last_transition_at,
                recoveryAttempts: parseInt(row.recovery_attempts) || 0
            }));
        }
        catch (error) {
            console.error('Failed to find stuck sagas:', error);
            logger.error({ error }, 'Failed to find stuck sagas');
            return [];
        }
    }
    /**
     * RECOVER SINGLE SAGA
     *
     * Ledger-first recovery (STRICT ORDER):
     * 1. Check money_events_audit for outbound intent
     * 2. Check Stripe ONLY if outbound exists
     * 3. Commit or fail based on evidence
     */
    static async recoverSaga(db, saga, stripeClient) {
        const { taskId, currentState, recoveryAttempts } = saga;
        // Check max attempts
        if (recoveryAttempts >= this.MAX_RECOVERY_ATTEMPTS) {
            logger.fatal({ taskId, attempts: recoveryAttempts }, 'SAGA RECOVERY EXHAUSTED - TRIGGERING KILLSWITCH');
            await AlertService.fire('SAGA_RECOVERY_EXHAUSTED', `Saga ${taskId} failed to recover after ${recoveryAttempts} attempts`, { taskId, state: currentState });
            await KillSwitch.trigger('SAGA_RETRY_EXHAUSTION', { taskId });
            return { taskId, action: 'escalated', reason: 'Max attempts exceeded, KillSwitch triggered' };
        }
        // Increment recovery attempts
        await this.incrementRecoveryAttempts(db, taskId);
        // Alert on recovery attempt
        await AlertService.fire('SAGA_STUCK', `Attempting recovery for saga ${taskId} (attempt ${recoveryAttempts + 1})`, { taskId, state: currentState, attempt: recoveryAttempts + 1 });
        // 1. Check outbound intent (ledger-first)
        const outboundIntent = await this.getOutboundIntent(db, taskId);
        if (!outboundIntent) {
            // No Stripe call was ever made - safe to fail
            await this.markFailed(db, taskId, 'no_outbound_intent');
            return { taskId, action: 'failed', reason: 'No outbound intent found' };
        }
        // 2. Query Stripe ONLY because outbound intent exists
        const stripeStatus = await this.queryStripe(saga, stripeClient);
        if (stripeStatus === 'succeeded') {
            // Stripe confirms success - commit
            await this.markCommitted(db, taskId);
            return { taskId, action: 'committed', reason: 'Stripe confirmed success' };
        }
        else if (stripeStatus === 'failed') {
            // Stripe confirms failure - mark failed
            await this.markFailed(db, taskId, 'stripe_confirmed_failure');
            return { taskId, action: 'failed', reason: 'Stripe confirmed failure' };
        }
        else {
            // Unknown - do not touch, wait for next sweep
            logger.warn({ taskId, stripeStatus }, 'Stripe status unknown, skipping');
            return { taskId, action: 'skipped', reason: 'Stripe status uncertain' };
        }
    }
    /**
     * GET OUTBOUND INTENT FROM AUDIT LOG
     */
    static async getOutboundIntent(db, taskId) {
        try {
            const [row] = await db `
                SELECT * FROM money_events_audit
                WHERE task_id = ${taskId}::uuid
                AND event_type LIKE '%executing%'
                ORDER BY created_at DESC
                LIMIT 1
            `;
            return row || null;
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to get outbound intent');
            return null;
        }
    }
    /**
     * QUERY STRIPE STATUS
     */
    static async queryStripe(saga, injectedClient) {
        const stripeClient = injectedClient || getStripe();
        if (!stripeClient) {
            logger.warn('Stripe not configured, cannot verify status');
            return 'unknown';
        }
        try {
            // Check transfer first (for payout scenarios)
            if (saga.transferId) {
                const transfer = await stripeClient.transfers.retrieve(saga.transferId);
                if (transfer.reversed)
                    return 'failed';
                return 'succeeded';
            }
            // Check payment intent (for escrow scenarios)
            if (saga.piId) {
                const pi = await stripeClient.paymentIntents.retrieve(saga.piId);
                if (pi.status === 'succeeded')
                    return 'succeeded';
                if (pi.status === 'canceled' || pi.status === 'requires_payment_method')
                    return 'failed';
            }
            return 'unknown';
        }
        catch (error) {
            logger.error({ error, saga }, 'Failed to query Stripe');
            return 'unknown';
        }
    }
    /**
     * MARK COMMITTED
     */
    static async markCommitted(db, taskId) {
        try {
            await db `
                UPDATE money_state_lock
                SET current_state = 'completed',
                    last_transition_at = NOW()
                WHERE task_id = ${taskId}::uuid
            `;
            await db `
                INSERT INTO money_events_audit (
                    event_id, task_id, event_type, previous_state, new_state, raw_context, created_at
                ) VALUES (
                    ${'recovery_' + Date.now()}, ${taskId}::uuid, 'saga_recovery_commit',
                    'executing', 'completed', ${{ recovery: true }}, NOW()
                )
            `;
            logger.info({ taskId }, 'Saga recovered - marked committed');
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to mark saga committed');
        }
    }
    /**
     * MARK FAILED
     */
    static async markFailed(db, taskId, reason) {
        try {
            await db `
                UPDATE money_state_lock
                SET current_state = 'failed',
                    last_transition_at = NOW()
                WHERE task_id = ${taskId}::uuid
            `;
            await db `
                INSERT INTO money_events_audit (
                    event_id, task_id, event_type, previous_state, new_state, raw_context, created_at
                ) VALUES (
                    ${'recovery_fail_' + Date.now()}, ${taskId}::uuid, 'saga_recovery_fail',
                    'executing', 'failed', ${{ recovery: true, reason }}, NOW()
                )
            `;
            logger.info({ taskId, reason }, 'Saga recovered - marked failed');
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to mark saga failed');
        }
    }
    /**
     * INCREMENT RECOVERY ATTEMPTS
     */
    static async incrementRecoveryAttempts(db, taskId) {
        try {
            await db `
                UPDATE money_state_lock
                SET recovery_attempts = COALESCE(recovery_attempts, 0) + 1,
                    last_recovery_at = NOW()
                WHERE task_id = ${taskId}::uuid
            `;
        }
        catch (error) {
            logger.error({ error, taskId }, 'Failed to increment recovery attempts');
        }
    }
}
//# sourceMappingURL=SagaRecoverySweeper.js.map