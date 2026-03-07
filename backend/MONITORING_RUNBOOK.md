# HustleXP Backend — Monitoring Runbook

Version: 1.0.0
Last updated: 2026-03-07
Owner: Platform / On-call team

---

## 1. Key Metrics and Alert Thresholds

| Metric | Description | Warning | Critical | Action |
|--------|-------------|---------|----------|--------|
| `http_requests_total{status_code=~"5.."}` | 5xx error rate (req/min) | > 5/min | > 20/min | Check Sentry; see §5.1 |
| `http_requests_total{status_code=~"4.."}` | 4xx error rate (req/min) | > 50/min | > 200/min | Check auth/validation errors |
| `http_request_duration_seconds` p99 | Request tail latency | > 1 s | > 3 s | Check DB pool / Redis; see §5.6 |
| `db_connections_active` | PostgreSQL active connections | > 15 | > 18 | Pool exhaustion; see §5.3 |
| `bullmq_jobs_waiting{queue="critical_payments"}` | Critical payment queue depth | > 10 | > 50 | See §5.5 |
| `bullmq_jobs_waiting{queue="user_notifications"}` | Notification queue depth | > 100 | > 500 | See §5.5 |
| `bullmq_jobs_failed` | Failed jobs across any queue | > 5 | > 20 | Check worker logs |
| `hustlexp_nodejs_heap_bytes{type="used"}` | JS heap used | > 400 MB | > 600 MB | Memory leak; restart pod |
| `hustlexp_process_uptime_seconds` | Process uptime | < 300 s (recent restart) | — | Crash loop; check startup logs |
| `nodejs_eventloop_lag_seconds` (p99) | Event loop lag | > 100 ms | > 500 ms | CPU-bound work; profile |

---

## 2. Health Check Endpoints

All endpoints are unauthenticated and intended for load-balancers, uptime monitors, and Kubernetes probes.

| Endpoint | Method | Use | Returns |
|----------|--------|-----|---------|
| `GET /health` | GET | Primary uptime check | `{status, timestamp, version, schema, environment}` |
| `GET /health/liveness` | GET | Kubernetes liveness probe | `{alive, uptime}` — no DB call |
| `GET /health/readiness` | GET | Kubernetes readiness probe | `{ready, dbLatencyMs}` — DB ping |
| `GET /ready` | GET | Combined readiness (DB + Redis) | `{status, checks, timestamp}` |
| `GET /health/detailed` | GET | Operator deep-dive | `{status, checks, pool, circuitBreakers, uptime, memory}` |

### Interpreting `/health/detailed`

```json
{
  "status": "healthy",
  "checks": {
    "database": { "status": "ok", "latency": 12 },
    "schema":   { "status": "ok" },
    "firebase": { "status": "configured" },
    "stripe":   { "status": "configured" }
  },
  "pool": {
    "totalConnections": 8,
    "idleConnections":  5,
    "waitingClients":   0
  },
  "circuitBreakers": {
    "openai":    "CLOSED",
    "stripe":    "CLOSED",
    "sendgrid":  "CLOSED"
  },
  "uptime": 3600,
  "memory": { "heapUsed": 120000000, "heapTotal": 200000000 }
}
```

- `status: "degraded"` means one or more checks are not `ok`/`configured`.
- `pool.waitingClients > 0` means requests are queuing for a DB connection.
- `circuitBreakers.*: "OPEN"` means an external service is being protected; calls are failing fast.

---

## 3. Prometheus Metrics Endpoint

**URL**: `GET /metrics`
**Content-Type**: `text/plain; version=0.0.4`
**Auth**: None (restrict at network layer in production — see §3.1)

### 3.1 Network-level Access Control

The `/metrics` endpoint must not be publicly reachable. Restrict it at the firewall or reverse proxy level:

**nginx:**
```nginx
location /metrics {
  allow 10.0.0.0/8;      # Internal monitoring CIDR
  allow 172.16.0.0/12;   # Docker/Railway internal networks
  deny  all;
  proxy_pass http://app;
}
```

**Railway (custom domain):** Use a private service network and expose `/metrics` only on the internal hostname.

### 3.2 Metric Reference

| Metric Name | Type | Labels | Description |
|-------------|------|--------|-------------|
| `http_requests_total` | counter | `method`, `route`, `status_code` | Cumulative request count |
| `http_request_duration_seconds` | histogram | `method`, `route`, `status_code` | Latency buckets (0.01–10 s) |
| `db_query_duration_seconds` | histogram | `operation`, `table` | DB query latency |
| `db_connections_active` | gauge | — | pg-pool active connections |
| `cache_operation_duration_seconds` | histogram | `operation`, `status` | Redis op latency |
| `cache_operations_total` | counter | `operation`, `status` | Redis op count |
| `api_errors_total` | counter | `error_type`, `endpoint` | Application-level errors |
| `active_users` | gauge | — | Active SSE connections |
| `escrow_total_value` | gauge | — | Total escrow value in cents |
| `bullmq_jobs_waiting` | gauge | `queue` | Jobs queued, not yet processing |
| `bullmq_jobs_active` | gauge | `queue` | Jobs currently processing |
| `bullmq_jobs_failed` | gauge | `queue` | Jobs in failed state |
| `bullmq_jobs_completed` | gauge | `queue` | Jobs completed (may be pruned) |
| `hustlexp_process_uptime_seconds` | gauge | — | Process uptime |
| `hustlexp_nodejs_heap_bytes` | gauge | `type` (used/total/rss) | Node.js memory |
| `nodejs_*` | various | — | Default Node.js metrics from prom-client |

### 3.3 Queue Names

| Queue | Purpose |
|-------|---------|
| `critical_payments` | Stripe webhooks, escrow state changes, XP awards |
| `critical_trust` | Trust tier recalculations, fraud signals |
| `user_notifications` | Email / SMS / push fan-out |
| `exports` | CSV/PDF generation, R2 uploads |
| `maintenance` | Cleanup, TTL expiry, scheduled backfills |
| `tax_reporting` | 1099-NEC generation, tax threshold notifications |

---

## 4. Sentry Configuration

**DSN**: Configured via `SENTRY_DSN` environment variable.
**Environment**: Set by `NODE_ENV` (development / staging / production).

### What is captured:
- Unhandled exceptions from all request paths (tRPC + REST + webhook)
- `captureError()` calls from tRPC `onError` handlers (INTERNAL_SERVER_ERROR only)
- BullMQ worker failures (via Sentry breadcrumbs in worker handlers)

### Recommended alert rules (Sentry dashboard):
1. **New issue spike**: > 5 new issues in 1 hour → PagerDuty
2. **Error volume**: > 50 events/hour → Slack #alerts-backend
3. **Regression**: Any previously-resolved issue re-occurs → Immediate notification
4. **Performance**: p95 transaction duration > 2 s → Weekly review

### Useful Sentry queries:
```
# All payment-related errors
tags[procedure]:escrow* OR tags[procedure]:stripe*

# Auth failures (might indicate token issues)
message:"Unauthorized" level:error

# DB errors
message:*postgres* OR message:*pool* OR message:*timeout*
```

---

## 5. Alert Playbooks

### 5.1 High 5xx Error Rate

**Alert**: `rate(http_requests_total{status_code=~"5.."}[5m]) > 0.33` (> 20/min)

**Steps**:
1. Open Sentry — filter to last 15 minutes, sort by frequency.
2. Check `/health/detailed` — look for DB/Redis connection errors.
3. Check recent deploys (`git log --oneline -10`).
4. If circuit breaker is OPEN for a dependency (Stripe, Firebase, OpenAI):
   - The service will degrade gracefully; wait for recovery or disable the feature flag.
5. If DB is the cause — see §5.3.
6. If no clear cause — restart the API pod and monitor for 5 minutes.

---

### 5.2 Health Check Failing

**Alert**: UptimeRobot / Better Uptime marks `GET /health` as down.

**Steps**:
1. `curl -s https://api.hustlexp.com/health | jq` — check the response.
2. If 503: `curl -s https://api.hustlexp.com/health/detailed | jq .checks` — find failing check.
3. If database failing:
   - Check Neon/Railway DB dashboard for connection limits and CPU.
   - Check `pool.waitingClients` — if > 0, pool is exhausted (see §5.3).
4. If Redis failing:
   - Check Upstash dashboard for connection count and memory.
   - BullMQ workers will stop processing; jobs accumulate (see §5.5).
5. If Firebase failing:
   - Authentication will fail for all protected endpoints.
   - Check Firebase console status page.

---

### 5.3 DB Pool Exhaustion

**Alert**: `db_connections_active > 15` or `pool.waitingClients > 0` in `/health/detailed`.

**Default pool config** (overridable via env):
- `DB_MAX_CONNECTIONS`: 20 (default)
- `DB_IDLE_TIMEOUT_MS`: 10000
- `DB_CONNECT_TIMEOUT_MS`: 5000
- `DB_STATEMENT_TIMEOUT_MS`: 30000

**Steps**:
1. Check `/health/detailed` → `pool` object for current counts.
2. Look for slow queries in Pino logs:
   ```
   grep "db_query_duration" /var/log/app.log | awk '$NF > 1000'
   ```
3. In Neon / pg console, run:
   ```sql
   SELECT pid, now() - pg_stat_activity.query_start AS duration, query, state
   FROM pg_stat_activity
   WHERE state != 'idle'
   ORDER BY duration DESC
   LIMIT 10;
   ```
4. Kill long-running queries if safe:
   ```sql
   SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE duration > interval '30 seconds';
   ```
5. If connections are from idle clients, reduce `DB_IDLE_TIMEOUT_MS` to 5000.
6. Scale the DB plan if consistently hitting the limit.

---

### 5.4 Redis Memory High

**Alert**: Upstash dashboard shows memory > 80% of plan limit.

**Steps**:
1. Check BullMQ retention settings in `src/jobs/queues.ts`.
   - `removeOnComplete.age` and `removeOnFail.age` control how long jobs are kept.
2. Prune old completed jobs manually if needed:
   ```typescript
   import { getQueue } from './src/jobs/queues';
   await getQueue('critical_payments').clean(86400000, 1000, 'completed');
   ```
3. Check if a runaway producer is flooding a queue (`bullmq_jobs_waiting` spike).
4. Consider upgrading the Upstash plan or adding a separate Redis instance for BullMQ.

---

### 5.5 BullMQ Queue Depth Growing

**Alert**: `bullmq_jobs_waiting{queue="critical_payments"} > 50`

**Steps**:
1. Check if workers are running:
   ```bash
   # Railway / Fly.io
   railway logs --service worker
   ```
2. Check for worker errors in Sentry (filter `service:hustlexp-worker`).
3. Check Redis connectivity from the worker pod:
   ```bash
   redis-cli -u $UPSTASH_REDIS_URL ping
   ```
4. If workers are dead, restart the worker service.
5. For `tax_reporting` queue — this queue runs seasonally and high depth is normal during 1099 season (Jan–Feb).
6. If `critical_payments` depth is growing:
   - This is a P0 incident — escalate immediately.
   - Failed Stripe webhooks mean payment state may be out of sync.
   - Check Stripe dashboard for webhook delivery failures.

---

### 5.6 High p99 Latency

**Alert**: `histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m])) > 3`

**Steps**:
1. Identify the slow route using Grafana → HTTP Request Duration panel.
2. Check `nodejs_eventloop_lag_seconds` — if > 100 ms, the process is CPU-bound.
3. Check DB query duration: `histogram_quantile(0.99, rate(db_query_duration_seconds_bucket[5m]))`.
4. Look for missing indexes: run `EXPLAIN ANALYZE` on the slowest queries.
5. Check Redis latency (`cache_operation_duration_seconds`).
6. If the bottleneck is an AI route, check `trackAIRequest` logs — provider may be slow.
7. Enable Datadog APM traces (if `DATADOG_AGENT_HOST` is set) for waterfall view.

---

## 6. Pino Log Queries

Pino writes structured JSON to stdout. In Railway / Fly.io, pipe to `pino-pretty` locally or query via the log aggregation tool.

### Common queries (Railway Log Explorer / Datadog Logs):

```
# All errors in the last hour
level:error

# Slow requests (> 1000 ms)
duration:>1000

# Specific request ID trace
requestId:550e8400-e29b-41d4-a716-446655440000

# tRPC procedure errors
path:escrow.release level:error

# Stripe webhook processing
path:/api/v1/stripe/webhook OR path:/webhooks/stripe

# Auth failures
message:"Unauthorized" OR message:"Invalid token"

# DB connection errors
message:*pool* OR message:*connection refused* OR message:*ECONNREFUSED*
```

### Log level matrix:

| HTTP status | Pino level | When to action |
|-------------|------------|----------------|
| 2xx | `info` | Normal |
| 4xx | `warn` | Review if volume is high |
| 5xx | `error` | Always review |

---

## 7. Uptime Monitoring Setup

### Using UptimeRobot (free tier)

1. Log in to uptimerobot.com and create a new monitor.
2. Settings:
   - Type: **HTTPS**
   - Friendly name: HustleXP API
   - URL: `https://api.hustlexp.com/health`
   - Monitoring interval: **1 minute**
   - Alert contacts: on-call email + Slack webhook
3. Add a second monitor for the readiness probe:
   - URL: `https://api.hustlexp.com/ready`
   - Alert on non-200 response.

### Using Better Uptime

1. Add a monitor for `https://api.hustlexp.com/health`.
2. Set keyword check: response body must contain `"status":"healthy"`.
3. Enable on-call escalation for P1 (immediate) and P2 (15 min delay).

### Using Prometheus Blackbox Exporter

```yaml
- job_name: hustlexp-health
  metrics_path: /probe
  params:
    module: [http_2xx]
  static_configs:
    - targets:
        - https://api.hustlexp.com/health
        - https://api.hustlexp.com/ready
  relabel_configs:
    - source_labels: [__address__]
      target_label: __param_target
    - source_labels: [__param_target]
      target_label: instance
    - target_label: __address__
      replacement: blackbox-exporter:9115
```

---

## 8. Prometheus Scrape Configuration

Add to your `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: hustlexp-api
    scrape_interval: 15s
    scrape_timeout: 10s
    scheme: https
    static_configs:
      - targets:
          - api.hustlexp.com:443
    metrics_path: /metrics
    # In production, the /metrics endpoint should be restricted at the
    # network layer. If using basic-auth as an alternative:
    # basic_auth:
    #   username: prometheus
    #   password: <METRICS_SCRAPE_PASSWORD>

alerting:
  alertmanagers:
    - static_configs:
        - targets: ['alertmanager:9093']

rule_files:
  - 'hustlexp_alerts.yml'
```

### Example alert rules (`hustlexp_alerts.yml`):

```yaml
groups:
  - name: hustlexp-backend
    interval: 30s
    rules:
      - alert: HighErrorRate
        expr: rate(http_requests_total{status_code=~"5.."}[5m]) > 0.33
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "High 5xx error rate on HustleXP API"
          description: "{{ $value | humanize }} errors/sec"

      - alert: DBPoolNearlyExhausted
        expr: db_connections_active > 15
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "DB connection pool near limit"

      - alert: CriticalQueueDepthHigh
        expr: bullmq_jobs_waiting{queue="critical_payments"} > 50
        for: 3m
        labels:
          severity: critical
        annotations:
          summary: "Critical payments queue backed up — payment processing may be delayed"

      - alert: HighP99Latency
        expr: |
          histogram_quantile(0.99,
            rate(http_request_duration_seconds_bucket[5m])
          ) > 3
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "p99 request latency exceeds 3 seconds"

      - alert: HeapMemoryHigh
        expr: hustlexp_nodejs_heap_bytes{type="used"} > 500000000
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Node.js heap usage above 500 MB — possible memory leak"
```
