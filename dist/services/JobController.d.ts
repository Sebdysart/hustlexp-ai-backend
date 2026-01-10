/**
 * Job Controller - Phase E
 *
 * Background jobs for:
 * - Daily maintenance (streaks, quests, metrics)
 * - Weekly maintenance (recaps, weekly metrics)
 * - Hourly health checks
 */
export interface DailyMetricsSnapshot {
    id: string;
    date: string;
    cityId: string;
    tasksCreated: number;
    tasksAccepted: number;
    tasksCompleted: number;
    tasksCancelled: number;
    disputesOpened: number;
    disputesResolved: number;
    completionRate: number;
    gmvUsd: number;
    platformRevenueUsd: number;
    aiCostUsd: number;
    activeHustlers: number;
    activePosters: number;
    createdAt: Date;
}
export interface WeeklyMetricsSnapshot {
    id: string;
    weekStartDate: string;
    cityId: string;
    tasksCreated: number;
    tasksCompleted: number;
    disputesOpened: number;
    disputesResolved: number;
    completionRate: number;
    gmvUsd: number;
    platformRevenueUsd: number;
    aiCostUsd: number;
    newUsers: number;
    activeUsers: number;
    createdAt: Date;
}
export interface JobResult {
    success: boolean;
    jobName: string;
    executedAt: Date;
    durationMs: number;
    message: string;
    details?: Record<string, unknown>;
}
declare class JobControllerClass {
    /**
     * Run daily maintenance job
     * Called once per day (night)
     */
    runDailyMaintenance(): Promise<JobResult>;
    /**
     * Create a daily metrics snapshot
     */
    private createDailySnapshot;
    /**
     * Run weekly maintenance job
     * Called once per week
     */
    runWeeklyMaintenance(): Promise<JobResult>;
    /**
     * Create a weekly metrics snapshot
     */
    private createWeeklySnapshot;
    /**
     * Run hourly health check
     * Called every hour
     */
    runHourlyHealth(): Promise<JobResult>;
    /**
     * Get daily metrics snapshots
     */
    getDailySnapshots(options?: {
        cityId?: string;
        limit?: number;
    }): DailyMetricsSnapshot[];
    /**
     * Get weekly metrics snapshots
     */
    getWeeklySnapshots(options?: {
        cityId?: string;
        limit?: number;
    }): WeeklyMetricsSnapshot[];
    /**
     * Get job history
     */
    getJobHistory(limit?: number): JobResult[];
    /**
     * Get sample daily metrics row
     */
    getSampleDailyMetricsRow(): DailyMetricsSnapshot;
}
export declare const JobController: JobControllerClass;
export {};
//# sourceMappingURL=JobController.d.ts.map