# Production Role Fixture Packaging (EPIC-04)

Create least-privilege, expiring fixtures. Never count fixtures as business outcomes.

Audit script (read-only): `scripts/verify-production-role-readiness.mjs`

## Fixture matrix

| Role | Identity provider | Account ID (redacted) | Expires (UTC) | Intended entry | Intended destination | Recovery | Payout destination controlled | Test-exclusion tagged | Journey evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Poster | Firebase / Supabase | | | `/get-help` | `/task-preview` | `/get-help` | n/a | | | |
| Hustler | Firebase | | | `/earn` | `/earn/setup` | `/earn` | test Connect only | | | |
| Business Client | Firebase | | | `/business` | `/business/workspace` | `/business` | | | | |
| Service Business | Firebase | | | `/business/provide` | `/business/workspace?mode=provider` | `/business/provide` | test Connect only | | | |
| Operations | ops admin key / magic link | | | `/ops` | `/ops` | `/` | n/a | | | |

## Packaging rules

1. Fixture emails/phones use a dedicated controlled domain or alias set.
2. Every fixture has an expiry ≤ 14 days unless re-authorized.
3. Payout destinations are test/sandbox or explicitly controlled corporate accounts — never personal production banks without dual control.
4. Journeys attach: browser revision (`/version.json`), engine revision (`/health.build.revision`), canonical IDs, and `/ops` visibility.
5. Revoke immediately after evidence capture or on expiry.

## Acceptance

- `verify-production-role-readiness` reports ready_accounts ≥ 1 for each of 5 roles
- Each lane reaches destination/recovery without inventing GMV
- Exact audit trail stored under `docs/production-role-readiness-evidence-*.md`
