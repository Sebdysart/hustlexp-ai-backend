# 1099-K Threshold Tracking

**Regulation:** IRS 1099-K reporting requirements
**Applicability:** HustleXP is a Third Party Settlement Organization (TPSO)
**Last Updated:** 2025-02-21

---

## Current Thresholds (2024-2025 Tax Year)

| Threshold | Amount | Status |
|-----------|--------|--------|
| Federal 1099-K threshold | $5,000 | Must report workers earning ≥$5,000/year |
| State thresholds (vary) | $600-$5,000 | Some states have lower thresholds |

> **Note:** The federal threshold was $20,000 prior to 2024. The IRS phased down
> to $5,000 for 2024 and plans $2,500 for 2025 and $600 for 2026+.

---

## Implementation Plan

### Phase 1: Data Collection (Alpha — Current)

```sql
-- Earnings tracking query (already in EscrowService.release())
-- Records each payout in escrows table with:
--   worker_id, amount, released_at, stripe_payment_intent_id

-- Aggregate query for threshold monitoring:
SELECT
  u.id AS worker_id,
  u.email,
  u.full_name,
  SUM(e.amount) AS total_earnings_cents,
  SUM(e.amount) / 100.0 AS total_earnings_usd,
  COUNT(*) AS transaction_count,
  MIN(e.released_at) AS first_payout,
  MAX(e.released_at) AS last_payout
FROM escrows e
JOIN tasks t ON t.id = e.task_id
JOIN users u ON u.id = t.worker_id
WHERE e.state = 'RELEASED'
  AND e.released_at >= '2025-01-01'
  AND e.released_at < '2026-01-01'
GROUP BY u.id, u.email, u.full_name
HAVING SUM(e.amount) >= 500000  -- $5,000 threshold in cents
ORDER BY total_earnings_usd DESC;
```

### Phase 2: Stripe Tax Reporting (Pre-GA)

- [ ] Enable Stripe Tax Reporting via Connect
- [ ] Collect W-9/tax info via Stripe Identity
- [ ] Implement tax document delivery (1099-K generation)
- [ ] Set up automated threshold monitoring alerts

### Phase 3: State Compliance (GA)

- [ ] Map state-specific thresholds
- [ ] Implement per-state reporting logic
- [ ] Tax ID (TIN) validation
- [ ] Annual filing automation

---

## Worker Notification Requirements

When a worker approaches the 1099-K threshold:

| Earnings Level | Action |
|---------------|--------|
| $4,000 (80%) | In-app notification: "You're approaching the $5,000 tax reporting threshold" |
| $4,500 (90%) | Email + in-app: "Tax information may be required soon" |
| $5,000 (100%) | Block further payouts until W-9 collected via Stripe |

---

## Monitoring Alert (add to ops/alerts/critical.yml)

```yaml
- alert: Worker1099ThresholdApproaching
  expr: |
    worker_annual_earnings_usd{app="hustlexp"} > 4000
  labels:
    severity: info
    team: compliance
  annotations:
    summary: "Worker {{ $labels.worker_id }} approaching 1099-K threshold"
```
