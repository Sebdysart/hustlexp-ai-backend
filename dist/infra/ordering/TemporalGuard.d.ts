export declare class TemporalGuard {
    /**
     * VALIDATE SEQUENCE
     * Returns TRUE if safe to proceed.
     * Returns FALSE if event is stale/older than current state (Time Travel).
     */
    static validateSequence(targetId: string, eventId: string): Promise<boolean>;
}
//# sourceMappingURL=TemporalGuard.d.ts.map