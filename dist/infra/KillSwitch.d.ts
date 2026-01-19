export type KillSwitchReason = 'LEDGER_DRIFT' | 'STRIPE_OUTAGE' | 'IDENTITY_FRAUD_SPIKE' | 'MANUAL_OVERRIDE' | 'SAGA_RETRY_EXHAUSTION' | 'TEST_SIMULATION';
export declare class KillSwitch {
    private static redis;
    private static localState;
    private static reason;
    private static REDIS_KEY;
    static initialize(): void;
    /**
     * IS SYSTEM FROZEN?
     * @returns true if payouts/money should STOP.
     */
    static isActive(): Promise<boolean>;
    /**
     * TRIGGER THE KILL SWITCH
     * Stops everything.
     */
    static trigger(reason: KillSwitchReason, metadata?: any): Promise<void>;
    /**
     * RESET (Admin Only)
     */
    static resolve(): Promise<void>;
    /**
     * CHECK SPECIFIC GATES
     */
    static checkGate(gate: 'PAYOUTS' | 'ESCROW_RELEASE' | 'NEW_TASKS'): Promise<boolean>;
}
//# sourceMappingURL=KillSwitch.d.ts.map