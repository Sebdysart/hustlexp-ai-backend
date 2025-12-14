# Dispute Resolution — Operator Playbook

> **When to use:** A poster has opened a dispute against a completed task.

---

## 1. Access Dispute Details

```sql
SELECT d.*, 
       t.title as task_title, 
       t.price,
       poster.email as poster_email,
       hustler.email as hustler_email
FROM disputes d
JOIN tasks t ON t.id = d.task_id
JOIN users poster ON poster.id = d.poster_id
JOIN users hustler ON hustler.id = d.hustler_id
WHERE d.id = '<dispute_id>';
```

---

## 2. Review Evidence

### Poster Evidence
```sql
SELECT * FROM dispute_evidence 
WHERE dispute_id = '<dispute_id>' 
AND submitted_by = '<poster_id>';
```

### Hustler Response
```sql
SELECT * FROM dispute_evidence 
WHERE dispute_id = '<dispute_id>' 
AND submitted_by = '<hustler_id>';
```

### Proof Submissions
```sql
SELECT * FROM proof_submissions 
WHERE task_id = '<task_id>'::uuid
ORDER BY created_at DESC;
```

---

## 3. Decision Framework

### Favor Poster (Refund) if:
- No proof submitted by hustler
- Proof clearly shows incomplete work
- Hustler did not respond within 48 hours
- Clear evidence of poor/no work

### Favor Hustler (Payout) if:
- Valid proof shows completed work
- Poster expectations were unreasonable
- Work matched task description
- Poster changed requirements mid-task

### Split if:
- Partial completion evident
- Both parties contributed to issue
- Unclear evidence on either side

---

## 4. Resolution Actions

### A. Refund Poster (Favor Poster)

```typescript
// 1. Resolve dispute
await DisputeService.resolveRefund(disputeId, adminId);

// This automatically:
// - Cancels/refunds escrow via StripeMoneyEngine
// - Updates dispute status to 'refunded'
// - Logs the resolution
```

Post-resolution:
```sql
-- Add strike if hustler was at fault
INSERT INTO strikes (user_id, reason, severity, source, task_id)
VALUES ('<hustler_id>', 'Dispute lost - work not completed', 2, 'manual', '<task_id>');
```

### B. Payout Hustler (Favor Hustler)

```typescript
// 1. Resolve dispute with uphold
await DisputeService.resolveUphold(disputeId, adminId);

// This automatically:
// - Releases payout via StripeMoneyEngine
// - Updates dispute status to 'upheld'
// - Logs the resolution
```

Note: Consider if poster is filing frivolous disputes:
```sql
SELECT COUNT(*) FROM disputes 
WHERE poster_id = '<poster_id>' 
AND status = 'upheld'
AND created_at > NOW() - INTERVAL '90 days';
```

### C. Split Payment

Manual process:
1. Calculate split amounts
2. Process partial refund to poster
3. Process partial payout to hustler
4. Update dispute with split details

```sql
UPDATE disputes 
SET status = 'resolved',
    resolution_notes = 'Split 50/50 - partial completion',
    resolved_at = NOW(),
    resolved_by = '<admin_id>'
WHERE id = '<dispute_id>';
```

---

## 5. Communication

### To Both Parties (Resolution)

> **Dispute Resolved**
> 
> We've reviewed the dispute for "[task title]".
> 
> **Decision:** [Refunded to poster / Paid to hustler / Split payment]
> 
> **Reason:** [Brief explanation]
> 
> If you have questions about this decision, please contact support.

### Hustler Lost (Strike Warning)

> **Important Notice**
> 
> A dispute was resolved against you. A strike has been added to your account.
> 
> Strikes: [X] / 3
> 
> Three strikes within 90 days will result in account suspension.
> 
> To avoid future disputes:
> - Always submit completion photos
> - Communicate clearly with posters
> - Don't accept tasks you can't complete

---

## 6. Edge Cases

### Hustler No-Shows
1. Check if hustler accepted task
2. Check for any communication
3. Almost always favor poster
4. Issue strike to hustler

### Poster Changed Requirements
1. Check chat history for requirement changes
2. If poster added work mid-task, favor hustler
3. Consider partial refund for truly incomplete scope

### Both Parties Unresponsive
1. Wait full 48-hour response window
2. If no response from either, refund poster
3. No strike to hustler (can't confirm fault)

---

## 7. SLA

| Amount | Resolution Target |
|--------|-------------------|
| < $50 | 48 hours |
| $50-100 | 36 hours |
| $100-200 | 24 hours |
| > $200 | 12 hours |

---

## 8. Escalation

⚠️ **Escalate if:**
- Physical safety concerns mentioned
- Allegations of theft or property damage
- Harassment or threats in communication
- Same users in repeated disputes
- Amount > $300
