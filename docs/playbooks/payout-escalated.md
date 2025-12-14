# Payout Escalated — Operator Playbook

> **When to use:** A payout has returned `ESCALATE` decision from the PayoutEligibilityResolver.

---

## 1. Understand Why It Escalated

Check the `EligibilityResult.blockReason`:

| Block Reason | Meaning |
|--------------|---------|
| `PROOF_REJECTED` | Proof was submitted but failed verification |
| `PROOF_ESCALATED` | Proof flagged for manual review (suspicious signals) |
| `ADMIN_OVERRIDE_REQUIRED` | System error during evaluation |

---

## 2. Access the Audit Trail

```sql
SELECT * FROM payout_eligibility_log 
WHERE task_id = '<task_id>'::uuid 
ORDER BY evaluated_at DESC;
```

Review `details` field for:
- `proofState` — Current proof status
- `hasValidProof` — Whether valid proof exists
- `disputeActive` — Whether dispute is blocking

---

## 3. Review Proof Submission

```sql
SELECT ps.*, pr.reason, pr.instructions
FROM proof_submissions ps
JOIN proof_requests pr ON pr.id = ps.request_id
WHERE ps.task_id = '<task_id>'::uuid
ORDER BY ps.created_at DESC;
```

Check:
- `forensics_result` — AI analysis results
- `state` — Current proof state
- `file_url` — View the submitted proof

---

## 4. Make a Decision

### Option A: Approve Payout (with override)

If proof is valid but flagged incorrectly:

1. Verify the proof image manually
2. Use admin override:

```typescript
await StripeMoneyEngine.handle(taskId, 'RELEASE_PAYOUT', context, {
    adminOverride: {
        enabled: true,
        adminId: 'your_admin_id',
        reason: 'Manual verification: proof confirmed valid'
    }
});
```

3. Log your action:
```sql
INSERT INTO admin_actions (admin_id, action, target_id, notes, created_at)
VALUES ('your_admin_id', 'PAYOUT_OVERRIDE', '<task_id>', 'Manually verified proof', NOW());
```

### Option B: Reject and Refund

If proof is invalid:

1. Request new proof or resolve as refund:

```typescript
await StripeMoneyEngine.handle(taskId, 'REFUND_ESCROW', {
    taskId,
    refundAmountCents: <amount>,
    reason: 'Proof verification failed - admin decision'
});
```

2. Notify both parties via support channel

### Option C: Request More Information

1. Contact hustler for additional proof
2. Keep task in escalated state
3. Set a 24-hour reminder to follow up

---

## 5. Close the Escalation

After resolution:

1. Update `payout_eligibility_log` with resolution:
```sql
UPDATE payout_eligibility_log 
SET admin_override = '{"resolved": true, "adminId": "...", "resolution": "approved|refunded"}'
WHERE evaluation_id = '<evaluation_id>';
```

2. Document outcome in admin notes

---

## Red Flags

⚠️ **Escalate to senior admin if:**
- Same hustler has 3+ escalations in 7 days
- Proof shows obvious fraud attempt
- Dollar amount > $200
- Poster is a high-value customer

---

## SLA

| Priority | Response Time |
|----------|---------------|
| < $50 | 24 hours |
| $50-100 | 12 hours |
| > $100 | 4 hours |
