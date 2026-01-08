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

import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('AlertingService');

// ============================================================================
// TYPES
// ============================================================================

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

// ============================================================================
// THRESHOLDS (FROM BUILD_GUIDE)
// ============================================================================

export const ALERT_THRESHOLDS: AlertThreshold[] = [
  {
    metric: 'error_rate',
    warningThreshold: 1,    // >1% = warning
    criticalThreshold: 5,   // >5% = critical
    windowMinutes: 5,
    comparison: 'gt',
  },
  {
    metric: 'response_time_p95',
    warningThreshold: 500,  // >500ms = warning
    criticalThreshold: 1000, // >1000ms = critical
    windowMinutes: 5,
    comparison: 'gt',
  },
  {
    metric: 'payment_failures_per_hour',
    warningThreshold: 2,    // >2 = warning
    criticalThreshold: 3,   // >3/hour = critical
    windowMinutes: 60,
    comparison: 'gt',
  },
  {
    metric: 'dispute_rate',
    warningThreshold: 3,    // >3% = warning
    criticalThreshold: 5,   // >5% = warning (BUILD_GUIDE)
    windowMinutes: 1440,    // 24 hours
    comparison: 'gt',
  },
  {
    metric: 'invariant_violations',
    warningThreshold: 0,    // ANY = critical
    criticalThreshold: 0,   // ANY = critical
    windowMinutes: 1,
    comparison: 'gt',
  },
];

// ============================================================================
// ALERTING SERVICE
// ============================================================================

class AlertingServiceClass {
  private alerts: Map<string, Alert> = new Map();
  private channels: AlertChannel[] = ['log'];
  
  /**
   * Configure alert channels
   */
  setChannels(channels: AlertChannel[]): void {
    this.channels = channels;
  }
  
  /**
   * Send an alert
   */
  async send(
    type: string,
    severity: AlertSeverity,
    title: string,
    message: string,
    metadata?: Record<string, any>
  ): Promise<string> {
    const alertId = `alert-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    
    const alert: Alert = {
      id: alertId,
      type,
      severity,
      title,
      message,
      metadata,
      timestamp: new Date(),
      acknowledged: false,
    };
    
    this.alerts.set(alertId, alert);
    
    // Log always
    const logMethod = severity === 'critical' ? 'error' : severity === 'warning' ? 'warn' : 'info';
    logger[logMethod]({
      alertId,
      type,
      severity,
      title,
      ...metadata,
    }, message);
    
    // Persist to database
    await this.persistAlert(alert);
    
    // Send to configured channels
    await this.sendToChannels(alert);
    
    return alertId;
  }
  
  /**
   * Send critical alert (convenience method)
   */
  async critical(type: string, title: string, message: string, metadata?: Record<string, any>): Promise<string> {
    return this.send(type, 'critical', title, message, metadata);
  }
  
  /**
   * Send warning alert (convenience method)
   */
  async warning(type: string, title: string, message: string, metadata?: Record<string, any>): Promise<string> {
    return this.send(type, 'warning', title, message, metadata);
  }
  
  /**
   * Send info alert (convenience method)
   */
  async info(type: string, title: string, message: string, metadata?: Record<string, any>): Promise<string> {
    return this.send(type, 'info', title, message, metadata);
  }
  
  /**
   * Alert for invariant violation (ALWAYS CRITICAL)
   */
  async invariantViolation(
    invariantId: string,
    details: string,
    metadata?: Record<string, any>
  ): Promise<string> {
    return this.critical(
      'invariant_violation',
      `INVARIANT VIOLATION: ${invariantId}`,
      `Constitutional invariant ${invariantId} was violated: ${details}`,
      { invariantId, ...metadata }
    );
  }
  
  /**
   * Alert for payment failure
   */
  async paymentFailure(
    taskId: string,
    error: string,
    metadata?: Record<string, any>
  ): Promise<string> {
    return this.critical(
      'payment_failure',
      'Payment Processing Failed',
      `Payment failed for task ${taskId}: ${error}`,
      { taskId, error, ...metadata }
    );
  }
  
  /**
   * Acknowledge an alert
   */
  async acknowledge(alertId: string, acknowledgedBy: string): Promise<boolean> {
    const sql = getSql();
    const alert = this.alerts.get(alertId);
    
    if (alert) {
      alert.acknowledged = true;
      alert.acknowledgedAt = new Date();
      alert.acknowledgedBy = acknowledgedBy;
    }
    
    await sql`
      UPDATE alerts
      SET acknowledged = true, acknowledged_at = NOW(), acknowledged_by = ${acknowledgedBy}
      WHERE id = ${alertId}
    `;
    
    return true;
  }
  
  /**
   * Get unacknowledged alerts
   */
  async getUnacknowledged(severity?: AlertSeverity): Promise<Alert[]> {
    const sql = getSql();
    
    const rows = severity
      ? await sql`
          SELECT * FROM alerts
          WHERE acknowledged = false AND severity = ${severity}
          ORDER BY timestamp DESC
        `
      : await sql`
          SELECT * FROM alerts
          WHERE acknowledged = false
          ORDER BY timestamp DESC
        `;
    
    return rows.map(this.rowToAlert);
  }
  
  /**
   * Check thresholds and send alerts
   */
  async checkThresholds(metrics: Record<string, number>): Promise<void> {
    for (const threshold of ALERT_THRESHOLDS) {
      const value = metrics[threshold.metric];
      
      if (value === undefined) continue;
      
      const exceedsCritical = this.compareValue(value, threshold.criticalThreshold, threshold.comparison);
      const exceedsWarning = this.compareValue(value, threshold.warningThreshold, threshold.comparison);
      
      if (exceedsCritical) {
        await this.critical(
          `threshold_${threshold.metric}`,
          `Critical: ${threshold.metric} exceeded threshold`,
          `${threshold.metric} is ${value}, threshold is ${threshold.criticalThreshold}`,
          { metric: threshold.metric, value, threshold: threshold.criticalThreshold }
        );
      } else if (exceedsWarning) {
        await this.warning(
          `threshold_${threshold.metric}`,
          `Warning: ${threshold.metric} approaching threshold`,
          `${threshold.metric} is ${value}, warning threshold is ${threshold.warningThreshold}`,
          { metric: threshold.metric, value, threshold: threshold.warningThreshold }
        );
      }
    }
  }
  
  // ==========================================================================
  // PRIVATE METHODS
  // ==========================================================================
  
  private compareValue(value: number, threshold: number, comparison: string): boolean {
    switch (comparison) {
      case 'gt': return value > threshold;
      case 'lt': return value < threshold;
      case 'gte': return value >= threshold;
      case 'lte': return value <= threshold;
      default: return false;
    }
  }
  
  private async persistAlert(alert: Alert): Promise<void> {
    const sql = getSql();
    
    try {
      await sql`
        INSERT INTO alerts (id, type, severity, title, message, metadata, timestamp, acknowledged)
        VALUES (
          ${alert.id},
          ${alert.type},
          ${alert.severity},
          ${alert.title},
          ${alert.message},
          ${JSON.stringify(alert.metadata || {})},
          ${alert.timestamp},
          false
        )
      `;
    } catch (error) {
      logger.error({ error, alertId: alert.id }, 'Failed to persist alert');
    }
  }
  
  private async sendToChannels(alert: Alert): Promise<void> {
    for (const channel of this.channels) {
      try {
        switch (channel) {
          case 'email':
            await this.sendEmail(alert);
            break;
          case 'slack':
            await this.sendSlack(alert);
            break;
          case 'pagerduty':
            await this.sendPagerDuty(alert);
            break;
          case 'sms':
            await this.sendSMS(alert);
            break;
          // 'log' is handled in send()
        }
      } catch (error) {
        logger.error({ error, channel, alertId: alert.id }, 'Failed to send alert to channel');
      }
    }
  }
  
  private async sendEmail(alert: Alert): Promise<void> {
    // TODO: Integrate with SendGrid
    logger.info({ alertId: alert.id }, 'Email alert would be sent');
  }
  
  private async sendSlack(alert: Alert): Promise<void> {
    // TODO: Integrate with Slack webhook
    logger.info({ alertId: alert.id }, 'Slack alert would be sent');
  }
  
  private async sendPagerDuty(alert: Alert): Promise<void> {
    // TODO: Integrate with PagerDuty
    logger.info({ alertId: alert.id }, 'PagerDuty alert would be sent');
  }
  
  private async sendSMS(alert: Alert): Promise<void> {
    // TODO: Integrate with Twilio
    logger.info({ alertId: alert.id }, 'SMS alert would be sent');
  }
  
  private rowToAlert(row: any): Alert {
    return {
      id: row.id,
      type: row.type,
      severity: row.severity as AlertSeverity,
      title: row.title,
      message: row.message,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata,
      timestamp: new Date(row.timestamp),
      acknowledged: row.acknowledged,
      acknowledgedAt: row.acknowledged_at ? new Date(row.acknowledged_at) : undefined,
      acknowledgedBy: row.acknowledged_by,
    };
  }
}

export const AlertingService = new AlertingServiceClass();
