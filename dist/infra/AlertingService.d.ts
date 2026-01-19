/**
 * ALERTING SERVICE (BUILD_GUIDE Phase 6)
 *
 * Centralized alerting system for production monitoring.
 *
 * Alert Thresholds (from BUILD_GUIDE):
 * - Error rate: >1% warning, >5% critical
 * - Response time: p95 >500ms warning
 * - Payment failures: >3/hour critical
 * - Dispute rate: >5% warning
 * - Invariant violations: ANY = critical
 *
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertChannel = 'log' | 'email' | 'slack' | 'pagerduty' | 'sms';
export interface Alert {
    id: string;
    type: string;
    severity: AlertSeverity;
    title: string;
    message: string;
    metadata?: Record<string, any>;
    timestamp: Date;
    acknowledged: boolean;
    acknowledgedAt?: Date;
    acknowledgedBy?: string;
}
export interface AlertThreshold {
    metric: string;
    warningThreshold: number;
    criticalThreshold: number;
    windowMinutes: number;
    comparison: 'gt' | 'lt' | 'gte' | 'lte';
}
export declare const ALERT_THRESHOLDS: AlertThreshold[];
declare class AlertingServiceClass {
    private alerts;
    private channels;
    /**
     * Configure alert channels
     */
    setChannels(channels: AlertChannel[]): void;
    /**
     * Send an alert
     */
    send(type: string, severity: AlertSeverity, title: string, message: string, metadata?: Record<string, any>): Promise<string>;
    /**
     * Send critical alert (convenience method)
     */
    critical(type: string, title: string, message: string, metadata?: Record<string, any>): Promise<string>;
    /**
     * Send warning alert (convenience method)
     */
    warning(type: string, title: string, message: string, metadata?: Record<string, any>): Promise<string>;
    /**
     * Send info alert (convenience method)
     */
    info(type: string, title: string, message: string, metadata?: Record<string, any>): Promise<string>;
    /**
     * Alert for invariant violation (ALWAYS CRITICAL)
     */
    invariantViolation(invariantId: string, details: string, metadata?: Record<string, any>): Promise<string>;
    /**
     * Alert for payment failure
     */
    paymentFailure(taskId: string, error: string, metadata?: Record<string, any>): Promise<string>;
    /**
     * Acknowledge an alert
     */
    acknowledge(alertId: string, acknowledgedBy: string): Promise<boolean>;
    /**
     * Get unacknowledged alerts
     */
    getUnacknowledged(severity?: AlertSeverity): Promise<Alert[]>;
    /**
     * Check thresholds and send alerts
     */
    checkThresholds(metrics: Record<string, number>): Promise<void>;
    private compareValue;
    private persistAlert;
    private sendToChannels;
    private sendEmail;
    private sendSlack;
    private sendPagerDuty;
    private sendSMS;
    private rowToAlert;
}
export declare const AlertingService: AlertingServiceClass;
export {};
//# sourceMappingURL=AlertingService.d.ts.map