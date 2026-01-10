export declare class BackfillService {
    /**
     * BACKFILL MISSING STRIPE EVENTS
     * Scans `stripe_balance_history` for IDs not present as `idempotency_key` in `ledger_transactions`.
     */
    static scanAndBackfill(): Promise<void>;
    private static backfillItem;
}
//# sourceMappingURL=BackfillService.d.ts.map