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

import { serviceLogger } from '../utils/logger.js';
import { env } from '../config/env.js';

const logger = serviceLogger.child({ module: 'AlertService' });

// ============================================================
// TYPES
// ============================================================

export type AlertSeverity = 'critical' | 'warning' | 'info';

export type AlertType =
    | 'KILLSWITCH_ACTIVATED'
    | 'SAGA_STUCK'
    | 'ESCROW_TIMEOUT_ACTION'
    | 'STRIPE_WEBHOOK_FAILURE_SPIKE'
    | 'LEDGER_DRIFT_DETECTED'
    | 'SAGA_RECOVERY_EXHAUSTED'
    | 'PAYOUT_FAILED';

interface AlertPayload {
    type: AlertType;
    severity: AlertSeverity;
    title: string;
    message: string;
    metadata?: Record<string, any>;
    timestamp: Date;
}

interface AlertResult {
    success: boolean;
    channels: {
        pagerduty: boolean;
        slack: boolean;
        logged: boolean;
    };
    errors: string[];
}

// ============================================================
// SEVERITY MAPPING
// ============================================================

const SEVERITY_MAP: Record<AlertType, AlertSeverity> = {
    'KILLSWITCH_ACTIVATED': 'critical',
    'SAGA_STUCK': 'critical',
    'SAGA_RECOVERY_EXHAUSTED': 'critical',
    'LEDGER_DRIFT_DETECTED': 'critical',
    'STRIPE_WEBHOOK_FAILURE_SPIKE': 'critical',
    'PAYOUT_FAILED': 'warning',
    'ESCROW_TIMEOUT_ACTION': 'warning'
};

const TITLE_MAP: Record<AlertType, string> = {
    'KILLSWITCH_ACTIVATED': '🚨 KILLSWITCH ACTIVATED - ALL MONEY MOVEMENT STOPPED',
    'SAGA_STUCK': '🔴 SAGA STUCK IN EXECUTING STATE',
    'SAGA_RECOVERY_EXHAUSTED': '🔴 SAGA RECOVERY EXHAUSTED - KILLSWITCH TRIGGERED',
    'LEDGER_DRIFT_DETECTED': '🔴 LEDGER DRIFT DETECTED - RECONCILIATION FAILED',
    'STRIPE_WEBHOOK_FAILURE_SPIKE': '🔴 STRIPE WEBHOOK FAILURE SPIKE',
    'PAYOUT_FAILED': '⚠️ PAYOUT FAILED',
    'ESCROW_TIMEOUT_ACTION': '⚠️ ESCROW TIMEOUT ACTION TAKEN'
};

// ============================================================
// ALERT SERVICE
// ============================================================

export class AlertService {
    private static pagerdutyKey = process.env.PAGERDUTY_ROUTING_KEY;
    private static slackWebhook = process.env.SLACK_ALERT_WEBHOOK;
    private static alertEmail = process.env.ALERT_EMAIL;

    /**
     * FIRE ALERT
     * 
     * Logs first, then attempts delivery to all configured channels.
     * Delivery failure does not throw - caller is never blocked.
     */
    static async fire(
        type: AlertType,
        message: string,
        metadata?: Record<string, any>
    ): Promise<AlertResult> {
        const payload: AlertPayload = {
            type,
            severity: SEVERITY_MAP[type] || 'warning',
            title: TITLE_MAP[type] || type,
            message,
            metadata,
            timestamp: new Date()
        };

        const result: AlertResult = {
            success: false,
            channels: {
                pagerduty: false,
                slack: false,
                logged: false
            },
            errors: []
        };

        // 1. ALWAYS LOG FIRST (never fails)
        this.logAlert(payload);
        result.channels.logged = true;

        // 2. Attempt all channels in parallel
        const [pagerdutyResult, slackResult] = await Promise.allSettled([
            this.sendPagerDuty(payload),
            this.sendSlack(payload)
        ]);

        if (pagerdutyResult.status === 'fulfilled' && pagerdutyResult.value) {
            result.channels.pagerduty = true;
        } else if (pagerdutyResult.status === 'rejected') {
            result.errors.push(`PagerDuty: ${pagerdutyResult.reason}`);
        }

        if (slackResult.status === 'fulfilled' && slackResult.value) {
            result.channels.slack = true;
        } else if (slackResult.status === 'rejected') {
            result.errors.push(`Slack: ${slackResult.reason}`);
        }

        // Success if at least one delivery channel worked (beyond logging)
        result.success = result.channels.pagerduty || result.channels.slack;

        if (!result.success) {
            logger.error({
                type,
                errors: result.errors
            }, 'ALERT DELIVERY FAILED TO ALL CHANNELS - CHECK CONFIGURATION');
        }

        return result;
    }

    /**
     * FIRE CRITICAL - Convenience method
     */
    static async fireCritical(
        type: AlertType,
        message: string,
        metadata?: Record<string, any>
    ): Promise<AlertResult> {
        return this.fire(type, message, metadata);
    }

    // -----------------------------------------------------------
    // INTERNAL: Logging
    // -----------------------------------------------------------

    private static logAlert(payload: AlertPayload): void {
        const logFn = payload.severity === 'critical'
            ? logger.fatal.bind(logger)
            : payload.severity === 'warning'
                ? logger.warn.bind(logger)
                : logger.info.bind(logger);

        logFn({
            alertType: payload.type,
            severity: payload.severity,
            title: payload.title,
            message: payload.message,
            metadata: payload.metadata,
            timestamp: payload.timestamp.toISOString()
        }, `[ALERT] ${payload.title}`);
    }

    // -----------------------------------------------------------
    // INTERNAL: PagerDuty
    // -----------------------------------------------------------

    private static async sendPagerDuty(payload: AlertPayload): Promise<boolean> {
        if (!this.pagerdutyKey) {
            logger.debug('PagerDuty not configured, skipping');
            return false;
        }

        try {
            const response = await fetch('https://events.pagerduty.com/v2/enqueue', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    routing_key: this.pagerdutyKey,
                    event_action: 'trigger',
                    dedup_key: `${payload.type}-${Date.now()}`,
                    payload: {
                        summary: payload.title,
                        severity: payload.severity === 'critical' ? 'critical' : 'warning',
                        source: 'HustleXP-Backend',
                        custom_details: {
                            type: payload.type,
                            message: payload.message,
                            ...payload.metadata
                        }
                    }
                })
            });

            if (!response.ok) {
                throw new Error(`PagerDuty returned ${response.status}`);
            }

            logger.info({ type: payload.type }, 'PagerDuty alert sent');
            return true;
        } catch (error) {
            logger.error({ error, type: payload.type }, 'PagerDuty delivery failed');
            return false;
        }
    }

    // -----------------------------------------------------------
    // INTERNAL: Slack
    // -----------------------------------------------------------

    private static async sendSlack(payload: AlertPayload): Promise<boolean> {
        if (!this.slackWebhook) {
            logger.debug('Slack webhook not configured, skipping');
            return false;
        }

        const color = payload.severity === 'critical' ? '#FF0000'
            : payload.severity === 'warning' ? '#FFA500'
                : '#36A64F';

        try {
            const response = await fetch(this.slackWebhook, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    attachments: [{
                        color,
                        title: payload.title,
                        text: payload.message,
                        fields: [
                            {
                                title: 'Type',
                                value: payload.type,
                                short: true
                            },
                            {
                                title: 'Severity',
                                value: payload.severity.toUpperCase(),
                                short: true
                            },
                            {
                                title: 'Timestamp',
                                value: payload.timestamp.toISOString(),
                                short: true
                            }
                        ],
                        footer: 'HustleXP Alert System'
                    }]
                })
            });

            if (!response.ok) {
                throw new Error(`Slack returned ${response.status}`);
            }

            logger.info({ type: payload.type }, 'Slack alert sent');
            return true;
        } catch (error) {
            logger.error({ error, type: payload.type }, 'Slack delivery failed');
            return false;
        }
    }

    // -----------------------------------------------------------
    // TEST METHODS
    // -----------------------------------------------------------

    /**
     * Send a test alert to verify configuration
     */
    static async sendTestAlert(): Promise<AlertResult> {
        return this.fire(
            'ESCROW_TIMEOUT_ACTION',
            'This is a test alert from HustleXP. If you see this, alerts are working.',
            { test: true, env: env.mode || 'unknown' }
        );
    }

    /**
     * Check which channels are configured
     */
    static getConfiguredChannels(): { pagerduty: boolean; slack: boolean } {
        return {
            pagerduty: !!this.pagerdutyKey,
            slack: !!this.slackWebhook
        };
    }
}
