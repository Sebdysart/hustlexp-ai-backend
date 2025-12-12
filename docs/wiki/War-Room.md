# War Room Protocol

## Pre-Launch (T-60 minutes)

- [ ] Clear all logs
- [ ] Verify health endpoint
- [ ] Synthetic payout test (sandbox)
- [ ] Confirm webhook reachability
- [ ] Confirm AI fallback chain

## Launch Window (Hours 0-4)

**Monitor every 5 minutes:**

| Metric | Target | Alert If |
|---|---|---|
| Stripe events | Processing | Queue > 10 |
| Payout queue | Empty | Queue > 5 |
| Webhook retries | 0 | > 3 |
| AI latency | < 5s | > 10s |
| Error rate | < 1% | > 2% |

**Command:**
```bash
watch -n 60 'curl -s https://<app>.railway.app/health/detailed | jq .'
```

## Stabilization (Hours 4-12)

| Check | Frequency |
|---|---|
| P99 latency | Hourly |
| Request ID correlation | Hourly |
| Admin actions | Hourly |
| XP duplication | Hourly |

## Post-Launch (T+24 hours)

```sql
-- XP integrity
SELECT COUNT(*) FROM xp_events 
GROUP BY user_id, task_id HAVING COUNT(*) > 1;

-- Escrow integrity
SELECT * FROM money_state_lock 
WHERE current_state NOT IN ('completed', 'refunded');
```
