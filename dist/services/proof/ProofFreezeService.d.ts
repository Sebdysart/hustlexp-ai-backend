import { ProofState } from './types.js';
export declare class ProofFreezeService {
    /**
     * Set freeze state on task when proof is requested
     */
    static setFreezeState(taskId: string, state: 'AWAITING_PROOF' | 'PROOF_VERIFIED' | null): Promise<void>;
    /**
     * Check if payout is blocked by proof state
     * This is the READ-ONLY dependency between proof and money
     */
    static isPayoutBlocked(taskId: string): Promise<{
        blocked: boolean;
        reason?: string;
    }>;
    /**
     * Get canonical proof truth for task
     * Single source of truth for "has valid evidence"
     */
    static getProofTruth(taskId: string): Promise<{
        hasValidProof: boolean;
        proofState: ProofState | null;
        submissionId?: string;
        verifiedAt?: Date;
    }>;
}
//# sourceMappingURL=ProofFreezeService.d.ts.map