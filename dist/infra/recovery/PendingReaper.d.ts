/**
 * PENDING TRANSACTION REAPER
 *
 * Formalizes the state machine by ensuring every ledger intent reaches a terminal state.
 *
 * Trigger conditions:
 * - ledger_transactions.status = 'pending'
 * - created_at < now() - INTERVAL 'X minutes' (default: 5 minutes)
 * - NO matching record in stripe_outbound_log
 *
 * Action:
 * - Transition -> 'failed'
 * - Record reason: 'crash_pre_execute'
 * - Emit audit log
 * - Do NOT touch balances (none exist for pre-execute crashes)
 */
export declare class PendingTransactionReaper {
    /**
     * Scan and reap orphaned pending transactions.
     * Should run on startup and periodically via RecoveryEngine.
     */
    static reap(): Promise<{
        reaped: number;
        transactions: string[];
    }>;
    /**
     * Get count of pending transactions (for monitoring)
     */
    static getPendingCount(): Promise<number>;
    /**
     * Recover pending transactions that HAVE Stripe success evidence.
     * These should be COMMITTED, not failed.
     */
    static recoverStripeCommitted(): Promise<{
        recovered: number;
        transactions: string[];
    }>;
}
//# sourceMappingURL=PendingReaper.d.ts.map