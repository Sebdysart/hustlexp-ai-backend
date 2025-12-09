# Gate 6: AI Orchestration — Verification Bundle

---

## Prerequisites

```bash
export HOST="https://your-backend.railway.app"
export USER_TOKEN="..."
```

---

# ITEM 6.1: Intent Routing

## 6.1.1 Task Creation Intent

```bash
curl -X POST "$HOST/ai/orchestrate" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "intent": "new_task",
    "input": "I need help moving a couch in Capitol Hill for $50",
    "context": {"userId": "'$USER_ID'"}
  }'
```

**Expected:**
```json
{
  "intent": "new_task",
  "action": "create_task_draft",
  "response": "...",
  "data": {
    "title": "...",
    "price": 50,
    "category": "moving"
  }
}
```

**DB Query (verify AI metrics):**
```sql
SELECT provider, route_type, tokens_in, tokens_out, cost_usd
FROM ai_metrics
ORDER BY created_at DESC LIMIT 5;
```

## 6.1.2 Task Search Intent

```bash
curl -X POST "$HOST/ai/orchestrate" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "intent": "find_task",
    "input": "Find me tasks near Ballard under $50",
    "context": {"userId": "'$USER_ID'"}
  }'
```

**Expected:** Returns matching tasks

## 6.1.3 Advice Intent

```bash
curl -X POST "$HOST/ai/orchestrate" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "intent": "get_advice",
    "input": "What should I do today to earn more?",
    "context": {"userId": "'$USER_ID'"}
  }'
```

**Expected:** Returns coaching advice

---

# ITEM 6.2: Model Routing Verification

## 6.2.1 Verify Provider Usage

After running above tests:

```sql
SELECT provider, route_type, COUNT(*) as calls
FROM ai_metrics
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY provider, route_type;
```

**Expected:**
- `safety` → `openai`
- `planning` → `deepseek`
- `intent` → `groq`

---

## Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 6.1.1 Create intent | ⬜ | ⬜ | ⬜ | | |
| 6.1.2 Search intent | ⬜ | ⬜ | ⬜ | | |
| 6.1.3 Advice intent | ⬜ | ⬜ | ⬜ | | |
| 6.2.1 Provider routing | ⬜ | ⬜ | ⬜ | | |

**Gate 6: 4 tests | Status:** ⬜

---

*Bundle version: 1.0*
