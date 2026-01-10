/**
 * PAYOUT ELIGIBILITY RESOLVER (Phase 12C)
 *
 * Single source of truth for payout eligibility.
 *
 * INVARIANT: Money cannot move unless the task is in a provably safe state.
 *
 * Inputs:
 * - Task state
 * - Proof state
 * - Dispute state
 * - KillSwitch state
 *
 * Output:
 * - ALLOW | BLOCK | ESCALATE (with reason)
 */
import { ProofState } from './proof/types.js';
export declare enum PayoutDecision {
    ALLOW = "ALLOW",
    BLOCK = "BLOCK",
    ESCALATE = "ESCALATE"
}
export declare enum BlockReason {
    KILLSWITCH_ACTIVE = "KILLSWITCH_ACTIVE",
    TASK_NOT_FOUND = "TASK_NOT_FOUND",
    TASK_NOT_COMPLETED = "TASK_NOT_COMPLETED",
    PROOF_PENDING = "PROOF_PENDING",
    PROOF_REJECTED = "PROOF_REJECTED",
    PROOF_REQUESTED = "PROOF_REQUESTED",
    PROOF_ANALYZING = "PROOF_ANALYZING",
    PROOF_ESCALATED = "PROOF_ESCALATED",
    DISPUTE_ACTIVE = "DISPUTE_ACTIVE",
    MONEY_STATE_INVALID = "MONEY_STATE_INVALID",
    ADMIN_OVERRIDE_REQUIRED = "ADMIN_OVERRIDE_REQUIRED"
}
export interface EligibilityResult {
    decision: PayoutDecision;
    reason?: string;
    blockReason?: BlockReason;
    details: {
        taskState?: string;
        proofState?: ProofState | null;
        hasValidProof?: boolean;
        disputeActive?: boolean;
        killSwitchActive?: boolean;
        moneyState?: string;
        adminOverride?: boolean;
    };
    evaluatedAt: Date;
    evaluationId: string;
}
export interface AdminOverride {
    enabled: boolean;
    adminId: string;
    reason: string;
    expiresAt?: Date;
}
export declare class PayoutEligibilityResolver {
    /**
     * RESOLVE PAYOUT ELIGIBILITY
     *
     * This is the ONLY function that determines if a payout can proceed.
     * StripeMoneyEngine MUST call this before every payout operation.
     */
    static resolve(taskId: string, options?: {
        adminOverride?: AdminOverride;
    }): Promise<EligibilityResult>;
    /**
     * LOG DECISION TO AUDIT TRAIL
     * Every eligibility decision is recorded for forensics.
     */
    private static logDecision;
    /**
     * CHECK ADMIN OVERRIDE VALIDITY
     * Validates an admin override before it can be used.
     */
    static validateAdminOverride(override: AdminOverride): {
        valid: boolean;
        error?: string;
    };
}
//# sourceMappingURL=PayoutEligibilityResolver.d.ts.map