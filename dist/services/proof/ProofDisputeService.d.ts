export declare class ProofDisputeService {
    /**
     * Snapshot proof state when dispute is opened
     * Creates immutable record attached to dispute
     */
    static snapshotForDispute(disputeId: string, taskId: string): Promise<{
        success: boolean;
        snapshotId?: string;
        error?: string;
    }>;
    /**
     * Get proof snapshot for dispute
     */
    static getDisputeSnapshot(disputeId: string): Promise<any | null>;
    /**
     * Check if proof is locked due to dispute
     */
    static isLockedByDispute(taskId: string): Promise<boolean>;
}
//# sourceMappingURL=ProofDisputeService.d.ts.map