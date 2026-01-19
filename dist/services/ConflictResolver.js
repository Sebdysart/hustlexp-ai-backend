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
import { createLogger } from '../utils/logger.js';
const logger = createLogger('ConflictResolver');
// ============================================================================
// CONSTANTS
// ============================================================================
const LAYER_PRIORITY = {
    database: 0,
    state_machine: 1,
    temporal: 2,
    payments: 3,
    ai: 4,
    ui_state: 5,
    client: 6,
};
const ALERT_THRESHOLD_PER_HOUR = 3;
const VIOLATION_WINDOW_MS = 60 * 60 * 1000; // 1 hour
// ============================================================================
// CONFLICT RESOLVER SERVICE
// ============================================================================
class ConflictResolverClass {
    violations = [];
    /**
     * Resolve conflict between layers
     * AUDIT-10: Higher layer ALWAYS wins
     */
    resolve(action, attemptedBy, rejectedBy, context) {
        const attemptPriority = LAYER_PRIORITY[attemptedBy];
        const rejectPriority = LAYER_PRIORITY[rejectedBy];
        // Higher priority (lower number) wins
        if (rejectPriority < attemptPriority) {
            // This is expected - higher layer rejected lower layer
            const violation = this.recordViolation(rejectedBy, attemptedBy, action, context.entityType, context.entityId, context.reason, context.metadata || {});
            logger.warn({
                action,
                attemptedBy,
                rejectedBy,
                entityType: context.entityType,
                entityId: context.entityId,
                reason: context.reason,
            }, 'AUDIT-10: Conflict resolved - higher layer wins');
            // Check alert threshold
            this.checkAlertThreshold();
            return {
                resolved: true,
                action: 'reject',
                higherLayerWins: true,
                violation,
            };
        }
        // If lower layer is rejecting higher layer, this is a bug
        if (attemptPriority < rejectPriority) {
            logger.error({
                action,
                attemptedBy,
                rejectedBy,
                entityType: context.entityType,
                entityId: context.entityId,
            }, 'CRITICAL: Lower layer attempted to reject higher layer action');
            // Still log, but this shouldn't happen
            const violation = this.recordViolation(rejectedBy, attemptedBy, action, context.entityType, context.entityId, `INVALID: Lower layer ${rejectedBy} rejected higher layer ${attemptedBy}`, context.metadata || {});
            return {
                resolved: false,
                action: 'log_only',
                higherLayerWins: false,
                violation,
            };
        }
        // Same layer conflict - log and reject
        const violation = this.recordViolation(rejectedBy, attemptedBy, action, context.entityType, context.entityId, `Same-layer conflict: ${context.reason}`, context.metadata || {});
        return {
            resolved: true,
            action: 'reject',
            higherLayerWins: false,
            violation,
        };
    }
    /**
     * Record a violation
     */
    recordViolation(higherLayer, lowerLayer, action, entityType, entityId, reason, context) {
        const violation = {
            id: `conflict_${Date.now()}_${Math.random().toString(36).slice(2)}`,
            timestamp: new Date(),
            higherLayer,
            lowerLayer,
            action,
            entityType,
            entityId,
            reason,
            context,
            resolved: 'rejected',
        };
        this.violations.push(violation);
        this.pruneOldViolations();
        return violation;
    }
    /**
     * Check if alert threshold exceeded
     */
    checkAlertThreshold() {
        const recentCount = this.getViolationCount();
        if (recentCount >= ALERT_THRESHOLD_PER_HOUR) {
            logger.error({
                count: recentCount,
                threshold: ALERT_THRESHOLD_PER_HOUR,
                windowHours: 1,
            }, 'AUDIT-10 ALERT: Conflict violation threshold exceeded');
            // In production, this would trigger AlertingService
            // AlertingService.critical('conflict_threshold', ...);
        }
    }
    /**
     * Prune old violations
     */
    pruneOldViolations() {
        const cutoff = Date.now() - VIOLATION_WINDOW_MS;
        this.violations = this.violations.filter(v => v.timestamp.getTime() > cutoff);
    }
    /**
     * Get violation count in last hour
     */
    getViolationCount() {
        const cutoff = Date.now() - VIOLATION_WINDOW_MS;
        return this.violations.filter(v => v.timestamp.getTime() > cutoff).length;
    }
    /**
     * Get recent violations
     */
    getViolations(limit = 100) {
        return this.violations.slice(-limit);
    }
    /**
     * Handle database constraint violation (Layer 0)
     */
    handleDatabaseRejection(action, attemptedBy, context) {
        return this.resolve(action, attemptedBy, 'database', {
            entityType: context.entityType,
            entityId: context.entityId,
            reason: `Database constraint: ${context.constraint}`,
            metadata: {
                constraint: context.constraint,
                sqlState: context.sqlState,
                detail: context.detail,
            },
        });
    }
    /**
     * Handle state machine rejection (Layer 1)
     */
    handleStateMachineRejection(action, attemptedBy, context) {
        return this.resolve(action, attemptedBy, 'state_machine', {
            entityType: context.entityType,
            entityId: context.entityId,
            reason: `Invalid transition: ${context.currentState} → ${context.attemptedTransition}`,
            metadata: {
                currentState: context.currentState,
                attemptedTransition: context.attemptedTransition,
            },
        });
    }
    /**
     * Handle Stripe/payment rejection (Layer 3)
     */
    handlePaymentRejection(action, attemptedBy, context) {
        return this.resolve(action, attemptedBy, 'payments', {
            entityType: context.entityType,
            entityId: context.entityId,
            reason: `Payment rejected: ${context.stripeError || 'Unknown error'}`,
            metadata: {
                stripeError: context.stripeError,
                declineCode: context.declineCode,
            },
        });
    }
    /**
     * Reset (for testing)
     */
    reset() {
        this.violations = [];
    }
}
export const ConflictResolver = new ConflictResolverClass();
//# sourceMappingURL=ConflictResolver.js.map