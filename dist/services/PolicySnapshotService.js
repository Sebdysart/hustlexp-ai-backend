/**
 * PolicySnapshotService - Phase 2C Policy Versioning
 *
 * INVARIANTS (NEVER VIOLATE):
 * 1. Policy assignment is STICKY - once assigned, never changes
 * 2. Allocation percentages are validated per scope (sum ≤ 100)
 * 3. Config hash guarantees reproducibility
 * 4. Safety regressions auto-deactivate policies
 */
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { sql, isDatabaseAvailable } from '../db/index.js';
import { serviceLogger } from '../utils/logger.js';
// ============================================
// Default Policy (Baseline)
// ============================================
const DEFAULT_POLICY_CONFIG = {
    pricing_confidence_enforce: 0.85,
    pricing_confidence_review: 0.60,
    scam_high_confidence: 0.80,
    trust_block_threshold: 20,
    trust_warn_threshold: 40,
    max_tasks_per_hour: 10,
    max_tasks_per_day: 50,
    min_task_price: 15,
};
// ============================================
// PolicySnapshotService
// ============================================
class PolicySnapshotServiceClass {
    cachedActivePolicy = null;
    // ============================================
    // STICKY POLICY ASSIGNMENT (CRITICAL)
    // ============================================
    /**
     * Assign policy to a task AT CREATION TIME.
     *
     * INVARIANT: Once assigned, this policy_snapshot_id NEVER changes
     * for the lifetime of the task.
     *
     * Returns: { policy_snapshot_id, config_hash }
     */
    async assignPolicyToTask(taskId, scope) {
        // Get all active policies matching scope (most specific first)
        const candidates = await this.getActivePoliciesForScope(scope);
        if (candidates.length === 0) {
            // Fallback to in-memory default
            const defaultPolicy = this.getDefaultPolicySnapshot();
            return {
                policy_snapshot_id: defaultPolicy.id,
                config_hash: defaultPolicy.config_hash,
            };
        }
        // A/B allocation: deterministic bucket based on task ID
        const bucket = this.hashToBucket(taskId, 100);
        // Find the policy that covers this bucket
        let cumulativeAllocation = 0;
        for (const policy of candidates) {
            cumulativeAllocation += policy.allocation_percent;
            if (bucket < cumulativeAllocation) {
                return {
                    policy_snapshot_id: policy.id,
                    config_hash: policy.config_hash,
                };
            }
        }
        // Fallback to first (should not reach here if allocations sum correctly)
        const fallback = candidates[0];
        return {
            policy_snapshot_id: fallback.id,
            config_hash: fallback.config_hash,
        };
    }
    /**
     * Deterministic bucket assignment using task ID hash.
     * Same task ID always gets same bucket → reproducible A/B split.
     */
    hashToBucket(taskId, buckets) {
        const hash = crypto.createHash('sha256').update(taskId).digest('hex');
        return parseInt(hash.substring(0, 8), 16) % buckets;
    }
    // ============================================
    // Policy Lookup
    // ============================================
    /**
     * Get active policies for a scope, sorted by specificity.
     * More specific policies (city+category+trust) come first.
     */
    async getActivePoliciesForScope(scope) {
        if (!isDatabaseAvailable() || !sql) {
            return [this.getDefaultPolicySnapshot()];
        }
        try {
            // Query: match scope OR global, active only
            const rows = await sql `
                SELECT * FROM policy_snapshots 
                WHERE is_active = true
                AND (city_id IS NULL OR city_id = ${scope.city_id || null})
                AND (category IS NULL OR category = ${scope.category || null})
                AND (trust_bucket IS NULL OR trust_bucket = ${scope.trust_bucket || null})
                ORDER BY 
                    (city_id IS NOT NULL)::int + 
                    (category IS NOT NULL)::int + 
                    (trust_bucket IS NOT NULL)::int DESC,
                    created_at DESC
            `;
            return rows.map(r => this.rowToPolicy(r));
        }
        catch (error) {
            serviceLogger.error({ error }, 'Failed to get active policies');
            return [this.getDefaultPolicySnapshot()];
        }
    }
    /**
     * Get the policy that was assigned to a specific task.
     * Used for all subsequent evaluations after creation.
     */
    async getPolicyForTask(taskId) {
        if (!isDatabaseAvailable() || !sql) {
            return this.getDefaultPolicySnapshot();
        }
        try {
            const [row] = await sql `
                SELECT ps.* FROM policy_snapshots ps
                JOIN tasks t ON t.policy_snapshot_id = ps.id
                WHERE t.id = ${taskId}
            `;
            if (!row) {
                return null;
            }
            return this.rowToPolicy(row);
        }
        catch (error) {
            serviceLogger.error({ error, taskId }, 'Failed to get policy for task');
            return null;
        }
    }
    // ============================================
    // Policy Creation with Config Hash
    // ============================================
    /**
     * Create a new policy snapshot with guaranteed config hash.
     */
    async createSnapshot(version, config, scope, allocationPercent = 100) {
        // Generate canonical config hash
        const configHash = this.generateConfigHash(config);
        const id = uuidv4();
        const now = new Date();
        if (!isDatabaseAvailable() || !sql) {
            throw new Error('Database not available');
        }
        await sql `
            INSERT INTO policy_snapshots (
                id, version, config_hash,
                city_id, category, trust_bucket,
                pricing_confidence_enforce, pricing_confidence_review,
                scam_high_confidence, trust_block_threshold, trust_warn_threshold,
                max_tasks_per_hour, max_tasks_per_day, min_task_price,
                is_active, allocation_percent, created_at
            ) VALUES (
                ${id}, ${version}, ${configHash},
                ${scope.city_id || null}, ${scope.category || null}, ${scope.trust_bucket || null},
                ${config.pricing_confidence_enforce}, ${config.pricing_confidence_review},
                ${config.scam_high_confidence}, ${config.trust_block_threshold}, ${config.trust_warn_threshold},
                ${config.max_tasks_per_hour}, ${config.max_tasks_per_day}, ${config.min_task_price},
                false, ${allocationPercent}, ${now}
            )
        `;
        serviceLogger.info({ id, version, configHash, scope }, 'Policy snapshot created');
        return {
            id,
            version,
            config_hash: configHash,
            city_id: scope.city_id || null,
            category: scope.category || null,
            trust_bucket: scope.trust_bucket || null,
            ...config,
            is_active: false,
            allocation_percent: allocationPercent,
            created_at: now,
            activated_at: null,
            deactivated_at: null,
        };
    }
    /**
     * Generate SHA256 hash of canonical config JSON.
     * Guarantees reproducibility.
     */
    generateConfigHash(config) {
        // Canonical JSON: sorted keys
        const canonical = JSON.stringify(config, Object.keys(config).sort());
        return crypto.createHash('sha256').update(canonical).digest('hex');
    }
    // ============================================
    // Activation with Allocation Validation
    // ============================================
    /**
     * Activate a policy snapshot.
     * VALIDATES: sum(allocation_percent) ≤ 100 within scope.
     */
    async activatePolicy(id) {
        if (!isDatabaseAvailable() || !sql) {
            throw new Error('Database not available');
        }
        // Get the policy to activate
        const [policy] = await sql `SELECT * FROM policy_snapshots WHERE id = ${id}`;
        if (!policy) {
            throw new Error('Policy not found');
        }
        if (policy.is_active) {
            return; // Already active
        }
        // Check allocation sum within scope
        const [existing] = await sql `
            SELECT COALESCE(SUM(allocation_percent), 0) as total
            FROM policy_snapshots
            WHERE is_active = true
            AND (city_id IS NOT DISTINCT FROM ${policy.city_id})
            AND (category IS NOT DISTINCT FROM ${policy.category})
            AND (trust_bucket IS NOT DISTINCT FROM ${policy.trust_bucket})
        `;
        const currentTotal = Number(existing.total);
        const newTotal = currentTotal + policy.allocation_percent;
        if (newTotal > 100) {
            throw new Error(`Cannot activate: allocation would exceed 100% (currently ${currentTotal}%, ` +
                `adding ${policy.allocation_percent}% = ${newTotal}%)`);
        }
        // Activate
        await sql `
            UPDATE policy_snapshots 
            SET is_active = true, activated_at = NOW()
            WHERE id = ${id}
        `;
        serviceLogger.warn({ id, version: policy.version }, 'Policy activated');
        this.cachedActivePolicy = null; // Invalidate cache
    }
    /**
     * Deactivate a policy snapshot.
     * Used for manual deactivation or SAFETY REGRESSION auto-deactivation.
     */
    async deactivatePolicy(id, reason) {
        if (!isDatabaseAvailable() || !sql) {
            throw new Error('Database not available');
        }
        await sql `
            UPDATE policy_snapshots 
            SET is_active = false, deactivated_at = NOW()
            WHERE id = ${id}
        `;
        serviceLogger.warn({ id, reason }, 'Policy deactivated');
        this.cachedActivePolicy = null;
    }
    // ============================================
    // Safety Regression Auto-Deactivation
    // ============================================
    /**
     * Check if a policy has violated safety constraints.
     * Called periodically by monitoring job.
     * AUTO-DEACTIVATES on breach.
     */
    async checkSafetyRegression(policyId, baselineMetrics, currentMetrics) {
        const HARD_CONSTRAINTS = {
            dispute_rate_max_increase: 0.02,
            injection_rate_max_increase: 0,
        };
        const disputeDelta = currentMetrics.dispute_rate - baselineMetrics.dispute_rate;
        const injectionDelta = currentMetrics.injection_rate - baselineMetrics.injection_rate;
        if (disputeDelta > HARD_CONSTRAINTS.dispute_rate_max_increase) {
            await this.deactivatePolicy(policyId, 'SAFETY_REGRESSION: dispute_rate exceeded');
            await this.logSafetyEvent(policyId, 'DISPUTE_RATE_BREACH', { disputeDelta });
            return { breached: true, reason: 'dispute_rate_breach' };
        }
        if (injectionDelta > HARD_CONSTRAINTS.injection_rate_max_increase) {
            await this.deactivatePolicy(policyId, 'SAFETY_REGRESSION: injection_rate exceeded');
            await this.logSafetyEvent(policyId, 'INJECTION_RATE_BREACH', { injectionDelta });
            return { breached: true, reason: 'injection_rate_breach' };
        }
        return { breached: false, reason: null };
    }
    async logSafetyEvent(policyId, eventType, details) {
        if (!isDatabaseAvailable() || !sql)
            return;
        try {
            await sql `
                INSERT INTO events (event_type, source, metadata)
                VALUES (${`SAFETY_REGRESSION_${eventType}`}, 'backend', ${JSON.stringify({ policyId, ...details })})
            `;
        }
        catch (error) {
            serviceLogger.error({ error }, 'Failed to log safety event');
        }
    }
    // ============================================
    // Helpers
    // ============================================
    getDefaultPolicySnapshot() {
        const configHash = this.generateConfigHash(DEFAULT_POLICY_CONFIG);
        return {
            id: 'default-baseline-v1',
            version: 'baseline-v1',
            config_hash: configHash,
            city_id: null,
            category: null,
            trust_bucket: null,
            ...DEFAULT_POLICY_CONFIG,
            is_active: true,
            allocation_percent: 100,
            created_at: new Date(),
            activated_at: new Date(),
            deactivated_at: null,
        };
    }
    rowToPolicy(row) {
        return {
            id: row.id,
            version: row.version,
            config_hash: row.config_hash,
            city_id: row.city_id,
            category: row.category,
            trust_bucket: row.trust_bucket,
            pricing_confidence_enforce: Number(row.pricing_confidence_enforce),
            pricing_confidence_review: Number(row.pricing_confidence_review),
            scam_high_confidence: Number(row.scam_high_confidence),
            trust_block_threshold: Number(row.trust_block_threshold),
            trust_warn_threshold: Number(row.trust_warn_threshold),
            max_tasks_per_hour: Number(row.max_tasks_per_hour),
            max_tasks_per_day: Number(row.max_tasks_per_day),
            min_task_price: Number(row.min_task_price),
            is_active: Boolean(row.is_active),
            allocation_percent: Number(row.allocation_percent),
            created_at: new Date(row.created_at),
            activated_at: row.activated_at ? new Date(row.activated_at) : null,
            deactivated_at: row.deactivated_at ? new Date(row.deactivated_at) : null,
        };
    }
    /**
     * Get current global active policy (cached).
     */
    async getActivePolicy() {
        if (this.cachedActivePolicy) {
            return this.cachedActivePolicy;
        }
        const policies = await this.getActivePoliciesForScope({});
        this.cachedActivePolicy = policies[0] || this.getDefaultPolicySnapshot();
        return this.cachedActivePolicy;
    }
}
export const PolicySnapshotService = new PolicySnapshotServiceClass();
//# sourceMappingURL=PolicySnapshotService.js.map