export interface CreateDisputeDTO {
    taskId: string;
    posterUid: string;
    reason: string;
}
export interface DisputeResult {
    success: boolean;
    message: string;
    disputeId?: string;
    status?: string;
}
export declare enum DisputeStatus {
    PENDING = "pending",
    UNDER_REVIEW = "under_review",
    REFUNDED = "refunded",
    UPHELD = "upheld"
}
export declare class DisputeServiceClass {
    /**
     * Create a new dispute (Poster Only)
     * Enforces: One dispute per task, Task must exist, Poster must own task
     */
    createDispute(data: CreateDisputeDTO): Promise<DisputeResult>;
    /**
     * Attach evidence (Poster Only per spec, but logically both could?)
     * Spec: "attachEvidence(disputeId, posterUid, files | urls)"
     */
    addEvidence(disputeId: string, userUid: string, urls: string[]): Promise<DisputeResult>;
    /**
     * Hustler Response
     */
    submitResponse(disputeId: string, hustlerUid: string, message: string): Promise<DisputeResult>;
    /**
     * Admin: Resolve Refund
     * Atomic Saga: Lock Dispute -> Call StripeService -> Finalize
     */
    resolveRefund(disputeId: string, adminId: string): Promise<DisputeResult>;
    /**
     * Admin: Resolve Uphold (Payout to Hustler)
     */
    resolveUphold(disputeId: string, adminId: string): Promise<DisputeResult>;
    /**
     * Safety: Add Strike
     */
    addStrike(userUid: string, reason: string, severity: number, source: 'ai' | 'manual', meta?: {
        taskId?: string;
    }): Promise<void>;
    /**
     * Safety: Check Suspension
     */
    isUserSuspended(userUid: string): Promise<{
        suspended: boolean;
        reason?: string;
    }>;
    /**
     * Compatibility Methods for Index.ts
     */
    listDisputes(filters: any): Promise<Record<string, any>[]>;
    getStats(): Promise<{
        total: number;
    }>;
    getDispute(id: string): Promise<Record<string, any>>;
    getUserStrikes(uid: string): Promise<Record<string, any>[]>;
    submitHustlerResponse(disputeId: string, hustlerId: string, message: string): Promise<DisputeResult>;
    resolveDispute(disputeId: string, adminId: string, resolution: 'refund' | 'payout' | 'split', meta?: any): Promise<DisputeResult>;
    unsuspendUser(uid: string): Promise<{
        success: boolean;
        message?: undefined;
    } | {
        success: boolean;
        message: string;
    }>;
}
export declare const DisputeService: DisputeServiceClass;
//# sourceMappingURL=DisputeService.d.ts.map