export declare class ReplayGuard {
    /**
     * IS DUPLICATE?
     * Returns TRUE if this is a replay (should skip).
     * Returns FALSE if this is new (safe to process).
     */
    static isDuplicate(eventId: string, stripeId?: string): Promise<boolean>;
    /**
     * RECORD ATTEMPT
     * Logs the attempt to the audit table regardless of success.
     */
    static logAttempt(eventId: string, type: string, payload: any): Promise<void>;
}
//# sourceMappingURL=ReplayGuard.d.ts.map