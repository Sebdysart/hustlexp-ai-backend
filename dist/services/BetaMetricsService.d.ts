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
export declare const METRICS: {
    readonly PROOF_REQUESTS_TOTAL: "hustlexp_proof_requests_total";
    readonly PROOF_SUBMISSIONS_TOTAL: "hustlexp_proof_submissions_total";
    readonly PROOF_REJECTIONS_TOTAL: "hustlexp_proof_rejections_total";
    readonly PROOF_VERIFICATIONS_TOTAL: "hustlexp_proof_verifications_total";
    readonly PROOF_ESCALATIONS_TOTAL: "hustlexp_proof_escalations_total";
    readonly PROOF_RESOLUTION_TIME_MS: "hustlexp_proof_resolution_time_ms";
    readonly PAYOUT_BLOCKED_TOTAL: "hustlexp_payout_blocked_total";
    readonly PAYOUT_ESCALATED_TOTAL: "hustlexp_payout_escalated_total";
    readonly PAYOUT_ALLOWED_TOTAL: "hustlexp_payout_allowed_total";
    readonly PAYOUT_DELAY_MS: "hustlexp_payout_delay_ms";
    readonly ADMIN_OVERRIDES_TOTAL: "hustlexp_admin_overrides_total";
    readonly KILLSWITCH_ACTIVATIONS_TOTAL: "hustlexp_killswitch_activations_total";
    readonly DISPUTES_OPENED_TOTAL: "hustlexp_disputes_opened_total";
    readonly DISPUTES_RESOLVED_TOTAL: "hustlexp_disputes_resolved_total";
};
export declare const THRESHOLDS: {
    readonly PROOF_REJECTION_RATE: 0.15;
    readonly ESCALATION_RATE: 0.05;
    readonly ADMIN_OVERRIDE_RATE: 0.01;
    readonly AVG_PAYOUT_DELAY_HOURS: 24;
    readonly DISPUTE_RATE: 0.03;
};
export declare class BetaMetricsService {
    static proofRequested(): void;
    static proofSubmitted(): void;
    static proofRejected(reason?: string): void;
    static proofVerified(): void;
    static proofEscalated(): void;
    static proofResolved(durationMs: number): void;
    static payoutBlocked(reason: string): void;
    static payoutEscalated(reason: string): void;
    static payoutAllowed(): void;
    static payoutDelayed(delayMs: number): void;
    static adminOverride(type: string, adminId: string): void;
    static killswitchActivated(reason: string): void;
    static disputeOpened(): void;
    static disputeResolved(outcome: 'refunded' | 'upheld' | 'split'): void;
    static getProofRejectionRate(): number;
    static getEscalationRate(): number;
    static getAdminOverrideRate(): number;
    static getDisputeRate(): number;
    static checkThresholds(): {
        breached: boolean;
        alerts: {
            metric: string;
            value: number;
            threshold: number;
        }[];
    };
    static generateDailyReport(): Promise<{
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
        thresholdBreaches: {
            metric: string;
            value: number;
            threshold: number;
        }[];
        healthStatus: 'healthy' | 'warning' | 'critical';
    }>;
    static recordEvent(type: string, metadata?: any): void;
    private static getRecentEvents;
    static getPrometheusMetrics(): string;
}
//# sourceMappingURL=BetaMetricsService.d.ts.map