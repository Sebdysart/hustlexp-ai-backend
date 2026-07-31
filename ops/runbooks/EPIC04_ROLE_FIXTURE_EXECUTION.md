# EPIC-04 — Authorized production role fixtures

**Status:** PACKAGING READY — live accounts **BLOCKED_AUTHORITY** (0/5 as of last audit 2026-07-22; no DB URL in this workspace)  
**Objective:** least-privilege, expiring fixtures for all five authenticated lanes; never count as GMV.

## Five lanes

| Role | Entry → destination | Recovery | Extra |
| --- | --- | --- | --- |
| Poster | `/get-help` → `/task-preview` | `/get-help` | PRODUCTION identity verification |
| Hustler | `/earn` → `/earn/setup` | `/earn` | worker mode + test Connect payouts |
| Business Client | `/business` → `/business/workspace` | `/business` | verified client org membership |
| Service Business | `/business/provide` → workspace `?mode=provider` | `/business/provide` | provider org + active payout |
| Operations | `/ops` → `/ops` | `/` | `admin_roles.can_manage_operations` |

Request pack: [`EPIC04_FIXTURE_REQUEST.json`](./EPIC04_FIXTURE_REQUEST.json)  
Template: [`docs/templates/PRODUCTION_ROLE_FIXTURE_PACKAGING.md`](../../docs/templates/PRODUCTION_ROLE_FIXTURE_PACKAGING.md)

## What engineering can do without writes

```powershell
cd D:\projects\hustlexp-ai-backend
# Schema / contract only
npm run verify:production-role-readiness:contract

# Package fixture descriptions (no account creation)
npm run package:role-fixture-evidence -- --in ops/runbooks/EPIC04_FIXTURE_REQUEST.json --out ops/runbooks/EPIC04_FIXTURE_PACKAGING_EVIDENCE.json
```

## What you (operator) must authorize

### 1) Read-only production DB URL (aggregate audit)

Put **only** in gitignored `.env.epic04.local` (never paste into chat):

```env
HX_PRODUCTION_ROLE_DATABASE_URL=postgresql://...
# If Railway public proxy has a self-signed chain for a diagnostic only:
# HX_DATABASE_TLS_REJECT_UNAUTHORIZED=false
```

Then:

```powershell
cd D:\projects\hustlexp-ai-backend
# load env then:
npm run verify:production-role-readiness
```

Expect counts only (no PII). Gate needs **≥1 ready account per role**.

### 2) Create five controlled Firebase users

Use dedicated fixture emails (aliases OK). Mark each as certification fixture:

- Expiry **≤ 2026-08-14** (or ≤14 days from grant)
- `test_exclusion` / internal flag so they never appear in business metrics
- Complete onboarding + **PRODUCTION** identity verification (not sandbox-only)

### 3) Role-specific grants (engine DB / admin tools)

Apply production mechanisms only (no local bypass, no forged rows via ad-hoc SQL unless an approved ops script exists):

| Role | Must satisfy readiness SQL in `verify-production-role-readiness.mjs` |
| --- | --- |
| Poster | `default_mode=poster` + ACTIVE_USER predicates |
| Hustler | `default_mode=worker` + payouts + `stripe_connect_id` (use **test** Connect) |
| Business Client | active membership on verified `client_enabled` org |
| Service Business | active membership on verified `provider_enabled` org with `payout_status=ACTIVE` |
| Operations | `admin_roles.can_manage_operations = true` |

Reuse Express test Connect `acct_1TzCeu7BxLRGjXMY` (or a fresh test Connect) for hustler / service-business payout destinations — **not** personal live banks.

### 4) Browser journeys (revision-bound)

Against live:

- Site: `https://www.hustlexp.app/version.json` → expect `31f33e13…` (or current clean)
- Engine: `/health` → expect `140ce19f…`, payment still **frozen**

For each role: sign in → entry → destination → recovery. Attach screenshots or session notes to `journey_evidence` (no secrets).

### 5) Revoke

On expiry or after evidence capture: disable accounts, strip admin grants, cancel Connect if disposable.

## Acceptance (EPIC-04 done)

- [ ] `verify:production-role-readiness` → **5/5** ready_accounts ≥ 1  
- [ ] Packaging evidence lists all five roles with expiry + test_exclusion  
- [ ] Five browser journeys recorded against exact site/engine revisions  
- [ ] No fixture counted as customer/GMV/liquidity  
- [ ] Production payment creation remains **frozen**

## Explicit non-goals

- Enabling `HX_PAYMENT_CREATION_MODE=enabled`
- Using real customer accounts as fixtures
- Claiming R5 or green-lane GMV from fixtures
