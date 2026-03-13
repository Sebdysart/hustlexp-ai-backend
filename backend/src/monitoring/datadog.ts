/**
 * Datadog APM Integration
 * 
 * Provides:
 * - Distributed tracing
 * - Custom metrics
 * - Service catalog integration
 * 
 * @see https://docs.datadoghq.com/tracing/trace_collection/custom_instrumentation/nodejs/
 */

import { StatsD } from 'node-statsd';
import { config } from '../config.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'datadog' });

// ============================================================================
// StatsD Client (for custom metrics)
// ============================================================================

let statsd: StatsD | null = null;

export function getStatsD(): StatsD | null {
  if (!config.datadog.enabled) return null;
  
  if (!statsd) {
    statsd = new StatsD({
      host: config.datadog.agentHost,
      port: config.datadog.agentPort,
      prefix: 'hustlexp.api.',
      globalTags: {
        env: config.app.env,
        service: 'hustlexp-api',
        version: process.env.npm_package_version || '1.0.0',
      },
    });

    statsd.on('error', (error) => {
      log.error({ error }, 'Datadog StatsD error');
    });
  }

  return statsd;
}

// ============================================================================
// Custom Metrics
// ============================================================================

export function increment(metric: string, tags?: Record<string, string>, value = 1): void {
  const client = getStatsD();
  if (!client) return;

  const tagArray = tags ? Object.entries(tags).map(([k, v]) => `${k}:${v}`) : [];
  client.increment(metric, value, 1, tagArray);
}

export function timing(metric: string, value: number, tags?: Record<string, string>): void {
  const client = getStatsD();
  if (!client) return;

  const tagArray = tags ? Object.entries(tags).map(([k, v]) => `${k}:${v}`) : [];
  client.timing(metric, value, 1, tagArray);
}

export function gauge(metric: string, value: number, tags?: Record<string, string>): void {
  const client = getStatsD();
  if (!client) return;

  const tagArray = tags ? Object.entries(tags).map(([k, v]) => `${k}:${v}`) : [];
  client.gauge(metric, value, 1, tagArray);
}

export function histogram(metric: string, value: number, tags?: Record<string, string>): void {
  const client = getStatsD();
  if (!client) return;

  const tagArray = tags ? Object.entries(tags).map(([k, v]) => `${k}:${v}`) : [];
  client.histogram(metric, value, 1, tagArray);
}

// ============================================================================
// Business Metrics
// ============================================================================

export function trackTaskCreated(taskType: string, valueCents: number): void {
  increment('tasks.created', { type: taskType });
  histogram('tasks.value', valueCents / 100, { type: taskType });
}

export function taskCompleted(duration: number, taskType: string): void {
  timing('tasks.duration', duration, { type: taskType });
  increment('tasks.completed', { type: taskType });
}

export function trackPayment(amountCents: number, type: 'escrow' | 'payout' | 'refund'): void {
  increment('payments', { type });
  histogram('payments.amount', amountCents / 100, { type });
}

export function trackAIRequest(agentType: string, provider: string, tokensUsed: number, latencyMs: number, costCents: number): void {
  increment('ai.requests', { agent: agentType, provider });
  timing('ai.latency', latencyMs, { agent: agentType, provider });
  histogram('ai.tokens', tokensUsed, { agent: agentType, provider });
  histogram('ai.cost', costCents / 100, { agent: agentType, provider });
}

export function trackDisputeCreated(reason: string): void {
  increment('disputes.created', { reason });
}

export function trackUserSignup(source: string): void {
  increment('users.signup', { source });
}

export function trackApiError(endpoint: string, errorCode: string): void {
  increment('api.errors', { endpoint, code: errorCode });
}

// ============================================================================
// Performance Tracking
// ============================================================================

export function trackDatabaseQuery(operation: string, table: string, durationMs: number): void {
  timing('db.query', durationMs, { operation, table });
}

export function trackExternalCall(service: string, operation: string, durationMs: number, success: boolean): void {
  timing('external.latency', durationMs, { service, operation, status: success ? 'success' : 'error' });
  if (!success) {
    increment('external.errors', { service, operation });
  }
}

export function trackCacheHit(type: 'hit' | 'miss', key: string): void {
  increment(`cache.${type}`, { key_prefix: key.split(':')[0] });
}

// ============================================================================
// Health & System Metrics
// ============================================================================

export function reportSystemMetrics(): void {
  const memUsage = process.memoryUsage();
  gauge('system.memory.heap_used', memUsage.heapUsed);
  gauge('system.memory.heap_total', memUsage.heapTotal);
  gauge('system.memory.rss', memUsage.rss);
  
  const cpuUsage = process.cpuUsage();
  gauge('system.cpu.user', cpuUsage.user);
  gauge('system.cpu.system', cpuUsage.system);
}

// Report system metrics every 30 seconds
setInterval(reportSystemMetrics, 30000);

// ============================================================================
// Graceful Shutdown
// ============================================================================

export async function flushMetrics(): Promise<void> {
  if (statsd) {
    await new Promise<void>((resolve) => {
      statsd!.close(() => resolve());
    });
    log.info('Datadog metrics flushed');
  }
}

export default {
  increment,
  timing,
  gauge,
  histogram,
  trackTaskCreated,
  taskCompleted,
  trackPayment,
  trackAIRequest,
  trackDisputeCreated,
  trackUserSignup,
  trackApiError,
  trackDatabaseQuery,
  trackExternalCall,
  trackCacheHit,
  flushMetrics,
};
