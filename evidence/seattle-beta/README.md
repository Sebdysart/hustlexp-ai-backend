# Seattle Beta Evidence Repository

**Complete verification system for all 10 gates.**

---

## Repository Structure

```
/evidence/seattle-beta/
├── README.md
├── gate-01-money/VERIFICATION_BUNDLE.md     ← 35 tests
├── gate-02-proof/VERIFICATION_BUNDLE.md     ← 8 tests
├── gate-03-safety/VERIFICATION_BUNDLE.md    ← 6 tests
├── gate-04-auth/VERIFICATION_BUNDLE.md      ← 5 tests
├── gate-05-beta/VERIFICATION_BUNDLE.md      ← 8 tests
├── gate-06-ai/VERIFICATION_BUNDLE.md        ← 4 tests
├── gate-07-abuse/VERIFICATION_BUNDLE.md     ← 6 tests
├── gate-08-observability/VERIFICATION_BUNDLE.md ← 6 tests
├── gate-09-secrets/VERIFICATION_BUNDLE.md   ← 5 tests
└── gate-10-field-test/VERIFICATION_BUNDLE.md ← 21 tests (7 steps × 3 runs)
```

---

## Total Tests: 104

| Gate | Name | Tests | Happy | Negative | Auth |
|------|------|-------|-------|----------|------|
| 1 | Money | 35 | 8 | 15 | 12 |
| 2 | Proof & GPS | 8 | 4 | 4 | - |
| 3 | Safety | 6 | 3 | 3 | - |
| 4 | Auth & Admin | 5 | 1 | 4 | - |
| 5 | Beta Guardrails | 8 | 4 | 4 | - |
| 6 | AI Orchestration | 4 | 4 | - | - |
| 7 | Abuse Testing | 6 | - | 6 | - |
| 8 | Observability | 6 | 6 | - | - |
| 9 | Secrets | 5 | 5 | - | - |
| 10 | Field Test | 21 | 21 | - | - |
| **TOTAL** | | **104** | | | |

---

## Environment Matrix

Every test in Gates 1-8 must pass in:
- [ ] Local Dev
- [ ] Staging
- [ ] Production

---

## Gate Status Dashboard

| Gate | Tests | Local | Staging | Prod | Status |
|------|-------|-------|---------|------|--------|
| 1 | 35 | ⬜ | ⬜ | ⬜ | **BLOCKED** |
| 2 | 8 | ⬜ | ⬜ | ⬜ | **BLOCKED** |
| 3 | 6 | ⬜ | ⬜ | ⬜ | **BLOCKED** |
| 4 | 5 | ⬜ | ⬜ | ⬜ | **BLOCKED** |
| 5 | 8 | ⬜ | ⬜ | ⬜ | **BLOCKED** |
| 6 | 4 | ⬜ | ⬜ | ⬜ | **BLOCKED** |
| 7 | 6 | ⬜ | ⬜ | ⬜ | **BLOCKED** |
| 8 | 6 | ⬜ | ⬜ | ⬜ | **BLOCKED** |
| 9 | 5 | N/A | ⬜ | ⬜ | **BLOCKED** |
| 10 | 21 | N/A | N/A | ⬜ | **BLOCKED** |

---

## How to Run

### 1. Set Prerequisites
```bash
export HOST="https://your-backend.railway.app"
export ADMIN_TOKEN="..."
export POSTER_TOKEN="..."
export HUSTLER_TOKEN="..."
```

### 2. Run Gate 1 First
```bash
# Open gate-01-money/VERIFICATION_BUNDLE.md
# Execute each curl command
# Verify expected outputs
# Take screenshots
# Run DB queries
```

### 3. Mark Evidence
- Store screenshots in `gate-XX-*/screenshots/`
- Log responses in `gate-XX-*/logs/`
- Update checklist in bundle

### 4. Move to Next Gate
Only after Gate N is fully PASSED.

---

## Re-Test Triggers

| Change | Gates to Re-Run |
|--------|-----------------|
| StripeService modified | 1 |
| Escrow/payout changed | 1, 2 |
| R2 config changed | 2 |
| Safety/moderation changed | 3, 7 |
| Auth middleware changed | 4 |
| Beta flags changed | 5 |
| AI routing changed | 6 |
| Any deployment | All |

---

## Final Decision

| Criteria | Required | Status |
|----------|----------|--------|
| All 104 tests pass | Yes | ⬜ |
| Staging verified | Yes | ⬜ |
| Production verified | Yes | ⬜ |
| Field test complete | Yes | ⬜ |
| All screenshots collected | Yes | ⬜ |
| All DB queries verified | Yes | ⬜ |

**LAUNCH STATUS:** ⬜ **NO GO** / ✅ **GO**

---

*Last updated: 2024-12-09*
*Verified by: ______________*
