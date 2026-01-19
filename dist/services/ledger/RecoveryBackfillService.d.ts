/**
 * RECOVERY BACKFILL SERVICE (The Time Machine)
 *
 * Rebuilds internal state from Stripe Truth.
 * Used when DB is corrupted, restored from old backup, or major drift occurred.
 */
export declare class RecoveryBackfillService {
    /**
     * Reconcile a single Task's financial state
     */
    static backfillTask(taskId: string): Promise<void>;
}
//# sourceMappingURL=RecoveryBackfillService.d.ts.map