/**
 * PAYOUT EXPLAINER (Phase 13A)
 *
 * User-facing explanations for payout states.
 *
 * RULE: No raw errors. No internal jargon. No confusion.
 *
 * This is the translation layer between:
 * - Internal: PayoutDecision, BlockReason
 * - External: Human-readable status, actionable hints
 */
import { EligibilityResult } from './PayoutEligibilityResolver.js';
import { ProofState } from './proof/types.js';
export declare enum UserPayoutState {
    READY = "ready",// Can be paid
    AWAITING_PROOF = "awaiting_proof",
    PROOF_REVIEWING = "proof_reviewing",
    PROOF_ISSUE = "proof_issue",
    DISPUTE_PENDING = "dispute_pending",
    UNDER_REVIEW = "under_review",
    COMPLETED = "completed",
    BLOCKED = "blocked"
}
export interface PayoutExplanation {
    state: UserPayoutState;
    title: string;
    message: string;
    icon: 'clock' | 'camera' | 'alert' | 'check' | 'help' | 'lock';
    color: 'green' | 'yellow' | 'orange' | 'red' | 'blue' | 'gray';
    actions: UserAction[];
    estimatedWait?: string;
}
export interface UserAction {
    id: string;
    label: string;
    type: 'primary' | 'secondary' | 'link';
    route?: string;
    disabled?: boolean;
    disabledReason?: string;
}
export declare class PayoutExplainer {
    /**
     * Convert internal eligibility result to user-facing explanation
     */
    static explain(result: EligibilityResult, context?: {
        taskTitle?: string;
        hustlerName?: string;
        amountCents?: number;
    }): PayoutExplanation;
    /**
     * Explain BLOCK decisions
     */
    private static explainBlock;
    /**
     * Explain ESCALATE decisions
     */
    private static explainEscalation;
    /**
     * Get proof-specific explanation for UI
     */
    static explainProofState(proofState: ProofState | null): {
        status: string;
        description: string;
        actionNeeded: boolean;
    };
    /**
     * Get a short status for list views
     */
    static getShortStatus(result: EligibilityResult): {
        label: string;
        color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
    };
}
//# sourceMappingURL=PayoutExplainer.d.ts.map