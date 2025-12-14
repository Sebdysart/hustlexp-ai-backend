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

import { PayoutDecision, BlockReason, EligibilityResult } from './PayoutEligibilityResolver.js';
import { ProofState } from './proof/types.js';

// ============================================================
// USER-FACING STATES (What the UI shows)
// ============================================================

export enum UserPayoutState {
    READY = 'ready',              // Can be paid
    AWAITING_PROOF = 'awaiting_proof',
    PROOF_REVIEWING = 'proof_reviewing',
    PROOF_ISSUE = 'proof_issue',
    DISPUTE_PENDING = 'dispute_pending',
    UNDER_REVIEW = 'under_review',
    COMPLETED = 'completed',
    BLOCKED = 'blocked'
}

// ============================================================
// USER-FACING EXPLANATION
// ============================================================

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

// ============================================================
// EXPLAINER SERVICE
// ============================================================

export class PayoutExplainer {

    /**
     * Convert internal eligibility result to user-facing explanation
     */
    static explain(result: EligibilityResult, context?: {
        taskTitle?: string;
        hustlerName?: string;
        amountCents?: number;
    }): PayoutExplanation {

        const amount = context?.amountCents
            ? `$${(context.amountCents / 100).toFixed(2)}`
            : 'your payment';

        // ALLOW → Ready for payout
        if (result.decision === PayoutDecision.ALLOW) {
            return {
                state: UserPayoutState.READY,
                title: 'Payment Ready',
                message: `${amount} has been verified and is being processed. You'll receive it within 1-2 business days.`,
                icon: 'check',
                color: 'green',
                actions: [
                    { id: 'view_earnings', label: 'View Earnings', type: 'primary', route: '/earnings' }
                ],
                estimatedWait: '1-2 business days'
            };
        }

        // ESCALATE → Under human review
        if (result.decision === PayoutDecision.ESCALATE) {
            return this.explainEscalation(result, amount);
        }

        // BLOCK → Specific reason
        return this.explainBlock(result, amount);
    }

    /**
     * Explain BLOCK decisions
     */
    private static explainBlock(result: EligibilityResult, amount: string): PayoutExplanation {
        switch (result.blockReason) {

            case BlockReason.KILLSWITCH_ACTIVE:
                return {
                    state: UserPayoutState.BLOCKED,
                    title: 'Payments Temporarily Paused',
                    message: 'We\'re performing system maintenance. All payments are safe and will resume shortly.',
                    icon: 'lock',
                    color: 'orange',
                    actions: [
                        { id: 'check_status', label: 'Check Status', type: 'secondary', route: '/status' }
                    ],
                    estimatedWait: 'Usually under 1 hour'
                };

            case BlockReason.PROOF_PENDING:
            case BlockReason.PROOF_REQUESTED:
                return {
                    state: UserPayoutState.AWAITING_PROOF,
                    title: 'Completion Photo Needed',
                    message: `Please submit a photo of the completed task to receive ${amount}.`,
                    icon: 'camera',
                    color: 'yellow',
                    actions: [
                        { id: 'submit_proof', label: 'Submit Photo', type: 'primary', route: '/proof/submit' },
                        { id: 'help', label: 'Need Help?', type: 'link', route: '/help/proof' }
                    ]
                };

            case BlockReason.PROOF_ANALYZING:
                return {
                    state: UserPayoutState.PROOF_REVIEWING,
                    title: 'Verifying Your Photo',
                    message: 'We\'re reviewing your completion photo. This usually takes just a few minutes.',
                    icon: 'clock',
                    color: 'blue',
                    actions: [],
                    estimatedWait: '5-10 minutes'
                };

            case BlockReason.PROOF_REJECTED:
                return {
                    state: UserPayoutState.PROOF_ISSUE,
                    title: 'Photo Issue',
                    message: 'The photo you submitted couldn\'t be verified. Please submit a new photo showing the completed work.',
                    icon: 'alert',
                    color: 'orange',
                    actions: [
                        { id: 'submit_new_proof', label: 'Submit New Photo', type: 'primary', route: '/proof/submit' },
                        { id: 'contact_support', label: 'Contact Support', type: 'secondary', route: '/support' }
                    ]
                };

            case BlockReason.PROOF_ESCALATED:
                return {
                    state: UserPayoutState.UNDER_REVIEW,
                    title: 'Additional Review Needed',
                    message: 'Your submission needs manual review. Our team will verify within 24 hours.',
                    icon: 'clock',
                    color: 'yellow',
                    actions: [
                        { id: 'view_status', label: 'View Status', type: 'secondary', route: '/proof/status' }
                    ],
                    estimatedWait: 'Within 24 hours'
                };

            case BlockReason.DISPUTE_ACTIVE:
                return {
                    state: UserPayoutState.DISPUTE_PENDING,
                    title: 'Dispute in Progress',
                    message: 'The poster has raised a concern about this task. Payment is on hold while we review.',
                    icon: 'help',
                    color: 'orange',
                    actions: [
                        { id: 'view_dispute', label: 'View Details', type: 'primary', route: '/disputes' },
                        { id: 'respond', label: 'Respond to Dispute', type: 'secondary', route: '/disputes/respond' }
                    ],
                    estimatedWait: 'Typically resolved within 48 hours'
                };

            case BlockReason.TASK_NOT_COMPLETED:
                return {
                    state: UserPayoutState.BLOCKED,
                    title: 'Task Not Completed',
                    message: 'This task hasn\'t been marked as completed yet. Complete the task to receive payment.',
                    icon: 'clock',
                    color: 'gray',
                    actions: [
                        { id: 'view_task', label: 'View Task', type: 'primary', route: '/tasks' }
                    ]
                };

            case BlockReason.MONEY_STATE_INVALID:
                return {
                    state: UserPayoutState.COMPLETED,
                    title: 'Already Processed',
                    message: 'This payment has already been processed. Check your earnings for details.',
                    icon: 'check',
                    color: 'green',
                    actions: [
                        { id: 'view_earnings', label: 'View Earnings', type: 'primary', route: '/earnings' }
                    ]
                };

            case BlockReason.TASK_NOT_FOUND:
                return {
                    state: UserPayoutState.BLOCKED,
                    title: 'Task Not Found',
                    message: 'We couldn\'t find this task. Please contact support if you believe this is an error.',
                    icon: 'alert',
                    color: 'red',
                    actions: [
                        { id: 'contact_support', label: 'Contact Support', type: 'primary', route: '/support' }
                    ]
                };

            default:
                return {
                    state: UserPayoutState.UNDER_REVIEW,
                    title: 'Processing',
                    message: 'Your payment is being processed. If you have questions, please contact support.',
                    icon: 'clock',
                    color: 'gray',
                    actions: [
                        { id: 'contact_support', label: 'Contact Support', type: 'secondary', route: '/support' }
                    ]
                };
        }
    }

    /**
     * Explain ESCALATE decisions
     */
    private static explainEscalation(result: EligibilityResult, amount: string): PayoutExplanation {
        // Escalation always means human review needed
        return {
            state: UserPayoutState.UNDER_REVIEW,
            title: 'Under Review',
            message: 'Your payment requires additional verification. Our team will review within 24 hours.',
            icon: 'clock',
            color: 'yellow',
            actions: [
                { id: 'view_status', label: 'View Status', type: 'secondary', route: '/payment/status' },
                { id: 'contact_support', label: 'Contact Support', type: 'link', route: '/support' }
            ],
            estimatedWait: 'Within 24 hours'
        };
    }

    /**
     * Get proof-specific explanation for UI
     */
    static explainProofState(proofState: ProofState | null): {
        status: string;
        description: string;
        actionNeeded: boolean;
    } {
        switch (proofState) {
            case ProofState.NONE:
            case null:
                return {
                    status: 'No proof required',
                    description: 'This task doesn\'t require photo verification.',
                    actionNeeded: false
                };
            case ProofState.REQUESTED:
                return {
                    status: 'Photo needed',
                    description: 'Please submit a completion photo to get paid.',
                    actionNeeded: true
                };
            case ProofState.SUBMITTED:
                return {
                    status: 'Photo received',
                    description: 'We\'ve received your photo and will verify it shortly.',
                    actionNeeded: false
                };
            case ProofState.ANALYZING:
                return {
                    status: 'Verifying',
                    description: 'Your photo is being verified. This takes just a few minutes.',
                    actionNeeded: false
                };
            case ProofState.VERIFIED:
                return {
                    status: 'Verified ✓',
                    description: 'Your completion photo has been verified.',
                    actionNeeded: false
                };
            case ProofState.REJECTED:
                return {
                    status: 'Photo issue',
                    description: 'Please submit a new photo showing the completed work.',
                    actionNeeded: true
                };
            case ProofState.ESCALATED:
                return {
                    status: 'Manual review',
                    description: 'Your photo is being reviewed by our team.',
                    actionNeeded: false
                };
            case ProofState.LOCKED:
                return {
                    status: 'Confirmed',
                    description: 'Proof has been verified and locked.',
                    actionNeeded: false
                };
            default:
                return {
                    status: 'Processing',
                    description: 'Your submission is being processed.',
                    actionNeeded: false
                };
        }
    }

    /**
     * Get a short status for list views
     */
    static getShortStatus(result: EligibilityResult): {
        label: string;
        color: 'green' | 'yellow' | 'orange' | 'red' | 'gray';
    } {
        if (result.decision === PayoutDecision.ALLOW) {
            return { label: 'Ready', color: 'green' };
        }
        if (result.decision === PayoutDecision.ESCALATE) {
            return { label: 'Review', color: 'yellow' };
        }

        switch (result.blockReason) {
            case BlockReason.PROOF_PENDING:
            case BlockReason.PROOF_REQUESTED:
                return { label: 'Proof needed', color: 'yellow' };
            case BlockReason.PROOF_ANALYZING:
                return { label: 'Verifying', color: 'gray' };
            case BlockReason.DISPUTE_ACTIVE:
                return { label: 'Disputed', color: 'orange' };
            case BlockReason.KILLSWITCH_ACTIVE:
                return { label: 'Paused', color: 'orange' };
            default:
                return { label: 'Pending', color: 'gray' };
        }
    }
}
