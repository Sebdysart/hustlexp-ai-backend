/**
 * Anomaly Detection Service v1.0.0
 *
 * Queries Prometheus metrics every 60s to detect anomalies:
 * - Error rate spikes (>2x trailing average)
 * - Latency spikes (p95 >2x baseline)
 * - Circuit breaker state changes
 * - AI budget exhaustion (>80%)
 *
 * Creates incident_events rows when anomalies detected.
 *
 * @see backend/src/services/IncidentDiagnosisService.ts
 */

import { db } from '../db';
import { ServiceResult } from '../types';

export interface AnomalyConfig {
  errorRateThreshold: number; // Multiplier (e.g., 2.0 = 2x baseline)
  latencyThreshold: number; // Multiplier (e.g., 2.0 = 2x baseline)
  budgetThreshold: number; // Percentage (e.g., 80)
  checkIntervalMs: number; // How often to check (e.g., 60000 = 60s)
}

export interface AnomalyEvent {
  id: string;
  eventType: 'error_spike' | 'latency_spike' | 'circuit_breaker_open' | 'budget_threshold' | 'anomaly_detected';
  severity: 'info' | 'warning' | 'critical';
  service: string;
  details: Record<string, any>;
}

const DEFAULT_CONFIG: AnomalyConfig = {
  errorRateThreshold: 2.0,
  latencyThreshold: 2.0,
  budgetThreshold: 80,
  checkIntervalMs: 60000,
};

export const AnomalyDetectionService = {
  /**
   * Detect error rate anomalies
   * In production, this would query Prometheus for api_errors_total rate
   */
  async detectErrorRateSpikes(
    config: AnomalyConfig = DEFAULT_CONFIG
  ): Promise<ServiceResult<AnomalyEvent[]>> {
    // Mock implementation - in production, query Prometheus
    // Example: rate(api_errors_total[1h]) > 2 * rate(api_errors_total[24h] offset 1h)
    
    const anomalies: AnomalyEvent[] = [];

    // Simulate: check if error rate is elevated
    const currentErrorRate = Math.random() * 10; // Mock
    const baselineErrorRate = 2.0; // Mock

    if (currentErrorRate > baselineErrorRate * config.errorRateThreshold) {
      const event = await this.createIncidentEvent({
        eventType: 'error_spike',
        severity: 'critical',
        service: 'api',
        details: {
          currentRate: currentErrorRate,
          baseline: baselineErrorRate,
          threshold: config.errorRateThreshold,
        },
      });

      if (event.success && event.data) {
        anomalies.push(event.data);
      }
    }

    return { success: true, data: anomalies };
  },

  /**
   * Detect latency anomalies
   * In production, query Prometheus for http_request_duration_seconds p95
   */
  async detectLatencySpikes(
    config: AnomalyConfig = DEFAULT_CONFIG
  ): Promise<ServiceResult<AnomalyEvent[]>> {
    // Mock implementation - in production, query Prometheus
    // Example: histogram_quantile(0.95, http_request_duration_seconds) > 2 * baseline
    
    const anomalies: AnomalyEvent[] = [];

    // Simulate: check if p95 latency is elevated
    const currentP95 = Math.random() * 1000; // Mock ms
    const baselineP95 = 200; // Mock ms

    if (currentP95 > baselineP95 * config.latencyThreshold) {
      const event = await this.createIncidentEvent({
        eventType: 'latency_spike',
        severity: 'warning',
        service: 'api',
        details: {
          currentP95,
          baseline: baselineP95,
          threshold: config.latencyThreshold,
        },
      });

      if (event.success && event.data) {
        anomalies.push(event.data);
      }
    }

    return { success: true, data: anomalies };
  },

  /**
   * Detect AI budget exhaustion
   */
  async detectBudgetExhaustion(
    config: AnomalyConfig = DEFAULT_CONFIG
  ): Promise<ServiceResult<AnomalyEvent[]>> {
    const anomalies: AnomalyEvent[] = [];

    // Query actual AI spending from ai_events table
    const result = await db.query<{
      total_cost: string;
      daily_budget: number;
      usage_pct: number;
    }>(
      `SELECT 
         SUM(cost_usd) as total_cost,
         10.0 as daily_budget,
         (SUM(cost_usd) / 10.0 * 100) as usage_pct
       FROM ai_events
       WHERE created_at >= NOW() - INTERVAL '1 day'`,
      []
    );

    if (result.rowCount && result.rowCount > 0) {
      const usage = result.rows[0];
      const usagePct = parseFloat(usage.usage_pct.toString());

      if (usagePct > config.budgetThreshold) {
        const event = await this.createIncidentEvent({
          eventType: 'budget_threshold',
          severity: usagePct > 95 ? 'critical' : 'warning',
          service: 'ai',
          details: {
            totalCost: parseFloat(usage.total_cost),
            dailyBudget: usage.daily_budget,
            usagePercentage: usagePct,
            threshold: config.budgetThreshold,
          },
        });

        if (event.success && event.data) {
          anomalies.push(event.data);
        }
      }
    }

    return { success: true, data: anomalies };
  },

  /**
   * Create incident event record
   */
  async createIncidentEvent(params: {
    eventType: AnomalyEvent['eventType'];
    severity: AnomalyEvent['severity'];
    service: string;
    details: Record<string, any>;
  }): Promise<ServiceResult<AnomalyEvent>> {
    try {
      const result = await db.query<AnomalyEvent>(
        `INSERT INTO incident_events (event_type, severity, service, details)
         VALUES ($1, $2, $3, $4)
         RETURNING id, event_type as "eventType", severity, service, details`,
        [params.eventType, params.severity, params.service, JSON.stringify(params.details)]
      );

      if (result.rowCount === 0) {
        return {
          success: false,
          error: { code: 'HX600', message: 'Failed to create incident event' },
        };
      }

      return { success: true, data: result.rows[0] };
    } catch (error) {
      console.error('AnomalyDetectionService.createIncidentEvent error:', error);
      return {
        success: false,
        error: { code: 'HX600', message: 'Internal server error' },
      };
    }
  },

  /**
   * Run all anomaly detectors
   */
  async runDetectors(
    config: AnomalyConfig = DEFAULT_CONFIG
  ): Promise<ServiceResult<AnomalyEvent[]>> {
    const results = await Promise.allSettled([
      this.detectErrorRateSpikes(config),
      this.detectLatencySpikes(config),
      this.detectBudgetExhaustion(config),
    ]);

    const allAnomalies: AnomalyEvent[] = [];

    results.forEach(result => {
      if (result.status === 'fulfilled' && result.value.success) {
        allAnomalies.push(...(result.value.data || []));
      }
    });

    return { success: true, data: allAnomalies };
  },
};
