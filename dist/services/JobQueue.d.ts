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
export type JobType = 'award_xp' | 'process_payout' | 'send_notification' | 'check_trust_upgrade' | 'expire_proofs' | 'stripe_transfer' | 'trust_downgrade';
export type JobStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
export interface JobPayload {
    taskId?: string;
    hustlerId?: string;
    escrowId?: string;
    userId?: string;
    amountCents?: number;
    stripeTransferId?: string;
    recipientId?: string;
    notificationType?: string;
    title?: string;
    body?: string;
    data?: Record<string, any>;
    trigger?: string;
    [key: string]: any;
}
export interface Job {
    id: string;
    type: JobType;
    payload: JobPayload;
    status: JobStatus;
    attempts: number;
    maxAttempts: number;
    lastError?: string;
    scheduledAt: Date;
    startedAt?: Date;
    completedAt?: Date;
    createdAt: Date;
}
declare class JobQueueClass {
    private readonly MAX_ATTEMPTS;
    private readonly BACKOFF_BASE_MS;
    /**
     * Add a job to the queue
     */
    add(type: JobType, payload: JobPayload, options?: {
        jobId?: string;
        delay?: number;
        priority?: number;
    }): Promise<string>;
    /**
     * Process pending jobs (called by cron or worker)
     */
    processJobs(limit?: number): Promise<number>;
    /**
     * Process a single job
     */
    private processJob;
    /**
     * Calculate exponential backoff delay
     */
    private calculateBackoff;
    /**
     * Handle XP award job (idempotent via AtomicXPService)
     */
    private handleAwardXP;
    /**
     * Handle payout processing
     */
    private handleProcessPayout;
    /**
     * Handle notification sending
     */
    private handleSendNotification;
    /**
     * Handle trust upgrade check
     */
    private handleCheckTrustUpgrade;
    /**
     * Handle proof expiration
     */
    private handleExpireProofs;
    /**
     * Handle Stripe transfer
     */
    private handleStripeTransfer;
    /**
     * Handle trust downgrade
     */
    private handleTrustDowngrade;
    /**
     * Get job status
     */
    getJob(jobId: string): Promise<Job | null>;
    /**
     * Get queue statistics
     */
    getStats(): Promise<{
        pending: number;
        processing: number;
        completed: number;
        failed: number;
        dead: number;
    }>;
    /**
     * Retry failed jobs
     */
    retryFailed(limit?: number): Promise<number>;
    /**
     * Clean up old completed jobs
     */
    cleanup(olderThanDays?: number): Promise<number>;
}
export declare const JobQueue: JobQueueClass;
export {};
//# sourceMappingURL=JobQueue.d.ts.map