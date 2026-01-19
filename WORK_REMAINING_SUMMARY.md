# Work Remaining Summary

## Current Status: ~60% Complete

### ✅ Completed (Infrastructure & Foundation)
1. **Schema & Migrations** - Files exist, need to be applied
   - `add_user_plans.sql` ✅
   - `add_plan_entitlements_table.sql` ✅
   - `stripe_events` table (from Phase D) ✅

2. **Invariant Tests** - Complete test suite exists
   - S-1: Webhook replay safety ✅
   - S-2: Plan downgrade monotonicity ✅
   - S-3: Entitlement idempotency ✅
   - S-4: Entitlement expiry enforcement ✅
   - S-5: Causal linkage to Stripe events ✅
   - **Status**: Tests exist but blocked by DB auth (environment issue)

3. **Core Services** - Partially complete
   - `StripeWebhookService` ✅ Complete (stores events, enqueues)
   - `StripeSubscriptionProcessor` ✅ Complete (handles subscription lifecycle)
   - `PlanService` ⚠️ Missing entitlement checks
   - `stripe-event-worker` ⚠️ Skeleton only (handlers throw errors)
   - `StripeEntitlementProcessor` ❌ Skeleton only (throws error)

4. **Integration Points** - Mostly complete
   - Webhook endpoint in `server.ts` ✅
   - Outbox pattern ✅
   - Plan gating in `TaskService` ✅
   - Realtime dispatcher filtering ✅

---

## ❌ Remaining Work (40%)

### 1. Implement Stripe Event Handlers (3 handlers)

**File**: `backend/src/jobs/stripe-event-worker.ts`

#### A. `checkout.session.completed` Handler
**Status**: Currently throws error  
**What to do**:
- Extract `user_id` and `plan` from checkout session metadata
- Call `processSubscriptionEvent` with subscription data
- Handle subscription activation

**Estimated effort**: 30 minutes

#### B. `payment_intent.succeeded` Handler (for entitlements)
**Status**: Currently throws error  
**What to do**:
- Extract `user_id`, `task_id`, `risk_level` from payment intent metadata
- Call `processEntitlementPurchase` (needs implementation)
- Create per-task entitlement

**Estimated effort**: 45 minutes (includes entitlement processor)

#### C. `invoice.payment_failed` Handler
**Status**: Currently throws error  
**What to do**:
- Extract subscription ID from invoice
- Determine if grace period applies
- Set plan expiry (don't downgrade immediately - S-2)

**Estimated effort**: 30 minutes

**Total for handlers**: ~2 hours

---

### 2. Implement StripeEntitlementProcessor

**File**: `backend/src/services/StripeEntitlementProcessor.ts`

**Status**: Skeleton only (throws error)

**What to implement**:
```typescript
export async function processEntitlementPurchase(
  payload: unknown,
  stripeEventId: string
): Promise<void> {
  // 1. Validate Stripe event exists (S-5)
  // 2. Extract user_id, task_id, risk_level from payment_intent metadata
  // 3. Calculate expires_at (24 hours from now, or task completion)
  // 4. Insert into plan_entitlements (idempotent - S-3)
  // 5. Handle errors appropriately
}
```

**Invariants to enforce**:
- S-3: Idempotency (UNIQUE source_event_id)
- S-4: Expiry enforcement (expires_at checked at read time)
- S-5: Causal linkage (verify event exists)

**Estimated effort**: 1 hour

---

### 3. Add Entitlement Checks to PlanService

**File**: `backend/src/services/PlanService.ts`

**Status**: Currently only checks `users.plan`, doesn't check `plan_entitlements`

**What to add**:

#### A. `canCreateTaskWithRisk()` - Add entitlement check
```typescript
// After checking plan, also check:
// 1. Query plan_entitlements for user_id + risk_level
// 2. Filter by expires_at > NOW() (S-4)
// 3. If active entitlement exists, allow access
```

#### B. `canAcceptTaskWithRisk()` - Add entitlement check
```typescript
// Similar to above - check entitlements for worker
```

**Estimated effort**: 1 hour

---

### 4. Apply Database Migrations

**Files**:
- `backend/database/migrations/add_user_plans.sql`
- `backend/database/migrations/add_plan_entitlements_table.sql`

**Status**: Files exist, need to be applied to database

**What to do**:
```bash
# Run migrations
psql $DATABASE_URL -f backend/database/migrations/add_user_plans.sql
psql $DATABASE_URL -f backend/database/migrations/add_plan_entitlements_table.sql
```

**Estimated effort**: 5 minutes (if DB access works)

---

### 5. Run Tests & Fix Issues

**File**: `backend/tests/invariants/stripe-monetization.test.ts`

**Status**: Tests exist but blocked by DB auth (environment issue)

**What to do**:
1. Fix DB credentials in `env.backend`
2. Run: `npm run test:invariants -- stripe-monetization`
3. Fix any failing tests
4. Verify all 5 invariants pass

**Estimated effort**: 30 minutes - 2 hours (depending on test failures)

---

### 6. Integration Verification

**What to verify**:
- [ ] Webhook → outbox → worker → plan update flow works end-to-end
- [ ] Plan gating (`TaskService.create`, `TaskService.accept`) respects plans AND entitlements
- [ ] Realtime dispatcher filters events by plan correctly
- [ ] No linter errors
- [ ] Manual webhook test with Stripe CLI

**Estimated effort**: 1 hour

---

## Total Estimated Time

| Task | Time |
|------|------|
| Stripe event handlers (3) | 2 hours |
| StripeEntitlementProcessor | 1 hour |
| PlanService entitlement checks | 1 hour |
| Database migrations | 5 minutes |
| Tests & fixes | 30 min - 2 hours |
| Integration verification | 1 hour |
| **Total** | **5.5 - 7 hours** |

---

## Priority Order

1. **Apply migrations** (5 min) - Unblocks everything
2. **Implement StripeEntitlementProcessor** (1 hour) - Core functionality
3. **Add entitlement checks to PlanService** (1 hour) - Required for gating
4. **Implement event handlers** (2 hours) - Complete the flow
5. **Run tests** (30 min - 2 hours) - Verify correctness
6. **Integration verification** (1 hour) - End-to-end proof

---

## Blockers

1. **Database access** - Tests blocked by invalid `DATABASE_URL` in `env.backend`
2. **Approval required** - Per `.cursorrules`, Stripe implementation needs explicit approval
3. **Environment setup** - Need valid Stripe webhook secret for testing

---

## Notes

- All code follows Phase D patterns (outbox, idempotency, DB time authority)
- Invariants are well-defined and testable
- No Phase D payment core files will be modified
- Implementation is straightforward - mostly wiring existing patterns together

**Ready to proceed once:**
1. Database migrations applied
2. Explicit approval for Stripe implementation
3. DB credentials fixed for testing
