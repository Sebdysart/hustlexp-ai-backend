# Phase 14A: Seattle Beta Reality Calibration

## Purpose

Learn from real users without breaking invariants.

**The kernel is FROZEN. No new features. Only parameter tuning.**

---

## Daily Rituals

### 1. Morning Check (5 min)

```bash
curl https://your-backend.up.railway.app/api/beta/metrics
```

Review:
- `proofRejectionRate` — Target < 15%
- `escalationRate` — Target < 5%
- `adminOverrideRate` — Target < 1%
- `disputeRate` — Target < 3%

If any breached → investigate immediately.

---

### 2. Daily Report (10 min)

```bash
curl https://your-backend.up.railway.app/api/beta/daily-report
```

Review:
- `tasksCompleted` — volume trend
- `proofsRejected` — rising = policy too strict
- `adminOverrides` — rising = policy too weak
- `healthStatus` — if "warning" or "critical", action needed

---

## What To Tune (And What NOT To)

### ✅ TUNE THESE (Parameters)

| Parameter | Location | When to Adjust |
|-----------|----------|----------------|
| Proof rejection sensitivity | `ProofPolicy.ts` | False positives > 10% |
| Escalation triggers | `ProofFreezeService.ts` | Too many escalations |
| Beta thresholds | `BetaMetricsService.ts` | After data proves safe |

### 🚫 DO NOT TOUCH

| Component | Why |
|-----------|-----|
| `PayoutEligibilityResolver` | Kernel is frozen |
| `StripeMoneyEngine` | Kernel is frozen |
| `KillSwitch` | Existential safety |
| Ledger logic | Financial correctness |

---

## Escalation Patterns to Watch

### 1. Proof Rejection Spike

**Signal:** `proofRejectionRate` > 15%

**Investigate:**
```sql
SELECT forensics_result->>'anomalies' as anomalies, COUNT(*)
FROM proof_submissions
WHERE state = 'rejected'
AND created_at > NOW() - INTERVAL '24 hours'
GROUP BY 1
ORDER BY 2 DESC;
```

**Common Causes:**
- Lighting conditions (outdoor tasks)
- Low-quality phone cameras
- Policy too strict for task type

**Action:** Adjust forensics thresholds, NOT payout logic.

---

### 2. Escalation Rate High

**Signal:** `escalationRate` > 5%

**Investigate:**
```sql
SELECT block_reason, COUNT(*)
FROM payout_eligibility_log
WHERE decision = 'ESCALATE'
AND evaluated_at > NOW() - INTERVAL '24 hours'
GROUP BY 1;
```

**Common Causes:**
- AI triggering too many escalations
- Proof hash reuse detection false positives
- Policy mismatch between task types

**Action:** Review escalation triggers in `ProofPolicy.ts`.

---

### 3. Admin Overrides Rising

**Signal:** `adminOverrideRate` > 1%

**Investigate:**
```sql
SELECT admin_override->>'reason', COUNT(*)
FROM payout_eligibility_log
WHERE admin_override IS NOT NULL
AND evaluated_at > NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY 2 DESC;
```

**Common Causes:**
- Policy blocking legitimate payouts
- Edge cases not covered by rules
- UX confusion causing unnecessary disputes

**Action:** If same reason repeats, consider policy change.

---

## Weekly Calibration Review

Every Friday, run:

```sql
-- Weekly summary
SELECT 
    date_trunc('day', evaluated_at) as day,
    COUNT(*) FILTER (WHERE decision = 'ALLOW') as allowed,
    COUNT(*) FILTER (WHERE decision = 'BLOCK') as blocked,
    COUNT(*) FILTER (WHERE decision = 'ESCALATE') as escalated,
    ROUND(COUNT(*) FILTER (WHERE decision = 'BLOCK')::numeric / NULLIF(COUNT(*), 0) * 100, 1) as block_rate
FROM payout_eligibility_log
WHERE evaluated_at > NOW() - INTERVAL '7 days'
GROUP BY 1
ORDER BY 1;
```

**Healthy pattern:**
- Block rate stable or decreasing
- Escalations decreasing
- Allow rate increasing

**Unhealthy pattern:**
- Block rate increasing week over week
- Same block reasons repeating
- User complaints rising

---

## What Success Looks Like (Week 1-2)

| Metric | Target | Action if Missed |
|--------|--------|------------------|
| Proof submission rate | > 80% of completions | Check UX, add reminders |
| Proof verification rate | > 85% | Relax forensics thresholds |
| Payout success rate | > 95% | Review block reasons |
| Dispute rate | < 3% | Improve task descriptions |
| Avg payout time | < 24h | Check escalation backlog |

---

## Phase 14A Exit Criteria

Move to Phase 14B when:

1. 2+ weeks of stable operation
2. All threshold alerts resolved
3. No KillSwitch activations
4. Admin override rate < 0.5%
5. User feedback is "clarity", not "confusion"

**Do NOT move to 14B early.** Data must prove the system before expanding AI.
