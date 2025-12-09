# Gate 4: Auth & Admin — Verification Bundle

---

## Prerequisites

```bash
export HOST="https://your-backend.railway.app"
export ADMIN_TOKEN="..."
export USER_TOKEN="..."  # Non-admin
export NO_TOKEN=""
```

---

# ITEM 4.1: Admin Endpoint Protection

## 4.1.1 Non-Admin Gets 403

```bash
# Test each admin endpoint
ADMIN_ENDPOINTS=(
  "GET /api/admin/disputes"
  "GET /api/admin/users"
  "GET /api/admin/moderation/logs"
  "POST /api/admin/beta/invites"
  "GET /api/admin/metrics/funnel"
  "GET /api/admin/health/providers"
)

for endpoint in "${ADMIN_ENDPOINTS[@]}"; do
  METHOD=$(echo $endpoint | cut -d' ' -f1)
  PATH=$(echo $endpoint | cut -d' ' -f2)
  
  RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X $METHOD "$HOST$PATH" \
    -H "Authorization: Bearer $USER_TOKEN")
  
  if [ "$RESPONSE" != "403" ]; then
    echo "FAIL: $endpoint returned $RESPONSE (expected 403)"
  else
    echo "PASS: $endpoint returned 403"
  fi
done
```

**Expected:** All return 403

## 4.1.2 No Token Gets 401

```bash
curl -s -o /dev/null -w "%{http_code}" \
  "$HOST/api/admin/disputes"
```

**Expected:** 401

## 4.1.3 Admin Gets 200

```bash
curl -s -o /dev/null -w "%{http_code}" \
  "$HOST/api/admin/disputes" \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

**Expected:** 200

---

# ITEM 4.2: Force Actions (Admin Only)

## 4.2.1 Non-Admin Force Refund

```bash
curl -X POST "$HOST/api/admin/tasks/[TASK_ID]/force-refund" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "test"}'
```

**Expected:** 403

## 4.2.2 Admin Force Refund

```bash
curl -X POST "$HOST/api/admin/tasks/[TASK_ID]/force-refund" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "test"}'
```

**Expected:** 200 with success

**DB Query:**
```sql
SELECT * FROM admin_actions WHERE action_type = 'force_refund';
```

---

## Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 4.1.1 Non-admin 403 | ⬜ | ⬜ | ⬜ | | |
| 4.1.2 No token 401 | ⬜ | ⬜ | ⬜ | | |
| 4.1.3 Admin 200 | ⬜ | ⬜ | ⬜ | | |
| 4.2.1 Non-admin force | ⬜ | ⬜ | ⬜ | | |
| 4.2.2 Admin force | ⬜ | ⬜ | ⬜ | | |

**Gate 4: 5 tests | Status:** ⬜

---

*Bundle version: 1.0*
