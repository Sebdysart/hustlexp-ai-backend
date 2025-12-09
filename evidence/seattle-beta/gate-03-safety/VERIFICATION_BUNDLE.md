# Gate 3: Safety — Verification Bundle

---

## Prerequisites

```bash
export HOST="https://your-backend.railway.app"
export ADMIN_TOKEN="..."
export USER_TOKEN="..."
export USER_ID="..."
```

---

# ITEM 3.1: Content Moderation (High-Risk Block)

## 3.1.1 Block Payment App Mention

```bash
curl -X POST "$HOST/api/tasks" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Help me move - pay you on venmo",
    "description": "Will pay cash",
    "price": 40,
    "category": "moving",
    "location": {"lat": 47.625, "lng": -122.315}
  }'
```

**Expected (PASS - blocked):**
```json
{
  "error": "HIGH_RISK_BLOCKED",
  "reason": "Off-platform payment mention"
}
```

**DB Query:**
```sql
SELECT * FROM moderation_logs 
WHERE action_taken = 'blocked'
ORDER BY created_at DESC LIMIT 5;
```

## 3.1.2 Block Explicit Content

```bash
curl -X POST "$HOST/api/tasks" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "[explicit content test]",
    "description": "[explicit content]",
    "price": 40
  }'
```

**Expected:** Blocked with `HIGH_RISK_BLOCKED`

## 3.1.3 Negative: Clean Content Passes

```bash
curl -X POST "$HOST/api/tasks" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Help me move a couch",
    "description": "Need help Saturday, takes about 2 hours",
    "price": 40,
    "category": "moving",
    "location": {"lat": 47.625, "lng": -122.315}
  }'
```

**Expected (PASS):** Task created successfully

---

# ITEM 3.2: Strike System

## 3.2.1 Add Strike

```bash
curl -X POST "$HOST/api/admin/user/$USER_ID/strikes" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Violation of terms",
    "severity": 2,
    "source": "manual"
  }'
```

**DB Query:**
```sql
SELECT * FROM user_strikes WHERE user_id = '[USER_ID]';
```

## 3.2.2 Auto-Suspension After 3 Medium Strikes

Add 3 severity-2 strikes, verify suspension:

```sql
SELECT is_suspended, suspended_until, suspension_reason
FROM users WHERE id = '[USER_ID]';
```

**Expected:** `is_suspended = true`

---

# ITEM 3.3: Suspended User Blocked

## 3.3.1 Suspended User Cannot Create Task

```bash
curl -X POST "$HOST/api/tasks" \
  -H "Authorization: Bearer $SUSPENDED_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "test", "price": 40}'
```

**Expected (PASS - blocked):**
```json
{
  "error": "USER_SUSPENDED",
  "until": "2024-12-15T..."
}
```

---

## Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 3.1.1 Block venmo | ⬜ | ⬜ | ⬜ | | |
| 3.1.2 Block explicit | ⬜ | ⬜ | ⬜ | | |
| 3.1.3 Clean passes | ⬜ | ⬜ | ⬜ | | |
| 3.2.1 Add strike | ⬜ | ⬜ | ⬜ | | |
| 3.2.2 Auto-suspend | ⬜ | ⬜ | ⬜ | | |
| 3.3.1 Suspended blocked | ⬜ | ⬜ | ⬜ | | |

**Gate 3: 6 tests | Status:** ⬜

---

*Bundle version: 1.0*
