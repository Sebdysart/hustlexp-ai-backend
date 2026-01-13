/**
 * CONFLICT RESOLUTION PROTOCOL (AUDIT-10)
 *
 * When lower layer attempts action rejected by higher layer:
 * 1. Action is REJECTED (not queued, not retried)
 * 2. Lower layer logs violation with full context
 * 3. No automatic retry without explicit state re-evaluation
 * 4. Alert raised if violation rate exceeds threshold (3/hour)
 *
 * Authority Hierarchy:
 * 0. PostgreSQL constraints (highest)
 * 1. Backend state machines
 * 2. Temporal enforcement
 * 3. Payments (Stripe)
 * 4. AI proposal layer
 * 5. UI state machines
 * 6. Client rendering (lowest)
 *
 * @version 1.0.0
 * @see ARCHITECTURE.md §1.1 (AUDIT-10)
 */
export type AuthorityLayer = 'database' | 'state_machine' | 'temporal' | 'payments' | 'ai' | 'ui_state' | 'client';
export interface ConflictEvent {
    id: string;
    timestamp: Date;
    higherLayer: AuthorityLayer;
    lowerLayer: AuthorityLayer;
    action: string;
    entityType: string;
    entityId: string;
    reason: string;
    context: Record<string, unknown>;
    resolved: 'rejected' | 'logged';
}
export interface ConflictResolution {
    resolved: boolean;
    action: 'reject' | 'log_only';
    higherLayerWins: boolean;
    violation?: ConflictEvent;
}
declare class ConflictResolverClass {
    private violations;
    /**
     * Resolve conflict between layers
     * AUDIT-10: Higher layer ALWAYS wins
     */
    resolve(action: string, attemptedBy: AuthorityLayer, rejectedBy: AuthorityLayer, context: {
        entityType: string;
        entityId: string;
        reason: string;
        metadata?: Record<string, unknown>;
    }): ConflictResolution;
    /**
     * Record a violation
     */
    private recordViolation;
    /**
     * Check if alert threshold exceeded
     */
    private checkAlertThreshold;
    /**
     * Prune old violations
     */
    private pruneOldViolations;
    /**
     * Get violation count in last hour
     */
    getViolationCount(): number;
    /**
     * Get recent violations
     */
    getViolations(limit?: number): ConflictEvent[];
    /**
     * Handle database constraint violation (Layer 0)
     */
    handleDatabaseRejection(action: string, attemptedBy: AuthorityLayer, context: {
        entityType: string;
        entityId: string;
        constraint: string;
        sqlState?: string;
        detail?: string;
    }): ConflictResolution;
    /**
     * Handle state machine rejection (Layer 1)
     */
    handleStateMachineRejection(action: string, attemptedBy: AuthorityLayer, context: {
        entityType: string;
        entityId: string;
        currentState: string;
        attemptedTransition: string;
    }): ConflictResolution;
    /**
     * Handle Stripe/payment rejection (Layer 3)
     */
    handlePaymentRejection(action: string, attemptedBy: AuthorityLayer, context: {
        entityType: string;
        entityId: string;
        stripeError?: string;
        declineCode?: string;
    }): ConflictResolution;
    /**
     * Reset (for testing)
     */
    reset(): void;
}
export declare const ConflictResolver: ConflictResolverClass;
export {};
//# sourceMappingURL=ConflictResolver.d.ts.map