import { Hono } from 'hono';
import { Registry, Histogram, Counter, Gauge, collectDefaultMetrics } from 'prom-client';

const registry = new Registry();
collectDefaultMetrics({ register: registry });

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

const dbQueryDuration = new Histogram({
  name: 'db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'table'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  registers: [registry],
});

const dbConnectionsActive = new Gauge({
  name: 'db_connections_active',
  help: 'Number of active database connections',
  registers: [registry],
});

const cacheOperationDuration = new Histogram({
  name: 'cache_operation_duration_seconds',
  help: 'Duration of cache operations in seconds',
  labelNames: ['operation', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.05],
  registers: [registry],
});

const cacheOperationsTotal = new Counter({
  name: 'cache_operations_total',
  help: 'Total number of cache operations',
  labelNames: ['operation', 'status'],
  registers: [registry],
});

const apiErrorsTotal = new Counter({
  name: 'api_errors_total',
  help: 'Total number of API errors',
  labelNames: ['error_type', 'endpoint'],
  registers: [registry],
});

const activeUsers = new Gauge({
  name: 'active_users',
  help: 'Number of active users',
  registers: [registry],
});

const escrowTotalValue = new Gauge({
  name: 'escrow_total_value',
  help: 'Total value held in escrow',
  registers: [registry],
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMetricsEndpoint(app: Hono<any>): void {
  app.get('/metrics', async (c) => {
    const metrics = await registry.metrics();
    return c.text(metrics, 200, {
      'Content-Type': registry.contentType,
    });
  });
}

export {
  registry,
  httpRequestDuration,
  httpRequestsTotal,
  dbQueryDuration,
  dbConnectionsActive,
  cacheOperationDuration,
  cacheOperationsTotal,
  apiErrorsTotal,
  activeUsers,
  escrowTotalValue,
  createMetricsEndpoint,
};
