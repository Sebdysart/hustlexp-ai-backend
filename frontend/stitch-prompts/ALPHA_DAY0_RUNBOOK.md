# Alpha Day-0 Runbook
## Purpose: What metrics you watch daily, when you intervene, when you do nothing

---

## Core Principle

> **"The system is the authority. You are the observer."**

You do not override the system.
You do not make exceptions.
You do not "fix" outcomes.

You **watch, measure, and decide whether to continue or stop**.

---

## Daily Metrics Dashboard (What You Watch)

### Primary KPIs (Non-Negotiable)

1. **Median Time-to-Accept (Instant tasks)**
   - Target: ≤ 60 seconds
   - Alert threshold: > 90 seconds for 24 hours
   - Action: If > 90s for 24h → disable Instant Mode immediately

2. **Instant Completion Rate**
   - Target: ≥ 90%
   - Alert threshold: < 85% for 48 hours
   - Action: If < 85% for 48h → investigate quality gates

3. **Dispute Rate (Instant vs Standard)**
   - Target: ≤ 5%
   - Alert threshold: > 10%
   - Action: If > 10% → disable Instant Mode immediately (rollback trigger)

4. **Abandonment Rate**
   - Target: ≤ 5%
   - Alert threshold: > 10%
   - Action: If > 10% → investigate trust tier enforcement

5. **Fallback to OPEN Rate**
   - Target: ≤ 25%
   - Alert threshold: > 40% for 24 hours
   - Action: If > 40% for 24h → investigate liquidity (trust tier too strict?)

6. **Surge Level 2 Usage**
   - Target: ≤ 30%
   - Alert threshold: > 50% for 24 hours
   - Action: If > 50% for 24h → investigate supply/demand balance

### Secondary Metrics (Diagnostic Only)

- Hustler accept rate (per interrupt)
- Notification delivery → open time
- Dismiss rate
- XP award failures
- Worker crash loops

---

## When You Intervene (Explicit Triggers)

### Immediate Rollback (Kill Switch)

**Trigger:** Any of these conditions:

1. Dispute rate > 10%
2. Median accept time > 90s for 24h
3. Data corruption detected
4. Safety concern reported

**Action:**
```bash
# Set all Instant Mode flags to false
INSTANT_MODE_ENABLED=false
INSTANT_SURGE_ENABLED=false
INSTANT_INTERRUPTS_ENABLED=false
```

**Then:**
- Notify alpha participants
- Log incident
- Do not re-enable until root cause identified

---

### Investigate (Do Not Disable)

**Trigger:** Any of these conditions:

1. Completion rate < 85% for 48h (but > 80%)
2. Fallback rate > 40% for 24h
3. Surge Level 2 > 50% for 24h
4. XP award failures spike

**Action:**
- Review logs for patterns
- Check trust tier distribution
- Verify eligibility guard enforcement
- Do NOT disable features
- Do NOT make exceptions

---

## When You Do Nothing (Critical Discipline)

**Do NOT intervene if:**

1. Individual task failures (system handles disputes)
2. One hustler complains about trust tier (system is authority)
3. Poster wants to bypass AI gate (system blocks for reason)
4. Metrics fluctuate within acceptable ranges (variance is normal)
5. Edge cases appear (system is designed to handle them)

**Principle:**
> If the system is working as designed, let it work.

---

## Daily Operating Cadence

### Morning Check (9:00 AM)

1. **Review overnight metrics**
   - Median time-to-accept
   - Completion rate
   - Dispute rate
   - Any alerts triggered?

2. **Check logs for errors**
   - Worker crashes
   - XP award failures
   - Eligibility guard rejections

3. **Verify system health**
   - Database connections
   - Queue processing
   - Notification delivery

**If all green:** Do nothing. System is working.

---

### Midday Check (2:00 PM)

1. **Review morning activity**
   - Tasks created
   - Accepts completed
   - Any anomalies?

2. **Check alpha participant feedback**
   - Review incident log
   - Note patterns (do not react to individual complaints)

**If all green:** Do nothing. System is working.

---

### Evening Review (6:00 PM)

1. **Daily summary**
   - All primary KPIs within target?
   - Any rollback triggers?
   - Any investigation needed?

2. **Log daily metrics**
   - Record in alpha metrics log
   - Note any trends (not individual events)

**If all green:** Do nothing. System is working.

---

## Expansion Rules (When to Add More Users)

**Do NOT expand if:**

- Any primary KPI is failing
- Rollback trigger occurred in last 7 days
- Support load is unmanageable
- System instability detected

**Expand ONLY if:**

- 7 consecutive days of passing metrics
- No rollback triggers
- Manageable support load
- System stability confirmed

**Expansion cadence:**
- Week 1: 20 hustlers, 15 posters (baseline)
- Week 2: +10 hustlers, +10 posters (if metrics pass)
- Week 3: +15 hustlers, +15 posters (if metrics pass)
- Week 4: +25 hustlers, +25 posters (if metrics pass)

**Maximum alpha size:** 70 hustlers, 70 posters

---

## Incident Response Playbook

### Level 1: System Error (Worker Crash, DB Error)

**Action:**
1. Check logs
2. Verify system recovers automatically
3. If not, restart worker/queue
4. Do NOT disable features

**Escalate if:** Error persists for > 1 hour

---

### Level 2: Metric Degradation (KPI Failing)

**Action:**
1. Review logs for patterns
2. Check trust tier distribution
3. Verify eligibility guard enforcement
4. Do NOT disable features
5. Do NOT make exceptions

**Escalate if:** Metric fails for > 48 hours

---

### Level 3: Safety Concern (Dispute Spike, Abuse Report)

**Action:**
1. **Immediately disable Instant Mode** (kill switch)
2. Notify alpha participants
3. Log incident
4. Investigate root cause
5. Do NOT re-enable until root cause identified

**Escalate if:** Safety concern is confirmed

---

## What Success Looks Like (Day 7 Checkpoint)

After 7 days, you should see:

- ✅ Median time-to-accept ≤ 60s
- ✅ Completion rate ≥ 90%
- ✅ Dispute rate ≤ 5%
- ✅ Abandonment rate ≤ 5%
- ✅ Fallback rate ≤ 25%
- ✅ Surge Level 2 ≤ 30%
- ✅ No rollback triggers
- ✅ Manageable support load
- ✅ System stability

**If all true:** Proceed to expansion.

**If any false:** Do not expand. Investigate. Fix. Re-measure.

---

## What Failure Looks Like (Stop Immediately)

Stop alpha if:

- Dispute rate > 10% (safety failure)
- Median accept time > 90s for 24h (core value prop broken)
- Data corruption (system integrity failure)
- Safety concern confirmed (trust system failure)

**Action:** Disable Instant Mode. Log incident. Do not re-enable until root cause fixed.

---

## Daily Metrics Log Template

```
Date: [YYYY-MM-DD]

Primary KPIs:
- Median time-to-accept: [X]s (target: ≤60s)
- Completion rate: [X]% (target: ≥90%)
- Dispute rate: [X]% (target: ≤5%)
- Abandonment rate: [X]% (target: ≤5%)
- Fallback rate: [X]% (target: ≤25%)
- Surge Level 2: [X]% (target: ≤30%)

Rollback triggers: [NONE / LIST]
Investigation needed: [NONE / LIST]
System health: [GREEN / YELLOW / RED]

Actions taken: [NONE / LIST]
```

---

## Alpha Start Date: January 22, 2025

**Timeline:**
- Day 0: Launch (20 hustlers, 15 posters)
- Day 7: First checkpoint (expansion decision)
- Day 14: Second checkpoint (expansion decision)
- Day 21: Third checkpoint (expansion decision)
- Day 28: Alpha completion assessment

---

## Bottom Line

**You are the observer, not the controller.**

The system is the authority.
Metrics are the truth.
Your job is to watch, measure, and decide: continue or stop.

Do not override.
Do not make exceptions.
Do not "fix" outcomes.

**Let the system work.**

---
