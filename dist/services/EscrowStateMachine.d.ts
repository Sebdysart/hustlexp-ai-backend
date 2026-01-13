/**
 * ESCROW STATE MACHINE (BUILD_GUIDE Phase 2)
 *
 * Implements the escrow lifecycle state machine from BUILD_GUIDE.
 *
 * STATES:
 * - PENDING: Awaiting payment
 * - FUNDED: Payment captured, held in escrow
 * - LOCKED_DISPUTE: Funds frozen during dispute
 * - RELEASED: Funds transferred to hustler (terminal)
 * - REFUNDED: Funds returned to client (terminal)
 * - PARTIAL_REFUND: Split between parties (terminal)
 *
 * INVARIANTS ENFORCED:
 * - INV-4: Amount immutable after creation
 * - INV-1: XP only awarded after RELEASED
 * - Terminal states immutable
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
export type EscrowState = 'pending' | 'funded' | 'locked_dispute' | 'released' | 'refunded' | 'partial_refund';
export declare const TERMINAL_ESCROW_STATES: EscrowState[];
export interface EscrowTransitionContext {
    stripePaymentIntentId?: string;
    stripeTransferId?: string;
    disputeId?: string;
    refundAmount?: number;
    adminId?: string;
    reason?: string;
}
export interface EscrowTransitionResult {
    success: boolean;
    previousState: EscrowState;
    newState: EscrowState;
    xpAwarded?: number;
    error?: string;
}
export declare const ESCROW_TRANSITIONS: Record<EscrowState, EscrowState[]>;
declare class EscrowStateMachineClass {
    /**
     * Check if a transition is valid
     */
    canTransition(from: EscrowState, to: EscrowState): boolean;
    /**
     * Execute a state transition
     */
    transition(taskId: string, targetState: EscrowState, context?: EscrowTransitionContext): Promise<EscrowTransitionResult>;
    /**
     * Get current escrow state
     */
    getState(taskId: string): Promise<EscrowState | null>;
    /**
     * Initialize escrow for a task (create money_state_lock)
     */
    initialize(taskId: string, amountCents: number): Promise<boolean>;
    /**
     * Get escrow details
     */
    getDetails(taskId: string): Promise<{
        state: EscrowState;
        amountCents: number;
        stripePaymentIntentId?: string;
        stripeTransferId?: string;
        updatedAt: Date;
    } | null>;
}
export declare const EscrowStateMachine: EscrowStateMachineClass;
export {};
//# sourceMappingURL=EscrowStateMachine.d.ts.map