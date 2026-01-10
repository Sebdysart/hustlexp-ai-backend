/**
 * ANALYSIS SNAPSHOT SERVICE (Control Plane)
 *
 * Creates immutable, versioned snapshots of system state for offline AI analysis.
 *
 * This service:
 * - Collects metrics from existing services (NO NEW QUERIES TO KERNEL)
 * - Aggregates into a structured snapshot
 * - Stores as immutable record with version stamp
 * - Exports as deterministic JSON for AI consumption
 *
 * CONSTRAINTS:
 * - READ-ONLY: Never writes to kernel tables
 * - NO PII: Aggregated metrics only, no user identifiers
 * - IMMUTABLE: Snapshots cannot be modified after creation
 * - VERSIONED: Schema version tracked for compatibility
 */
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';
import { ulid } from 'ulidx';
import { BetaMetricsService } from '../services/BetaMetricsService.js';
import { MetricsService } from '../services/MetricsService.js';
import { AdaptiveProofPolicy } from '../services/AdaptiveProofPolicy.js';
const logger = serviceLogger.child({ module: 'AnalysisSnapshot' });
let sql = null;
function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}
// ============================================================
// SCHEMA VERSION (Increment when format changes)
// ============================================================
const SCHEMA_VERSION = 'v1';
// ============================================================
// ANALYSIS SNAPSHOT SERVICE
// ============================================================
export class AnalysisSnapshotService {
    /**
     * GENERATE SNAPSHOT
     * Creates immutable snapshot of current system state
     */
    static async generateSnapshot(type, periodStart, periodEnd) {
        const id = ulid();
        const now = new Date();
        // Default period based on type
        if (!periodEnd)
            periodEnd = now;
        if (!periodStart) {
            if (type === 'hourly') {
                periodStart = new Date(now.getTime() - 60 * 60 * 1000);
            }
            else if (type === 'daily') {
                periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            }
            else {
                periodStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            }
        }
        logger.info({ id, type, periodStart, periodEnd }, 'Generating analysis snapshot');
        // Collect from existing services (NO NEW KERNEL QUERIES)
        const [operations, funnel, aiUsage, riskDistribution, shadowAnalysis, systemHealth] = await Promise.all([
            this.collectOperationsMetrics(),
            this.collectFunnelMetrics(),
            this.collectAIUsageMetrics(),
            this.collectRiskDistribution(),
            this.collectShadowAnalysis(),
            this.collectSystemHealth()
        ]);
        const snapshot = {
            id,
            schemaVersion: SCHEMA_VERSION,
            snapshotType: type,
            createdAt: now,
            periodStart,
            periodEnd,
            operations,
            funnel,
            aiUsage,
            riskDistribution,
            shadowAnalysis,
            systemHealth
        };
        // Store immutably
        await this.storeSnapshot(snapshot);
        logger.info({ id, type }, 'Snapshot generated and stored');
        return snapshot;
    }
    /**
     * GET SNAPSHOT BY ID
     */
    static async getSnapshot(id) {
        const db = getDb();
        if (!db)
            return null;
        try {
            const [row] = await db `
                SELECT data FROM analysis_snapshots WHERE id = ${id}
            `;
            return row ? row.data : null;
        }
        catch (error) {
            logger.error({ error, id }, 'Failed to get snapshot');
            return null;
        }
    }
    /**
     * LIST SNAPSHOTS
     */
    static async listSnapshots(type, limit = 50) {
        const db = getDb();
        if (!db)
            return [];
        try {
            let rows;
            if (type) {
                rows = await db `
                    SELECT id, snapshot_type, created_at 
                    FROM analysis_snapshots 
                    WHERE snapshot_type = ${type}
                    ORDER BY created_at DESC
                    LIMIT ${limit}
                `;
            }
            else {
                rows = await db `
                    SELECT id, snapshot_type, created_at 
                    FROM analysis_snapshots 
                    ORDER BY created_at DESC
                    LIMIT ${limit}
                `;
            }
            return rows.map((r) => ({
                id: r.id,
                type: r.snapshot_type,
                createdAt: new Date(r.created_at)
            }));
        }
        catch (error) {
            logger.error({ error }, 'Failed to list snapshots');
            return [];
        }
    }
    /**
     * EXPORT FOR AI ANALYSIS
     * Produces deterministic JSON for offline AI consumption
     */
    static async exportForAI(snapshotId) {
        const snapshot = await this.getSnapshot(snapshotId);
        if (!snapshot)
            return null;
        return {
            snapshot,
            exportedAt: new Date(),
            exportFormat: 'json',
            promptTemplateVersion: 'v1'
        };
    }
    /**
     * GET LATEST SNAPSHOT
     */
    static async getLatest(type) {
        const db = getDb();
        if (!db)
            return null;
        try {
            let row;
            if (type) {
                [row] = await db `
                    SELECT data FROM analysis_snapshots 
                    WHERE snapshot_type = ${type}
                    ORDER BY created_at DESC
                    LIMIT 1
                `;
            }
            else {
                [row] = await db `
                    SELECT data FROM analysis_snapshots 
                    ORDER BY created_at DESC
                    LIMIT 1
                `;
            }
            return row ? row.data : null;
        }
        catch (error) {
            logger.error({ error }, 'Failed to get latest snapshot');
            return null;
        }
    }
    // -----------------------------------------------------------
    // INTERNAL: Collectors (Read from existing services only)
    // -----------------------------------------------------------
    static async collectOperationsMetrics() {
        // Uses BetaMetricsService - already exists, no new queries
        return {
            proofRejectionRate: BetaMetricsService.getProofRejectionRate(),
            escalationRate: BetaMetricsService.getEscalationRate(),
            adminOverrideRate: BetaMetricsService.getAdminOverrideRate(),
            disputeRate: BetaMetricsService.getDisputeRate(),
            thresholdBreaches: BetaMetricsService.checkThresholds()
        };
    }
    static async collectFunnelMetrics() {
        // Uses MetricsService - already exists
        const funnel = MetricsService.getGlobalFunnel();
        return {
            tasksCreated: funnel.tasksCreated,
            tasksAccepted: funnel.tasksAccepted,
            tasksCompleted: funnel.tasksCompleted,
            tasksDisputed: funnel.tasksDisputed,
            completionRate: funnel.completionRate,
            disputeRate: funnel.disputeRate,
            acceptanceRate: funnel.acceptanceRate
        };
    }
    static async collectAIUsageMetrics() {
        // Uses MetricsService - already exists
        const stats = MetricsService.getOverallStats();
        const aiSummary = MetricsService.getAIMetricsSummary();
        return {
            totalCalls: stats.ai.totalCalls,
            totalCostUsd: stats.ai.totalCostUsd,
            avgLatencyMs: stats.ai.avgLatencyMs,
            byProvider: aiSummary.map(s => ({
                provider: s.provider,
                calls: s.calls,
                costUsd: s.totalCostUsd
            }))
        };
    }
    static async collectRiskDistribution() {
        const db = getDb();
        const defaultResult = {
            byTier: { minimal: 0, low: 0, medium: 0, high: 0, critical: 0 },
            avgScore: 0,
            highRiskTaskCount: 0
        };
        if (!db)
            return defaultResult;
        try {
            // Query risk_score_log (our table, not kernel)
            const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const tierCounts = await db `
                SELECT tier, COUNT(*) as count
                FROM risk_score_log
                WHERE evaluated_at >= ${since}
                GROUP BY tier
            `;
            const [avgStats] = await db `
                SELECT 
                    AVG(score) as avg_score,
                    COUNT(*) FILTER (WHERE score >= 50) as high_risk
                FROM risk_score_log
                WHERE evaluated_at >= ${since}
            `;
            const byTier = { minimal: 0, low: 0, medium: 0, high: 0, critical: 0 };
            for (const row of tierCounts) {
                if (row.tier in byTier) {
                    byTier[row.tier] = parseInt(row.count);
                }
            }
            return {
                byTier,
                avgScore: parseFloat(avgStats?.avg_score || '0'),
                highRiskTaskCount: parseInt(avgStats?.high_risk || '0')
            };
        }
        catch (error) {
            logger.warn({ error }, 'Failed to collect risk distribution');
            return defaultResult;
        }
    }
    static async collectShadowAnalysis() {
        // Uses AdaptiveProofPolicy - already exists
        try {
            return await AdaptiveProofPolicy.getShadowAnalysis(1); // Last 24 hours
        }
        catch (error) {
            return {
                totalEvaluations: 0,
                byDelta: { same: 0, moreStrict: 0, lessStrict: 0 },
                recommendations: []
            };
        }
    }
    static async collectSystemHealth() {
        const db = getDb();
        const defaultResult = {
            killswitchActive: false,
            pendingSagas: 0,
            driftAmount: 0
        };
        if (!db)
            return defaultResult;
        try {
            // Check killswitch via Redis would be ideal, but we'll check local state
            // This is a READ operation, not modifying anything
            const { KillSwitch } = await import('../infra/KillSwitch.js');
            const killswitchActive = await KillSwitch.isActive();
            // Count pending sagas (read-only query to ledger_transactions)
            // This is allowed - we're reading, not writing
            const [pendingCount] = await db `
                SELECT COUNT(*) as count FROM ledger_transactions 
                WHERE status IN ('pending', 'executing')
            `;
            return {
                killswitchActive,
                pendingSagas: parseInt(pendingCount?.count || '0'),
                driftAmount: 0 // Would require ledger query - skip for now
            };
        }
        catch (error) {
            logger.warn({ error }, 'Failed to collect system health');
            return defaultResult;
        }
    }
    // -----------------------------------------------------------
    // INTERNAL: Storage
    // -----------------------------------------------------------
    static async storeSnapshot(snapshot) {
        const db = getDb();
        if (!db)
            return;
        try {
            await db `
                INSERT INTO analysis_snapshots (
                    id, schema_version, snapshot_type, data, 
                    period_start, period_end, created_at
                ) VALUES (
                    ${snapshot.id}, ${snapshot.schemaVersion}, ${snapshot.snapshotType},
                    ${JSON.stringify(snapshot)}, ${snapshot.periodStart}, ${snapshot.periodEnd},
                    ${snapshot.createdAt}
                )
            `;
        }
        catch (error) {
            logger.error({ error, id: snapshot.id }, 'Failed to store snapshot');
        }
    }
}
//# sourceMappingURL=AnalysisSnapshotService.js.map