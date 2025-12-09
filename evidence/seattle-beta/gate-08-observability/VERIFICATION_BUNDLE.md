# Gate 8: Observability — Verification Bundle

---

## Prerequisites

```bash
export HOST="https://your-backend.railway.app"
export ADMIN_TOKEN="..."
```

---

# ITEM 8.1: Events Logging

## 8.1.1 Task Creation Event

Create a task, then verify:

```sql
SELECT * FROM events 
WHERE event_type = 'task_created'
ORDER BY created_at DESC LIMIT 5;
```

**Expected:** Row exists with task_id, user_id, metadata

## 8.1.2 Payout Event

Complete a payout, then verify:

```sql
SELECT * FROM events 
WHERE event_type = 'payout_released'
ORDER BY created_at DESC LIMIT 5;
```

---

# ITEM 8.2: AI Metrics Logging

## 8.2.1 AI Call Logged

Make an AI call, then verify:

```sql
SELECT provider, model, tokens_in, tokens_out, cost_usd, latency_ms
FROM ai_metrics
ORDER BY created_at DESC LIMIT 10;
```

**Expected:** Row exists with all fields populated

## 8.2.2 Cost Tracking

```bash
curl "$HOST/api/admin/metrics/ai" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Expected:**
```json
{
  "summary": [
    {"provider": "openai", "totalCalls": 10, "totalCostUsd": 0.05},
    {"provider": "groq", "totalCalls": 50, "totalCostUsd": 0.01}
  ]
}
```

---

# ITEM 8.3: Circuit Breaker Status

## 8.3.1 Health Endpoint

```bash
curl "$HOST/api/admin/health/providers" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Expected:**
```json
{
  "providers": [
    {"provider": "openai", "healthy": true, "circuitOpen": false},
    {"provider": "stripe", "healthy": true, "circuitOpen": false}
  ]
}
```

## 8.3.2 Reset Circuit

```bash
curl -X POST "$HOST/api/admin/health/reset-circuit/openai" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Expected:** 200 with success

---

## Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 8.1.1 Task event | ⬜ | ⬜ | ⬜ | | |
| 8.1.2 Payout event | ⬜ | ⬜ | ⬜ | | |
| 8.2.1 AI logged | ⬜ | ⬜ | ⬜ | | |
| 8.2.2 Cost tracking | ⬜ | ⬜ | ⬜ | | |
| 8.3.1 Health endpoint | ⬜ | ⬜ | ⬜ | | |
| 8.3.2 Reset circuit | ⬜ | ⬜ | ⬜ | | |

**Gate 8: 6 tests | Status:** ⬜

---

*Bundle version: 1.0*
