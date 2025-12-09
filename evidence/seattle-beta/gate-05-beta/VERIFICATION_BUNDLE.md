# Gate 5: Beta Guardrails — Verification Bundle

**Critical: This gate ensures Seattle-only, invite-only, capped beta.**

---

## Prerequisites

```bash
export HOST="https://your-backend.railway.app"
export ADMIN_TOKEN="your-firebase-admin-token"
export NEW_USER_TOKEN="new-user-firebase-token"
```

---

## Item 5.1: Invite Code Validation

### Test Valid Code

```bash
curl -X POST "$HOST/api/beta/validate-invite" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "SEATTLE-BETA-2024",
    "role": "hustler",
    "cityId": "city_seattle"
  }'
```

### Expected Output (PASS - Valid)

```json
{
  "valid": true,
  "invite": {
    "code": "SEATTLE-BETA-2024",
    "role": "both",
    "maxUses": 100,
    "uses": 12
  }
}
```

### Test Invalid Code

```bash
curl -X POST "$HOST/api/beta/validate-invite" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "FAKE-CODE-123",
    "role": "hustler"
  }'
```

### Expected Output (PASS - Rejection)

```json
{
  "valid": false,
  "reason": "INVALID_CODE"
}
```

### Test Expired Code

Create expired invite first, then test.

### Expected Output (PASS - Rejection)

```json
{
  "valid": false,
  "reason": "EXPIRED"
}
```

### Test Max Uses

```bash
# Create invite with maxUses: 1, use it, then try again
```

### Expected Output (PASS - Rejection)

```json
{
  "valid": false,
  "reason": "MAX_USES_REACHED"
}
```

---

## Item 5.2: Invite Consumption

### Test Procedure

```bash
# Get current uses
curl "$HOST/api/admin/beta/invites" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.invites[] | select(.code=="SEATTLE-BETA-2024")'

# Note the 'uses' value

# Consume invite
curl -X POST "$HOST/api/beta/consume-invite" \
  -H "Authorization: Bearer $NEW_USER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "code": "SEATTLE-BETA-2024",
    "userId": "[NEW_USER_ID]"
  }'

# Check uses again - should be incremented
```

### DB Verification

```sql
SELECT code, uses, max_uses
FROM beta_invites
WHERE code = 'SEATTLE-BETA-2024';
```

**Expected:** `uses` incremented by 1

### FAIL Criteria

- Uses not incremented
- Same user can consume same code twice

---

## Item 5.3: Seattle-Only Enforcement

### Test Seattle (should pass)

```bash
curl -X POST "$HOST/api/beta/check-signup" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "hustler",
    "cityId": "city_seattle",
    "inviteCode": "SEATTLE-BETA-2024"
  }'
```

### Expected Output (PASS - Allowed)

```json
{
  "allowed": true
}
```

### Test LA (should fail)

```bash
curl -X POST "$HOST/api/beta/check-signup" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "hustler",
    "cityId": "city_la"
  }'
```

### Expected Output (PASS - Rejection)

```json
{
  "allowed": false,
  "reason": "SEATTLE_ONLY"
}
```

### Verify Flag

```bash
curl "$HOST/api/flags/beta_seattle_only" | jq
```

**Expected:** `{ "enabled": true }`

---

## Item 5.4: City Capacity Cap

### Setup Test

```bash
# Set low cap for testing
curl -X POST "$HOST/api/admin/rules/city_seattle" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "max_active_hustlers_per_city",
    "value": 2
  }'
```

### Test At Capacity

Register 2 hustlers, then try 3rd:

```bash
curl -X POST "$HOST/api/beta/check-signup" \
  -H "Content-Type: application/json" \
  -d '{
    "role": "hustler",
    "cityId": "city_seattle",
    "inviteCode": "SEATTLE-BETA-2024"
  }'
```

### Expected Output (PASS - Rejection)

```json
{
  "allowed": false,
  "reason": "CITY_AT_CAPACITY"
}
```

### Cleanup

```bash
# Reset cap to production value
curl -X POST "$HOST/api/admin/rules/city_seattle" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "max_active_hustlers_per_city",
    "value": 500
  }'
```

---

## Evidence Checklist

| Item | Description | Screenshot | Verified By | Date |
|------|-------------|------------|-------------|------|
| 5.1 | Valid invite accepted | ⬜ | | |
| 5.1 | Invalid invite rejected | ⬜ | | |
| 5.1 | Expired invite rejected | ⬜ | | |
| 5.1 | Max uses rejected | ⬜ | | |
| 5.2 | Uses incremented | ⬜ | | |
| 5.3 | Seattle allowed | ⬜ | | |
| 5.3 | LA rejected | ⬜ | | |
| 5.4 | Capacity cap works | ⬜ | | |

**Gate 5 Status:** ⬜ NOT PASSED / ✅ PASSED

---

*Bundle version: 1.0*
