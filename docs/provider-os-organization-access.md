# Provider OS organization access: stage one

Provider OS acquisition requires an explicitly selected business organization,
current eligible actor and active business membership, the existing business
operation policy, an active provider-enabled organization, and a time-valid
Provider OS entitlement. Worker mode and membership in a different organization
confer no authority. Entitlement is never checked by canonical task execution,
address release, payment, proof, completion, payout, cancellation or support.

## Migration and rollout

`20260918_provider_os_organization_access.sql` is registered after the historical
Provider OS migrations and canonical business tables. The normal migration runner
wraps it and its checkpoint in a transaction. Historical migrations are unchanged.
No migration was applied to a live database during implementation.

All historical user-owned invites and relationships remain in place, marked
revoked with an explicit disabled reason and null organization ownership. Even a
single current business membership cannot prove historical organization ownership
or customer consent: the old email-only onboarding API could create the same row.
Do not assign the first organization or reactivate these rows. Grant the correct
business access and have customers explicitly accept NEW organization invitations.
No entitlements are automatically granted.

The unique relationship key is (provider_organization_id, poster_user_id).
Active relationships and open invitations require non-null organization IDs.
Nullable legacy provider_user_id is evidence only, never read authority. New rows
record creator/acceptance actors separately. Organization/customer FKs restrict
hard deletion; new optional actor FKs use SET NULL. Canonical account anonymization
retains the user row and disables account access; deleted customers are excluded
from the workspace queries. Historical audit and invitation PII retention remains
subject to the existing retention process; this is not a GDPR redesign.

## Interim operations API (no billing integration)

Authenticated operations administrators use the existing generic tRPC client:

- `providerOs.inspectEntitlement({ organizationId })` (GET)
- `providerOs.setEntitlement({ organizationId, status, expiresAt?, reason })` (POST)

Only `operationsAdminProcedure` can call these: admin/founder or a recognized
admin role with can_manage_operations, on an eligible authenticated account.
There is no public/self-service grant or environment bypass.

Grant or renew with status `active`, an optional future ISO expiry, and a required
reason. Missing/null expiry means no expiry; grants begin now. Suspend with
`suspended`, revoke with `revoked`. Suspension/revocation preserve the original
access window. Each mutation locks the organization and writes before/after
state to ops_action_audit atomically; audit failure rolls back the entitlement.
An absent row reports `inactive`; future-start rows report `scheduled`; active rows at
or beyond expiry report `expired`. Only effective `active` grants workspace use.
Inspect returns the stored status/window; accessStatus returns effective status.

## Operations and consent

- accessStatus checks eligible account, exact membership, READ_WORKSPACE and
  organization eligibility but does not require entitlement (needed for paywall).
- listClients/listDrafts/getDraft require READ_WORKSPACE plus active entitlement.
  Client/draft visibility derives from active organization/customer relationships.
- createInvite requires MANAGE_MEMBERS plus entitlement, stores a SHA-256 token
  hash and organization/creator, and returns a 30-day opaque invite link.
- previewInvite/acceptInvite derive organization ONLY from the hashed token row;
  both reject non-open, expired, legacy/unowned, or no-longer-entitled invitations.
- Opening a link previews; signing in uses canonical unified authentication and a
  validated return URL. Only clicking Accept invitation creates a relationship.
- Acceptance verifies the account and intended email and writes relationship,
  acceptance audit and invite accounting in one transaction. A duplicate active
  relationship is idempotent. A revoked organization/customer pair stays revoked,
  even with another valid invitation; support intervention is required.
- setQuote requires ASSIGN_CREW, entitlement, active relationship and eligible
  unconverted draft. It locks/checks the organization before the draft, then uses
  validateBusinessQuoteContext/createBusinessQuoteInTransaction. Verified-only
  behavior is retained; pending-verification Provider OS activation is unsupported.
  Service profiles and business locations are not inputs or prerequisites.

## Premium SMS pause

All four old Provider OS SMS events are disabled at enqueue. The old user-owned
fan-out/provenance hook module is removed. The SMS worker recognizes historical
provider_os: idempotency keys and suppresses unsent rows before Twilio delivery;
other SMS and canonical notification paths are unchanged. Message templates and
historical ledger rows remain. Re-enabling requires organization provenance,
entitlement and current-recipient membership checks plus the dedicated durable
notification/preferences work. Do not simply re-enable the old emitter.

## Deliberately deferred

Subscription checkout/pricing/billing; shared BusinessQuoteForm UI parity; quote
provenance/history and pending-verification activation; notification durability
and preferences; Provider OS client/task detail parity. No task lifecycle or
exact-address system is replaced by Provider OS.
