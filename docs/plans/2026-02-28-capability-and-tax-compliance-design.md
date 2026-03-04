# Design: capability.ts Hardcoded Placeholder Fix + TaxComplianceService Plan

**Date:** 2026-02-28
**Branch:** feat/god-mode-hardening
**Priority:** 🔴 RED — live API returns wrong eligibility data to iOS

---

## Part 1 — capability.ts: Fix 4 Hardcoded Placeholders

### Problem

`checkEligibility` in `backend/src/routers/capability.ts:114-118` passes hardcoded
values to `EligibilityResolverService.isEligible()`:

```ts
activeTaskCount: 0,       // TODO: query actual count
hasActiveDispute: false,  // TODO: query actual status
accountAgeDays: 30,       // TODO: calculate from user.created_at
trustScore: 4.5,          // TODO: query actual score
```

`activeTaskCount` and `hasActiveDispute` directly affect eligibility gating
(HX401, HX402). Every worker always appears dispute-free and zero-task regardless
of reality. This is a live correctness bug.

### Schema Sources

| Field | Table | Column / Condition |
|-------|-------|--------------------|
| `accountAgeDays` | `users` | `EXTRACT(DAY FROM NOW() - created_at)::int` |
| `trustScore` | `users` | `trust_tier` (INTEGER 1–4) |
| `activeTaskCount` | `tasks` | `COUNT(*) WHERE worker_id = $1 AND state IN ('ACCEPTED','PROOF_SUBMITTED')` |
| `hasActiveDispute` | `disputes` | `EXISTS WHERE (worker_id = $1 OR initiated_by = $1) AND state != 'RESOLVED'` |

### Solution: Single CTE Query

Replace the 4 hardcoded values with one `db.query` call using scalar subqueries,
keeping the result as one DB roundtrip:

```sql
SELECT
  EXTRACT(DAY FROM NOW() - u.created_at)::int AS account_age_days,
  u.trust_tier,
  (
    SELECT COUNT(*)::int FROM tasks
    WHERE worker_id = u.id
      AND state IN ('ACCEPTED', 'PROOF_SUBMITTED')
  ) AS active_task_count,
  EXISTS (
    SELECT 1 FROM disputes
    WHERE (worker_id = u.id OR initiated_by = u.id)
      AND state != 'RESOLVED'
  ) AS has_active_dispute
FROM users u
WHERE u.id = $1
```

**Error handling:** If user row not found → `TRPCError { code: 'NOT_FOUND' }`.

### Files Changed

- `backend/src/routers/capability.ts` — replace hardcoded block in `checkEligibility`

### Not in Scope

- The three `// TODO: Check admin role` comments on `approveLicense`,
  `rejectLicense`, `getPendingLicenses` — separate auth concern, tracked separately.

---

## Part 2 — TaxComplianceService: Implementation Plan (plan only, no code)

### Problem

Three private functions in `src/services/TaxComplianceService.ts` are stubs:

| Function | Current state | Risk |
|----------|--------------|------|
| `encryptTIN` | base64 encode (not encryption) | PII exposure if DB compromised |
| `verifyTIN` | no-op | Backup withholding never triggered; IRS non-compliance |
| `generateStripe1099NEC` | returns fake ID | 1099-NEC never filed; IRS penalty exposure |
| `generateStripe1099K` | returns fake ID | 1099-K never filed; IRS penalty exposure |

### Phase 1 — AES-256-GCM TIN Encryption (unblocks W-9 path)

**Replace `encryptTIN` / add `decryptTIN`:**

- Algorithm: `aes-256-gcm` via Node.js built-in `crypto`
- Key: `config.tax.encryptionKey` — 32-byte hex string from env var `TAX_TIN_ENCRYPTION_KEY`
- Storage format: `<iv_hex>:<authTag_hex>:<ciphertext_hex>` (all hex, colon-delimited)
- IV: 16 random bytes per encryption (never reuse)
- Auth tag: 16 bytes, stored alongside ciphertext for GCM integrity verification
- Add `decryptTIN(encrypted: string): string` for future read-back path

**Config addition:** `config.tax.encryptionKey` loaded from `TAX_TIN_ENCRYPTION_KEY` env var.
Fail fast at startup if missing in production.

### Phase 2 — Stripe Tax 1099 Generation (unblocks January filing)

**Replace `generateStripe1099NEC` and `generateStripe1099K`:**

- Use `stripe.tax.forms.create()` (Stripe Tax API)
- Requires worker's Stripe Connect account ID from `stripe_connect_accounts.stripe_account_id`
  WHERE `user_id = worker.user_id`
- Pass: `type`, `payee.tin` (decrypted), `payee.name`, `payment_amount`, `tax_year`
- Store returned `form.id` in `stripe_tax_form_id`
- Stripe Tax must be enabled on the platform Connect account (ops prerequisite)

**Pre-requisite check:** If `stripe_connect_accounts` row missing for worker →
log error + push to `errors[]` array (existing pattern in `generate1099NECForms`).

### Phase 3 — IRS TIN Verification (async, lowest urgency)

**Replace `verifyTIN`:**

- IRS e-Services Bulk TIN Matching API (requires IRS e-Services registration)
- Flow: submit `{ tin, name, tinType }` → receive match/no-match result (async, up to 24h)
- On **match**: call `markW9Verified(userId)`
- On **no-match**: set `backup_withholding = TRUE` in `worker_earnings_1099`
- Implementation: outbox event (`tin_verification_requested`) → background job polls
  IRS response file; updates DB on result

**Fallback:** Until IRS API is integrated, backup withholding defaults to `FALSE`
(current behavior). Safe to ship Phase 1+2 without Phase 3.

### Files to Change

- `src/services/TaxComplianceService.ts` — `encryptTIN`, `decryptTIN`, `verifyTIN`,
  `generateStripe1099NEC`, `generateStripe1099K`
- `src/config.ts` (or equivalent) — add `tax.encryptionKey`
- Possibly `src/services/StripeService.ts` — reuse existing Stripe client

### Sequencing

```
Phase 1 (encryption)  →  Phase 2 (Stripe 1099)  →  Phase 3 (IRS TIN)
  ~1 day                    ~2 days                   ~3–5 days (IRS reg required)
```

Phase 3 requires IRS e-Services enrollment (multi-day ops process). Phases 1 and 2
can ship independently.
