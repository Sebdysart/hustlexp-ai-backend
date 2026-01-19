# N2.4 Authority Regression Checklist

**Purpose:** Verify that Phase N2.4 authority model remains intact after any code changes.

**When to run:** After every phase that touches verification, capability, or eligibility code.

---

## ✅ Authority Model Verification

### 1. Resolution Endpoints (Admin/System Only)

- [ ] `verification.resolveLicense` requires admin/system auth
- [ ] `verification.resolveInsurance` requires admin/system auth
- [ ] `verification.resolveBackgroundCheck` requires admin/system auth
- [ ] No user-auth context can resolve verifications

**Check:** Review `backend/trpc/routes/verification/resolve*/route.ts` for auth checks.

---

### 2. State Transition Enforcement

- [ ] All resolve endpoints call `assertVerificationTransition()`
- [ ] Only legal transitions allowed: `PENDING → APPROVED/REJECTED`, `APPROVED → EXPIRED`
- [ ] Terminal states (`REJECTED`, `EXPIRED`) cannot transition

**Check:** Review `backend/trpc/routes/verification/state-machine.ts` and resolve endpoints.

---

### 3. Mutation Discipline (CRITICAL)

- [ ] Resolution endpoints **NEVER** write to `capability_profiles`
- [ ] Resolution endpoints **NEVER** write to `verified_trades`
- [ ] Resolution endpoints **ONLY** update verification status
- [ ] Resolution endpoints **ONLY** emit recompute trigger (job_queue)

**Check:** Run CI deny-list workflow: `.github/workflows/n2-4-authority-guard.yml`

**Forbidden patterns:**
```typescript
// ❌ FORBIDDEN in resolve endpoints:
INSERT INTO capability_profiles ...
UPDATE capability_profiles ...
INSERT INTO verified_trades ...
UPDATE verified_trades ...
```

---

### 4. Recompute Service Authority

- [ ] `CapabilityRecomputeService` is the **sole writer** of `capability_profiles`
- [ ] `CapabilityRecomputeService` is the **sole writer** of `verified_trades`
- [ ] Recompute is deterministic (same inputs → same outputs)
- [ ] Recompute is idempotent (safe to run multiple times)
- [ ] Recompute is reconstructable (can rebuild from verification tables)

**Check:** Review `backend/src/services/CapabilityRecomputeService.ts`

---

### 5. Recompute Trigger Wiring

- [ ] All resolve endpoints emit `job_queue` entries with type `recompute_capability`
- [ ] Job payload includes: `userId`, `reason`, `sourceVerificationId`
- [ ] Recompute worker processes jobs correctly
- [ ] No direct recompute calls from resolution endpoints

**Check:** Review resolve endpoints and `CapabilityRecomputeWorker.ts`

---

### 6. Feed Eligibility Authority

- [ ] Feed query (`tasks.list`) uses SQL JOIN with `capability_profiles` for eligibility
- [ ] No client-side eligibility filtering
- [ ] No post-query filtering of eligible tasks
- [ ] Frontend trusts all returned tasks are eligible

**Check:** Review `backend/trpc/routes/tasks/list/route.ts` (when migrated to real DB)

---

## ✅ Invariant Tests

Run the following test suites and verify all pass:

```bash
npm run test:invariants -- n2-4-verification-resolution.test.ts
npm run test:invariants -- n2-4-e2e-resolution.test.ts
```

**Required tests:**
- [ ] INV-N2.4-1: Resolution cannot mutate capability directly
- [ ] INV-N2.4-2: Resolution cannot mutate verified_trades directly
- [ ] INV-N2.4-3: Recompute is deterministic
- [ ] INV-N2.4-4: Expired verifications remove capability
- [ ] E2E-N2.4-1: Submit → Pending → Approve → Recompute → Capability granted
- [ ] E2E-N2.4-2: Submit → Pending → Reject → Recompute → No capability granted
- [ ] E2E-N2.4-3: Approve → Expire → Recompute → Capability revoked

---

## ✅ CI Deny-List Checks

Run CI workflow and verify all checks pass:

```bash
# CI automatically runs on PR
# Or run locally:
grep -r "INSERT INTO capability_profiles\|UPDATE capability_profiles" \
  --include="*.ts" \
  --exclude-dir=node_modules \
  --exclude="CapabilityRecomputeService.ts" \
  backend/
```

**Expected:** No matches (except in `CapabilityRecomputeService.ts`)

---

## ✅ End-to-End Flow Verification

Test the complete flow manually or via E2E tests:

1. **Submit verification** → Creates `PENDING` record
2. **Resolve to APPROVED** → Updates status, emits recompute trigger
3. **Recompute runs** → Updates `capability_profiles` and `verified_trades`
4. **Feed query** → Returns eligible tasks (when migrated to real DB)

**Verify:**
- [ ] No direct capability mutation during resolution
- [ ] Recompute runs after resolution
- [ ] Capability granted after approval
- [ ] Capability revoked after expiry

---

## 🚫 Forbidden Patterns (Regression Indicators)

If you see any of these, **STOP** and fix before proceeding:

1. **Direct capability writes in resolve endpoints:**
   ```typescript
   // ❌ FORBIDDEN
   await db.query('INSERT INTO capability_profiles ...');
   ```

2. **Direct verified_trades writes in resolve endpoints:**
   ```typescript
   // ❌ FORBIDDEN
   await db.query('INSERT INTO verified_trades ...');
   ```

3. **Missing recompute trigger:**
   ```typescript
   // ❌ FORBIDDEN (must emit trigger)
   await db.query('UPDATE license_verifications SET status = ...');
   // Missing: job_queue insert
   ```

4. **User-auth resolving verifications:**
   ```typescript
   // ❌ FORBIDDEN (must be admin/system only)
   if (!ctx.user) throw new TRPCError(...);
   // Missing: admin role check
   ```

---

## 📋 Checklist Completion

After completing all checks above:

- [ ] All authority checks passed
- [ ] All invariant tests passed
- [ ] All CI deny-list checks passed
- [ ] End-to-end flow verified
- [ ] No forbidden patterns detected

**Status:** ✅ Authority model intact

---

## Amendment History

| Version | Date | Author | Summary |
|---------|------|--------|---------|
| 1.0.0 | Jan 2025 | HustleXP Core | Initial authority regression checklist for N2.4 |

---

**END OF N2.4 AUTHORITY REGRESSION CHECKLIST**
