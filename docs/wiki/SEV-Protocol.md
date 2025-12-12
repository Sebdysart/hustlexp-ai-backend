# SEV Protocol

## SEV0 — CATASTROPHIC

**Symptoms:**
- Money incorrectly moved
- Payout double-executed
- Stripe transfer mismatch

**Actions:**
1. DISABLE PAYOUTS — `railway variables set PAYOUTS_DISABLED=true`
2. FREEZE STRIPE — Pause payouts in Dashboard
3. ALERT — Notify all stakeholders
4. DOCUMENT — Screenshot evidence

**Response Time:** < 5 minutes

---

## SEV1 — CRITICAL

**Symptoms:**
- AI outage (all providers)
- Task approvals failing
- Webhook processing stopped

**Actions:**
1. DEGRADE — Enable fallback mode
2. PAUSE — Halt non-critical operations
3. DIAGNOSE — Check provider status
4. COMMUNICATE — User status update

**Response Time:** < 15 minutes

---

## SEV2 — HIGH

**Symptoms:**
- Latency spikes > 5s
- XP service delays
- Single AI provider down

**Actions:**
1. RESTART — Affected workers
2. SWITCH — To fallback AI provider
3. MONITOR — For recovery

**Response Time:** < 1 hour

---

## SEV3 — MEDIUM

**Symptoms:**
- Minor error logs
- Admin endpoint failures

**Actions:**
1. LOG — Document issue
2. SCHEDULE — Fix within 48 hours

**Response Time:** < 48 hours
