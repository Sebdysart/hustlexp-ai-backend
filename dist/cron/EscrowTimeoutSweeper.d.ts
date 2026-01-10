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
interface TimeoutResult {
    escrowId: string;
    action: 'released' | 'refunded' | 'skipped';
    reason: string;
}
export declare class EscrowTimeoutSweeper {
    private static readonly TIMEOUT_HOURS;
    /**
     * RUN SWEEPER
     *
     * Called by cron. Finds and resolves timed-out escrows.
     */
    static run(options?: {
        stripeClient?: any;
    }): Promise<TimeoutResult[]>;
    /**
     * FIND STUCK ESCROWS
     */
    private static findStuckEscrows;
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
    private static resolveEscrow;
    /**
     * GET TASK STATE
     */
    private static getTaskState;
    /**
     * GET REFUND REASON
     */
    private static getRefundReason;
    /**
     * EXECUTE RELEASE (to hustler)
     */
    private static executeRelease;
    /**
     * EXECUTE REFUND (to poster)
     */
    /**
     * EXECUTE REFUND (to poster)
     */
    private static executeRefund;
    /**
     * NOTIFY USERS
     */
    private static notifyUsers;
}
export {};
//# sourceMappingURL=EscrowTimeoutSweeper.d.ts.map