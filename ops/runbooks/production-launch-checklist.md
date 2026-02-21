# HustleXP Production Launch Checklist

**Last Updated:** 2025-02-21
**Target:** Alpha → GA promotion
**Owner:** Backend Team

---

## Pre-Launch (T-7 days)

### Infrastructure

- [ ] Railway production environment configured
- [ ] Neon PostgreSQL production database provisioned
- [ ] Upstash Redis production instance provisioned
- [ ] Custom domain + SSL configured
- [ ] CDN (Cloudflare) in front of Railway
- [ ] DNS propagation verified

### Security

- [ ] All environment variables set in Railway (no placeholders)
- [ ] `validateConfig()` runs on startup (server.ts)
- [ ] Stripe webhook endpoint registered in Stripe Dashboard
- [ ] Firebase project set to production mode
- [ ] Sentry DSN configured for production
- [ ] Rate limits verified for production load
- [ ] CORS origins updated to production domains only
- [ ] Health endpoint does NOT expose environment info

### Database

- [ ] All migrations applied (`schema_versions` table current)
- [ ] 5 invariant triggers verified active:
  - `xp_requires_released_escrow`
  - `escrow_released_requires_completed_task`
  - `task_completed_requires_accepted_proof`
  - `task_terminal_guard`
  - `escrow_terminal_guard`
- [ ] Connection pool sized for expected load (max 20)
- [ ] Performance indexes created (`performance_indexes_v1`)
- [ ] Backup schedule configured (Neon automated backups)

### Monitoring

- [ ] Grafana dashboard imported (`ops/grafana/dashboard.json`)
- [ ] Alert rules deployed (`ops/alerts/critical.yml`)
- [ ] PagerDuty integration for P0 alerts
- [ ] Slack #alerts channel for P1/P2
- [ ] Sentry error tracking configured
- [ ] Log aggregation (Railway logs → external if needed)

---

## Launch Day (T-0)

### Smoke Tests

- [ ] `k6 run ops/load-test/k6-smoke.js` passes all thresholds
- [ ] `/health` returns `{ status: "healthy" }`
- [ ] `/health/readiness` returns 200 with DB latency <100ms
- [ ] `/health/detailed` shows all circuit breakers CLOSED
- [ ] Stripe test webhook fires and processes correctly

### Functional Verification

- [ ] User registration flow works (Firebase Auth)
- [ ] Task creation succeeds (OPEN state)
- [ ] Task acceptance succeeds (OPEN → ACCEPTED)
- [ ] Escrow creation + funding works (PENDING → FUNDED)
- [ ] Stripe payment intent creates successfully
- [ ] Proof submission flow works
- [ ] Escrow release + payout works (FUNDED → RELEASED)

### Go/No-Go Decision

- [ ] Error rate <1% for 15 minutes
- [ ] P99 latency <500ms
- [ ] No P0 alerts firing
- [ ] All circuit breakers CLOSED
- [ ] DB connection pool utilization <50%

---

## Post-Launch (T+1 to T+7)

### Day 1

- [ ] Monitor error rate continuously
- [ ] Verify no escrow state drift
- [ ] Check AI daily spend is within $50 budget
- [ ] Review Sentry for new error patterns

### Week 1

- [ ] Run `k6-stress.js` against production (off-peak hours)
- [ ] Review P99 latency trends
- [ ] Check 1099-K threshold monitoring
- [ ] Verify backup restore works (test restore to dev)
- [ ] Review rate limit hit patterns (abuse detection)

---

## Rollback Plan

1. **Immediate:** Railway instant rollback to previous deployment
2. **Database:** Neon point-in-time recovery (PITR)
3. **Stripe:** Webhook endpoint can be disabled in Stripe Dashboard
4. **DNS:** Cloudflare can redirect to maintenance page in <30s
