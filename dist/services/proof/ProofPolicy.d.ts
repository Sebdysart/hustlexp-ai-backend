/**
 * PROOF POLICY
 *
 * Guardrails for AI proof requests.
 * AI cannot freestyle - must pass policy checks.
 */
import { ProofType, ProofReason } from './types.js';
interface ProofPolicyCheck {
    allowed: boolean;
    reason?: string;
}
interface TaskContext {
    id: string;
    category: string;
    status: string;
    price: number;
    riskScore?: number;
    posterTrustTier?: number;
    hustlerTrustTier?: number;
}
interface UserContext {
    id: string;
    trustTier: number;
    proofRequestsToday: number;
    disputeRate: number;
}
export declare class ProofPolicy {
    /**
     * Check if AI can request proof for this task
     */
    static canRequestProof(task: TaskContext, user: UserContext, proofType: ProofType, reason: ProofReason, existingProofCount: number): ProofPolicyCheck;
    /**
     * Determine if proof should be auto-required for task
     */
    static isProofRequired(task: TaskContext, hustler: UserContext): boolean;
    /**
     * Get recommended proof type for task category
     */
    static getRecommendedProofType(category: string, reason: ProofReason): ProofType;
    /**
     * Generate proof instructions based on context
     */
    static generateInstructions(category: string, reason: ProofReason, proofType: ProofType): string;
}
export {};
//# sourceMappingURL=ProofPolicy.d.ts.map