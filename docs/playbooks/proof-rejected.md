# Proof Rejected — Operator Playbook

> **When to use:** A proof submission has been rejected, blocking payout.

---

## 1. Understand the Rejection

Check the proof submission:

```sql
SELECT ps.id, ps.state, ps.forensics_result, ps.file_url,
       pr.reason, pr.instructions
FROM proof_submissions ps
JOIN proof_requests pr ON pr.id = ps.request_id
WHERE ps.task_id = '<task_id>'::uuid
ORDER BY ps.created_at DESC
LIMIT 1;
```

### Common Rejection Reasons

| Signal | Meaning |
|--------|---------|
| `likelyScreenshot: true` | Image appears to be a screenshot, not original photo |
| `likelyAIGenerated: true` | AI generation patterns detected |
| `likelyEdited: true` | Image shows signs of editing/manipulation |
| Low `confidenceScore` | Multiple anomalies detected |
| Hash reuse | Same evidence used on different task |

---

## 2. Review the Proof Image

1. Access the file: `file_url` from the submission
2. Manually check:
   - Does it show the described work?
   - Is it clearly from a phone camera?
   - Does timestamp make sense?
   - Does location match (if GPS required)?

---

## 3. Decision Tree

```
Is the proof obviously valid?
├── YES → Override rejection, approve payout
│         (False positive from AI)
│
└── NO → Is hustler a repeat offender?
         ├── YES → Issue strike, refund poster
         │
         └── NO → Request new proof
                  (Give benefit of doubt first time)
```

---

## 4. Actions

### A. Override Rejection (AI False Positive)

If proof is valid but AI flagged incorrectly:

1. Update proof state:
```sql
UPDATE proof_submissions 
SET state = 'verified', 
    updated_at = NOW()
WHERE id = '<submission_id>';
```

2. Clear freeze state:
```typescript
await ProofFreezeService.setFreezeState(taskId, 'PROOF_VERIFIED');
```

3. Log override:
```sql
INSERT INTO proof_events (task_id, event_type, actor, actor_type, details)
VALUES (
    '<task_id>'::uuid, 
    'admin_override', 
    'your_admin_id', 
    'admin',
    '{"reason": "Manual review: proof valid, AI false positive"}'
);
```

4. Proceed with payout via admin override

---

### B. Request New Proof

If proof is unclear but hustler seems legitimate:

1. Create new proof request:
```typescript
await ProofService.createRequest({
    taskId,
    proofType: 'photo',
    reason: 'task_completion',
    requestedBy: 'system',
    instructions: 'Please submit a new photo. Previous photo could not be verified. Make sure to take a fresh photo showing [specific thing needed].',
    deadlineHours: 24
});
```

2. Notify hustler via app notification

3. Set follow-up reminder for 24 hours

---

### C. Reject and Refund (Fraud/Invalid)

If proof is clearly invalid or fraudulent:

1. Lock the submission:
```sql
UPDATE proof_submissions 
SET state = 'rejected', 
    locked_at = NOW()
WHERE id = '<submission_id>';
```

2. Check for pattern abuse:
```sql
SELECT COUNT(*) as rejection_count 
FROM proof_submissions 
WHERE submitted_by = '<hustler_id>' 
AND state = 'rejected'
AND created_at > NOW() - INTERVAL '30 days';
```

3. If 3+ rejections → Issue strike:
```typescript
await DisputeService.addStrike(
    hustlerId,
    'Repeated proof rejections',
    2, // severity
    'ai',
    { taskId }
);
```

4. Refund poster:
```typescript
await StripeMoneyEngine.handle(taskId, 'REFUND_ESCROW', {
    taskId,
    refundAmountCents: <amount>,
    reason: 'Proof verification failed'
});
```

---

## 5. User Communication

### To Hustler (Proof Re-requested)

> Your completion photo couldn't be verified. This sometimes happens with certain lighting or angles.
> 
> Please submit a new photo showing [specific requirement].
> 
> You have 24 hours to submit. Your payment will be processed once verified.

### To Hustler (Rejected)

> Your completion photo for "[task title]" was reviewed and could not be accepted.
> 
> [Specific reason if appropriate]
> 
> The poster has been refunded. If you believe this is an error, please contact support.

### To Poster (Refund)

> The work for "[task title]" could not be verified. Your payment has been refunded.
> 
> If you'd like to repost this task, you can do so from your dashboard.

---

## Red Flags — Escalate Immediately

⚠️ **Escalate if:**
- Same image hash used across multiple tasks
- Hustler has 3+ rejections in 7 days
- Evidence of AI-generated content
- Metadata shows impossible timeline (photo before task accepted)
