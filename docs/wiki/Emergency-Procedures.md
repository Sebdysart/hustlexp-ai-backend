# Emergency Procedures

## Rollback

```bash
railway rollback --to <previous-deployment-id>
```

## Disable Payouts

```bash
railway variables set PAYOUTS_DISABLED=true
railway up
```

## Freeze Stripe

1. Stripe Dashboard → Settings → Payouts
2. Click "Pause payouts"

## Kill Switch (Full Stop)

```bash
railway service stop hustlexp-backend-production
```

## Database Snapshot

```bash
pg_dump $DATABASE_URL > emergency_backup_$(date +%Y%m%d_%H%M%S).sql
```

## Recovery Checklist

After emergency:

1. [ ] Identify root cause
2. [ ] Document incident
3. [ ] Verify data integrity
4. [ ] Test fix in staging
5. [ ] Deploy fix
6. [ ] Monitor for recurrence
