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
export type SnapshotType = 'hourly' | 'daily' | 'manual';
export interface AnalysisSnapshot {
    id: string;
    schemaVersion: string;
    snapshotType: SnapshotType;
    createdAt: Date;
    periodStart: Date;
    periodEnd: Date;
    operations: {
        proofRejectionRate: number;
        escalationRate: number;
        adminOverrideRate: number;
        disputeRate: number;
        thresholdBreaches: {
            breached: boolean;
            alerts: {
                metric: string;
                value: number;
                threshold: number;
            }[];
        };
    };
    funnel: {
        tasksCreated: number;
        tasksAccepted: number;
        tasksCompleted: number;
        tasksDisputed: number;
        completionRate: number;
        disputeRate: number;
        acceptanceRate: number;
    };
    aiUsage: {
        totalCalls: number;
        totalCostUsd: number;
        avgLatencyMs: number;
        byProvider: {
            provider: string;
            calls: number;
            costUsd: number;
        }[];
    };
    riskDistribution: {
        byTier: Record<string, number>;
        avgScore: number;
        highRiskTaskCount: number;
    };
    shadowAnalysis: {
        totalEvaluations: number;
        byDelta: {
            same: number;
            moreStrict: number;
            lessStrict: number;
        };
        recommendations: string[];
    };
    systemHealth: {
        killswitchActive: boolean;
        pendingSagas: number;
        driftAmount: number;
    };
}
export interface SnapshotExport {
    snapshot: AnalysisSnapshot;
    exportedAt: Date;
    exportFormat: 'json';
    promptTemplateVersion: string;
}
export declare class AnalysisSnapshotService {
    /**
     * GENERATE SNAPSHOT
     * Creates immutable snapshot of current system state
     */
    static generateSnapshot(type: SnapshotType, periodStart?: Date, periodEnd?: Date): Promise<AnalysisSnapshot>;
    /**
     * GET SNAPSHOT BY ID
     */
    static getSnapshot(id: string): Promise<AnalysisSnapshot | null>;
    /**
     * LIST SNAPSHOTS
     */
    static listSnapshots(type?: SnapshotType, limit?: number): Promise<{
        id: string;
        type: SnapshotType;
        createdAt: Date;
    }[]>;
    /**
     * EXPORT FOR AI ANALYSIS
     * Produces deterministic JSON for offline AI consumption
     */
    static exportForAI(snapshotId: string): Promise<SnapshotExport | null>;
    /**
     * GET LATEST SNAPSHOT
     */
    static getLatest(type?: SnapshotType): Promise<AnalysisSnapshot | null>;
    private static collectOperationsMetrics;
    private static collectFunnelMetrics;
    private static collectAIUsageMetrics;
    private static collectRiskDistribution;
    private static collectShadowAnalysis;
    private static collectSystemHealth;
    private static storeSnapshot;
}
//# sourceMappingURL=AnalysisSnapshotService.d.ts.map