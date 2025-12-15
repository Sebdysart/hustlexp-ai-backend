/**
 * BETA METRICS SERVICE (Phase 13C)
 * 
 * Operational signals for Seattle Beta monitoring.
 * These are NOT vanity metrics - they are early-warning systems.
 * 
 * Metrics Tracked:
 * - Proof System: requests, submissions, rejections, verifications
 * - Payout Flow: blocked, escalated, allowed, delays
 * - Ops: admin overrides, killswitch activations
 * 
 * Thresholds:
 * - Proof rejection rate > 15% → review ProofPolicy
 * - Escalation rate > 5% → UX or AI misfire  
 * - Admin overrides > 1% of tasks → policy failure
 * - Avg payout delay > 24h → trust erosion
 */

import { PrometheusMetrics } from '../infra/metrics/Prometheus.js';
import { neon } from '@neondatabase/serverless';
import { serviceLogger } from '../utils/logger.js';

const logger = serviceLogger.child({ module: 'BetaMetrics' });

let sql: ReturnType<typeof neon> | null = null;

function getDb() {
    if (!sql && process.env.DATABASE_URL) {
        sql = neon(process.env.DATABASE_URL);
    }
    return sql;
}

// ============================================================
// METRIC NAMES (Prometheus-style)
// ============================================================

export const METRICS = {
    // Proof System
    PROOF_REQUESTS_TOTAL: 'hustlexp_proof_requests_total',
    PROOF_SUBMISSIONS_TOTAL: 'hustlexp_proof_submissions_total',
    PROOF_REJECTIONS_TOTAL: 'hustlexp_proof_rejections_total',
    PROOF_VERIFICATIONS_TOTAL: 'hustlexp_proof_verifications_total',
    PROOF_ESCALATIONS_TOTAL: 'hustlexp_proof_escalations_total',
    PROOF_RESOLUTION_TIME_MS: 'hustlexp_proof_resolution_time_ms',

    // Payout Flow
    PAYOUT_BLOCKED_TOTAL: 'hustlexp_payout_blocked_total',
    PAYOUT_ESCALATED_TOTAL: 'hustlexp_payout_escalated_total',
    PAYOUT_ALLOWED_TOTAL: 'hustlexp_payout_allowed_total',
    PAYOUT_DELAY_MS: 'hustlexp_payout_delay_ms',

    // Ops
    ADMIN_OVERRIDES_TOTAL: 'hustlexp_admin_overrides_total',
    KILLSWITCH_ACTIVATIONS_TOTAL: 'hustlexp_killswitch_activations_total',

    // Disputes
    DISPUTES_OPENED_TOTAL: 'hustlexp_disputes_opened_total',
    DISPUTES_RESOLVED_TOTAL: 'hustlexp_disputes_resolved_total',
} as const;

// ============================================================
// THRESHOLDS (Seattle Beta Limits)
// ============================================================

export const THRESHOLDS = {
    PROOF_REJECTION_RATE: 0.15,      // > 15% → review ProofPolicy
    ESCALATION_RATE: 0.05,           // > 5% → UX or AI misfire
    ADMIN_OVERRIDE_RATE: 0.01,       // > 1% of tasks → policy failure
    AVG_PAYOUT_DELAY_HOURS: 24,      // > 24h → trust erosion
    DISPUTE_RATE: 0.03,              // > 3% → marketplace health issue
} as const;

// ============================================================
// IN-MEMORY TRACKING (Persisted to DB periodically)
// ============================================================

interface MetricSnapshot {
    timestamp: Date;
    proofRequests: number;
    proofSubmissions: number;
    proofRejections: number;
    proofVerifications: number;
    proofEscalations: number;
    payoutBlocked: number;
    payoutEscalated: number;
    payoutAllowed: number;
    adminOverrides: number;
    disputesOpened: number;
    avgPayoutDelayMs: number;
    avgProofResolutionMs: number;
}

// Rolling window for rate calculations
const WINDOW_SIZE = 1000;
const recentEvents: { type: string; timestamp: Date; metadata?: any }[] = [];

// ============================================================
// BETA METRICS SERVICE
// ============================================================

export class BetaMetricsService {

    // -----------------------------------------------------------
    // EMIT METHODS (Call these from services)
    // -----------------------------------------------------------

    static proofRequested(): void {
        PrometheusMetrics.increment(METRICS.PROOF_REQUESTS_TOTAL);
        this.recordEvent('proof_request');
    }

    static proofSubmitted(): void {
        PrometheusMetrics.increment(METRICS.PROOF_SUBMISSIONS_TOTAL);
        this.recordEvent('proof_submission');
    }

    static proofRejected(reason?: string): void {
        PrometheusMetrics.increment(METRICS.PROOF_REJECTIONS_TOTAL, { reason: reason || 'unknown' });
        this.recordEvent('proof_rejection', { reason });
    }

    static proofVerified(): void {
        PrometheusMetrics.increment(METRICS.PROOF_VERIFICATIONS_TOTAL);
        this.recordEvent('proof_verification');
    }

    static proofEscalated(): void {
        PrometheusMetrics.increment(METRICS.PROOF_ESCALATIONS_TOTAL);
        this.recordEvent('proof_escalation');
    }

    static proofResolved(durationMs: number): void {
        PrometheusMetrics.setGauge(METRICS.PROOF_RESOLUTION_TIME_MS, {}, durationMs);
        this.recordEvent('proof_resolved', { durationMs });
    }

    static payoutBlocked(reason: string): void {
        PrometheusMetrics.increment(METRICS.PAYOUT_BLOCKED_TOTAL, { reason });
        this.recordEvent('payout_blocked', { reason });
    }

    static payoutEscalated(reason: string): void {
        PrometheusMetrics.increment(METRICS.PAYOUT_ESCALATED_TOTAL, { reason });
        this.recordEvent('payout_escalated', { reason });
    }

    static payoutAllowed(): void {
        PrometheusMetrics.increment(METRICS.PAYOUT_ALLOWED_TOTAL);
        this.recordEvent('payout_allowed');
    }

    static payoutDelayed(delayMs: number): void {
        PrometheusMetrics.setGauge(METRICS.PAYOUT_DELAY_MS, {}, delayMs);
        this.recordEvent('payout_delayed', { delayMs });
    }

    static adminOverride(type: string, adminId: string): void {
        PrometheusMetrics.increment(METRICS.ADMIN_OVERRIDES_TOTAL, { type });
        this.recordEvent('admin_override', { type, adminId });
        logger.warn({ type, adminId }, 'Admin override recorded');
    }

    static killswitchActivated(reason: string): void {
        PrometheusMetrics.increment(METRICS.KILLSWITCH_ACTIVATIONS_TOTAL, { reason });
        this.recordEvent('killswitch_activated', { reason });
        logger.fatal({ reason }, 'KillSwitch activation recorded');
    }

    static disputeOpened(): void {
        PrometheusMetrics.increment(METRICS.DISPUTES_OPENED_TOTAL);
        this.recordEvent('dispute_opened');
    }

    static disputeResolved(outcome: 'refunded' | 'upheld' | 'split'): void {
        PrometheusMetrics.increment(METRICS.DISPUTES_RESOLVED_TOTAL, { outcome });
        this.recordEvent('dispute_resolved', { outcome });
    }

    // -----------------------------------------------------------
    // RATE CALCULATIONS
    // -----------------------------------------------------------

    static getProofRejectionRate(): number {
        const window = this.getRecentEvents(60 * 60 * 1000); // Last hour
        const submissions = window.filter(e => e.type === 'proof_submission').length;
        const rejections = window.filter(e => e.type === 'proof_rejection').length;
        return submissions > 0 ? rejections / submissions : 0;
    }

    static getEscalationRate(): number {
        const window = this.getRecentEvents(60 * 60 * 1000);
        const payoutAttempts = window.filter(e =>
            e.type === 'payout_allowed' ||
            e.type === 'payout_blocked' ||
            e.type === 'payout_escalated'
        ).length;
        const escalations = window.filter(e => e.type === 'payout_escalated').length;
        return payoutAttempts > 0 ? escalations / payoutAttempts : 0;
    }

    static getAdminOverrideRate(): number {
        const window = this.getRecentEvents(24 * 60 * 60 * 1000); // Last 24h
        const payouts = window.filter(e => e.type === 'payout_allowed').length;
        const overrides = window.filter(e => e.type === 'admin_override').length;
        return payouts > 0 ? overrides / payouts : 0;
    }

    static getDisputeRate(): number {
        const window = this.getRecentEvents(24 * 60 * 60 * 1000);
        const completions = window.filter(e => e.type === 'payout_allowed').length;
        const disputes = window.filter(e => e.type === 'dispute_opened').length;
        return completions > 0 ? disputes / completions : 0;
    }

    // -----------------------------------------------------------
    // THRESHOLD CHECKS
    // -----------------------------------------------------------

    static checkThresholds(): {
        breached: boolean;
        alerts: { metric: string; value: number; threshold: number }[]
    } {
        const alerts: { metric: string; value: number; threshold: number }[] = [];

        const proofRejectionRate = this.getProofRejectionRate();
        if (proofRejectionRate > THRESHOLDS.PROOF_REJECTION_RATE) {
            alerts.push({
                metric: 'proof_rejection_rate',
                value: proofRejectionRate,
                threshold: THRESHOLDS.PROOF_REJECTION_RATE
            });
        }

        const escalationRate = this.getEscalationRate();
        if (escalationRate > THRESHOLDS.ESCALATION_RATE) {
            alerts.push({
                metric: 'escalation_rate',
                value: escalationRate,
                threshold: THRESHOLDS.ESCALATION_RATE
            });
        }

        const adminOverrideRate = this.getAdminOverrideRate();
        if (adminOverrideRate > THRESHOLDS.ADMIN_OVERRIDE_RATE) {
            alerts.push({
                metric: 'admin_override_rate',
                value: adminOverrideRate,
                threshold: THRESHOLDS.ADMIN_OVERRIDE_RATE
            });
        }

        const disputeRate = this.getDisputeRate();
        if (disputeRate > THRESHOLDS.DISPUTE_RATE) {
            alerts.push({
                metric: 'dispute_rate',
                value: disputeRate,
                threshold: THRESHOLDS.DISPUTE_RATE
            });
        }

        if (alerts.length > 0) {
            logger.warn({ alerts }, 'Beta threshold breaches detected');
        }

        return { breached: alerts.length > 0, alerts };
    }

    // -----------------------------------------------------------
    // DAILY REPORT
    // -----------------------------------------------------------

    static async generateDailyReport(): Promise<{
        date: string;
        summary: {
            tasksCompleted: number;
            proofsRequested: number;
            proofsRejected: number;
            proofsVerified: number;
            payoutsReleased: number;
            payoutsBlocked: number;
            disputesOpened: number;
            disputesResolved: number;
            adminOverrides: number;
        };
        rates: {
            proofRejectionRate: number;
            escalationRate: number;
            adminOverrideRate: number;
            disputeRate: number;
        };
        thresholdBreaches: { metric: string; value: number; threshold: number }[];
        healthStatus: 'healthy' | 'warning' | 'critical';
    }> {
        const db = getDb();
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        yesterday.setHours(0, 0, 0, 0);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Pull from DB where possible
        let dbStats = {
            tasksCompleted: 0,
            proofsRequested: 0,
            proofsRejected: 0,
            proofsVerified: 0,
            payoutsReleased: 0,
            payoutsBlocked: 0,
            disputesOpened: 0,
            disputesResolved: 0,
            adminOverrides: 0
        };

        if (db) {
            try {
                // Tasks completed
                const [taskCount] = await db`
                    SELECT COUNT(*) as count FROM tasks 
                    WHERE status = 'completed' 
                    AND updated_at >= ${yesterday} AND updated_at < ${today}
                ` as any[];
                dbStats.tasksCompleted = parseInt(taskCount?.count || '0');

                // Proof stats
                const [proofStats] = await db`
                    SELECT 
                        COUNT(*) FILTER (WHERE state = 'requested') as requested,
                        COUNT(*) FILTER (WHERE state = 'rejected') as rejected,
                        COUNT(*) FILTER (WHERE state IN ('verified', 'locked')) as verified
                    FROM proof_requests 
                    WHERE created_at >= ${yesterday} AND created_at < ${today}
                ` as any[];
                dbStats.proofsRequested = parseInt(proofStats?.requested || '0');
                dbStats.proofsRejected = parseInt(proofStats?.rejected || '0');
                dbStats.proofsVerified = parseInt(proofStats?.verified || '0');

                // Payout eligibility stats
                const [payoutStats] = await db`
                    SELECT 
                        COUNT(*) FILTER (WHERE decision = 'ALLOW') as allowed,
                        COUNT(*) FILTER (WHERE decision = 'BLOCK') as blocked
                    FROM payout_eligibility_log 
                    WHERE evaluated_at >= ${yesterday} AND evaluated_at < ${today}
                ` as any[];
                dbStats.payoutsReleased = parseInt(payoutStats?.allowed || '0');
                dbStats.payoutsBlocked = parseInt(payoutStats?.blocked || '0');

                // Dispute stats
                const [disputeStats] = await db`
                    SELECT 
                        COUNT(*) FILTER (WHERE created_at >= ${yesterday} AND created_at < ${today}) as opened,
                        COUNT(*) FILTER (WHERE resolved_at >= ${yesterday} AND resolved_at < ${today}) as resolved
                    FROM disputes
                ` as any[];
                dbStats.disputesOpened = parseInt(disputeStats?.opened || '0');
                dbStats.disputesResolved = parseInt(disputeStats?.resolved || '0');

            } catch (error) {
                logger.error({ error }, 'Failed to fetch DB stats for daily report');
            }
        }

        // Calculate rates
        const rates = {
            proofRejectionRate: this.getProofRejectionRate(),
            escalationRate: this.getEscalationRate(),
            adminOverrideRate: this.getAdminOverrideRate(),
            disputeRate: this.getDisputeRate()
        };

        // Check thresholds
        const thresholdCheck = this.checkThresholds();

        // Determine health status
        let healthStatus: 'healthy' | 'warning' | 'critical' = 'healthy';
        if (thresholdCheck.alerts.length > 0) {
            healthStatus = thresholdCheck.alerts.length >= 3 ? 'critical' : 'warning';
        }

        return {
            date: yesterday.toISOString().split('T')[0],
            summary: dbStats,
            rates,
            thresholdBreaches: thresholdCheck.alerts,
            healthStatus
        };
    }

    // -----------------------------------------------------------
    // INTERNAL HELPERS
    // -----------------------------------------------------------

    static recordEvent(type: string, metadata?: any): void {
        recentEvents.push({ type, timestamp: new Date(), metadata });

        // Trim to window size
        while (recentEvents.length > WINDOW_SIZE) {
            recentEvents.shift();
        }
    }

    private static getRecentEvents(windowMs: number): typeof recentEvents {
        const cutoff = new Date(Date.now() - windowMs);
        return recentEvents.filter(e => e.timestamp >= cutoff);
    }

    // -----------------------------------------------------------
    // PROMETHEUS EXPORT
    // -----------------------------------------------------------

    static getPrometheusMetrics(): string {
        return PrometheusMetrics.getMetrics();
    }
}
