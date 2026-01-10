/**
 * ALERT SERVICE (Phase Ω-OPS - Foundation)
 *
 * Purpose: No silent failures.
 *
 * Alert channels:
 * - PagerDuty (primary) - PAGERDUTY_ROUTING_KEY
 * - Slack (fallback) - SLACK_ALERT_WEBHOOK
 * - Logged always
 *
 * CONSTRAINTS:
 * - All alerts are logged before delivery attempt
 * - Delivery failure does not block caller
 * - Multiple channels attempted in parallel
 */
export type AlertSeverity = 'critical' | 'warning' | 'info';
export type AlertType = 'KILLSWITCH_ACTIVATED' | 'SAGA_STUCK' | 'STUCK_SAGA' | 'ESCROW_TIMEOUT_ACTION' | 'STRIPE_WEBHOOK_FAILURE_SPIKE' | 'LEDGER_DRIFT_DETECTED' | 'SAGA_RECOVERY_EXHAUSTED' | 'PAYOUT_FAILED' | 'SAFEMODE_ACTIVATED' | 'CORRECTION_SYSTEM_SAFEMODE';
interface AlertResult {
    success: boolean;
    channels: {
        pagerduty: boolean;
        slack: boolean;
        logged: boolean;
    };
    errors: string[];
}
export declare class AlertService {
    private static pagerdutyKey;
    private static slackWebhook;
    private static alertEmail;
    /**
     * FIRE ALERT
     *
     * Logs first, then attempts delivery to all configured channels.
     * Delivery failure does not throw - caller is never blocked.
     */
    static fire(type: AlertType, message: string, metadata?: Record<string, any>): Promise<AlertResult>;
    /**
     * FIRE CRITICAL - Convenience method
     */
    static fireCritical(type: AlertType, message: string, metadata?: Record<string, any>): Promise<AlertResult>;
    private static logAlert;
    private static sendPagerDuty;
    private static sendSlack;
    /**
     * Send a test alert to verify configuration
     */
    static sendTestAlert(): Promise<AlertResult>;
    /**
     * Check which channels are configured
     */
    static getConfiguredChannels(): {
        pagerduty: boolean;
        slack: boolean;
    };
}
export {};
//# sourceMappingURL=AlertService.d.ts.map