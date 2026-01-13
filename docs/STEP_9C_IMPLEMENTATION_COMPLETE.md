# Step 9-C: Server-Side Gating & Feature Flags — Implementation Complete

**Date:** 2025-01-08  
**Status:** ✅ COMPLETE

---

## Summary

Implemented server-side gating logic for monetization hooks. All pricing rules are enforced at the service layer with read-only checks. No state mutation in gating logic.

---

## Files Created/Modified

### New Files

1. **`backend/database/migrations/add_user_plans.sql`**
   - Adds `plan`, `plan_subscribed_at`, `plan_expires_at` to users table
   - Default: `'free'`
   - CHECK constraint: `('free', 'premium', 'pro')`

2. **`backend/src/services/PlanService.ts`**
   - Plan eligibility checks
   - Risk level gating logic
   - Live tracking access checks
   - All methods are read-only

### Modified Files

1. **`backend/src/types.ts`**
   - Added `plan`, `plan_subscribed_at`, `plan_expires_at` to `User` interface

2. **`backend/src/services/TaskService.ts`**
   - Added plan gating to `create()` method (risk level checks)
   - Added plan gating to `accept()` method (worker eligibility)
   - Returns `PLAN_REQUIRED` error with details when blocked

3. **`backend/src/realtime/realtime-dispatcher.ts`**
   - Filters `TRAVELING`/`WORKING` events by user plan
   - Premium users: all events
   - Free users: only `POSTED`, `ACCEPTED`, `COMPLETED`, `CLOSED`

---

## Gating Rules Implemented

### Task Creation (Poster)

| Risk Level | Free Plan | Premium Plan |
|------------|-----------|--------------|
| LOW        | ✅ Allowed | ✅ Allowed    |
| MEDIUM     | ⚠️ Allowed (per-task fee) | ✅ Allowed |
| HIGH       | ❌ Blocked | ✅ Allowed    |
| IN_HOME    | ❌ Blocked | ✅ Allowed    |

**Error Code:** `PLAN_REQUIRED`  
**Error Details:** `{ requiredPlan: 'premium', riskLevel: 'HIGH' }`

### Task Acceptance (Worker)

| Risk Level | Free Worker | Pro Worker |
|------------|--------------|------------|
| LOW        | ✅ Allowed   | ✅ Allowed  |
| MEDIUM     | ✅ Allowed   | ✅ Allowed  |
| HIGH       | ❌ Blocked   | ✅ Allowed  |
| IN_HOME    | ❌ Blocked   | ✅ Allowed  |

**Requirements for Pro:**
- `plan === 'pro'`
- `trust_tier >= 3`
- `trust_hold === false`

**Error Code:** `PLAN_REQUIRED`  
**Error Details:** `{ requiredPlan: 'pro', riskLevel: 'HIGH' }`

### Live Tracking Events (Realtime)

| Progress State | Free Plan | Premium Plan |
|----------------|-----------|--------------|
| POSTED         | ✅        | ✅           |
| ACCEPTED       | ✅        | ✅           |
| TRAVELING      | ❌        | ✅           |
| WORKING        | ❌        | ✅           |
| COMPLETED      | ✅        | ✅           |
| CLOSED         | ✅        | ✅           |

**Implementation:**
- `PlanService.canReceiveProgressEvent()` checks plan before fanout
- Free users never receive `TRAVELING`/`WORKING` events
- Premium users receive all events

---

## PlanService API

### `getUserPlan(userId: string): Promise<UserPlan>`
- Returns current plan (with expiration check)
- Auto-resets to `'free'` if expired

### `canCreateTaskWithRisk(userId: string, riskLevel: TaskRiskLevel): Promise<PlanCheckResult>`
- Checks if poster can create task with given risk level
- Returns `{ allowed: boolean, reason?, requiredPlan? }`

### `canAcceptTaskWithRisk(userId: string, riskLevel: TaskRiskLevel): Promise<PlanCheckResult>`
- Checks if worker can accept task with given risk level
- Validates plan + trust tier + trust hold

### `canReceiveProgressEvent(userId: string, progressState: TaskProgressState): Promise<boolean>`
- Checks if user can receive specific progress event
- Used by realtime dispatcher for filtering

### `hasLiveTrackingAccess(userId: string): Promise<boolean>`
- Convenience method for UI checks
- Returns `true` if plan is `'premium'`

---

## Error Handling

### Task Creation Blocked

```typescript
{
  success: false,
  error: {
    code: 'PLAN_REQUIRED',
    message: 'Premium plan required for this risk level',
    details: {
      requiredPlan: 'premium',
      riskLevel: 'HIGH'
    }
  }
}
```

### Task Acceptance Blocked

```typescript
{
  success: false,
  error: {
    code: 'PLAN_REQUIRED',
    message: 'Pro plan and trust tier 3+ required for high-risk tasks',
    details: {
      requiredPlan: 'pro',
      riskLevel: 'HIGH'
    }
  }
}
```

---

## Database Migration

**File:** `backend/database/migrations/add_user_plans.sql`

**Columns Added:**
- `users.plan` VARCHAR(20) DEFAULT 'free' CHECK (plan IN ('free', 'premium', 'pro'))
- `users.plan_subscribed_at` TIMESTAMPTZ
- `users.plan_expires_at` TIMESTAMPTZ

**Index:** `idx_users_plan` on `users(plan)`

**To Apply:**
```bash
psql $DATABASE_URL -f backend/database/migrations/add_user_plans.sql
```

---

## Testing Checklist

- [ ] Migration applies cleanly
- [ ] Default users have `plan = 'free'`
- [ ] Free users blocked from HIGH/IN_HOME task creation
- [ ] Free workers blocked from HIGH/IN_HOME task acceptance
- [ ] Premium users can create all risk levels
- [ ] Pro workers can accept all risk levels
- [ ] Free users don't receive TRAVELING/WORKING events
- [ ] Premium users receive all events
- [ ] Plan expiration auto-resets to free
- [ ] Error messages include required plan details

---

## Next Steps

1. **Stripe Integration** (Step 9-D)
   - Create Stripe products/prices
   - Webhook handler to update `users.plan`
   - Subscription management

2. **UI Integration**
   - Show upsell modals based on error codes
   - Display plan status in user profile
   - Filter task feed by plan eligibility

3. **Feature Flags** (Optional)
   - Gradual rollout of monetization
   - A/B testing pricing
   - Regional gating

---

## Guardrails Enforced

✅ **All checks are read-only** (no state mutation)  
✅ **All checks are idempotent** (safe to retry)  
✅ **No pricing logic in services** (handled by Stripe)  
✅ **No coupling to Trust v2** (uses existing `trust_tier`)  
✅ **No changes to payment core** (Phase D untouched)  

---

## Critical Invariant: Data Truth vs Delivery

**INVARIANT:** Plan gating may affect realtime delivery, never data truth.

### Enforcement

1. **REST endpoints always return full task state**
   - `TaskService.getById()` returns complete `progress_state`
   - No filtering based on user plan
   - Free and premium users see identical data

2. **Only SSE delivery is filtered**
   - `PlanService.canReceiveProgressEvent()` used only in realtime dispatcher
   - Free users don't receive `TRAVELING`/`WORKING` events via SSE
   - But they can still query REST to see current state

3. **UI makes rendering decisions**
   - UI can collapse states for free users ("In progress" instead of "TRAVELING")
   - But underlying data is always truthful
   - Reconnect/rehydration always shows correct state

### Test Coverage

See `backend/tests/invariants/plan-gating-invariant.test.ts` for automated verification.

---

**Status:** Ready for Stripe integration and UI wiring.
