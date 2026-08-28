# Superseded EPIC-04 production-role fixture procedure

Status: `LEGACY_NON_EXECUTABLE / EXPIRED_AUTHORITY`

The prior procedure, revisions, role counts, account window, payout assumptions, and production actions have expired. Do not create Firebase users, database roles, organizations, identity records, payout destinations, Connect accounts, browser sessions, or production journeys from this file.

The retained design lesson is narrow: role fixtures must be least-privilege, expiring, excluded from business metrics, exact-revision bound, and independently reviewed. They cannot prove real user readiness, provider eligibility, processor approval, payment readiness, liquidity, GMV, or a completed task.

Any future fixture execution requires:

- current Governor and root-specific production authority;
- the replacement fixture package in `docs/templates/PRODUCTION_ROLE_FIXTURE_PACKAGING.md`;
- named session/RBAC/MFA controls for Operations;
- synthetic privacy-safe data and explicit retention/deletion;
- fake adapter or separately approved sandbox;
- exact site/backend/worker/schema/build identities;
- independent journey, negative authorization, audit, revocation, and cleanup evidence.

Production remains `NO-GO`. See [the Team Goal and Execution Contract](../../docs/HUSTLEXP_TEAM_ALIGNMENT.md).
