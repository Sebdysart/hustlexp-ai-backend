export declare class CompensationService {
    private static MAX_AUTO_DRIFT_CENTS;
    /**
     * PROPOSE COMPENSATION
     * Generates a transaction to fix the balance.
     */
    static proposeCompensation(accountId: string, driftAmount: number, // Positive = Ledger has MORE than Reality (Need to Credit Asset/Debit Liab to reduce?)
    isAsset: boolean): Promise<void>;
    private static getSystemDriftAccount;
}
//# sourceMappingURL=CompensationService.d.ts.map