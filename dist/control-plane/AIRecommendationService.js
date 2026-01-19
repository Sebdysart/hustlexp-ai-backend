/**
 * AI RECOMMENDATION SERVICE (Control Plane)
 *
 * Ingests and manages AI-generated recommendations.
 *
 * This service:
 * - Ingests AI recommendations via admin endpoint
 * - Validates against forbidden actions (auto-reject violations)
 * - Manages state machine: RECEIVED → REVIEWED → ACCEPTED/REJECTED → ARCHIVED
 * - Provides full audit trail
 *
 * CONSTRAINTS:
 * - NO AUTO-EXECUTION: All recommendations require human approval
 * - FORBIDDEN ACTIONS: Kernel modifications are auto-rejected
 * - FULL AUDIT: Every state change is logged with actor
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
const logger = serviceLogger.child({ module: 'AIRecommendation' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// FORBIDDEN TARGETS (Auto-reject if suggested)
// ============================================================
const FORBIDDEN_TARGETS = [
    // Ledger
    'LedgerService',
    'LedgerGuardService',
    'LedgerLockService',
    'ledger_transactions',
    'ledger_entries',
    'ledger_accounts',
    // Stripe/Money
    'StripeMoneyEngine',
    'StripeService',
    'stripe_outbound_log',
    'money_events_audit',
    // Recovery
    'RecoveryEngine',
    'PendingReaper',
    'DLQProcessor',
    'BackfillService',
    // Guards
    'TemporalGuard',
    'OrderingGate',
    'KillSwitch',
    // State machines
    'SAGA_STATES',
    'MoneyEvent',
    'TaskTransition',
    // Tables
    'money_state_lock',
    'killswitch',
];
// ============================================================
// AI RECOMMENDATION SERVICE
// ============================================================
export class AIRecommendationService {
    /**
     * INGEST RECOMMENDATIONS
     * Validates and stores AI-generated recommendations
     */
    static async ingest(payload, ingestedBy) {
        const results = [];
        let accepted = 0;
        let rejected = 0;
        for (const rec of payload.recommendations) {
            const id = ulid();
            // Validate against forbidden targets
            const validation = this.validateRecommendation(rec.suggestedChange.target);
            const recommendation = {
                id,
                snapshotId: payload.snapshotId,
                type: rec.type,
                status: validation.isValid ? 'received' : 'rejected',
                summary: rec.summary,
                details: rec.details,
                suggestedChange: rec.suggestedChange,
                isValid: validation.isValid,
                validationErrors: validation.errors,
                createdAt: new Date(),
                ...(validation.isValid ? {} : {
                    resolvedAt: new Date(),
                    resolvedBy: 'system',
                    resolution: 'rejected',
                    resolutionNotes: `Auto-rejected: ${validation.errors.join(', ')}`
                })
            };
            await this.storeRecommendation(recommendation);
            await this.logAudit(id, 'ingested', ingestedBy, { validation });
            if (validation.isValid) {
                accepted++;
            }
            else {
                rejected++;
                logger.warn({
                    id,
                    target: rec.suggestedChange.target,
                    errors: validation.errors
                }, 'Recommendation auto-rejected');
            }
            results.push(recommendation);
        }
        logger.info({
            snapshotId: payload.snapshotId,
            total: payload.recommendations.length,
            accepted,
            rejected,
            ingestedBy
        }, 'Recommendations ingested');
        return { accepted, rejected, recommendations: results };
    }
    /**
     * LIST RECOMMENDATIONS
     */
    static async list(status, limit = 50) {
        const db = getDb();
        if (!db)
            return [];
        try {
            let rows;
            if (status) {
                rows = await db `
                    SELECT data FROM ai_recommendations 
                    WHERE status = ${status}
                    ORDER BY created_at DESC
                    LIMIT ${limit}
                `;
            }
            else {
                rows = await db `
                    SELECT data FROM ai_recommendations 
                    ORDER BY created_at DESC
                    LIMIT ${limit}
                `;
            }
            return rows.map((r) => r.data);
        }
        catch (error) {
            logger.error({ error }, 'Failed to list recommendations');
            return [];
        }
    }
    /**
     * GET RECOMMENDATION
     */
    static async get(id) {
        const db = getDb();
        if (!db)
            return null;
        try {
            const [row] = await db `
                SELECT data FROM ai_recommendations WHERE id = ${id}
            `;
            return row ? row.data : null;
        }
        catch (error) {
            logger.error({ error, id }, 'Failed to get recommendation');
            return null;
        }
    }
    /**
     * MARK AS REVIEWED
     */
    static async markReviewed(id, reviewedBy) {
        const db = getDb();
        if (!db)
            return false;
        try {
            const rec = await this.get(id);
            if (!rec)
                return false;
            if (rec.status !== 'received') {
                logger.warn({ id, status: rec.status }, 'Cannot mark as reviewed - wrong status');
                return false;
            }
            rec.status = 'reviewed';
            rec.reviewedAt = new Date();
            rec.reviewedBy = reviewedBy;
            await this.updateRecommendation(rec);
            await this.logAudit(id, 'reviewed', reviewedBy);
            return true;
        }
        catch (error) {
            logger.error({ error, id }, 'Failed to mark reviewed');
            return false;
        }
    }
    /**
     * ACCEPT RECOMMENDATION
     */
    static async accept(id, acceptedBy, notes) {
        const db = getDb();
        if (!db)
            return false;
        try {
            const rec = await this.get(id);
            if (!rec)
                return false;
            if (rec.status !== 'reviewed') {
                logger.warn({ id, status: rec.status }, 'Cannot accept - must be reviewed first');
                return false;
            }
            rec.status = 'accepted';
            rec.resolvedAt = new Date();
            rec.resolvedBy = acceptedBy;
            rec.resolution = 'accepted';
            rec.resolutionNotes = notes;
            await this.updateRecommendation(rec);
            await this.logAudit(id, 'accepted', acceptedBy, { notes });
            logger.info({ id, acceptedBy }, 'Recommendation accepted');
            return true;
        }
        catch (error) {
            logger.error({ error, id }, 'Failed to accept');
            return false;
        }
    }
    /**
     * REJECT RECOMMENDATION
     */
    static async reject(id, rejectedBy, notes) {
        const db = getDb();
        if (!db)
            return false;
        try {
            const rec = await this.get(id);
            if (!rec)
                return false;
            if (rec.status === 'accepted' || rec.status === 'rejected' || rec.status === 'archived') {
                logger.warn({ id, status: rec.status }, 'Cannot reject - already resolved');
                return false;
            }
            rec.status = 'rejected';
            rec.resolvedAt = new Date();
            rec.resolvedBy = rejectedBy;
            rec.resolution = 'rejected';
            rec.resolutionNotes = notes;
            await this.updateRecommendation(rec);
            await this.logAudit(id, 'rejected', rejectedBy, { notes });
            logger.info({ id, rejectedBy }, 'Recommendation rejected');
            return true;
        }
        catch (error) {
            logger.error({ error, id }, 'Failed to reject');
            return false;
        }
    }
    /**
     * ARCHIVE RECOMMENDATION
     */
    static async archive(id, archivedBy) {
        const db = getDb();
        if (!db)
            return false;
        try {
            const rec = await this.get(id);
            if (!rec)
                return false;
            rec.status = 'archived';
            await this.updateRecommendation(rec);
            await this.logAudit(id, 'archived', archivedBy);
            return true;
        }
        catch (error) {
            logger.error({ error, id }, 'Failed to archive');
            return false;
        }
    }
    /**
     * GET PENDING COUNT
     */
    static async getPendingCount() {
        const db = getDb();
        if (!db)
            return { received: 0, reviewed: 0 };
        try {
            const [counts] = await db `
                SELECT 
                    COUNT(*) FILTER (WHERE status = 'received') as received,
                    COUNT(*) FILTER (WHERE status = 'reviewed') as reviewed
                FROM ai_recommendations
            `;
            return {
                received: parseInt(counts?.received || '0'),
                reviewed: parseInt(counts?.reviewed || '0')
            };
        }
        catch (error) {
            return { received: 0, reviewed: 0 };
        }
    }
    // -----------------------------------------------------------
    // INTERNAL: Validation
    // -----------------------------------------------------------
    static validateRecommendation(target) {
        const errors = [];
        // Check against forbidden targets
        for (const forbidden of FORBIDDEN_TARGETS) {
            if (target.toLowerCase().includes(forbidden.toLowerCase())) {
                errors.push(`Forbidden target: ${forbidden} (kernel modification not allowed)`);
            }
        }
        return {
            isValid: errors.length === 0,
            errors
        };
    }
    // -----------------------------------------------------------
    // INTERNAL: Storage
    // -----------------------------------------------------------
    static async storeRecommendation(rec) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO ai_recommendations (
                    id, snapshot_id, type, status, is_valid, data, created_at
                ) VALUES (
                    ${rec.id}, ${rec.snapshotId}, ${rec.type}, ${rec.status},
                    ${rec.isValid}, ${JSON.stringify(rec)}, ${rec.createdAt}
                )
            `;
        }
        catch (error) {
            logger.error({ error, id: rec.id }, 'Failed to store recommendation');
        }
    }
    static async updateRecommendation(rec) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                UPDATE ai_recommendations 
                SET status = ${rec.status}, data = ${JSON.stringify(rec)}
                WHERE id = ${rec.id}
            `;
        }
        catch (error) {
            logger.error({ error, id: rec.id }, 'Failed to update recommendation');
        }
    }
    static async logAudit(recommendationId, action, actor, metadata = {}) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO ai_recommendation_audit (
                    recommendation_id, action, actor, metadata, created_at
                ) VALUES (
                    ${recommendationId}, ${action}, ${actor}, 
                    ${JSON.stringify(metadata)}, NOW()
                )
            `;
        }
        catch (error) {
            // Audit table might not exist yet
            logger.warn({ error }, 'Failed to log audit');
        }
    }
}
//# sourceMappingURL=AIRecommendationService.js.map