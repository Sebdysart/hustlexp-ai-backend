/**
 * Prometheus Metrics — HustleXP Backend
 *
 * Exposes /metrics in Prometheus text exposition format (0.0.4).
 *
 * Metrics catalogue:
 *  - http_request_duration_seconds  (histogram, labelled method/route/status_code)
 *  - http_requests_total            (counter,   labelled method/route/status_code)
 *  - db_query_duration_seconds      (histogram, labelled operation/table)
 *  - db_connections_active          (gauge)
 *  - cache_operation_duration_seconds (histogram, labelled operation/status)
 *  - cache_operations_total         (counter,   labelled operation/status)
 *  - api_errors_total               (counter,   labelled error_type/endpoint)
 *  - active_users                   (gauge)
 *  - escrow_total_value             (gauge,     cents)
 *  - bullmq_jobs_waiting            (gauge,     labelled queue)
 *  - bullmq_jobs_active             (gauge,     labelled queue)
 *  - bullmq_jobs_failed             (gauge,     labelled queue)
 *  - bullmq_jobs_completed          (gauge,     labelled queue)
 *  - process_uptime_seconds         (gauge)
 *  - nodejs_heap_bytes              (gauge,     labelled type=used|total|rss)
 *  Plus all default Node.js metrics from collectDefaultMetrics().
 *
 * Security note: /metrics is unauthenticated so monitoring agents (Prometheus,
 * Grafana Agent, Datadog) can scrape it without Bearer tokens.
 * In production, restrict access at the load-balancer / firewall level to
 * your monitoring CIDR range (e.g. 10.0.0.0/8) rather than exposing it to
 * the public internet.
 *
 * IP allowlist reminder (nginx / Railway / Fly.io):
 *   location /metrics { allow 10.0.0.0/8; deny all; proxy_pass http://app; }
 */

import { Hono } from 'hono';
import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from 'prom-client';
import { getQueue, type QueueName } from '../jobs/queues';
import { logger } from '../logger';

const log = logger.child({ module: 'metrics' });

// ============================================================================
// REGISTRY
// ============================================================================

const registry = new Registry();

// Collect default Node.js process metrics (event loop lag, GC, heap, FDs…)
collectDefaultMetrics({ register: registry, prefix: 'nodejs_' });

// ============================================================================
// HTTP METRICS
// ============================================================================

const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const httpRequestsTotal = new Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [registry],
});

// ============================================================================
// DATABASE METRICS
// ============================================================================

const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [registry],
});

const dbConnectionsActive = new Gauge({
  name: 'db_connections_active',
  help: 'Number of active database connections in the pg pool',
  registers: [registry],
});

// ============================================================================
// CACHE METRICS
// ============================================================================

const cacheOperationDuration = new Histogram({
  name: 'cache_operation_duration_seconds',
  help: 'Duration of Redis cache operations in seconds',
  labelNames: ['operation', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.05],
  registers: [registry],
});

const cacheOperationsTotal = new Counter({
  name: 'cache_operations_total',
  help: 'Total number of Redis cache operations',
  labelNames: ['operation', 'status'],
  registers: [registry],
});

// ============================================================================
// API ERROR METRICS
// ============================================================================

const apiErrorsTotal = new Counter({
  name: 'api_errors_total',
  help: 'Total number of API errors by type and endpoint',
  labelNames: ['error_type', 'endpoint'],
  registers: [registry],
});

// ============================================================================
// BUSINESS METRICS
// ============================================================================

const activeUsers = new Gauge({
  name: 'active_users',
  help: 'Number of active users (SSE connections)',
  registers: [registry],
});

const escrowTotalValue = new Gauge({
  name: 'escrow_total_value',
  help: 'Total value held in escrow in cents',
  registers: [registry],
});

// ============================================================================
// BULLMQ QUEUE METRICS
// ============================================================================

const bullmqJobsWaiting = new Gauge({
  name: 'bullmq_jobs_waiting',
  help: 'Number of jobs waiting to be processed in each BullMQ queue',
  labelNames: ['queue'],
  registers: [registry],
});

const bullmqJobsActive = new Gauge({
  name: 'bullmq_jobs_active',
  help: 'Number of jobs currently being processed in each BullMQ queue',
  labelNames: ['queue'],
  registers: [registry],
});

const bullmqJobsFailed = new Gauge({
  name: 'bullmq_jobs_failed',
  help: 'Number of failed jobs in each BullMQ queue',
  labelNames: ['queue'],
  registers: [registry],
});

const bullmqJobsCompleted = new Gauge({
  name: 'bullmq_jobs_completed',
  help: 'Number of completed jobs in each BullMQ queue (may be pruned per retention policy)',
  labelNames: ['queue'],
  registers: [registry],
});

// ============================================================================
// PROCESS METRICS (explicit HustleXP gauges — supplements collectDefaultMetrics)
// ============================================================================

const processUptimeSeconds = new Gauge({
  name: 'hustlexp_process_uptime_seconds',
  help: 'Process uptime in seconds',
  registers: [registry],
  collect() {
    this.set(process.uptime());
  },
});

const nodejsHeapBytes = new Gauge({
  name: 'hustlexp_nodejs_heap_bytes',
  help: 'Node.js heap usage in bytes',
  labelNames: ['type'],
  registers: [registry],
  collect() {
    const mem = process.memoryUsage();
    this.set({ type: 'used' }, mem.heapUsed);
    this.set({ type: 'total' }, mem.heapTotal);
    this.set({ type: 'rss' }, mem.rss);
  },
});

// ============================================================================
// QUEUE SCRAPE HELPER
// ============================================================================

/**
 * All BullMQ queue names registered in this service.
 * Must stay in sync with QueueName in jobs/queues.ts.
 */
const QUEUE_NAMES: QueueName[] = [
  'critical_payments',
  'critical_trust',
  'user_notifications',
  'exports',
  'maintenance',
  'tax_reporting',
];

/**
 * Refresh BullMQ job-count gauges.
 * Called inside the /metrics handler so counts are fresh on every scrape.
 * Failures are logged and silently swallowed — a stale count is better than
 * a broken /metrics endpoint.
 */
async function refreshQueueMetrics(): Promise<void> {
  await Promise.allSettled(
    QUEUE_NAMES.map(async (queueName) => {
      try {
        const queue = getQueue(queueName);
        const [waiting, active, failed, completed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getFailedCount(),
          queue.getCompletedCount(),
        ]);
        bullmqJobsWaiting.set({ queue: queueName }, waiting);
        bullmqJobsActive.set({ queue: queueName }, active);
        bullmqJobsFailed.set({ queue: queueName }, failed);
        bullmqJobsCompleted.set({ queue: queueName }, completed);
      } catch (err) {
        log.warn({ err, queue: queueName }, 'Failed to refresh queue metrics for scrape');
      }
    })
  );
}

// ============================================================================
// /metrics ENDPOINT
// ============================================================================

/**
 * Register the GET /metrics endpoint on the provided Hono app.
 *
 * Access control note:
 *   This endpoint is intentionally unauthenticated so that Prometheus and
 *   other scrape agents can reach it without Bearer tokens. Restrict it at
 *   the network layer in production (firewall / load-balancer allowlist).
 *
 * Example Prometheus scrape config:
 *   - job_name: hustlexp-api
 *     static_configs:
 *       - targets: ['api.hustlexp.com:443']
 *     scheme: https
 *     metrics_path: /metrics
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMetricsEndpoint(app: Hono<any>): void {
  app.get('/metrics', async (c) => {
    // Refresh BullMQ counts synchronously before rendering — adds ~10-50 ms
    // per scrape (network calls to Redis) but keeps counts accurate.
    await refreshQueueMetrics();

    const metrics = await registry.metrics();
    return c.text(metrics, 200, {
      'Content-Type': registry.contentType,
    });
  });
}

// ============================================================================
// EXPORTS
// ============================================================================

export {
  registry,
  // HTTP
  httpRequestDuration,
  httpRequestsTotal,
  // DB
  dbQueryDuration,
  dbConnectionsActive,
  // Cache
  cacheOperationDuration,
  cacheOperationsTotal,
  // Errors
  apiErrorsTotal,
  // Business
  activeUsers,
  escrowTotalValue,
  // BullMQ
  bullmqJobsWaiting,
  bullmqJobsActive,
  bullmqJobsFailed,
  bullmqJobsCompleted,
  // Process (used by server.ts / health check for ad-hoc reads)
  processUptimeSeconds,
  nodejsHeapBytes,
  // Endpoint factory
  createMetricsEndpoint,
};
