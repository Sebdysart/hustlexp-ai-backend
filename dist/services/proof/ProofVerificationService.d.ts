import type { ProofMetadata } from './types.js';
interface VerificationDecision {
    action: 'verify' | 'reject' | 'escalate';
    reason: string;
    confidence: number;
    requiresReview: boolean;
}
export declare class ProofVerificationService {
    /**
     * Analyze and decide on proof submission
     */
    static analyzeAndDecide(submissionId: string, fileUrl: string, mimeType: string, metadata: ProofMetadata): Promise<{
        success: boolean;
        decision?: VerificationDecision;
        error?: string;
    }>;
    /**
     * Make verification decision based on forensics
     */
    private static makeDecision;
    /**
     * Admin override verification decision
     */
    static adminOverride(submissionId: string, adminId: string, decision: 'verify' | 'reject', reason: string): Promise<{
        success: boolean;
        error?: string;
    }>;
    /**
     * Get submissions pending review
     */
    static getPendingReviews(): Promise<any[]>;
}
export {};
//# sourceMappingURL=ProofVerificationService.d.ts.map