# Provider OS controlled product purchases

This stage implements only the existing controlled/local-test adapter, per the revised request. It does not integrate Stripe or any external rail, charge real money, or establish approved production pricing. Production-shaped controlled certification is available only with the existing `HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION=true` override and all normal controlled-test gates. Real-money production purchasing remains unavailable.

## Architecture and payment reconnaissance

Inspected QuotePaymentProvider, StripeQuotePaymentProvider, StaxQuotePaymentProvider, PaymentProviderResolver, StaxAssessmentPaymentProvider/businessAssessment, LocalCertificationPaymentProvider, ControlledTestQuotePaymentService, subscription router/configuration, shared Stripe client, webhook/event processing, and frontend QuotePayment. Existing generic/task payment interfaces require task/escrow or quote identities; assessments and user subscription plans are also unsuitable business-product owners.

The selected rail is LocalCertificationPaymentProvider. Its existing task methods, gates and task tables are preserved. Three standalone methods create, confirm and verify product intents using its existing HMAC/secret helpers and controlled-test gate. They use a separate durable provider ledger, never fabricated tasks or escrow. A small StandaloneProductPaymentProvider interface and ControlledProductPaymentProvider adapter separate orchestration from this implementation.

## Schema and migration

New registered migration: `20260921_provider_os_purchases.sql`, after the existing Provider OS access, quote-origin and premium-event migrations. No historical migration is edited.

- `provider_os_purchases`: organization, purchaser, product, provider IDs, amount/currency/period snapshot, test flag, pending/succeeded/failed/canceled status, payment/grant timestamps, review reason and next reconciliation time.
- `hxos_local_test_product_intents`: independent provider payment state, immutable identity/price/period binding and hashed confirmation secret. No card credentials.
- `hxos_local_test_product_events`: durable created/succeeded events with unique dedupe keys.
- Entitlement `grant_source` supports `manual_ops` and `purchase`; `source_purchase_id` identifies the latest paid grant, with earlier grants preserved in audit history.

Only one pending purchase per organization; provider intent and transaction identities are unique. Provider intent purchase IDs and event keys are unique. Business deletion is restricted while purchase records exist. Purchaser deletion nulls both ownership actor references; it does not delete payment evidence or grant authority. Ledger/purchase FKs restrict deletion. Indexes support organization history and bounded reconciliation.

## Server configuration

No default price or duration. All of the following are required:

- `NODE_ENV=production` additionally requires `HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION=true`. Missing/false rejects purchasing. Outside production this override is not required. Both the catalog and provider execution reuse the existing `localCertificationPaymentEnabled` helper; no new environment variable or boolean parser is introduced.
- `PAYMENT_PROVIDER=local_test`
- Existing gate: `HXOS_ALLOW_LOCAL_TEST_PAYMENT=true`, `ENGINE_API_MODE=test`, `STRIPE_MODE=test`, and `HXOS_LOCAL_TEST_PAYMENT_SECRET` at least 32 trimmed characters. `STRIPE_MODE` is an existing safety sentinel only; no Stripe client or credentials are used.
- `PROVIDER_OS_TEST_PURCHASE_ENABLED=true`
- `PROVIDER_OS_TEST_AMOUNT_CENTS`: explicit positive integer, maximum 99,999,999.
- `PROVIDER_OS_TEST_CURRENCY=usd`
- `PROVIDER_OS_TEST_PERIOD_DAYS`: explicit integer, 1–366.
- Existing `HX_PAYMENT_CREATION_MODE` must permit new payments. Freeze blocks creation/confirmation but not verification of an already-confirmed test payment while the controlled environment remains enabled.

Tests explicitly use 1,234 cents / 30 days as fixture data, not an approved product price. No environment files or real credentials were changed.

## API and authorization

All inputs are strict. The frontend supplies only organization ID and, where required, a server-issued purchase ID:

- `providerOs.purchaseStatus`: current server product/access state and latest organization purchase.
- `providerOs.createPurchase`: persists pending purchase, initializes provider intent and returns a `controlled_test` checkout discriminator.
- `providerOs.completeControlledPurchase`: reauthorizes, confirms the test provider intent, then invokes the common finalizer.
- `providerOs.refreshPurchase`: independently verifies the saved provider payment and reloads status.
- `providerOs.inspectPurchases`: existing operations-admin authorization, latest 50 durable records including review reasons/provider IDs/grant times.

Purchase authority requires exact active organization, provider enabled, current active/non-banned/non-trust-held account and active membership with existing `MANAGE_BILLING` action (owners/admins). Entitlement is not required to purchase. No amount, period, status, product code or external transaction ID is accepted from the client.

Unverified but otherwise eligible businesses may exercise a controlled purchase. The UI explicitly says purchasing does not verify the business; Provider OS quote acquisition remains VERIFIED-only.

## Verification, grants and concurrency

Purchase persistence precedes provider confirmation. Confirmation locks the organization and purchase, rechecks current membership/admin blocks, and writes the provider intent success and deduped event atomically. It does not directly grant entitlement.

`finalizeProviderOsPurchase` independently reads the provider ledger and checks intent/purchase/organization/purchaser/product/amount/currency/period/test identity. It then locks organization, purchase and entitlement and revalidates current eligibility. Purchase success, entitlement mutation and before/after Ops audit commit atomically. Success replay exits before adding time. Separate database-connection tests exercise concurrent creation/finalization.

Manual Ops mutation and paid grants converge on `writeProviderOsEntitlement`. Manual grants use `manual_ops`; payment grants use `purchase` plus source purchase ID. Suspend/revoke retain the prior grant source as historical evidence.

- Inactive or expired: grant from database NOW for the purchased number of 24-hour days.
- Future finite access appearing during pending checkout: add the period to existing expiry.
- Current active access: no new purchase CTA and new purchase creation is rejected to prevent accidental stacking. A new purchase is available after expiry.
- Suspended/revoked: never overwritten by purchase.
- Scheduled or unlimited access appearing during checkout: hold for review rather than shortening/replacing it.
- Removed/ineligible original purchaser or organization: confirmed payment remains pending with `paid_at`, provider transaction ID and an explicit review reason; entitlement is unchanged. Ops can inspect it and resolve policy/membership before re-verification. No automatic bypass.

## Recovery and failure handling

No external webhook exists in this controlled-only stage. The independently verified provider ledger is authoritative, not a browser success flag. Provider events are deduped by `product-created:<intent>` and `product-succeeded:<intent>`.

Existing maintenance queue schedules `provider_os.reconcile_purchases` every minute. It claims up to 50 due records with `FOR UPDATE SKIP LOCKED`, advances retry time and recovers saved creation/finalization work. Normal retries are five minutes, verification failures ten minutes, policy holds one hour. It never confirms an unconfirmed payment automatically. Removing test configuration disables confirmation/verification; records remain available for later authorized recovery.

A provider-confirmed payment survives an entitlement transaction failure and can be finalized later without confirming twice. Failed/canceled provider records do not grant access. Uncertain verification remains pending with a review reason rather than being mislabeled unpaid. Ops sees persisted evidence; logs contain purchase IDs and safe summaries, not secrets.

## Frontend

Authenticated `/provider-os/purchase?organizationId=...` is outside the premium entitlement guard so inactive businesses can buy. It is inside canonical authentication, and safe auth continuation permits this route. Every API still verifies organization authority.

The existing dashboard/access entry links inactive businesses to this page. The page reads server price/period, clearly labels test-only/no-real-money behavior, initializes a purchase and offers `Complete controlled-test payment` only for a server-provided controlled checkout. It polls saved state, provides explicit verification/retry controls, shows review/error/unavailable states, and invalidates entitlement cache after server-confirmed access. Active businesses see expiry and Open Provider OS; suspended/revoked businesses see support guidance. There is no localStorage entitlement flag or optimistic unlock.

## Separation and remaining work

No changes to Stripe/Stax clients, webhooks, quote_payments, assessment_payments, escrow, task fees, payouts, Connect, quote verification policy, payment materialization, addresses, proof/completion or premium SMS. Existing LocalCertificationPaymentProvider task methods and their tables remain unchanged; only separate product methods were added. Premium notifications continue reading effective entitlement normally. Manual Ops access remains.

This is a certification path, not production monetization. Remaining work: approved production product price/period; a deliberately selected real provider integration with server verification/webhook/reconciliation; refunds/cancellations for real product purchases; recurring billing only if later requested. No real-provider credentials are needed now. Existing accepted canonical work remains accessible independently of premium entitlement.

## Validation for this implementation

- Backend `npm run build` (TypeScript noEmit) and `npm run compile`: passed.
- Frontend `npm run build` (TypeScript project build + Vite): passed; existing large-bundle warning remains.
- Backend focused Provider OS, controlled-payment, entitlement, auth and migration-order checks: 162 passed across 12 files. Includes real isolated PostgreSQL purchase/provider ledger transactions, concurrent connections, and rollback/recovery. Existing premium-event fixture also passed.
- Frontend focused purchase, Provider OS, notification destination, auth, launch and proof checks: 46 passed across 7 files.
- Backend changed production files and frontend purchase/entry/App files: scoped ESLint passed.
- The additionally scoped auth return-destination file has two existing no-control-regex errors on its unchanged defensive control-character checks. Only the purchase route allowlist was changed.
- Whole backend lint: existing 40 errors / 135 warnings. Whole frontend lint: existing 33 errors / 4 warnings.
- Broader backend validation reproduced eight baseline failures: three engine migration fixtures (stale full-list/count and Docker path assumptions), one local-payment Docker-copy fixture, four Operations router authority mocks missing current authorization query results. These eight also reproduce with the pre-change feature-branch migration manifest; the implementation manifest was restored after that comparison.
- `git diff --check`: passed in both repositories.
- No live external charge, production migration, browser integration or full production schema rehearsal was performed. Database tests used a disposable schema in an isolated local PostgreSQL instance, with no task-payment tables required for product purchases.

## Production-shaped controlled certification gate correction

Removed only the two unconditional production rejections from the Provider OS catalog gate and standalone provider guard. The unchanged `localCertificationPaymentEnabled` helper now decides the environment allowance in both paths, including exact-string `HXOS_ALLOW_LOCAL_TEST_PAYMENT_IN_PRODUCTION=true`. All other catalog, provider, test-mode, secret, purchase-enablement and payment-creation gates remain required. No frontend change, entitlement change, new environment variable, or task-payment behavior change.

Focused validation for this correction: 74 tests passed across configuration, existing local-payment provider, Provider OS router and isolated PostgreSQL purchase tests. Coverage includes non-production, production override true/false/missing, invalid companion gates, successful production-shaped create/confirm/verify/grant, and unchanged task-payment gate behavior. Backend build/typecheck and compile, frontend build, scoped production-file lint and diff checks passed. The existing frontend bundle-size warning remains. No live charge or production database migration was performed.
