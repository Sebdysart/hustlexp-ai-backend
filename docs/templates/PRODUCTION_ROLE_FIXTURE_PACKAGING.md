# Production Role Fixture Packaging (EPIC-04)

Create least-privilege, expiring fixtures. Never count fixtures as business outcomes.

Audit script (read-only): `scripts/verify-production-role-readiness.mjs`

## Fixture matrix

| Role | Identity provider | Account ID (redacted) | Expires (UTC) | Intended entry | Intended destination | Recovery | Payout destination controlled | Test-exclusion tagged | Journey evidence | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Poster | Firebase | `poster+epic04@…` | 2026-08-14 | `/get-help` | `/task-preview` | `/get-help` | n/a | yes | | REQUESTED |
| Hustler | Firebase | `hustler+epic04@…` | 2026-08-14 | `/earn` | `/earn/setup` | `/earn` | test Connect only | yes | | REQUESTED |
| Business Client | Firebase | `bizclient+epic04@…` | 2026-08-14 | `/business` | `/business/workspace` | `/business` | n/a | yes | | REQUESTED |
| Service Business | Firebase | `svcbusiness+epic04@…` | 2026-08-14 | `/business/provide` | `/business/workspace?mode=provider` | `/business/provide` | test Connect only | yes | | REQUESTED |
| Operations | Firebase + admin_roles | `ops+epic04@…` | 2026-08-14 | `/ops` | `/ops` | `/` | n/a | yes | | REQUESTED |

Live request pack: `ops/runbooks/EPIC04_FIXTURE_REQUEST.json` · Execution: `ops/runbooks/EPIC04_ROLE_FIXTURE_EXECUTION.md`

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
