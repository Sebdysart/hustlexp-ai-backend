# HustleXP production release gate

Status: `CURRENT_RUNBOOK / NO_GO_GATE`

Last aligned: `2026-08-25 America/Los_Angeles`

Current decision: `NO-GO`

Production effects authorized by this checklist: `NONE`

This checklist is a blocking decision record, not a launch procedure. It cannot authorize a merge, deployment, DNS change, database mutation, provider action, configuration change, pilot, customer communication, or money movement. Read [the Team Goal and Execution Contract](../../docs/HUSTLEXP_TEAM_ALIGNMENT.md).

A single unchecked, stale, contradicted, or unowned requirement preserves `NO-GO`. Configuration presence, code presence, green CI, a test receipt, or one healthy probe is not launch proof.

## 1. Authority and exact identity

- [ ] Canonical Governor preflight passes in the release session with one release node and no missing dependency.
- [ ] Current state, checkpoint, evidence ledger, dependency graph, requirements registry, revision lock, and manifest agree.
- [ ] Exact backend, site, worker, migration, build, image, and deployment identities are recorded.
- [ ] Railway Git auto-deploy is detached or placed behind the exact protected release transaction; a merge cannot deploy production by itself.
- [ ] Repository SHA, Railway source metadata, image digest, and runtime health identity agree; stale `HX_BUILD_*` overrides are absent.
- [ ] Source and build are clean, signed, reproducible, and independently accepted by a named Reviewer.
- [ ] A distinct named Certifier reproduces the accepted exact signed candidate in a clean environment and accepts only the stated certification boundary.
- [ ] Repository rules reject direct pushes, bypass, unsigned commits, unresolved review threads, and unapproved merge.
- [ ] Production authority names exact allowed effects, roots, actors, expiry, rollback, and receipts.

**Done Criteria:** One immutable release identity and one unambiguous authority chain exist; Builder, Reviewer, and Certifier are three distinct identities.

**Test Plan:** Change one SHA, artifact digest, authority root, Reviewer identity, Certifier identity, or clean-environment witness. Push a harmless signed rehearsal change through the authorized non-production path and verify that Railway creates no production deployment. Any mismatch or automatic deployment fails the gate.

## 2. Underwriting, legal, and operating policy

- [ ] All 20 processor decisions are accepted in writing for the exact business model, origin, category, geography, limits, and cohort.
- [ ] Executed processor commercial terms and prohibited/restricted-activity decisions are attached.
- [ ] Legal, privacy, worker-classification, tax, category, credential, insurance, dispute, refund, cancellation, and merchant-context policies are approved.
- [ ] Public claims, terms, privacy notices, consent, fee disclosures, support promises, and provider economics match approved policy.
- [ ] Severe-edge owners and independent approvals are named and current.

**Done Criteria:** No processor-, legal-, policy-, or category-dependent capability remains unresolved for the bounded release cell.

**Test Plan:** Remove one written decision or introduce one unapproved category/geography/fee. Capability evaluation must return disabled and launch must remain `NO-GO`.

## 3. Canonical lifecycle and authority

- [ ] Every occurrence has one canonical task root in Railway PostgreSQL.
- [ ] Marketplace, Provider OS, and bring-your-own-provider origins share the same lifecycle.
- [ ] Task Draft precedes opportunity, provider interest, Financial Security Event, Work Order, assignment, and exact-address release.
- [ ] Processor eligibility and HustleXP task eligibility are separate, expiring, auditable facts.
- [ ] Financial Security Event, capture, settlement, platform funding, provider payout, and reconciliation are distinct.
- [ ] Supabase and browsers cannot write canonical task, assignment, payment, completion, payout, or recurrence state.
- [ ] `/OPS` uses named short-lived sessions, strict RBAC, expected versions, immutable results, step-up, and dual approval where required.

**Done Criteria:** Every money-affecting path has one owner, canonical record, command boundary, idempotency witness, audit trail, and capability gate.

**Test Plan:** Trace task creation through closure for all three origins plus a recurring occurrence. Any duplicate writer, inferred rail, shared-key path, arbitrary status mutation, or processor-direct bypass fails.

## 4. Migration and data integrity

- [ ] Every persistent PostgreSQL target and applied-migration ledger relevant to the release is closed with current evidence.
- [ ] Exactly one migration lineage is selected; no applied migration name or checksum is overwritten.
- [ ] Fresh install, upgrade, replay, drift, partial failure, concurrency, and forward-repair tests pass on real disposable PostgreSQL.
- [ ] Canonical and overlay data mappings, counts, financial totals, identity links, and tombstones reconcile.
- [ ] Backup/PITR and restore drills produce measured RPO/RTO for canonical and required overlay stores.

**Done Criteria:** The exact release migration is safe for every in-scope persistent target and restore/recovery is demonstrated.

**Test Plan:** Replay the migration, inject a mid-flight failure, restore a pre-migration snapshot, and compare invariant/ledger checks. Any unexplained drift or ambiguous target preserves `NO-GO`.

## 5. Money, processor, and reconciliation

- [ ] Positive production customer-money creation remains structurally impossible until this gate receives separate production authority.
- [ ] Fake-adapter task-first FSE, capture, refund, void, settlement, funding, payout, dispute, and reconciliation scenarios pass.
- [ ] An approved sandbox passes the same exact scenario matrix only after written processor decisions exist.
- [ ] Every external operation is durably claimed before provider I/O with deterministic idempotency.
- [ ] Webhooks are verified, deduplicated, normalized, replay-safe, and order-independent.
- [ ] Ambiguous outcomes become `RECONCILIATION_REQUIRED`; no code guesses success.
- [ ] Kill switches block the exact capability without disabling refund, void, recovery, webhook, or reconciliation lanes.
- [ ] Bank-arrival and daily three-way reconciliation evidence exists for any bounded pilot.

**Done Criteria:** No unexplained ledger, provider, settlement, funding, payout, or bank mismatch exists for the exact certified cell.

**Test Plan:** Force timeouts, duplicate events, stale versions, reordered webhooks, partial capture/refund, payout return, dispute, and kill-switch activation. Any duplicate money, state regression, silent loss, or unexplained mismatch preserves `NO-GO`.

## 6. Security, privacy, safety, and Operations

- [ ] Anonymous, expired, wrong-role, missing-step-up, stale-version, and idempotency-drift commands fail closed.
- [ ] Built assets and source contain no browser-held human admin credential.
- [ ] Exact addresses and sensitive evidence remain encrypted, masked, purpose-limited, and retention-controlled.
- [ ] Independent penetration testing covers the API, command surface, webhook inbox, object access, queues, workers, database roles, and recovery paths.
- [ ] All six source-dated secret-scanning alerts are resolved with provider-side revocation/rotation receipts: two Google API keys and one each for DeepSeek, GitHub personal access token, Groq, and OpenAI. No secret value appears in the evidence packet.
- [ ] Every replaced credential has least-privilege scope, an identified owner, storage location, rotation date, expiry/next-rotation date, and a negative test proving the exposed predecessor is rejected.
- [ ] Incident, fraud, dispute, privacy, safety, legal, processor, and reconciliation queues have primary/backup owners and tested escalation.
- [ ] Accepted and rejected Operations actions produce immutable actor-attributed results.

**Done Criteria:** No P0/P1 security, privacy, safety, authority, or severe-edge ownership defect remains open.

**Test Plan:** Exercise cross-tenant access, actor spoofing, privilege escalation, replay, shared-secret search, address access before assignment, audit tampering, and two-person-control bypass. Any success fails launch.

## 7. Reliability and rollback

- [ ] API, worker, queue, database, cache, provider, storage, and notification observability is revision-bound.
- [ ] Dead-letter, retry, timeout, backpressure, reconciliation, and alert-delivery drills pass.
- [ ] Rollback or forward-repair preserves append-only financial/audit evidence and does not re-enable positive money.
- [ ] Capacity, latency, availability, and cost thresholds are derived from the bounded pilot load and pass with margin.
- [ ] Runbooks are current, authority-scoped, and rehearsed by someone other than the author.

**Done Criteria:** A controlled failure can be detected, owned, contained, recovered, and reconciled without founder rescue.

**Test Plan:** Stop one dependency at a time, inject queue lag and provider failure, and execute recovery from the exact release. Missing alerts, unbounded retries, lost effects, or unverifiable recovery fails.

## 8. Bounded pilot and final decision

- [ ] The pilot cell has explicit category, geography, origin, cohort, amount, velocity, and time limits.
- [ ] Customer/provider fixtures or participants are authorized, truthful, excluded from business metrics where required, and privacy-safe.
- [ ] Emergency stop, refund/void, reconciliation, support, incident, and termination procedures are staffed during the window.
- [ ] A fresh independent Reviewer accepts the exact evidence package and release identity without editing it.
- [ ] A distinct Certifier reproduces the accepted exact signed identity from a clean environment.
- [ ] The authorized approver records `GO` for only the bounded cell and time window.

**Done Criteria:** Every prior section is complete, current, exact-revision bound, independently accepted, independently certified, and covered by explicit production authority.

**Test Plan:** Expand any cell dimension, exceed any limit, let authority expire, or invalidate one receipt. The system must stop new positive effects while preserving recovery lanes.

## Current disposition

`NO-GO`. The active node is `D1_CI_INCIDENT_RECOVERY_20260825`; its local candidate has no frozen SHA, fresh Governor acceptance, full/PostgreSQL evidence, independent review, protected merge, or exact Railway web/worker/database/health convergence. PR #275 was merged unchanged without the requested `whitehorse1016` approval. Six exposed credentials remain without accepted rotation receipts, all 20 processor decisions remain unresolved, and full task-first fake-FSE, `/OPS` authority convergence, sandbox certification, and production release evidence are absent. Do not convert this checklist into a percentage score.
