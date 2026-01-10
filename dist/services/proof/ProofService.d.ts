import { ProofState, ProofType, ProofReason, type ForensicsResult } from './types.js';
export declare class ProofService {
    /**
     * Create a proof request
     */
    static createRequest(params: {
        taskId: string;
        proofType: ProofType;
        reason: ProofReason;
        requestedBy: 'ai' | 'system' | 'poster';
        instructions: string;
        deadlineHours?: number;
    }): Promise<{
        success: boolean;
        requestId?: string;
        error?: string;
    }>;
    /**
     * Submit proof for a request
     * HARDENED: Checks for hash reuse across tasks
     */
    static submitProof(params: {
        requestId: string;
        submittedBy: string;
        fileUrl: string;
        fileHash: string;
        mimeType: string;
        fileSize: number;
        metadata: Record<string, any>;
    }): Promise<{
        success: boolean;
        submissionId?: string;
        error?: string;
        escalated?: boolean;
    }>;
    /**
     * Record forensics analysis result
     */
    static recordForensicsResult(submissionId: string, result: ForensicsResult): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Verify or reject proof (system/admin decision)
     */
    static finalizeProof(submissionId: string, decision: 'verified' | 'rejected' | 'escalated', actor: string, actorType: 'system' | 'admin', reason?: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Lock proof (make immutable)
     */
    static lockProof(submissionId: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Get proof status for task
     */
    static getTaskProofStatus(taskId: string): Promise<{
        requests: any[];
        submissions: any[];
        currentState: ProofState;
    }>;
    /**
     * Log proof event (immutable audit trail)
     */
    private static logEvent;
}
//# sourceMappingURL=ProofService.d.ts.map