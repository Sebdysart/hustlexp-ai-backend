# N2.3 Recompute Trigger Documentation (NOT IMPLEMENTED)

**Status:** DOCUMENTED ONLY — Not implemented in Phase N2.3

**Phase:** N2.4 (Verification Resolution) — Admin / Provider Webhooks

---

## Purpose

This document specifies the **recompute trigger** that will be implemented in Phase N2.4. It describes when and how `capability_profiles` are recomputed based on verification status changes.

**Critical Rule:** Recompute is **triggered by status changes**, not by submission.

---

## Trigger Events

### 1. License Verification Status Change

**Event:** `license_verifications.status` changes to `APPROVED` or `EXPIRED`

**Action:**
```typescript
// PSEUDOCODE - NOT IMPLEMENTED YET
async function onLicenseVerificationStatusChange(verificationId: string, newStatus: string) {
  if (newStatus === 'APPROVED') {
    // Enqueue recompute job
    await enqueue('recomputeCapabilityProfile', {
      userId: verification.user_id,
      trigger: 'license_approved',
      verificationId,
    });
  } else if (newStatus === 'EXPIRED') {
    // Enqueue recompute job (to remove expired license)
    await enqueue('recomputeCapabilityProfile', {
      userId: verification.user_id,
      trigger: 'license_expired',
      verificationId,
    });
  }
}
```

**Effect:**
- `verified_trades` table is updated (license is added/removed)
- `capability_profiles` is recomputed (not directly modified)
- Feed eligibility is updated (via recompute → feed JOINs)

---

### 2. Insurance Verification Status Change

**Event:** `insurance_verifications.status` changes to `APPROVED` or `EXPIRED`

**Action:**
```typescript
// PSEUDOCODE - NOT IMPLEMENTED YET
async function onInsuranceVerificationStatusChange(verificationId: string, newStatus: string) {
  if (newStatus === 'APPROVED') {
    await enqueue('recomputeCapabilityProfile', {
      userId: verification.user_id,
      trigger: 'insurance_approved',
      verificationId,
    });
  } else if (newStatus === 'EXPIRED') {
    await enqueue('recomputeCapabilityProfile', {
      userId: verification.user_id,
      trigger: 'insurance_expired',
      verificationId,
    });
  }
}
```

**Effect:**
- `capability_profiles.insurance_valid` is recomputed
- `capability_profiles.insurance_expires_at` is recomputed
- Feed eligibility is updated (via recompute → feed JOINs)

---

### 3. Background Check Status Change

**Event:** `background_checks.status` changes to `APPROVED` or `EXPIRED`

**Action:**
```typescript
// PSEUDOCODE - NOT IMPLEMENTED YET
async function onBackgroundCheckStatusChange(checkId: string, newStatus: string) {
  if (newStatus === 'APPROVED') {
    await enqueue('recomputeCapabilityProfile', {
      userId: backgroundCheck.user_id,
      trigger: 'background_check_approved',
      checkId,
    });
  } else if (newStatus === 'EXPIRED') {
    await enqueue('recomputeCapabilityProfile', {
      userId: backgroundCheck.user_id,
      trigger: 'background_check_expired',
      checkId,
    });
  }
}
```

**Effect:**
- `capability_profiles.background_check_valid` is recomputed
- `capability_profiles.background_check_expires_at` is recomputed
- Feed eligibility is updated (via recompute → feed JOINs)

---

## Recompute Job Specification (N2.4)

**Job Name:** `recomputeCapabilityProfile`

**Inputs:**
```typescript
interface RecomputeJob {
  userId: string;
  trigger: 'license_approved' | 'license_expired' | 'insurance_approved' | 'insurance_expired' | 'background_check_approved' | 'background_check_expired';
  verificationId?: string;  // For license/insurance verifications
  checkId?: string;  // For background checks
}
```

**Process:**
1. Read all `license_verifications` for user with status = `APPROVED`
2. Read all `insurance_verifications` for user with status = `APPROVED` (not expired)
3. Read most recent `background_checks` for user with status = `APPROVED` (not expired)
4. Compute `capability_profiles` fields:
   - `verified_trades` (from approved licenses)
   - `insurance_valid` (from approved insurance)
   - `background_check_valid` (from approved background check)
   - `expires_at` JSONB (from all expiration dates)
5. Update `capability_profiles` table (UPSERT)
6. Update `verified_trades` table (sync with approved licenses)

**Authority:**
- `capability_profiles` is **never mutated directly** by submission endpoints
- `capability_profiles` is **always re-derived** from verification status
- Feed eligibility is **always computed** via JOIN with `capability_profiles`

---

## Forbidden in Phase N2.3

**Explicitly NOT implemented:**

- ❌ Status change handlers
- ❌ Recompute job queue
- ❌ Direct `capability_profiles` writes from verification submission
- ❌ Direct `verified_trades` writes from verification submission
- ❌ Feed eligibility changes on submission

---

## Implementation Plan (N2.4)

1. **Status Change Webhooks/Handlers**
   - Admin API endpoint to update verification status
   - Provider webhook handlers (external verification services)
   - Status change triggers

2. **Recompute Job Queue**
   - Job queue setup (e.g., Bull, Inngest, or similar)
   - `recomputeCapabilityProfile` job implementation
   - Idempotency handling

3. **Feed Refresh**
   - Feed query automatically reflects new eligibility (via JOIN)
   - No explicit "refresh feed" endpoint needed

---

## References

- **Phase N2.3:** Verification Submission (LOCKED) — Submission only, no recompute
- **Phase N2.4:** Verification Resolution (Admin / Provider Webhooks) — Status changes trigger recompute
- **CAPABILITY_PROFILE_SCHEMA_AND_INVARIANTS_LOCKED.md:** Schema and invariants
- **FEED_QUERY_AND_ELIGIBILITY_RESOLVER_LOCKED.md:** Feed eligibility logic

---

**END OF N2.3 RECOMPUTE TRIGGER DOCUMENTATION**
