/**
 * MONITORING SERVICE (BUILD_GUIDE Phase 6)
 * 
 * Collects and tracks production metrics for alerting.
 * 
 * Metrics Tracked (from BUILD_GUIDE):
 * - Error rate
 * - Response time (p95)
 * - Payment failures
 * - Dispute rate
 * - Database health
 * - Webhook delivery
 * - Invariant violations
 * 
 * @version 1.0.0 (BUILD_GUIDE aligned)
 */

import { getSql } from '../db/index.js';
import { createLogger } from '../utils/logger.js';
import { AlertingService } from './AlertingService.js';
import { PrometheusMetrics } from './metrics/Prometheus.js';

const logger = createLogger('MonitoringService');

// ============================================================================
// TYPES
// ============================================================================

export interface MetricsSnapshot {
  timestamp: Date;
  error_rate: number;
  response_time_p95: number;
  payment_failures_per_hour: number;
  dispute_rate: number;
  invariant_violations: number;
  db_connection_healthy: boolean;
  webhook_delivery_rate: number;
  active_tasks: number;
  pending_payouts: number;
  queue_depth: number;
}

interface RequestMetric {
  timestamp: number;
  duration: number;
  success: boolean;
  endpoint: string;
}

// ============================================================================
// MONITORING SERVICE
// ============================================================================

class MonitoringServiceClass {
  private requestMetrics: RequestMetric[] = [];
  private readonly MAX_METRICS_AGE_MS = 5 * 60 * 1000; // 5 minutes
  private readonly MAX_METRICS_COUNT = 10000;
  
  /**
   * Record a request metric
   */
  recordRequest(endpoint: string, durationMs: number, success: boolean): void {
    const metric: RequestMetric = {
      timestamp: Date.now(),
      duration: durationMs,
      success,
      endpoint,
    };
    
    this.requestMetrics.push(metric);
    
    // Cleanup old metrics
    this.pruneOldMetrics();
    
    // Update Prometheus
    PrometheusMetrics.increment('http_requests_total', { endpoint, success: String(success) });
    if (!success) {
      PrometheusMetrics.increment('http_errors_total', { endpoint });
    }
  }
  
  /**
   * Record an invariant violation (ALWAYS CRITICAL)
   */
  async recordInvariantViolation(invariantId: string, details: string): Promise<void> {
    const sql = getSql();
    
    // Log to database
    await sql`
      INSERT INTO invariant_violations (invariant_id, details, created_at)
      VALUES (${invariantId}, ${details}, NOW())
    `;
    
    // Send critical alert
    await AlertingService.invariantViolation(invariantId, details);
    
    // Update Prometheus
    PrometheusMetrics.increment('invariant_violations_total', { invariant: invariantId });
  }
  
  /**
   * Record a payment failure
   */
  async recordPaymentFailure(taskId: string, error: string): Promise<void> {
    const sql = getSql();
    
    await sql`
      INSERT INTO payment_failures (task_id, error, created_at)
      VALUES (${taskId}, ${error}, NOW())
    `;
    
    PrometheusMetrics.increment('payment_failures_total');
    
    // Check if we should alert (>3/hour = critical)
    const [count] = await sql`
      SELECT COUNT(*)::int as cnt FROM payment_failures
      WHERE created_at > NOW() - INTERVAL '1 hour'
    `;
    
    if (count.cnt >= 3) {
      await AlertingService.paymentFailure(taskId, error, { hourlyCount: count.cnt });
    }
  }
  
  /**
   * Get current metrics snapshot
   */
  async getMetricsSnapshot(): Promise<MetricsSnapshot> {
    const sql = getSql();
    const now = Date.now();
    const fiveMinutesAgo = now - this.MAX_METRICS_AGE_MS;
    
    // Calculate error rate
    const recentRequests = this.requestMetrics.filter(m => m.timestamp > fiveMinutesAgo);
    const errorRate = recentRequests.length > 0
      ? (recentRequests.filter(m => !m.success).length / recentRequests.length) * 100
      : 0;
    
    // Calculate p95 response time
    const durations = recentRequests.map(m => m.duration).sort((a, b) => a - b);
    const p95Index = Math.floor(durations.length * 0.95);
    const responseTimeP95 = durations[p95Index] || 0;
    
    // Get payment failures per hour
    const [paymentFailures] = await sql`
      SELECT COUNT(*)::int as cnt FROM payment_failures
      WHERE created_at > NOW() - INTERVAL '1 hour'
    `;
    
    // Get dispute rate (24 hours)
    const [disputeStats] = await sql`
      SELECT 
        COUNT(*) FILTER (WHERE status LIKE 'disputed%')::int as disputed,
        COUNT(*)::int as total
      FROM tasks
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `;
    const disputeRate = disputeStats.total > 0
      ? (disputeStats.disputed / disputeStats.total) * 100
      : 0;
    
    // Get invariant violations
    const [violations] = await sql`
      SELECT COUNT(*)::int as cnt FROM invariant_violations
      WHERE created_at > NOW() - INTERVAL '5 minutes'
    `;
    
    // Check DB health
    let dbHealthy = true;
    try {
      await sql`SELECT 1`;
    } catch {
      dbHealthy = false;
    }
    
    // Get webhook delivery rate
    const [webhookStats] = await sql`
      SELECT 
        COUNT(*) FILTER (WHERE processed_at IS NOT NULL)::int as processed,
        COUNT(*)::int as total
      FROM stripe_events
      WHERE created_at > NOW() - INTERVAL '1 hour'
    `;
    const webhookDeliveryRate = webhookStats.total > 0
      ? (webhookStats.processed / webhookStats.total) * 100
      : 100;
    
    // Get active tasks
    const [activeTasks] = await sql`
      SELECT COUNT(*)::int as cnt FROM tasks
      WHERE status IN ('open', 'accepted', 'proof_submitted')
    `;
    
    // Get pending payouts
    const [pendingPayouts] = await sql`
      SELECT COUNT(*)::int as cnt FROM money_state_lock
      WHERE current_state = 'funded'
    `;
    
    // Get queue depth
    const [queueDepth] = await sql`
      SELECT COUNT(*)::int as cnt FROM job_queue
      WHERE status = 'pending'
    `;
    
    return {
      timestamp: new Date(),
      error_rate: errorRate,
      response_time_p95: responseTimeP95,
      payment_failures_per_hour: paymentFailures.cnt,
      dispute_rate: disputeRate,
      invariant_violations: violations.cnt,
      db_connection_healthy: dbHealthy,
      webhook_delivery_rate: webhookDeliveryRate,
      active_tasks: activeTasks.cnt,
      pending_payouts: pendingPayouts.cnt,
      queue_depth: queueDepth.cnt,
    };
  }
  
  /**
   * Run monitoring check and alert if needed
   */
  async runCheck(): Promise<MetricsSnapshot> {
    const metrics = await this.getMetricsSnapshot();
    
    // Update Prometheus gauges
    PrometheusMetrics.setGauge('error_rate', {}, metrics.error_rate);
    PrometheusMetrics.setGauge('response_time_p95', {}, metrics.response_time_p95);
    PrometheusMetrics.setGauge('payment_failures_hourly', {}, metrics.payment_failures_per_hour);
    PrometheusMetrics.setGauge('dispute_rate', {}, metrics.dispute_rate);
    PrometheusMetrics.setGauge('active_tasks', {}, metrics.active_tasks);
    PrometheusMetrics.setGauge('pending_payouts', {}, metrics.pending_payouts);
    PrometheusMetrics.setGauge('job_queue_depth', {}, metrics.queue_depth);
    
    // Check thresholds and alert
    await AlertingService.checkThresholds({
      error_rate: metrics.error_rate,
      response_time_p95: metrics.response_time_p95,
      payment_failures_per_hour: metrics.payment_failures_per_hour,
      dispute_rate: metrics.dispute_rate,
      invariant_violations: metrics.invariant_violations,
    });
    
    // Check DB health
    if (!metrics.db_connection_healthy) {
      await AlertingService.critical(
        'db_connection',
        'Database Connection Failed',
        'Cannot connect to database'
      );
    }
    
    // Check webhook delivery
    if (metrics.webhook_delivery_rate < 95) {
      await AlertingService.warning(
        'webhook_delivery',
        'Webhook Delivery Degraded',
        `Webhook delivery rate is ${metrics.webhook_delivery_rate.toFixed(1)}%`
      );
    }
    
    logger.info({
      errorRate: metrics.error_rate.toFixed(2),
      p95: metrics.response_time_p95,
      paymentFailures: metrics.payment_failures_per_hour,
      disputeRate: metrics.dispute_rate.toFixed(2),
      queueDepth: metrics.queue_depth,
    }, 'Monitoring check complete');
    
    return metrics;
  }
  
  /**
   * Prune old metrics from memory
   */
  private pruneOldMetrics(): void {
    const cutoff = Date.now() - this.MAX_METRICS_AGE_MS;
    
    // Remove old metrics
    this.requestMetrics = this.requestMetrics.filter(m => m.timestamp > cutoff);
    
    // Cap total count
    if (this.requestMetrics.length > this.MAX_METRICS_COUNT) {
      this.requestMetrics = this.requestMetrics.slice(-this.MAX_METRICS_COUNT);
    }
  }
}

export const MonitoringService = new MonitoringServiceClass();
