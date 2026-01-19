/**
 * PolicySnapshotService - Phase 2C Policy Versioning
 *
 * INVARIANTS (NEVER VIOLATE):
 * 1. Policy assignment is STICKY - once assigned, never changes
 * 2. Allocation percentages are validated per scope (sum ≤ 100)
 * 3. Config hash guarantees reproducibility
 * 4. Safety regressions auto-deactivate policies
 */
export interface PolicySnapshot {
    id: string;
    version: string;
    config_hash: string;
    city_id: string | null;
    category: string | null;
    trust_bucket: 'new' | 'low' | 'medium' | 'high' | null;
    pricing_confidence_enforce: number;
    pricing_confidence_review: number;
    scam_high_confidence: number;
    trust_block_threshold: number;
    trust_warn_threshold: number;
    max_tasks_per_hour: number;
    max_tasks_per_day: number;
    min_task_price: number;
    is_active: boolean;
    allocation_percent: number;
    created_at: Date;
    activated_at: Date | null;
    deactivated_at: Date | null;
}
export interface PolicyConfig {
    pricing_confidence_enforce: number;
    pricing_confidence_review: number;
    scam_high_confidence: number;
    trust_block_threshold: number;
    trust_warn_threshold: number;
    max_tasks_per_hour: number;
    max_tasks_per_day: number;
    min_task_price: number;
}
export interface PolicyScope {
    city_id?: string;
    category?: string;
    trust_bucket?: 'new' | 'low' | 'medium' | 'high';
}
declare class PolicySnapshotServiceClass {
    private cachedActivePolicy;
    /**
     * Assign policy to a task AT CREATION TIME.
     *
     * INVARIANT: Once assigned, this policy_snapshot_id NEVER changes
     * for the lifetime of the task.
     *
     * Returns: { policy_snapshot_id, config_hash }
     */
    assignPolicyToTask(taskId: string, scope: PolicyScope): Promise<{
        policy_snapshot_id: string;
        config_hash: string;
    }>;
    /**
     * Deterministic bucket assignment using task ID hash.
     * Same task ID always gets same bucket → reproducible A/B split.
     */
    private hashToBucket;
    /**
     * Get active policies for a scope, sorted by specificity.
     * More specific policies (city+category+trust) come first.
     */
    private getActivePoliciesForScope;
    /**
     * Get the policy that was assigned to a specific task.
     * Used for all subsequent evaluations after creation.
     */
    getPolicyForTask(taskId: string): Promise<PolicySnapshot | null>;
    /**
     * Create a new policy snapshot with guaranteed config hash.
     */
    createSnapshot(version: string, config: PolicyConfig, scope: PolicyScope, allocationPercent?: number): Promise<PolicySnapshot>;
    /**
     * Generate SHA256 hash of canonical config JSON.
     * Guarantees reproducibility.
     */
    private generateConfigHash;
    /**
     * Activate a policy snapshot.
     * VALIDATES: sum(allocation_percent) ≤ 100 within scope.
     */
    activatePolicy(id: string): Promise<void>;
    /**
     * Deactivate a policy snapshot.
     * Used for manual deactivation or SAFETY REGRESSION auto-deactivation.
     */
    deactivatePolicy(id: string, reason?: string): Promise<void>;
    /**
     * Check if a policy has violated safety constraints.
     * Called periodically by monitoring job.
     * AUTO-DEACTIVATES on breach.
     */
    checkSafetyRegression(policyId: string, baselineMetrics: {
        dispute_rate: number;
        injection_rate: number;
    }, currentMetrics: {
        dispute_rate: number;
        injection_rate: number;
    }): Promise<{
        breached: boolean;
        reason: string | null;
    }>;
    private logSafetyEvent;
    private getDefaultPolicySnapshot;
    private rowToPolicy;
    /**
     * Get current global active policy (cached).
     */
    getActivePolicy(): Promise<PolicySnapshot>;
}
export declare const PolicySnapshotService: PolicySnapshotServiceClass;
export {};
//# sourceMappingURL=PolicySnapshotService.d.ts.map