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
interface RecoveryResult {
    taskId: string;
    action: 'committed' | 'failed' | 'escalated' | 'skipped';
    reason: string;
}
export declare class SagaRecoverySweeper {
    private static readonly STUCK_THRESHOLD_MINUTES;
    private static readonly MAX_RECOVERY_ATTEMPTS;
    /**
     * RUN SWEEPER
     *
     * Called by cron. Finds and recovers stuck sagas.
     */
    static run(options?: {
        stripeClient?: any;
    }): Promise<RecoveryResult[]>;
    /**
     * FIND STUCK SAGAS
     */
    private static findStuckSagas;
    /**
     * RECOVER SINGLE SAGA
     *
     * Ledger-first recovery (STRICT ORDER):
     * 1. Check money_events_audit for outbound intent
     * 2. Check Stripe ONLY if outbound exists
     * 3. Commit or fail based on evidence
     */
    private static recoverSaga;
    /**
     * GET OUTBOUND INTENT FROM AUDIT LOG
     */
    private static getOutboundIntent;
    /**
     * QUERY STRIPE STATUS
     */
    private static queryStripe;
    /**
     * MARK COMMITTED
     */
    private static markCommitted;
    /**
     * MARK FAILED
     */
    private static markFailed;
    /**
     * INCREMENT RECOVERY ATTEMPTS
     */
    private static incrementRecoveryAttempts;
}
export {};
//# sourceMappingURL=SagaRecoverySweeper.d.ts.map