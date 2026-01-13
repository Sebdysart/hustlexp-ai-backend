# Step 9: Monetization Hooks — Pricing & Plans

**Date:** 2025-01-08  
**Status:** Design Spec (Product Decision)

---

## Overview

Monetize **certainty**, **speed**, and **safety** by gating premium features behind subscription tiers. All pricing decisions are **read-only checks** + UI gating. No core infrastructure changes.

---

## A. Pricing Philosophy

### Value Propositions

1. **Posters:** Reduce anxiety through realtime visibility
2. **Workers:** Access higher-paying, higher-risk tasks faster
3. **Platform:** Align revenue with value delivered

### Pricing Principles

- **Risk-based:** Higher risk → higher need for certainty → higher willingness to pay
- **Subscription-first:** Predictable revenue, better UX
- **Hybrid option:** Per-task fees for occasional users
- **Trust-aligned:** Premium features require trust tier 3+

---

## B. Plan Tiers

### Poster Plans

#### **Free (Baseline)**
- ✅ Create LOW risk tasks
- ✅ Basic progress visibility (POSTED → ACCEPTED → COMPLETED/CLOSED)
- ✅ Standard dispute resolution
- ❌ No live tracking (TRAVELING, WORKING hidden)
- ❌ Cannot create HIGH/IN_HOME tasks
- ❌ No priority matching

**Price:** $0/month

---

#### **Premium (Poster)**
- ✅ All Free features
- ✅ **Live Tracking:** Real-time visibility of TRAVELING → WORKING states
- ✅ Create MEDIUM risk tasks
- ✅ Create HIGH/IN_HOME tasks (with Live Tracking requirement)
- ✅ Priority matching (see Pro workers first)
- ✅ Enhanced dispute support

**Price:** $9.99/month or $99/year (17% savings)

**Value Moment:**
> "See exactly when your Hustler is on the way and working. Reduce anxiety, prevent disputes."

---

### Worker Plans

#### **Free (Baseline)**
- ✅ Accept LOW risk tasks
- ✅ Accept MEDIUM risk tasks (if poster has Premium)
- ✅ Standard earnings
- ❌ No priority in task feed
- ❌ Cannot accept HIGH/IN_HOME tasks
- ❌ No Pro badge visibility

**Price:** $0/month

---

#### **Pro (Worker)**
- ✅ All Free features
- ✅ **Priority Access:** Appear first in task feed
- ✅ Accept HIGH/IN_HOME tasks
- ✅ Pro badge visible to posters
- ✅ Higher trust tier unlocks (up to tier 4)
- ✅ Priority dispute resolution

**Price:** $14.99/month or $149/year (17% savings)

**Value Moment:**
> "Get first access to high-paying tasks. Build trust faster. Earn more."

**Eligibility Requirements:**
- `trust_tier >= 3`
- No active `trust_hold`
- Minimum 5 completed tasks (for new Pro users)

---

## C. Per-Task Pricing (Hybrid Model)

For users who don't want subscriptions:

### Poster Per-Task Fees

| Risk Level | Free Plan | Premium Plan |
|------------|-----------|--------------|
| LOW        | Free      | Free         |
| MEDIUM     | $2.99     | Free         |
| HIGH       | $4.99     | Free         |
| IN_HOME    | $7.99     | Free         |

**Rationale:**
- MEDIUM: Low barrier, tests willingness to pay
- HIGH: Significant risk reduction value
- IN_HOME: Maximum safety requirement

### Worker Per-Task Boosts

- **Priority Boost:** $1.99 per task
  - Guarantees top 3 positions in feed for that task
  - One-time use
  - Refunded if task not accepted within 24h

---

## D. Risk-Based Gating Rules

### Task Creation Rules (Poster)

| Risk Level | Free Plan | Premium Plan |
|------------|-----------|--------------|
| LOW        | ✅ Allowed | ✅ Allowed    |
| MEDIUM     | ❌ Blocked | ✅ Allowed    |
| HIGH       | ❌ Blocked | ✅ Allowed (requires Live Tracking) |
| IN_HOME    | ❌ Blocked | ✅ Allowed (requires Live Tracking) |

**Enforcement:**
- `TaskService.create()` validates `poster.plan` + `risk_level`
- UI preflight shows pricing before submission

---

### Task Acceptance Rules (Worker)

| Risk Level | Free Worker | Pro Worker |
|------------|-------------|------------|
| LOW        | ✅ Allowed  | ✅ Allowed  |
| MEDIUM     | ✅ Allowed  | ✅ Allowed  |
| HIGH       | ❌ Blocked  | ✅ Allowed   |
| IN_HOME    | ❌ Blocked  | ✅ Allowed   |

**Enforcement:**
- `TaskService.accept()` validates `worker.plan` + `task.risk_level`
- Feed filtering prioritizes Pro workers

---

## E. Live Tracking Gating

### Free Plan
- Receives events: `POSTED`, `ACCEPTED`, `COMPLETED`, `CLOSED`
- **Suppressed:** `TRAVELING`, `WORKING`
- UI shows: "Task accepted" → "Task completed" (no intermediate states)

### Premium Plan
- Receives all events: `POSTED`, `ACCEPTED`, `TRAVELING`, `WORKING`, `COMPLETED`, `CLOSED`
- Full realtime visibility

**Implementation:**
- Realtime dispatcher checks `poster.plan === 'premium'` before fanout of `TRAVELING`/`WORKING` events
- OR: UI filters based on plan (simpler, client-side)

---

## F. Priority Matching (Worker Feed)

### Feed Ordering Rules

1. **Pro Workers** (sorted by trust_tier DESC, then completion_rate DESC)
2. **Free Workers** (sorted by trust_tier DESC, then completion_rate DESC)

**Within Pro tier:**
- Trust tier 4 → Trust tier 3
- Higher completion rate → Lower completion rate
- Recent activity → Older activity

**Upsell Moment:**
- Free worker sees: "This task was accepted by a Pro Hustler"
- Copy: "Upgrade to Pro to get priority access to high-paying tasks"

---

## G. Pricing Table Summary

### Monthly Subscriptions

| Plan      | Price/Month | Price/Year | Savings | Target User |
|-----------|-------------|------------|---------|-------------|
| Free      | $0          | $0         | -       | Casual users |
| Premium   | $9.99       | $99        | 17%     | Posters      |
| Pro       | $14.99      | $149       | 17%     | Workers      |

### Per-Task Fees (Non-Subscribers)

| Feature              | Price  | Use Case                    |
|---------------------|--------|-----------------------------|
| MEDIUM risk task     | $2.99  | Occasional medium-risk needs |
| HIGH risk task       | $4.99  | One-time high-risk task      |
| IN_HOME task         | $7.99  | Maximum safety requirement   |
| Priority boost       | $1.99  | Worker: jump queue           |

---

## H. Revenue Projections (Example)

### Scenario: 1,000 active users/month

**Assumptions:**
- 60% Posters, 40% Workers
- 20% conversion to paid plans
- Average 2 tasks/month per poster
- Average 5 tasks/month per worker

**Monthly Revenue:**
- Premium subscriptions: 600 posters × 20% × $9.99 = **$1,199**
- Pro subscriptions: 400 workers × 20% × $14.99 = **$1,199**
- Per-task fees (non-subscribers): ~$500 (estimated)
- **Total: ~$2,900/month**

**Annual Revenue (with annual plans):**
- Premium: 120 subscribers × $99 = **$11,880**
- Pro: 80 subscribers × $149 = **$11,920**
- Per-task fees: ~$6,000
- **Total: ~$29,800/year**

---

## I. Implementation Checklist

### Phase 1: Data Model (Minimal)

- [ ] Add `users.plan` enum: `'free' | 'premium' | 'pro'`
- [ ] Add `users.plan_subscribed_at` timestamp
- [ ] Add `users.plan_expires_at` timestamp (for annual plans)
- [ ] Migration: Set all existing users to `'free'`

### Phase 2: Server-Side Gating

- [ ] `TaskService.create()`: Validate plan + risk_level
- [ ] `TaskService.accept()`: Validate worker plan + task risk_level
- [ ] Realtime dispatcher: Filter `TRAVELING`/`WORKING` events by plan
- [ ] Task feed: Prioritize Pro workers

### Phase 3: Stripe Integration

- [ ] Create Stripe products: `premium_monthly`, `premium_yearly`, `pro_monthly`, `pro_yearly`
- [ ] Create Stripe prices for per-task fees
- [ ] Webhook handler: Update `users.plan` on subscription success
- [ ] Webhook handler: Handle subscription cancellations

### Phase 4: UI Gating

- [ ] Task creation form: Show plan requirements for risk levels
- [ ] Task feed: Show Pro badges, priority indicators
- [ ] Progress UI: Hide TRAVELING/WORKING for free users
- [ ] Upsell modals: Trigger at conversion moments

---

## J. Conversion Moments (Timing)

### Poster Conversion Hooks

1. **Task Creation (MEDIUM/HIGH/IN_HOME)**
   - Modal: "This task requires Premium. Upgrade now?"
   - Copy: "Unlock live tracking and access to all risk levels."

2. **First TRAVELING Event (Free User)**
   - Toast: "Want to see when your Hustler is on the way? Upgrade to Premium."
   - CTA: "Unlock Live Tracking"

3. **After Dispute-Free Completion**
   - Success screen: "Great experience! Upgrade to Premium for live tracking on all tasks."

### Worker Conversion Hooks

1. **Missed HIGH/IN_HOME Task**
   - Notification: "This task was accepted by a Pro Hustler."
   - Copy: "Upgrade to Pro to get priority access to high-paying tasks."

2. **Attempt to Accept HIGH/IN_HOME (Free Worker)**
   - Modal: "This task requires Pro membership."
   - Copy: "Upgrade to Pro to access high-paying, high-risk tasks."

3. **Trust Tier 3 Achieved**
   - Celebration: "You're eligible for Pro! Upgrade to get priority access."

---

## K. Guardrails (Non-Negotiable)

✅ **Allowed:**
- Read-only plan checks in services
- UI filtering based on plan
- Stripe webhook updates to `users.plan`
- Feature flags for gradual rollout

❌ **Forbidden:**
- Monetization logic in state machines
- Pricing logic in workers
- Coupling to Trust v2 (use existing trust_tier)
- Changes to payment core (Phase D)

---

## L. Next Steps

1. **Review & Approve Pricing** (Product decision)
2. **Design Exact Upsell Copy** (Step 9-B)
3. **Define Server-Side Gating Flags** (Step 9-C)
4. **Implement Stripe Products** (Step 9-D)

---

## M. Open Questions

1. **Annual plan discount:** 17% (2 months free) or different?
2. **Per-task fee refunds:** If task cancelled before acceptance?
3. **Pro worker eligibility:** Minimum tasks required? (Suggested: 5)
4. **Family/team plans:** Future consideration?
5. **Trial period:** 7-day free trial for Premium/Pro?

---

**Status:** Ready for product review and approval.
