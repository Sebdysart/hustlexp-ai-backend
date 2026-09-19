# Provider OS quote workspace (stage two)

Apply the registered `20260919_provider_os_quote_origin` migration through the
normal migration runner before serving this code. It follows the stage-one
organization/entitlement migration and existing photo-audit migration. No
production migration is applied by this implementation.

## Provenance and tracking

`quotes.acquisition_origin` is assigned by server-side acquisition code:
`claim_link`, `direct_proposal`, or `provider_os`. Unspecified historical and
other canonical quote origins remain null; no actor/audit-based backfill guesses
are made. Historical unlabelled Provider OS quotes are consequently not included
in the new origin-filtered history. Repairing those would require independently
verified provenance, not a blanket backfill.

Origin belongs to the quote, so changing its active version or paying/materializing
the quote does not replace it. The initial version also snapshots origin in
`scope_json`. This is not a notification event or a billing entitlement.

`providerOs.listQuotes` and `getQuote` require the stage-one explicit-organization
access guard with `READ_WORKSPACE`. They read only that organization's Provider OS
quotes and their versions; they never join claim links or expose payment tokens,
other businesses' quotes, or address-vault data. History uses durable ownership
of the organization's own commercial record, independent of subsequent client
relationship revocation. This does not authorize new customer draft reads.

History is cursor-paginated at 50 quotes, ordered by creation timestamp/id, with
full PostgreSQL timestamp precision in the cursor. All quote statuses are retained;
unprocessed submitted quote expiry is also displayed. Only the selected quote may
link to the draft's materialized task.

Before materialization the business destination is
`/provider-os/quotes/:quoteId?organizationId=:organizationId`. Accepted/declined
notifications use that destination for Provider OS origins. After materialization,
the existing paid notification and task actions use `/business/tasks/:taskId`.
Customer notifications remain on canonical customer routes.

## Request and media authority

The eligible feed filters draft status, claimed/selected/materialized state, active
organization/client relationship, and active organization-owned quotes in SQL
before its 100-row limit. Different members of one organization see the same feed.
The request detail may show an existing org quote while the underlying request is
still eligible for viewing, preventing an obsolete quote action on a cached page.

`upload.listTaskDraftPhotos` accepts optional `providerOrganizationId` for an
explicit Provider OS principal. That mode has no fallback to ordinary authority:
the authenticated actor must pass the stage-one guard, and the requested draft
must belong to an active client relationship of that organization, with an active
customer, eligible status, and no claim, selected quote, or materialized task.
Organization eligibility, membership, entitlement, relationship and draft locks
are held through signed-media delivery and audit commit. Only finalized/consumed
draft photos are loaded. Existing five-minute signing, field projection and
gallery/lightbox are reused. Audit rows record `PROVIDER_OS`, viewer and organization.

Ordinary authenticated and public token-preview photo authorization remain distinct
and retain their existing rules. Upload, finalization and removal are unchanged.
Structured task facts and original customer text use the canonical display helper;
this does not read or release the exact-address vault.

## Boundaries and deferred work

Provider OS quote acquisition remains VERIFIED-only. The canonical pending quote
activation service still requires a real claim record; supporting Provider OS
pending verification requires an origin-aware activation path that revalidates
the org entitlement, relationship, draft and current quote version. No fake claim
records are created.

Entitlement is required for premium workspace access/acquisition, not canonical
payment or accepted/paid task execution. Address release, proof, completion,
support, cancellation and payout remain canonical.

Premium SMS remains disabled at enqueue and worker delivery. Future work includes
durable origin-aware premium events, recipient membership/entitlement checks,
preferences and delivery deduplication; billing/paywall checkout; optional pending
verification; and further client workspace polish. None is enabled by this pass.
