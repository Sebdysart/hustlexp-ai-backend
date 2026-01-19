/**
 * OMEGA SWEEPERS (Background Invariant Enforcement)
 */
export declare class OmegaSweepers {
    private static stripe;
    static init(): void;
    /**
     * Start all background sweepers.
     */
    static start(): void;
    /**
     * CONTROL PLANE: Generate Analysis Snapshot
     * Creates immutable snapshot for offline AI analysis
     */
    static generateSnapshot(type: 'hourly' | 'daily' | 'manual'): Promise<void>;
    /**
     * POINT 12: SAGA TIMEOUT INVARIANT
     * Auto-fail Sagas stuck in PENDING/EXECUTING > X seconds.
     */
    static sweepStuckSagas(): Promise<void>;
    /**
     * POINT 14: REALITY MIRROR BACKFILL
     * Audit Stripe vs DB Consistency (30 Day Window).
     */
    static backfillRealityMirror(): Promise<void>;
}
//# sourceMappingURL=omega_sweepers.d.ts.map