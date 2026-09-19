# Legacy production-role fixture package

Status: `LEGACY_NON_EXECUTABLE / EXPIRED_TEMPLATE`

The prior August 2026 fixture window expired. This file no longer contains account-creation, database-grant, identity, payout, provider, or browser-execution instructions.

A future controlled fixture package requires fresh production authority and must record:

| Field | Required evidence |
|---|---|
| Fixture purpose and lane | Exact bounded scenario; never a business outcome |
| Identity | Redacted provider ID, issuer, assurance level, and server-derived roles |
| Scope | Tenant, resources, capabilities, category, geography, amount, and allowed effects |
| Exclusions | Analytics, GMV, liquidity, customer/provider metrics, communications, and payouts |
| Time | Issued/expiry/revoked timestamps; shortest practical duration |
| Data | Synthetic values, retention/deletion plan, privacy owner |
| Financial boundary | Fake adapter or separately authorized sandbox; never a personal bank |
| Candidate | Exact site/backend/worker/schema/build identities |
| Approval | Distinct requester, approver, executor, reviewer; step-up/dual control where required |
| Evidence | Login, authorization, journey, denial, audit, revocation, and cleanup receipts |

Required rules:

1. No raw secret, password, token, identity document, bank detail, or exact address enters Git or chat.
2. The fixture cannot share a reusable human credential.
3. Production money creation remains frozen unless separately authorized by the full release gate.
4. Operations roles use named sessions and server-derived authority.
5. Revocation/cleanup is a separate explicit effect and must preserve audit evidence.
6. A ready fixture proves only its exact controlled lane, never product readiness.

See [the Team Goal and Execution Contract](../HUSTLEXP_TEAM_ALIGNMENT.md).
