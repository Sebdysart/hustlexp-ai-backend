/**
 * AnomalyDetectionService v1.0.0
 *
 * Stateless threshold-based anomaly detection.
 * Each method checks current values against baselines and returns an AnomalyResult.
 * Use recordAnomaly() to persist detected anomalies to the incident_events table.
 *
 * @see migrations/20260222_008_incident_events.sql
 */

import { db } from '../db';
import { aiLogger } from '../logger';
import type { ServiceResult } from '../types';

const log = aiLogger.child({ service: 'AnomalyDetectionService' });

// ============================================================================
// TYPES
// ============================================================================

export interface AnomalyResult {
  detected: boolean;
  eventType: 'error_spike' | 'latency_spike' | 'circuit_open' | 'budget_alert';
  severity: 'info' | 'warning' | 'critical';
  service: string;
  details: Record<string, unknown>;
  message: string;
}

// ============================================================================
// DETECTION METHODS
// ============================================================================

/**
 * Detect error rate spike: current > 2x baseline.
 * Returns not-detected if baseline is 0 (avoid division by zero).
 */
export function checkErrorRateSpike(currentRate: number, baselineRate: number): AnomalyResult {
  const notDetected: AnomalyResult = {
    detected: false,
    eventType: 'error_spike',
    severity: 'info',
    service: 'api',
    details: { currentRate, baselineRate },
    message: 'Error rate within normal range',
  };

  if (baselineRate <= 0) return notDetected;

  const ratio = currentRate / baselineRate;
  if (ratio > 2) {
    return {
      detected: true,
      eventType: 'error_spike',
      severity: ratio > 5 ? 'critical' : 'warning',
      service: 'api',
      details: { currentRate, baselineRate, ratio },
      message: `Error rate spike: ${currentRate.toFixed(2)} (${ratio.toFixed(1)}x baseline of ${baselineRate.toFixed(2)})`,
    };
  }

  return notDetected;
}

/**
 * Detect P95 latency spike: current > 2x baseline.
 */
export function checkLatencySpike(currentP95: number, baselineP95: number): AnomalyResult {
  const notDetected: AnomalyResult = {
    detected: false,
    eventType: 'latency_spike',
    severity: 'info',
    service: 'api',
    details: { currentP95, baselineP95 },
    message: 'Latency within normal range',
  };

  if (baselineP95 <= 0) return notDetected;

  const ratio = currentP95 / baselineP95;
  if (ratio > 2) {
    return {
      detected: true,
      eventType: 'latency_spike',
      severity: ratio > 5 ? 'critical' : 'warning',
      service: 'api',
      details: { currentP95, baselineP95, ratio },
      message: `P95 latency spike: ${currentP95}ms (${ratio.toFixed(1)}x baseline of ${baselineP95}ms)`,
    };
  }

  return notDetected;
}

/**
 * Detect circuit breaker in OPEN state — always critical.
 */
export function checkCircuitBreakerOpen(service: string, state: string): AnomalyResult {
  if (state === 'OPEN') {
    return {
      detected: true,
      eventType: 'circuit_open',
      severity: 'critical',
      service,
      details: { state },
      message: `Circuit breaker OPEN for ${service}`,
    };
  }

  return {
    detected: false,
    eventType: 'circuit_open',
    severity: 'info',
    service,
    details: { state },
    message: `Circuit breaker ${state} for ${service}`,
  };
}

/**
 * Detect budget exhaustion: warning at >80%, critical at >95%.
 */
export function checkBudgetExhaustion(currentSpend: number, dailyBudget: number): AnomalyResult {
  const notDetected: AnomalyResult = {
    detected: false,
    eventType: 'budget_alert',
    severity: 'info',
    service: 'ai',
    details: { currentSpend, dailyBudget },
    message: 'AI budget within normal range',
  };

  if (dailyBudget <= 0) return notDetected;

  const utilization = currentSpend / dailyBudget;
  if (utilization > 0.95) {
    return {
      detected: true,
      eventType: 'budget_alert',
      severity: 'critical',
      service: 'ai',
      details: { currentSpend, dailyBudget, utilizationPercent: Math.round(utilization * 100) },
      message: `AI budget critical: ${Math.round(utilization * 100)}% of daily budget consumed`,
    };
  }

  if (utilization > 0.8) {
    return {
      detected: true,
      eventType: 'budget_alert',
      severity: 'warning',
      service: 'ai',
      details: { currentSpend, dailyBudget, utilizationPercent: Math.round(utilization * 100) },
      message: `AI budget warning: ${Math.round(utilization * 100)}% of daily budget consumed`,
    };
  }

  return notDetected;
}

// ============================================================================
// PERSISTENCE
// ============================================================================

/**
 * Record a detected anomaly to the incident_events table.
 */
export async function recordAnomaly(anomaly: AnomalyResult): Promise<ServiceResult<{ id: string }>> {
  try {
    const result = await db.query<{ id: string }>(
      `INSERT INTO incident_events (event_type, severity, service, details)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [anomaly.eventType, anomaly.severity, anomaly.service, JSON.stringify(anomaly.details)]
    );

    const id = result.rows[0].id;
    log.info({ id, eventType: anomaly.eventType, severity: anomaly.severity }, anomaly.message);

    return { success: true, data: { id } };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error({ err: message }, 'Failed to record anomaly');
    return { success: false, error: { code: 'RECORD_ANOMALY_FAILED', message } };
  }
}

// ============================================================================
// EXPORT
// ============================================================================

export const AnomalyDetectionService = {
  checkErrorRateSpike,
  checkLatencySpike,
  checkCircuitBreakerOpen,
  checkBudgetExhaustion,
  recordAnomaly,
};

export default AnomalyDetectionService;
