# Production role-readiness evidence — 2026-07-22

## Decision and boundary

**Production remains NO-GO under `EXT-DEPLOY-001`.** A privacy-safe,
aggregate-only audit found zero production-ready accounts for every authenticated
HustleXP role. No user, role, organization, verification, payout, task, provider,
or database state was created or changed by this audit.

This gate proves only that the minimum role infrastructure exists. A passing
count never proves a controlled certification fixture, successful authentication,
safe authorization, provider delivery, or a completed browser journey. Those
require separately authorized, revision-bound evidence.

## Deterministic gate

`scripts/verify-production-role-readiness.mjs` executes one `COUNT(*)` query for
each authenticated role and returns only counts:

| Role             | Minimum readiness contract                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------ |
| Poster           | Active adult, onboarding complete, current production identity verification                            |
| Hustler          | Poster controls plus worker mode, no trust hold, production payout destination ready                   |
| Business Client  | Ready user with active membership in an active, verified client organization                           |
| Service Business | Ready user with active membership in an active, verified provider organization and active payout state |
| Operations       | Ready user with an administrator grant carrying Operations-management authority                        |

The verifier contains no write statement and does not select email, phone,
Firebase UID, name, provider identifier, or any row-level identity. Query errors
are reduced to a generic failure so connection data cannot leak into the report.
Six contract tests pin the query inventory, mutation prohibition, PII projection
ban, healthy contract, independent missing-role failures, failure redaction, and
database transport policy.

## Live read-only result

At `2026-07-22T14:29:33.714Z`, the production database returned:

| Role             | Ready accounts | Result |
| ---------------- | -------------: | ------ |
| Poster           |              0 | FAIL   |
| Hustler          |              0 | FAIL   |
| Business Client  |              0 | FAIL   |
| Service Business |              0 | FAIL   |
| Operations       |              0 | FAIL   |

Result: **0/5; fail closed.**

The run used Railway's public database proxy because no authenticated Railway
SSH/private-network path was available locally. The verifier requires strict
certificate validation for public URLs by default. This one diagnostic used the
explicit `HX_DATABASE_TLS_REJECT_UNAUTHORIZED=false` override to encrypt the
connection while accepting Railway's self-signed certificate chain. Therefore,
the run proves aggregate database state but does not certify public-proxy endpoint
identity. A launch artifact must run inside Railway private networking or with a
trusted provider CA.

## Falsifiable exit test

Product Operations, Identity/Trust, Business Operations, and Release Engineering
must jointly provide controlled accounts without impersonating or reusing real
participants. The role sub-gate passes only when:

1. Every role count is at least one under the exact database predicates above.
2. Each account is explicitly authorized for certification, attributable to an
   owner, time-bounded, and excluded from marketplace, liquidity, financial,
   reputation, and growth outcomes.
3. Authentication and role grants use production mechanisms; no local-test token,
   bypass, direct database role forgery, or shared participant credential is used.
4. Poster, Hustler, Business Client, Service Business, and Operations browser
   journeys are captured against the exact deployed site and engine revisions.
5. Authorization-negative, expired, interrupted, offline, prohibited-work,
   no-supply, provider-failure, severe-exception, and recovery paths remain
   fail-closed and user-actionable.
6. Fixture data is reconciled and retained or revoked according to the approved
   evidence policy; it is never counted as a customer, worker, task, payment,
   revenue, liquidity, retention, or provider-delivery outcome.

Passing this verifier does not close `EXT-DEPLOY-001`; canonical DNS/TLS,
zero-error runtime evidence, and revision-bound controlled journeys must also
pass.
