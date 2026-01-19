/**
 * JOB QUEUE SYSTEM (BUILD_GUIDE Phase 4)
 *
 * Implements background job processing for:
 * - XP award after escrow release
 * - Payout processing
 * - Notification delivery
 * - Trust tier evaluation
 * - Proof expiration checks
 *
 * Uses database-backed job queue compatible with serverless.
 * (Note: BullMQ requires persistent Redis connection not available in Upstash REST)
 *
 * INVARIANTS ENFORCED:
 * - All jobs are idempotent (safe to retry)
 * - Jobs have unique IDs for deduplication
 * - Failed jobs are logged and retried
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { awardXPForTask } from './AtomicXPService.js';
import { TrustTierService } from './TrustTierService.js';
import { EscrowStateMachine } from './EscrowStateMachine.js';
const logger = createLogger('JobQueue');
// ============================================================================
// JOB QUEUE CLASS
// ============================================================================
class JobQueueClass {
    MAX_ATTEMPTS = 5;
    BACKOFF_BASE_MS = 1000;
    /**
     * Add a job to the queue
     */
    async add(type, payload, options = {}) {
        const sql = getSql();
        const jobId = options.jobId || `${type}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const scheduledAt = new Date(Date.now() + (options.delay || 0));
        try {
            // Idempotent insert - if job exists, skip
            await sql `
        INSERT INTO job_queue (
          id,
          type,
          payload,
          status,
          attempts,
          max_attempts,
          scheduled_at,
          priority,
          created_at
        ) VALUES (
          ${jobId},
          ${type},
          ${JSON.stringify(payload)},
          'pending',
          0,
          ${this.MAX_ATTEMPTS},
          ${scheduledAt},
          ${options.priority || 0},
          NOW()
        )
        ON CONFLICT (id) DO NOTHING
      `;
            logger.info({ jobId, type, scheduledAt }, 'Job added to queue');
            return jobId;
        }
        catch (error) {
            logger.error({ error, jobId, type }, 'Failed to add job');
            throw error;
        }
    }
    /**
     * Process pending jobs (called by cron or worker)
     */
    async processJobs(limit = 10) {
        const sql = getSql();
        let processed = 0;
        try {
            // Get pending jobs that are due
            const jobs = await sql `
        SELECT * FROM job_queue
        WHERE status = 'pending'
          AND scheduled_at <= NOW()
          AND attempts < max_attempts
        ORDER BY priority DESC, scheduled_at ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;
            for (const row of jobs) {
                const job = {
                    id: row.id,
                    type: row.type,
                    payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
                    status: row.status,
                    attempts: row.attempts,
                    maxAttempts: row.max_attempts,
                    lastError: row.last_error,
                    scheduledAt: new Date(row.scheduled_at),
                    startedAt: row.started_at ? new Date(row.started_at) : undefined,
                    completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
                    createdAt: new Date(row.created_at),
                };
                await this.processJob(job);
                processed++;
            }
            return processed;
        }
        catch (error) {
            logger.error({ error }, 'Failed to process jobs');
            return processed;
        }
    }
    /**
     * Process a single job
     */
    async processJob(job) {
        const sql = getSql();
        // Mark as processing
        await sql `
      UPDATE job_queue
      SET status = 'processing', started_at = NOW(), attempts = attempts + 1
      WHERE id = ${job.id}
    `;
        try {
            // Execute job based on type
            switch (job.type) {
                case 'award_xp':
                    await this.handleAwardXP(job.payload);
                    break;
                case 'process_payout':
                    await this.handleProcessPayout(job.payload);
                    break;
                case 'send_notification':
                    await this.handleSendNotification(job.payload);
                    break;
                case 'check_trust_upgrade':
                    await this.handleCheckTrustUpgrade(job.payload);
                    break;
                case 'expire_proofs':
                    await this.handleExpireProofs(job.payload);
                    break;
                case 'stripe_transfer':
                    await this.handleStripeTransfer(job.payload);
                    break;
                case 'trust_downgrade':
                    await this.handleTrustDowngrade(job.payload);
                    break;
                default:
                    throw new Error(`Unknown job type: ${job.type}`);
            }
            // Mark as completed
            await sql `
        UPDATE job_queue
        SET status = 'completed', completed_at = NOW()
        WHERE id = ${job.id}
      `;
            logger.info({ jobId: job.id, type: job.type }, 'Job completed');
        }
        catch (error) {
            // Mark as failed or dead
            const newStatus = job.attempts + 1 >= job.maxAttempts ? 'dead' : 'failed';
            const nextSchedule = new Date(Date.now() + this.calculateBackoff(job.attempts + 1));
            await sql `
        UPDATE job_queue
        SET 
          status = ${newStatus},
          last_error = ${error.message},
          scheduled_at = ${nextSchedule}
        WHERE id = ${job.id}
      `;
            logger.error({
                jobId: job.id,
                type: job.type,
                attempt: job.attempts + 1,
                error: error.message,
                newStatus,
            }, 'Job failed');
        }
    }
    /**
     * Calculate exponential backoff delay
     */
    calculateBackoff(attempt) {
        return this.BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
    }
    // ==========================================================================
    // JOB HANDLERS
    // ==========================================================================
    /**
     * Handle XP award job (idempotent via AtomicXPService)
     */
    async handleAwardXP(payload) {
        if (!payload.taskId || !payload.hustlerId) {
            throw new Error('Missing taskId or hustlerId for XP award');
        }
        const result = await awardXPForTask(payload.taskId, payload.hustlerId);
        if (!result.success && !result.alreadyAwarded) {
            throw new Error(result.error || 'XP award failed');
        }
        // If already awarded, that's fine - idempotent
        logger.info({
            taskId: payload.taskId,
            hustlerId: payload.hustlerId,
            xpAwarded: result.xpAwarded,
            alreadyAwarded: result.alreadyAwarded,
        }, 'XP award job processed');
    }
    /**
     * Handle payout processing
     */
    async handleProcessPayout(payload) {
        if (!payload.taskId) {
            throw new Error('Missing taskId for payout');
        }
        // Get escrow details
        const details = await EscrowStateMachine.getDetails(payload.taskId);
        if (!details) {
            throw new Error(`Escrow not found for task: ${payload.taskId}`);
        }
        if (details.state !== 'released') {
            throw new Error(`Cannot process payout for escrow in state: ${details.state}`);
        }
        // Stripe transfer handled separately in stripe_transfer job
        logger.info({ taskId: payload.taskId }, 'Payout job processed');
    }
    /**
     * Handle notification sending
     */
    async handleSendNotification(payload) {
        if (!payload.recipientId || !payload.notificationType) {
            throw new Error('Missing recipientId or notificationType');
        }
        // TODO: Integrate with notification service (Firebase, Expo, etc.)
        const sql = getSql();
        await sql `
      INSERT INTO notifications (
        user_id,
        type,
        title,
        body,
        data,
        read,
        created_at
      ) VALUES (
        ${payload.recipientId},
        ${payload.notificationType},
        ${payload.title || ''},
        ${payload.body || ''},
        ${JSON.stringify(payload.data || {})},
        false,
        NOW()
      )
    `;
        logger.info({ recipientId: payload.recipientId, type: payload.notificationType }, 'Notification sent');
    }
    /**
     * Handle trust upgrade check
     */
    async handleCheckTrustUpgrade(payload) {
        if (!payload.userId) {
            throw new Error('Missing userId for trust check');
        }
        await TrustTierService.checkUpgradeAfterCompletion(payload.userId);
    }
    /**
     * Handle proof expiration
     */
    async handleExpireProofs(payload) {
        const sql = getSql();
        // Find and expire old pending proofs
        const expired = await sql `
      UPDATE proof_submissions
      SET status = 'expired', updated_at = NOW()
      WHERE status = 'pending'
        AND expires_at < NOW()
      RETURNING id, task_id
    `;
        logger.info({ count: expired.length }, 'Proofs expired');
        // Queue notifications for expired proofs
        for (const proof of expired) {
            const [task] = await sql `
        SELECT assigned_to FROM tasks WHERE id = ${proof.task_id}
      `;
            if (task?.assigned_to) {
                await this.add('send_notification', {
                    recipientId: task.assigned_to,
                    notificationType: 'proof_expired',
                    title: 'Proof Expired',
                    body: 'Your submitted proof has expired. Please resubmit.',
                    data: { taskId: proof.task_id },
                });
            }
        }
    }
    /**
     * Handle Stripe transfer
     */
    async handleStripeTransfer(payload) {
        if (!payload.taskId) {
            throw new Error('Missing taskId for Stripe transfer');
        }
        // TODO: Integrate with Stripe service
        // This is where StripeMoneyEngine.initiateTransfer would be called
        logger.info({ taskId: payload.taskId }, 'Stripe transfer job processed');
    }
    /**
     * Handle trust downgrade
     */
    async handleTrustDowngrade(payload) {
        if (!payload.userId || !payload.trigger) {
            throw new Error('Missing userId or trigger for trust downgrade');
        }
        await TrustTierService.checkDowngrade(payload.userId, payload.trigger);
    }
    // ==========================================================================
    // UTILITY METHODS
    // ==========================================================================
    /**
     * Get job status
     */
    async getJob(jobId) {
        const sql = getSql();
        const [row] = await sql `
      SELECT * FROM job_queue WHERE id = ${jobId}
    `;
        if (!row)
            return null;
        return {
            id: row.id,
            type: row.type,
            payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
            status: row.status,
            attempts: row.attempts,
            maxAttempts: row.max_attempts,
            lastError: row.last_error,
            scheduledAt: new Date(row.scheduled_at),
            startedAt: row.started_at ? new Date(row.started_at) : undefined,
            completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
            createdAt: new Date(row.created_at),
        };
    }
    /**
     * Get queue statistics
     */
    async getStats() {
        const sql = getSql();
        const stats = await sql `
      SELECT 
        status,
        COUNT(*)::int as count
      FROM job_queue
      GROUP BY status
    `;
        const result = {
            pending: 0,
            processing: 0,
            completed: 0,
            failed: 0,
            dead: 0,
        };
        for (const row of stats) {
            if (row.status in result) {
                result[row.status] = row.count;
            }
        }
        return result;
    }
    /**
     * Retry failed jobs
     */
    async retryFailed(limit = 100) {
        const sql = getSql();
        const result = await sql `
      UPDATE job_queue
      SET status = 'pending', scheduled_at = NOW()
      WHERE status = 'failed'
        AND attempts < max_attempts
      LIMIT ${limit}
    `;
        return result.count || 0;
    }
    /**
     * Clean up old completed jobs
     */
    async cleanup(olderThanDays = 7) {
        const sql = getSql();
        const result = await sql `
      DELETE FROM job_queue
      WHERE status IN ('completed', 'dead')
        AND completed_at < NOW() - INTERVAL '${olderThanDays} days'
    `;
        return result.count || 0;
    }
}
export const JobQueue = new JobQueueClass();
//# sourceMappingURL=JobQueue.js.map