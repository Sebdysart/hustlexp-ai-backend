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
declare class JobWorkerClass {
    private running;
    private pollTimer?;
    private cleanupTimer?;
    /**
     * Start the worker (continuous polling)
     */
    start(): Promise<void>;
    /**
     * Stop the worker
     */
    stop(): void;
    /**
     * Poll for and process jobs
     */
    poll(): Promise<number>;
    /**
     * Clean up old jobs
     */
    cleanup(): Promise<void>;
    /**
     * Get worker status
     */
    getStatus(): {
        running: boolean;
        pollInterval: number;
        batchSize: number;
    };
}
export declare const JobWorker: JobWorkerClass;
export {};
//# sourceMappingURL=JobWorker.d.ts.map