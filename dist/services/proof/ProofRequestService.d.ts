import { ProofType, ProofReason } from './types.js';
interface AIProofRequestParams {
    taskId: string;
    proofType?: ProofType;
    reason: ProofReason;
    customInstructions?: string;
    deadlineHours?: number;
}
export declare class ProofRequestService {
    /**
     * AI requests proof for task
     * Enforces policy guardrails
     */
    static aiRequestProof(params: AIProofRequestParams): Promise<{
        success: boolean;
        requestId?: string;
        error?: string;
    }>;
    /**
     * System auto-requests proof based on task attributes
     */
    static autoRequestIfRequired(taskId: string): Promise<{
        required: boolean;
        requestId?: string;
    }>;
    /**
     * Get pending proof requests for task
     */
    static getPendingRequests(taskId: string): Promise<any[]>;
}
export {};
//# sourceMappingURL=ProofRequestService.d.ts.map