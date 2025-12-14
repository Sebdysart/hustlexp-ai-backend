# KillSwitch Fired — Operator Playbook

> **When to use:** The system KillSwitch has been triggered. ALL financial operations are frozen.

---

## 🚨 IMMEDIATE PRIORITY — THIS IS A SYSTEM-WIDE FREEZE

When KillSwitch fires:
- No payouts can be released
- No escrow can be captured
- No refunds can be processed
- Users see "Payments Temporarily Paused"

---

## 1. Confirm KillSwitch is Active

```bash
# Check Redis state
redis-cli GET sys:kill_switch:active
redis-cli GET sys:kill_switch:reason
redis-cli GET sys:kill_switch:meta
```

Or check logs for:
```
⚠️ KILL SWITCH TRIGGERED - SYSTEM FREEZING ⚠️
```

---

## 2. Identify the Trigger Reason

| Reason | Meaning | Severity |
|--------|---------|----------|
| `LEDGER_DRIFT` | Ledger sum does not equal zero | 🔴 CRITICAL |
| `STRIPE_OUTAGE` | Stripe API failures detected | 🟡 EXTERNAL |
| `IDENTITY_FRAUD_SPIKE` | Multiple fraud attempts detected | 🟠 HIGH |
| `SAGA_RETRY_EXHAUSTION` | Money saga failed after max retries | 🔴 CRITICAL |
| `MANUAL_OVERRIDE` | Admin triggered manually | 🟢 CONTROLLED |
| `TEST_SIMULATION` | Test mode (ignore if expected) | 🟢 TEST |

---

## 3. Triage by Reason

### LEDGER_DRIFT (Critical)

Money accounting is broken. DO NOT resolve until fixed.

1. Run ledger audit:
```sql
SELECT 
    SUM(CASE WHEN direction = 'debit' THEN amount ELSE 0 END) as total_debits,
    SUM(CASE WHEN direction = 'credit' THEN amount ELSE 0 END) as total_credits
FROM ledger_entries
WHERE ledger_transaction_id IN (
    SELECT id FROM ledger_transactions WHERE status = 'committed'
);
```

2. Find the imbalanced transaction:
```sql
SELECT lt.id, lt.type, lt.created_at,
    SUM(CASE WHEN le.direction = 'debit' THEN le.amount ELSE 0 END) as debits,
    SUM(CASE WHEN le.direction = 'credit' THEN le.amount ELSE 0 END) as credits
FROM ledger_transactions lt
JOIN ledger_entries le ON le.ledger_transaction_id = lt.id
WHERE lt.status = 'committed'
GROUP BY lt.id, lt.type, lt.created_at
HAVING SUM(CASE WHEN le.direction = 'debit' THEN le.amount ELSE 0 END) 
    != SUM(CASE WHEN le.direction = 'credit' THEN le.amount ELSE 0 END);
```

3. **DO NOT resolve KillSwitch until ledger is balanced**

---

### STRIPE_OUTAGE (External)

Stripe is having issues.

1. Check Stripe status: https://status.stripe.com/
2. Check our recent failures:
```sql
SELECT * FROM stripe_outbound_log 
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

3. If Stripe confirms resolved, test with a small operation
4. Resolve KillSwitch only after successful test

---

### IDENTITY_FRAUD_SPIKE

Multiple fraud attempts detected.

1. Check recent strikes:
```sql
SELECT * FROM strikes 
WHERE created_at > NOW() - INTERVAL '1 hour'
ORDER BY created_at DESC;
```

2. Review flagged users:
```sql
SELECT u.*, COUNT(s.id) as strike_count
FROM users u
JOIN strikes s ON s.user_id = u.id
WHERE s.created_at > NOW() - INTERVAL '24 hours'
GROUP BY u.id
ORDER BY strike_count DESC;
```

3. Suspend high-risk accounts manually
4. Resolve KillSwitch after threat contained

---

### SAGA_RETRY_EXHAUSTION

A money operation failed permanently.

1. Check DLQ:
```sql
SELECT * FROM ledger_pending_actions 
WHERE status = 'pending'
ORDER BY created_at DESC;
```

2. Review failed transaction and determine:
   - Can it be retried safely?
   - Should it be manually resolved?
   - Does it need Stripe reconciliation?

3. Resolve the DLQ item before clearing KillSwitch

---

## 4. Resolve KillSwitch

**Only after root cause is addressed:**

```typescript
await KillSwitch.resolve();
```

Or via Redis:
```bash
redis-cli DEL sys:kill_switch:active
redis-cli DEL sys:kill_switch:reason
redis-cli DEL sys:kill_switch:meta
```

---

## 5. Post-Incident

1. Document in incident log:
```sql
INSERT INTO admin_actions (admin_id, action, notes, created_at)
VALUES ('your_id', 'KILLSWITCH_RESOLVED', 'Reason: ... Resolution: ...', NOW());
```

2. Notify team via Slack/PagerDuty
3. Write post-mortem if duration > 30 minutes
4. Monitor for 1 hour after resolution

---

## Communication Template

For user-facing status page:

> **Payment Processing Delayed**
> 
> We're experiencing a brief delay in processing payments. All funds are safe and secure. 
> Payments will resume shortly. We apologize for any inconvenience.
>
> Last updated: [TIME]

---

## Escalation

| Condition | Action |
|-----------|--------|
| KillSwitch > 30 mins | Page on-call engineer |
| LEDGER_DRIFT detected | Page CTO immediately |
| Cannot identify cause | Page senior backend engineer |
