/**
 * JOB WORKER (BUILD_GUIDE Phase 4)
 *
 * Background worker for processing queued jobs.
 * Can be run as:
 * - Cron job (every minute)
 * - Standalone worker (continuous)
 * - API endpoint (on-demand)
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
import { JobQueue } from '../services/JobQueue.js';
import { createLogger } from '../utils/logger.js';
const logger = createLogger('JobWorker');
// ============================================================================
// WORKER CONFIGURATION
// ============================================================================
const BATCH_SIZE = 10;
const POLL_INTERVAL_MS = 5000; // 5 seconds
const CLEANUP_INTERVAL_MS = 3600000; // 1 hour
// ============================================================================
// WORKER CLASS
// ============================================================================
class JobWorkerClass {
    running = false;
    pollTimer;
    cleanupTimer;
    /**
     * Start the worker (continuous polling)
     */
    async start() {
        if (this.running) {
            logger.warn('Worker already running');
            return;
        }
        this.running = true;
        logger.info('Job worker starting...');
        // Start polling
        await this.poll();
        this.pollTimer = setInterval(() => this.poll(), POLL_INTERVAL_MS);
        // Start cleanup timer
        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
        logger.info({
            batchSize: BATCH_SIZE,
            pollInterval: POLL_INTERVAL_MS,
        }, 'Job worker started');
    }
    /**
     * Stop the worker
     */
    stop() {
        this.running = false;
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = undefined;
        }
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = undefined;
        }
        logger.info('Job worker stopped');
    }
    /**
     * Poll for and process jobs
     */
    async poll() {
        try {
            const processed = await JobQueue.processJobs(BATCH_SIZE);
            if (processed > 0) {
                logger.info({ processed }, 'Processed jobs');
            }
            return processed;
        }
        catch (error) {
            logger.error({ error: error.message }, 'Poll error');
            return 0;
        }
    }
    /**
     * Clean up old jobs
     */
    async cleanup() {
        try {
            const deleted = await JobQueue.cleanup(7);
            if (deleted > 0) {
                logger.info({ deleted }, 'Cleaned up old jobs');
            }
        }
        catch (error) {
            logger.error({ error: error.message }, 'Cleanup error');
        }
    }
    /**
     * Get worker status
     */
    getStatus() {
        return {
            running: this.running,
            pollInterval: POLL_INTERVAL_MS,
            batchSize: BATCH_SIZE,
        };
    }
}
export const JobWorker = new JobWorkerClass();
// ============================================================================
// STANDALONE WORKER SCRIPT
// ============================================================================
// Run as standalone if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    logger.info('Starting standalone job worker...');
    JobWorker.start().catch((error) => {
        logger.error({ error }, 'Failed to start worker');
        process.exit(1);
    });
    // Graceful shutdown
    process.on('SIGTERM', () => {
        logger.info('SIGTERM received, shutting down...');
        JobWorker.stop();
        process.exit(0);
    });
    process.on('SIGINT', () => {
        logger.info('SIGINT received, shutting down...');
        JobWorker.stop();
        process.exit(0);
    });
}
//# sourceMappingURL=JobWorker.js.map