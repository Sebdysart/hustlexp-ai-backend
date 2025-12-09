# Gate 1: Money — COMPLETE Operational Test Suite

**100% coverage: happy paths, negative paths, auth separation, edge cases, environment matrix.**

---

## Environment Matrix

| Environment | Host | Run Required |
|-------------|------|--------------|
| Local Dev | `http://localhost:3000` | ⬜ |
| Staging | `https://staging.hustlexp.railway.app` | ⬜ |
| Production | `https://api.hustlexp.com` | ⬜ |

**All items must pass in BOTH staging AND production before GO.**

---

## Prerequisites

```bash
# ========================================
# SET THESE BEFORE RUNNING ANY TEST
# ========================================

# Environment (switch between local/staging/prod)
export HOST="https://staging.hustlexp.railway.app"
export ENV="staging"  # local | staging | production

# Auth tokens (Firebase JWT)
export ADMIN_TOKEN="eyJ..."    # Admin user
export POSTER_TOKEN="eyJ..."   # Poster user (has payment method)
export HUSTLER_TOKEN="eyJ..."  # Hustler user (has Connect account)
export RANDOM_TOKEN="eyJ..."   # Unrelated user (for negative tests)

# User IDs
export ADMIN_ID="admin-user-uuid"
export POSTER_ID="poster-user-uuid"
export HUSTLER_ID="hustler-user-uuid"
export RANDOM_ID="random-user-uuid"

# Test data
export TASK_ID=""  # Will be set during tests
export ESCROW_ID=""
export DISPUTE_ID=""
```

---

# ITEM 1.1: Stripe Connect Account Creation

## 1.1.1 Happy Path

```bash
curl -X POST "$HOST/api/stripe/connect/create" \
  -H "Authorization: Bearer $HUSTLER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId": "'$HUSTLER_ID'"}'
```

**Expected (PASS):**
```json
{
  "accountId": "acct_xxxxxxxxxxxxx",
  "status": "pending"
}
```

**DB Query:**
```sql
SELECT id, stripe_connect_account_id, stripe_connect_status
FROM users WHERE id = '[HUSTLER_ID]';
```

**Stripe Dashboard:** Connect → Accounts → find account

---

## 1.1.2 Negative: Duplicate Creation

```bash
# Run same command twice
curl -X POST "$HOST/api/stripe/connect/create" \
  -H "Authorization: Bearer $HUSTLER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId": "'$HUSTLER_ID'"}'
```

**Expected (PASS - idempotent):**
```json
{
  "accountId": "acct_xxxxxxxxxxxxx",  // Same as before
  "status": "pending",
  "message": "Account already exists"
}
```

**FAIL if:** Creates second account or throws unhandled error

---

## 1.1.3 Negative: Unauthorized User

```bash
# Random user tries to create Connect for hustler
curl -X POST "$HOST/api/stripe/connect/create" \
  -H "Authorization: Bearer $RANDOM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"userId": "'$HUSTLER_ID'"}'
```

**Expected (PASS - rejection):**
```json
{
  "error": "Unauthorized",
  "code": 403
}
```

**FAIL if:** Account created for wrong user

---

## 1.1.4 Negative: No Auth Token

```bash
curl -X POST "$HOST/api/stripe/connect/create" \
  -H "Content-Type: application/json" \
  -d '{"userId": "'$HUSTLER_ID'"}'
```

**Expected (PASS - rejection):**
```json
{
  "error": "Unauthorized",
  "code": 401
}
```

---

### 1.1 Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 1.1.1 Happy path | ⬜ | ⬜ | ⬜ | | |
| 1.1.2 Duplicate | ⬜ | ⬜ | ⬜ | | |
| 1.1.3 Unauthorized | ⬜ | ⬜ | ⬜ | | |
| 1.1.4 No auth | ⬜ | ⬜ | ⬜ | | |

**Screenshot path:** `gate-01-money/1.1-connect/`

---

# ITEM 1.2: Connect Onboarding

## 1.2.1 Get Onboarding Link

```bash
curl -X GET "$HOST/api/stripe/connect/$HUSTLER_ID/onboard" \
  -H "Authorization: Bearer $HUSTLER_TOKEN"
```

**Expected (PASS):**
```json
{
  "url": "https://connect.stripe.com/setup/...",
  "expiresAt": "2024-12-10T..."
}
```

---

## 1.2.2 Complete Onboarding (Manual)

1. Open URL in browser
2. Use Stripe test data:
   - Business type: Individual
   - SSN last 4: 0000 (test mode)
   - Bank: 000123456789, routing: 110000000
3. Complete all steps

---

## 1.2.3 Verify Status After Onboarding

```bash
curl -X GET "$HOST/api/stripe/connect/$HUSTLER_ID/status" \
  -H "Authorization: Bearer $HUSTLER_TOKEN"
```

**Expected (PASS):**
```json
{
  "status": "verified",
  "canReceivePayouts": true,
  "accountId": "acct_xxxxxxxxxxxxx"
}
```

**DB Query:**
```sql
SELECT stripe_connect_status FROM users WHERE id = '[HUSTLER_ID]';
-- Expected: 'verified'
```

---

## 1.2.4 Negative: Get Status of Other User

```bash
curl -X GET "$HOST/api/stripe/connect/$HUSTLER_ID/status" \
  -H "Authorization: Bearer $RANDOM_TOKEN"
```

**Expected (PASS - rejection):**
```json
{
  "error": "Unauthorized"
}
```

---

### 1.2 Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 1.2.1 Get link | ⬜ | ⬜ | ⬜ | | |
| 1.2.2 Complete onboarding | ⬜ | ⬜ | ⬜ | | |
| 1.2.3 Verify status | ⬜ | ⬜ | ⬜ | | |
| 1.2.4 Unauthorized | ⬜ | ⬜ | ⬜ | | |

---

# ITEM 1.3: Escrow Creation

## 1.3.0 Prerequisite: Create Test Task

```bash
TASK_RESPONSE=$(curl -s -X POST "$HOST/api/tasks" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Gate 1 Test Task - '$ENV' - '$(date +%s)'",
    "description": "Test task for money gate verification",
    "price": 40,
    "category": "moving",
    "location": {"lat": 47.625, "lng": -122.315}
  }')

export TASK_ID=$(echo $TASK_RESPONSE | jq -r '.id // .task.id')
echo "Created task: $TASK_ID"
```

---

## 1.3.1 Create Escrow

```bash
curl -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "'$TASK_ID'",
    "amount": 4000
  }'
```

**Expected (PASS):**
```json
{
  "escrowId": "esc_xxxxx",
  "status": "pending",
  "paymentIntentId": "pi_xxxxx",
  "amount": 4000
}
```

```bash
export ESCROW_ID="esc_xxxxx"  # Save this
```

**DB Query:**
```sql
SELECT id, task_id, amount, status, stripe_payment_intent_id, created_at
FROM escrow WHERE task_id = '[TASK_ID]';
```

**Stripe Dashboard:**
1. Payments → find PaymentIntent
2. Verify amount = $40.00
3. Verify status = `requires_capture` (held)
4. Verify metadata contains taskId

---

## 1.3.2 Negative: Escrow for Non-Owned Task

```bash
# Random user tries to escrow poster's task
curl -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $RANDOM_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "'$TASK_ID'",
    "amount": 4000
  }'
```

**Expected (PASS - rejection):**
```json
{
  "error": "Unauthorized - not task owner"
}
```

---

## 1.3.3 Negative: Escrow Already Exists

```bash
# Try to create second escrow for same task
curl -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "'$TASK_ID'",
    "amount": 4000
  }'
```

**Expected (PASS - rejection or idempotent):**
```json
{
  "error": "Escrow already exists for this task"
}
```

OR returns existing escrow (idempotent)

**FAIL if:** Creates duplicate escrow

---

## 1.3.4 Negative: Invalid Amount

```bash
curl -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "'$TASK_ID'",
    "amount": -100
  }'
```

**Expected (PASS - rejection):**
```json
{
  "error": "Invalid amount"
}
```

---

## 1.3.5 Edge Case: Minimum Amount

```bash
# Create task with $1 (100 cents) - below Stripe minimum?
curl -X POST "$HOST/api/escrow/create" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "'$NEW_TASK_ID'",
    "amount": 100
  }'
```

**Document expected behavior** (Stripe minimum is $0.50)

---

### 1.3 Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 1.3.1 Create escrow | ⬜ | ⬜ | ⬜ | | |
| 1.3.2 Non-owner | ⬜ | ⬜ | ⬜ | | |
| 1.3.3 Duplicate | ⬜ | ⬜ | ⬜ | | |
| 1.3.4 Invalid amount | ⬜ | ⬜ | ⬜ | | |
| 1.3.5 Min amount | ⬜ | ⬜ | ⬜ | | |

---

# ITEM 1.4: Escrow Release (Payout)

## 1.4.0 Prerequisites

```bash
# Task must be accepted by hustler
curl -X POST "$HOST/api/tasks/$TASK_ID/accept" \
  -H "Authorization: Bearer $HUSTLER_TOKEN"

# Proof must be submitted
curl -X POST "$HOST/api/proof/validated/submit" \
  -H "Authorization: Bearer $HUSTLER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "'$TASK_ID'",
    "lat": 47.625,
    "lng": -122.315,
    "accuracy": 10,
    "photoBase64": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "caption": "Test proof"
  }'
```

---

## 1.4.1 Approve Proof (Triggers Payout)

```bash
curl -X POST "$HOST/api/proof/validated/$TASK_ID/approve" \
  -H "Authorization: Bearer $POSTER_TOKEN"
```

**Expected (PASS):**
```json
{
  "success": true,
  "payoutId": "po_xxxxx",
  "transferId": "tr_xxxxx",
  "amount": 3400
}
```

**DB Queries:**
```sql
-- Escrow released
SELECT status, released_at, stripe_transfer_id 
FROM escrow WHERE task_id = '[TASK_ID]';
-- Expected: status='released', released_at NOT NULL

-- Task completed
SELECT status FROM tasks WHERE id = '[TASK_ID]';
-- Expected: 'completed'

-- Payout record
SELECT * FROM payouts WHERE task_id = '[TASK_ID]';
-- Expected: row exists
```

**Stripe Dashboard:**
1. Balance → Transfers → find transfer
2. Verify destination = hustler's Connect account
3. Verify amount = $34.00 (after 15% fee)

---

## 1.4.2 Negative: Hustler Tries to Approve Own Proof

```bash
curl -X POST "$HOST/api/proof/validated/$TASK_ID/approve" \
  -H "Authorization: Bearer $HUSTLER_TOKEN"
```

**Expected (PASS - rejection):**
```json
{
  "error": "Only task poster can approve"
}
```

---

## 1.4.3 Negative: Random User Tries to Approve

```bash
curl -X POST "$HOST/api/proof/validated/$TASK_ID/approve" \
  -H "Authorization: Bearer $RANDOM_TOKEN"
```

**Expected (PASS - rejection):**
```json
{
  "error": "Unauthorized"
}
```

---

## 1.4.4 Negative: Double Approval (Idempotency)

```bash
# Approve twice rapidly
curl -X POST "$HOST/api/proof/validated/$TASK_ID/approve" \
  -H "Authorization: Bearer $POSTER_TOKEN" &
curl -X POST "$HOST/api/proof/validated/$TASK_ID/approve" \
  -H "Authorization: Bearer $POSTER_TOKEN" &
wait
```

**Expected (PASS):**
- Only ONE transfer in Stripe
- No duplicate payout records

**Stripe Check:** Only 1 transfer to hustler for this task

---

## 1.4.5 Negative: Approve Without Escrow

```bash
# Create task without escrow, try to approve
curl -X POST "$HOST/api/proof/validated/$NEW_TASK_ID/approve" \
  -H "Authorization: Bearer $POSTER_TOKEN"
```

**Expected (PASS - rejection):**
```json
{
  "error": "No escrow found for this task"
}
```

---

### 1.4 Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 1.4.1 Approve/payout | ⬜ | ⬜ | ⬜ | | |
| 1.4.2 Hustler self-approve | ⬜ | ⬜ | ⬜ | | |
| 1.4.3 Random approve | ⬜ | ⬜ | ⬜ | | |
| 1.4.4 Double approval | ⬜ | ⬜ | ⬜ | | |
| 1.4.5 No escrow | ⬜ | ⬜ | ⬜ | | |

---

# ITEM 1.5: Refund Path

## 1.5.0 Setup: New Task with Escrow

```bash
# Create new task (different from 1.4)
# Create escrow
# Hustler accepts
# Hustler submits proof
```

---

## 1.5.1 Reject with Refund

```bash
curl -X POST "$HOST/api/proof/validated/$TASK_ID/reject" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Task not completed as described",
    "action": "refund"
  }'
```

**Expected (PASS):**
```json
{
  "success": true,
  "refundId": "re_xxxxx",
  "amount": 4000
}
```

**DB Query:**
```sql
SELECT status, refunded_at FROM escrow WHERE task_id = '[TASK_ID]';
-- Expected: status='refunded'
```

**Stripe Dashboard:**
1. Payments → find PaymentIntent
2. Verify shows "Refunded"

---

## 1.5.2 Negative: Refund Already Refunded

```bash
curl -X POST "$HOST/api/proof/validated/$TASK_ID/reject" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "test", "action": "refund"}'
```

**Expected (PASS - rejection):**
```json
{
  "error": "Escrow already refunded"
}
```

---

## 1.5.3 Negative: Refund Released Escrow

```bash
# Try to refund after payout already released
```

**Expected (PASS - rejection):**
```json
{
  "error": "Cannot refund - escrow already released"
}
```

---

### 1.5 Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 1.5.1 Refund | ⬜ | ⬜ | ⬜ | | |
| 1.5.2 Double refund | ⬜ | ⬜ | ⬜ | | |
| 1.5.3 Refund after release | ⬜ | ⬜ | ⬜ | | |

---

# ITEM 1.6: Dispute Resolution (Admin)

## 1.6.1 Create Dispute

```bash
curl -X POST "$HOST/api/proof/validated/$TASK_ID/reject" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "reason": "Quality dispute",
    "action": "dispute"
  }'
```

**Save dispute ID:**
```bash
export DISPUTE_ID="disp_xxxxx"
```

---

## 1.6.2 Admin Resolve: Refund

```bash
curl -X POST "$HOST/api/admin/disputes/$DISPUTE_ID/resolve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "resolution": "refund",
    "note": "Poster claim verified"
  }'
```

**Expected (PASS):**
```json
{
  "success": true,
  "dispute": {"status": "resolved_refund"},
  "refundId": "re_xxxxx"
}
```

---

## 1.6.3 Admin Resolve: Payout

```bash
curl -X POST "$HOST/api/admin/disputes/$DISPUTE_ID/resolve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "resolution": "payout",
    "note": "Hustler completed work"
  }'
```

**Expected (PASS):**
```json
{
  "success": true,
  "dispute": {"status": "resolved_payout"},
  "transferId": "tr_xxxxx"
}
```

---

## 1.6.4 Admin Resolve: Split

```bash
curl -X POST "$HOST/api/admin/disputes/$DISPUTE_ID/resolve" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "resolution": "split",
    "splitPercent": 50,
    "note": "Partial completion"
  }'
```

**Expected (PASS):**
```json
{
  "success": true,
  "refundAmount": 2000,
  "payoutAmount": 2000
}
```

---

## 1.6.5 Negative: Non-Admin Resolve

```bash
curl -X POST "$HOST/api/admin/disputes/$DISPUTE_ID/resolve" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resolution": "refund"}'
```

**Expected (PASS - rejection):**
```json
{
  "error": "Forbidden",
  "code": 403
}
```

---

### 1.6 Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 1.6.1 Create dispute | ⬜ | ⬜ | ⬜ | | |
| 1.6.2 Admin refund | ⬜ | ⬜ | ⬜ | | |
| 1.6.3 Admin payout | ⬜ | ⬜ | ⬜ | | |
| 1.6.4 Admin split | ⬜ | ⬜ | ⬜ | | |
| 1.6.5 Non-admin | ⬜ | ⬜ | ⬜ | | |

---

# ITEM 1.7: Admin Force Actions

## 1.7.1 Force Complete

```bash
curl -X POST "$HOST/api/admin/tasks/$TASK_ID/force-complete" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Emergency resolution"}'
```

**Expected (PASS):**
```json
{
  "success": true,
  "taskId": "...",
  "action": "force_complete"
}
```

**DB Query:**
```sql
SELECT * FROM admin_actions 
WHERE action_type = 'force_complete' AND target_task_id = '[TASK_ID]';
```

---

## 1.7.2 Force Refund

```bash
curl -X POST "$HOST/api/admin/tasks/$TASK_ID/force-refund" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "Customer service resolution"}'
```

**Expected (PASS):**
```json
{
  "success": true,
  "refundId": "re_xxxxx"
}
```

---

## 1.7.3 Negative: Non-Admin Force

```bash
curl -X POST "$HOST/api/admin/tasks/$TASK_ID/force-refund" \
  -H "Authorization: Bearer $POSTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason": "test"}'
```

**Expected (PASS - rejection):** 403 Forbidden

---

### 1.7 Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 1.7.1 Force complete | ⬜ | ⬜ | ⬜ | | |
| 1.7.2 Force refund | ⬜ | ⬜ | ⬜ | | |
| 1.7.3 Non-admin force | ⬜ | ⬜ | ⬜ | | |

---

# ITEM 1.8: Webhook Handling

## 1.8.1 Valid Webhook

1. Go to Stripe Dashboard → Developers → Webhooks
2. Find endpoint: `$HOST/api/stripe/webhooks`
3. Click "Send test webhook"
4. Select: `payment_intent.succeeded`

**DB Query:**
```sql
SELECT * FROM events 
WHERE metadata->>'type' = 'stripe_webhook'
ORDER BY created_at DESC LIMIT 5;
```

---

## 1.8.2 Invalid Signature

```bash
curl -X POST "$HOST/api/stripe/webhooks" \
  -H "Stripe-Signature: t=123,v1=invalid" \
  -H "Content-Type: application/json" \
  -d '{"type": "payment_intent.succeeded"}'
```

**Expected (PASS - rejection):**
```json
{
  "error": "Invalid signature"
}
```
HTTP 400

---

## 1.8.3 Idempotency (Duplicate Event)

Send same webhook event twice from Stripe Dashboard.

**Expected:**
- Both return 200
- Only one action taken (idempotent)

---

### 1.8 Evidence Checklist

| Test | Local | Staging | Prod | Verified By | Date |
|------|-------|---------|------|-------------|------|
| 1.8.1 Valid webhook | ⬜ | ⬜ | ⬜ | | |
| 1.8.2 Invalid sig | ⬜ | ⬜ | ⬜ | | |
| 1.8.3 Idempotency | ⬜ | ⬜ | ⬜ | | |

---

# GATE 1 SUMMARY

## Total Tests: 35

| Item | Tests | Passed |
|------|-------|--------|
| 1.1 Connect | 4 | /4 |
| 1.2 Onboarding | 4 | /4 |
| 1.3 Escrow Create | 5 | /5 |
| 1.4 Escrow Release | 5 | /5 |
| 1.5 Refund | 3 | /3 |
| 1.6 Dispute | 5 | /5 |
| 1.7 Admin Force | 3 | /3 |
| 1.8 Webhooks | 3 | /3 |
| **TOTAL** | **35** | **/35** |

---

## Environment Matrix

| Environment | Tests Run | Tests Passed |
|-------------|-----------|--------------|
| Local Dev | ⬜ | /35 |
| Staging | ⬜ | /35 |
| Production | ⬜ | /35 |

---

## Gate 1 Final Status

| Criteria | Status |
|----------|--------|
| All happy paths pass | ⬜ |
| All negative paths pass | ⬜ |
| All auth tests pass | ⬜ |
| All environments tested | ⬜ |
| Screenshots collected | ⬜ |
| DB queries verified | ⬜ |
| Stripe Dashboard verified | ⬜ |

**GATE 1 STATUS:** ⬜ **NOT PASSED** / ✅ **PASSED**

---

## Signatures

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Tester | | | |
| Reviewer | | | |
| Final Approver | | | |

---

## Re-Test Triggers

Run Gate 1 again if ANY of these change:

- [ ] StripeService.ts modified
- [ ] Escrow flow changed
- [ ] Payout logic changed
- [ ] Webhook handler changed
- [ ] Admin endpoints changed
- [ ] Database schema migrated
- [ ] Stripe keys rotated
- [ ] New deployment

---

*Bundle version: 2.0*
*Tests: 35*
*Last updated: 2024-12-09*
