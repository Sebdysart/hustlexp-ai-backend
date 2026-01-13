/**
 * AI CHAINING GUARD (AUDIT-14)
 *
 * Prevents AI-to-AI chaining without human intervention.
 *
 * AUDIT-14 Rule:
 * "No AI output may trigger another AI action without human review."
 *
 * Violations:
 * - AI proof assessment → automatic AI dispute resolution
 * - AI matching → automatic AI pricing
 * - AI recommendation → automatic AI action
 *
 * @version 1.0.0
 * @see ARCHITECTURE.md §3.1.1 (AUDIT-14)
 */
import { createLogger } from '../utils/logger.js';
const logger = createLogger('AIChainingGuard');
// ============================================================================
// CHAINING RULES
// ============================================================================
/**
 * Define which AI actions can trigger other AI actions
 * TRUE = requires human review between actions
 * FALSE = chaining allowed (rare exceptions)
 */
const CHAINING_RULES = {
    // Proof assessment cannot trigger dispute resolution
    proof_assessment: ['dispute_resolution'],
    // Dispute resolution cannot trigger any other AI
    dispute_resolution: ['proof_assessment', 'pricing_recommendation', 'smart_match'],
    // Matching cannot trigger automatic pricing
    smart_match: ['pricing_recommendation'],
    // Pricing cannot trigger automatic matching
    pricing_recommendation: ['smart_match'],
    // Risk score cannot trigger automatic fraud action
    risk_score: ['fraud_detection', 'content_moderation'],
    // Fraud detection cannot trigger automatic dispute
    fraud_detection: ['dispute_resolution'],
    // Content moderation is standalone
    content_moderation: [],
    // Recommendations are advisory
    task_recommendation: [],
    profile_optimization: [],
    coaching: [],
};
// ============================================================================
// AI CHAINING GUARD
// ============================================================================
class AIChainingGuardClass {
    recentActions = new Map();
    violations = [];
    windowMs = 60000; // 1 minute window for chaining detection
    /**
     * Record an AI action
     */
    recordAction(userId, actionType, actionId) {
        const record = {
            actionId,
            actionType,
            initiatedAt: new Date(),
            humanReviewed: false,
        };
        const key = `${userId}:${actionType}:${actionId}`;
        this.recentActions.set(key, record);
        // Cleanup old records
        this.pruneOldRecords();
        logger.debug({ userId, actionType, actionId }, 'AI action recorded');
        return record;
    }
    /**
     * Mark an action as human-reviewed
     */
    markReviewed(userId, actionType, actionId, reviewedBy) {
        const key = `${userId}:${actionType}:${actionId}`;
        const record = this.recentActions.get(key);
        if (record) {
            record.humanReviewed = true;
            record.reviewedAt = new Date();
            record.reviewedBy = reviewedBy;
            logger.info({ userId, actionType, actionId, reviewedBy }, 'AI action marked as reviewed');
        }
    }
    /**
     * Check if an AI action can proceed (AUDIT-14 enforcement)
     * Returns true if allowed, false if blocked
     */
    canProceed(userId, targetAction, _requestId) {
        // Get recent unreviewed actions for this user
        const unreviewedActions = this.getUnreviewedActions(userId);
        // Check if any unreviewed action blocks this target action
        for (const record of unreviewedActions) {
            const blockedTargets = CHAINING_RULES[record.actionType] || [];
            if (blockedTargets.includes(targetAction)) {
                const violation = {
                    sourceAction: record.actionType,
                    targetAction,
                    timestamp: new Date(),
                    blocked: true,
                    reason: `AUDIT-14: AI action "${targetAction}" blocked. Previous AI action "${record.actionType}" requires human review before proceeding.`,
                };
                this.violations.push(violation);
                logger.warn({
                    userId,
                    sourceAction: record.actionType,
                    targetAction,
                    sourceActionId: record.actionId,
                }, 'AUDIT-14: AI chaining blocked');
                return {
                    allowed: false,
                    reason: violation.reason,
                    violation,
                };
            }
        }
        return { allowed: true };
    }
    /**
     * Get unreviewed actions for a user within the window
     */
    getUnreviewedActions(userId) {
        const cutoff = Date.now() - this.windowMs;
        const results = [];
        for (const [key, record] of this.recentActions.entries()) {
            if (key.startsWith(`${userId}:`) &&
                !record.humanReviewed &&
                record.initiatedAt.getTime() > cutoff) {
                results.push(record);
            }
        }
        return results;
    }
    /**
     * Prune old records from memory
     */
    pruneOldRecords() {
        const cutoff = Date.now() - this.windowMs * 5; // Keep 5x window for safety
        for (const [key, record] of this.recentActions.entries()) {
            if (record.initiatedAt.getTime() < cutoff) {
                this.recentActions.delete(key);
            }
        }
        // Also prune violations older than 1 hour
        const violationCutoff = Date.now() - 3600000;
        this.violations = this.violations.filter(v => v.timestamp.getTime() > violationCutoff);
    }
    /**
     * Get recent violations (for monitoring)
     */
    getViolations(limit = 100) {
        return this.violations.slice(-limit);
    }
    /**
     * Get violation count (for alerting)
     */
    getViolationCount() {
        return this.violations.length;
    }
    /**
     * Reset (for testing)
     */
    reset() {
        this.recentActions.clear();
        this.violations = [];
    }
}
export const AIChainingGuard = new AIChainingGuardClass();
// ============================================================================
// DECORATOR FOR AI SERVICES
// ============================================================================
/**
 * Decorator to enforce AI chaining rules
 * Use this on AI service methods that should be protected
 */
export function enforceNoChaining(actionType) {
    return function (_target, _propertyKey, descriptor) {
        const originalMethod = descriptor.value;
        descriptor.value = async function (...args) {
            // Assume first arg is context with userId
            const context = args[0];
            const userId = context?.userId || 'unknown';
            // Check if chaining is allowed
            const check = AIChainingGuard.canProceed(userId, actionType, context?.requestId);
            if (!check.allowed) {
                throw new Error(check.reason || 'AUDIT-14: AI chaining blocked');
            }
            // Record this action
            const actionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            AIChainingGuard.recordAction(userId, actionType, actionId);
            // Execute original method
            return originalMethod.apply(this, args);
        };
        return descriptor;
    };
}
//# sourceMappingURL=AIChainingGuard.js.map