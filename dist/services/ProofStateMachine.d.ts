/**
 * PROOF STATE MACHINE (BUILD_GUIDE Phase 2)
 *
 * Implements the proof lifecycle state machine from BUILD_GUIDE.
 *
 * STATES:
 * - PENDING: Proof submitted, awaiting review
 * - REVIEWING: AI or admin reviewing proof
 * - ACCEPTED: Proof approved (terminal for this proof)
 * - REJECTED: Proof rejected, can resubmit
 * - EXPIRED: Review window passed (terminal)
 *
 * INVARIANTS ENFORCED:
 * - INV-3: Task COMPLETED requires ACCEPTED proof
 * - Only one active proof per task
 * - Rejection allows resubmission
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
export type ProofState = 'pending' | 'reviewing' | 'accepted' | 'rejected' | 'expired';
export declare const TERMINAL_PROOF_STATES: ProofState[];
export interface ProofTransitionContext {
    reviewerId?: string;
    aiScore?: number;
    rejectionReason?: string;
    photoUrls?: string[];
}
export interface ProofTransitionResult {
    success: boolean;
    previousState: ProofState;
    newState: ProofState;
    proofId?: string;
    error?: string;
}
export declare const PROOF_TRANSITIONS: Record<ProofState, ProofState[]>;
export type ProofQuality = 'BASIC' | 'STANDARD' | 'COMPREHENSIVE';
export declare function calculateProofQuality(proof: {
    description?: string;
    photoUrls?: string[];
    hasBeforeAfter?: boolean;
}): ProofQuality;
declare class ProofStateMachineClass {
    /**
     * Check if a transition is valid
     */
    canTransition(from: ProofState, to: ProofState): boolean;
    /**
     * Submit new proof for a task
     */
    submit(taskId: string, hustlerId: string, data: {
        description?: string;
        photoUrls?: string[];
    }): Promise<ProofTransitionResult>;
    /**
     * Transition proof to a new state
     */
    transition(proofId: string, targetState: ProofState, context?: ProofTransitionContext): Promise<ProofTransitionResult>;
    /**
     * Accept a proof
     */
    accept(proofId: string, reviewerId?: string): Promise<ProofTransitionResult>;
    /**
     * Reject a proof
     */
    reject(proofId: string, reason: string, reviewerId?: string): Promise<ProofTransitionResult>;
    /**
     * Get current proof state for a task
     */
    getTaskProofState(taskId: string): Promise<{
        proofId: string;
        state: ProofState;
        quality: ProofQuality;
        photoUrls: string[];
        rejectionReason?: string;
        expiresAt?: Date;
    } | null>;
    /**
     * Check if task has accepted proof (INV-3 helper)
     */
    hasAcceptedProof(taskId: string): Promise<boolean>;
}
export declare const ProofStateMachine: ProofStateMachineClass;
export {};
//# sourceMappingURL=ProofStateMachine.d.ts.map