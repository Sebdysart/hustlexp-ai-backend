# HustleXP Team Goal and Execution Contract

Status: `CURRENT_TEAM_TARGET / NOT_PRODUCTION_AUTHORITY`

Publication resolution: `EXACT_COMMIT_AND_INDEPENDENT_ACCEPTANCE_REQUIRED`

Last evidence refresh: `2026-08-31 America/Los_Angeles`

Decision: `RESHAPE`

Production launch: `NO-GO`

Production effects authorized by this document: `NONE`

This is the stable human-readable engineering target for the active HustleXP Universal V1A convergence mission. It defines the mission, ownership boundaries, target invariants, execution order, and objective definition of done. The repository copy becomes team-operative only at an exact commit accepted by an independent Reviewer; mutable working-copy text receives no adoption credit. Current implementation and external-state claims live in the separately refreshable [Current Backend Checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md), so a changed PR or runtime identity can stale the checkpoint without invalidating this target contract. This document does not approve a processor, migration, merge, deployment, legal position, category, provider cohort, market cell, or money movement.

The sole business authority is the `HustleXP Business and Universal V1 Charter v1.1.0` at signed commit `0b80c71e118d7cab70474bbbf6df778811fe4fe8`. The ACTIVE `HustleXP Codex End-to-End Delivery OS v1.0.0`, doctrine SHA-256 `5D4045B3C7A1CD3EC05CA133FA6F6699182EF58AF7EF202D596E63AAABA195A4`, and authority-manifest SHA-256 `C22082CB4B95E2139E317C8D4A806B0ADBE00F5BD9A8F41C561765F06F1793B7` govern how the current technical objective is executed; they do not replace the Charter or grant external authority. The active boundary is Universal V1A Gates 0–10. Live-processor work is deferred to Gate 11, and any controlled pilot is deferred to Gate 12; both are excluded from this mission.

## 1. Mission

Complete and certify the smallest maintainable Universal V1A system that can safely execute the complete local-work transaction loop through deterministic fake financial providers only:

```text
qualified demand
→ durable Task Draft
→ approved scope and commercial terms
→ payment-method reference ready
→ simulated provider-account eligibility and HustleXP task eligibility
→ expiring Conditional Provider Hold
→ approved fake Financial Security Event
→ immutable Canonical Work Order materialization
→ separately authorized hard assignment
→ separately authorized controlled private-detail release
→ verified fulfillment
→ fake capture
→ fake settlement
→ fake platform funding and provider payout
→ reconciliation
→ closure
→ repeat or a new recurring occurrence
```

V1A preserves the production-shaped domain distinctions and adapter boundary while creating no real financial effect. A later approved V1B adapter must reuse this lifecycle rather than rewrite it. Production payment creation and hard assignment remain deny-by-default throughout the current mission.

Optimize for:

1. safely completed paid tasks;
2. reliable, reconciled provider earnings;
3. repeat customer use and discrete recurring occurrences;
4. positive contribution margin;
5. fulfillment and recovery without founder rescue;
6. processor portability;
7. auditable Operations control;
8. minimum complexity consistent with correctness.

Do not optimize for PR count, schema volume, abstraction, AI activity, signups without fulfillment, synthetic liquidity, or readiness percentages.

## 2. Truth planes and source use

There is no global precedence ladder across unlike claims. Keep these planes separate:

| Plane | Sources that control claims in that plane | Proves | Does not prove |
|---|---|---|---|
| Authority and permission | Executed agreements, written processor/legal/policy approvals, canonical Governor authority, repository and environment controls | What an identified actor may do to an identified root within an expiry and effect boundary | That code exists, is deployed, or works |
| Target product and architecture | The Charter, subordinate underwriting target, approved policy, this contract, the ACTIVE Delivery OS, the backend mission, and the `/OPS` target specification | What HustleXP intends to build and the invariants it must satisfy | Current implementation, deployment, provider approval, or outcomes |
| Implementation | Exact commit/tree source, migrations, manifests, tests, build configuration, and static call graphs | What the identified source revision implements and what its tests actually cover | Deployment, production configuration, provider behavior, authority, or business outcomes |
| Runtime, provider, and outcomes | Trusted deployment identity, database ledgers, provider receipts, reconciliations, bank arrival, incident records, and canonical outcome metrics | What was observed at a stated target and time | Permission outside the approved boundary or target correctness by itself |

Resolve conflicts inside a plane using the freshest exact primary source and retain contradictions across planes as explicit blockers. Authority never rewrites implementation fact; code never grants authority; deployment never proves processor reconciliation or business outcome.

Target-plane sources for this mission are:

- the `HustleXP Business and Universal V1 Charter v1.1.0` at signed commit `0b80c71e118d7cab70474bbbf6df778811fe4fe8`, which is the sole business authority. This engineering contract and every subordinate source must conform to it;
- the ACTIVE `HustleXP Codex End-to-End Delivery OS v1.0.0`, doctrine SHA-256 `5D4045B3C7A1CD3EC05CA133FA6F6699182EF58AF7EF202D596E63AAABA195A4`, paired with authority-manifest SHA-256 `C22082CB4B95E2139E317C8D4A806B0ADBE00F5BD9A8F41C561765F06F1793B7`. It controls the current Gates 0–10 execution and certification method, not business policy, processor selection, release approval, or production authority;
- the subordinate `HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3.3`, the latest primary underwriting source actually read in this workspace. The one-tab Google Doc was read at exact provider revision `AIroW37_64ZTORJE2_jnezyXuxDCYyPrZP0UJPXgvzxloOXEM47evoZQhE4swHX1QJFEacb8Xm8-FBDMcVLrX1frAMEmDeu7Lmkao57ZJw`, provider-modified `2026-08-27T04:51:56.612Z`; its confidential contents are not mirrored here. It is a request for written external decisions, not evidence that any decision was approved: every processor selection, capability, commercial, onboarding, certification, pilot, and production decision remains unresolved. It grants no payment, business, release, deployment, or processor authority; production effects remain `NONE` and production money remains `FROZEN`. Its maintained non-authorizing lifecycle constraints are: a Task Opportunity permits `EXPRESS_INTEREST` only; interest creates no reservation, assignment, earnings, private-data, eligibility, or money authority; Provider Account approval remains separate from HustleXP task eligibility; merchant context and a successful Financial Security Event must precede a Work Order; authorization, capture, settlement, funding, payout, and reconciliation remain distinct; a provider command record precedes any provider effect; authenticated webhooks enter an idempotent append-only inbox; reconciliation compares canonical ledger facts to provider observations; and Marketplace, Provider OS, and Bring Your Own Provider share one lifecycle. Its engineering-current-state statements are source-dated applicant assertions, not repository readback. Earlier local notes referred to a restricted v3.4 source, but its exact primary bytes and revision have not been supplied or read; any supersession claim remains `READBACK_REQUIRED`. The machine-bound v7 rejection and v3.1 source artifacts remain immutable historical evidence and are not rewritten by this reference;
- the byte-preserved [Backend PR Audit, Architecture Convergence, and Processor-Readiness Mission](source-contracts/HUSTLEXP_BACKEND_PR_AUDIT_AND_CONVERGENCE_MISSION.md), SHA-256 `437df53578b045f0b6ee55f99d1a302c2aee68fb288ad10c1083e0e411e25469`;
- the byte-preserved [`/OPS` Internal Operations Control Plane Specification](source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md), SHA-256 `65aa1868547e73dae157393572e4fbf68113990b4b71d241c6a7512a9d47af96`;
- this stable contract and the source-dated [Payment and `/OPS` Convergence Record](architecture/HUSTLEXP_PAYMENT_OPS_CONVERGENCE_RECORD.md).

## 3. Truth labels

Use one label for every material claim:

| Label | Meaning |
|---|---|
| `VERIFIED_CURRENT` | Directly observed in the exact identified source, API, database, provider view, or runtime. |
| `REPORTED_CURRENT` | Supplied by an operator or document but not independently reproduced. |
| `PROPOSED_TARGET` | Required future design; not represented as built. |
| `OPEN_DECISION` | External or internal policy decision is unresolved. |
| `BLOCKED` | A named dependency, authority, or proof is missing. |
| `LEGACY` | Existing historical behavior retained only for evidence or bounded recovery. |
| `DEPRECATED` | Must receive no new authority and is awaiting verified removal. |
| `ACCEPTED` | A named independent Reviewer accepted an exact immutable candidate for a stated review boundary. |
| `CERTIFIED` | A distinct named Certifier reproduced the accepted exact signed candidate in a clean environment and accepted the certification boundary. |
| `UNKNOWN` | Evidence is absent, stale, ambiguous, or too weak. |

Never use `ready`, `healthy`, `secure`, `live`, `approved`, or `complete` without the exact boundary and evidence level.

## 4. Canonical ownership

### 4.1 Railway/PostgreSQL engine

The backend owns canonical:

- transaction identity;
- Task Draft, scope, quote, opportunity, eligibility, hold, Work Order, assignment, fulfillment, and recurrence state;
- Financial Security Event, operation, capture, settlement, funding, payout, refund, dispute, ledger, and reconciliation facts;
- exact-address authorization;
- immutable audit and command results;
- deterministic state transitions, database invariants, inbox/outbox, workers, and recovery.

The only production database target currently recognized as canonical is Railway PostgreSQL. The runtime uses the standard PostgreSQL driver; it must not depend on Supabase- or Neon-specific semantics.

### 4.2 Site and Supabase overlay

The site is an API consumer. Supabase may own only approved acquisition, attribution, consent, communications, recovery coordination, analytics, and read-model overlay data while cutover remains incomplete.

Supabase and browser code must not create a second canonical task, quote, assignment, proof, completion, payment, settlement, payout, or recurrence lifecycle. An overlay row may retain an idempotent `engine_task_id` pointer.

### 4.3 `/OPS`

`/OPS` is a governed internal control plane, not a database editor or processor-shaped dashboard. It consumes versioned read models and submits typed commands through named, short-lived authenticated sessions.

No browser-held shared admin key, caller-supplied actor identity, arbitrary status string, direct canonical SQL write, generic “mark paid,” or processor API call is permitted.

### 4.4 AI

AI may interpret, classify, summarize, rank, detect, recommend, and draft. Typed deterministic services plus approved humans authorize money, assignment, identity, private-data release, safety, policy, and closure.

## 5. One lifecycle, three origins

Every transaction has one immutable `relationshipOrigin`:

- `MARKETPLACE`
- `PROVIDER_OS`
- `BRING_YOUR_OWN_PROVIDER`

Origin may alter sourcing, disclosed fees, merchant presentation, support promises, and analytics. It cannot create a parallel financial or fulfillment lifecycle.

A recurring template or series is not a transaction. Every occurrence receives its own canonical transaction root, Work Order, Financial Security Event, capture, funding, and reconciliation evidence.

## 6. Orthogonal state domains

Do not use one task status or one payment status as aggregate truth. The target has independently versioned domains for:

1. commercial/request;
2. provider processor eligibility;
3. HustleXP task/category/credential eligibility;
4. sourcing and assignment;
5. financial security;
6. fulfillment;
7. capture;
8. processor settlement;
9. platform funding;
10. provider payout;
11. reconciliation;
12. incident and dispute;
13. Operations exception;
14. retention.

Refunds, reversals, returns, recoveries, and chargebacks are immutable operation, allocation, and exposure facts. They do not overwrite historical capture, settlement, funding, or payout truth.

## 7. Hard invariants

1. No durable Task Draft means no opportunity or claim link.
2. Expressing interest creates no reservation, assignment, earnings, or private-data authority.
3. Processor payment eligibility and HustleXP task eligibility are separate and both required.
4. No approved final scope, schedule, economics, provider acceptance, merchant context, category, geography, credential, and limit means no Financial Security Event.
5. No successful, unexpired, reconciled Financial Security Event means no Canonical Work Order, hard assignment, or exact-address release.
6. A payment-method reference is not financial security.
7. Financial security is not capture.
8. Capture is not settlement.
9. Settlement is not platform funding or provider payout.
10. Funding or payout is not reconciliation.
11. No approved completion evidence, final amount, incident gate, cancellation state, and customer notice or timeout means no capture.
12. No processor/ledger agreement means no closure.
13. Every external money or obligation call has one durable operation claim and deterministic idempotency key committed before provider I/O.
14. Provider I/O occurs outside the database transaction; exact version/claim witnesses govern finalization.
15. Duplicate, replayed, stale, or out-of-order events cannot duplicate money or regress state.
16. Ambiguous provider outcomes become `RECONCILIATION_REQUIRED`, never guessed success.
17. Historical Stripe records remain labeled `STRIPE`; they are not relabeled as a future processor.
18. Every unresolved processor-dependent capability fails closed.
19. A release candidate is unacceptable unless new production customer-money creation is structurally impossible before every external release gate passes.

## 8. Command and authority contract

Every consequential write uses a strict command envelope containing at least:

```text
commandId
actionKey
entityType
entityId
expectedVersion
actorId (server-derived)
requestedAt
reasonCode
policyVersionId
capabilitySnapshotId
approvalId where required
idempotencyKey
correlationId
causationId
payload
```

Requirements:

- named short-lived session;
- server-side RBAC and resource authorization;
- strict command and reason-code registries;
- recent MFA/step-up for money, identity, address, safety, and governance actions;
- two distinct humans for production payment enablement, emergency-stop release, ledger adjustment, unexplained reconciliation exception, merchant-context change, and blocked-category activation;
- immutable accepted and rejected command results;
- expected-version conflict rather than last-write-wins;
- exact replay returns the original result; same idempotency key with payload drift conflicts.

### 8.1 Named `/OPS` roles and explicit denials

Capabilities are closed and additive; a title never implies an unlisted action. The complete target is frozen in the [`/OPS` source contract](source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md#4-roles-permissions-and-separation-of-duties).

| Role | Primary authority | Explicit denial |
|---|---|---|
| Executive / Product and Policy Lead | Category, commercial, exception, and operating policy | Cannot self-certify payment code or processor configuration |
| Marketplace Operator | Scope, sourcing, scheduling, provider communication, and non-money recovery | Cannot capture, refund, change merchant context, or enable capabilities |
| Support and Risk Operator | Incidents, disputes, evidence, remediation, and restrictions | Cannot alter ledger records or silently close incidents |
| Payment Operations | FSE, capture, settlement, refund, payout-exception, and reconciliation review | Cannot change fulfillment evidence or provider eligibility outside governed workflow |
| Lead Engineer | Adapter, state-machine, webhook, idempotency, and reconciliation implementation | Cannot approve own production release |
| Independent Reviewer / Release Gate | Review exact money code, certification evidence, and production configuration | Cannot modify evidence under review |
| Auditor / Underwriter | Read-only access to approved evidence and reports | No operational actions |
| System Automation | Execute policy-approved deterministic commands | Cannot exceed named capability, action class, or policy authority |
| AI Operator | Recommend, summarize, classify, draft, and detect | No independent money, assignment, private-data, or policy authority |

Production payment enablement, emergency-stop release, manual ledger adjustment, unexplained reconciliation exception, merchant-context change, blocked-category activation, and processor-restriction override require two distinct human identities plus the policy-specific step-up and authority record.

## 9. Current-state boundary

Current implementation, repository, provider, migration, and evidence status is maintained in the separately refreshable [Current Backend Checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md). Every checkpoint claim is source-dated and exact-identity bound.

A stale or contradicted checkpoint blocks current-state, release, migration, provider, and production claims. It does not silently rewrite this stable target contract. No checkpoint row authorizes an external effect.

## 10. Execution order

Gates 0–10 are the complete ACTIVE V1A boundary and run in dependency order. A gate is an evidence boundary, not a readiness percentage. Gates 11–12 are recorded only to prevent scope leakage and are not authorized work in this mission.

### Gate 0 — establish exact implementation truth

Refresh the exact repository, remote, branch, SHA, signature, dirty state, ruleset, bypass actor, required check, production deployment trigger, deployed revision, runtime provenance, capability policy, payment freeze, database and migration state, competing lifecycle or money writer, staging resource, credential state, and unresolved decision. Treat prior reports, branches, PRs, receipts, and SHAs as evidence to verify, never timeless authority.

Exit: one exact baseline and evidence-backed current-state, system, payment-path, privileged-access, route, test, deployment, and gap inventories; production money creation is proved disabled or recorded as P0; every material target is classified without inventing current truth.

### Gate 1 — build the canonical domain kernel and contain competing authority

Establish one immutable transaction root and lifecycle, `relationship_origin`, typed command envelopes, expected versions, idempotency, correlation and causation, immutable audit, Ops Cases, ledger and reconciliation primitives, append-only webhook inboxes, kill switches, and the provider-neutral fake-adapter contract. Retire, port, or structurally deny competing lifecycle and positive-money writers. PostgreSQL retains final transition authority.

The owner has authorized Option A for isolated synthetic local, preview, and
staging implementation. Its status is
`AUTHORIZED_LOCAL_NONPROD_IMPLEMENTATION_PENDING /
RELEASE_BLOCKED_PENDING_IMPLEMENTATION_AND_INDEPENDENT_REVIEW` under
`backend/database/work-order-command-authority.HOLD.json` and the
[actor-attestation decision packet](architecture/HUSTLEXP_V1A_ACTOR_ATTESTATION_DECISION_PACKET.md).
The fixed direction uses seven pairwise-distinct migration, API, worker,
attester, command-owner, assertion-owner, and finance-owner roles; the three
owners are unprivileged `NOLOGIN`. The isolated attester issues random 256-bit
one-time tokens, persists only their SHA-256 digests, and uses a database-owned
maximum lifetime of 60 seconds. This owner decision is not implementation,
provisioning, live readback, independent security review, or release approval.
Continue independent lanes, but do not certify the dependent Work Order,
assignment, or address-release boundary until sealed commands, alternate-writer
disposition, direct-DML revocation, exact authorization tests, and independent
review all pass on the exact candidate.

Exit: illegal or stale transitions fail closed at the server/database boundary, repeated commands cannot duplicate an effect, every consequential command emits immutable evidence, no generic status mutation route remains, and no callable production positive-money path exists.

### Gate 2 — prove one public API-and-worker fake-adapter walking skeleton

Use one bounded general-service scenario and one pre-seeded fake eligible provider to drive the public API and worker—not direct SQL fixtures—through:

```text
Task Draft
→ scope and exact quote
→ customer approval and fake token readiness
→ redacted opportunity and provider interest
→ separate provider-account and HustleXP eligibility
→ expiring conditional hold
→ durable fake Financial Security Event
→ atomic Work Order materialization
→ synthetic nonproduction assignment and address grant
→ fulfillment and evidence
→ completion review
→ fake capture, settlement, funding, payout, and reconciliation
→ guarded closure
```

Exit: customer, provider, and `/OPS` read models show the same authoritative state; failure before or after fake financial security creates neither an unauthorized Work Order nor private-data release; capture and settlement remain distinct; PostgreSQL fresh-install, upgrade, replay, race, timeout, failure, and recovery tests pass on the exact lineage; production effects are `NONE`. The Work Order HOLD in Gate 1 must be closed before this gate can be certified, even when a contained synthetic test journey passes.

### Gate 3 — complete demand intake

Complete broad legitimate-work acquisition, service-cell and category capability rendering, emergency and prohibited-work triage, privacy-safe Task Drafts, category-specific scope collection, media and secure access notes, route preview, Request ID, customer Request detail, `/OPS` read visibility, and source-to-draft analytics.

Exit: unsupported work receives one truthful routing outcome rather than a false booking, emergencies stop the ordinary flow, exact addresses never reach preassignment provider payloads, and public actions derive from server-returned capability state.

### Gate 4 — complete supply acquisition and provider eligibility

Complete general-provider and `VERIFIED_TRADE_BUSINESS` onboarding, separate identity, provider-account, funding, category, credential, geography, availability, trust, and restriction states, signed expiring Task Opportunities, redacted opportunity cards, Express Interest, onboarding continuation, expiry/task-filled behavior, conditional holds, and named crews.

Exit: no opportunity exists without a durable open Task Draft; interest and onboarding create no assignment, payable, customer authorization, or private-data access; provider-account eligibility and HustleXP task eligibility remain separate.

### Gate 5 — complete scope, quote, estimate, and verified-trade workflows

Complete immutable scope, quote, and provider-authored estimate versions, diagnostics, customer approval, provider economics acceptance, issuing-authority and jurisdictional credential evidence, specialty and crew checks, regulated-scope controls, change orders, truthful direct-provider-payment fallback records, and routing of unsupported high-ticket or milestone work away from Universal V1 checkout.

Exit: one exact immutable version governs consent; expired quotes, wrong specialties, expired credentials, unapproved crews, and unsupported work fail closed; HustleXP or AI never invents a regulated provider's scope or price.

### Gate 6 — harden every fake-financial and assignment branch

Exercise deterministic fake success, decline, timeout, duplicate and out-of-order webhook, retry, unknown outcome, expiry, replacement, token-portability and reauthorization branches, amount changes, void, capture, partial refund, reversal, dispute, delayed settlement, funding return, provider-account failure or restriction, kill switch, mismatch, reconciliation recovery, and durable leased-command recovery. Maintain a balanced double-entry ledger.

Exit: no durable operation claim means no provider call; unknown outcomes lock unsafe retries and open an Ops Case; provider-bound financial events cannot silently transfer; incomplete evidence or unresolved incidents block capture; reconciliation disagreement blocks closure.

### Gate 7 — complete fulfillment, recovery, and evidence

Complete typed en-route, arrival, start-work, blocked-access, change-order, completion, cancellation, replacement, incident, refund/dispute, restriction, remediation, and notification flows. Bind category evidence and media to the exact root and Work Order.

Exit: work cannot start before valid synthetic assignment, additional scope pauses for approval, evidence cannot cross roots, cancellation consequences appear before confirmation, unperformed work is never silently captured, and recovery never fabricates financial success.

### Gate 8 — converge Provider OS, BYOP, and recurring work

Complete provider-originated customers, versioned estimates and Work Orders, BYOP invitations, the same eligibility and fake-financial-security gates, recurring templates with discrete occurrence generation, provider finance views, and relationship-origin fee/disclosure policy. Universal V1 contains no Provider OS subscription billing surface.

Exit: every occurrence owns its own root, Work Order, Financial Security Event, evidence, capture, payout, and reconciliation; BYOP cannot bypass eligibility; every origin reuses the same transaction engine; no annual prepayment, indefinite authorization, or subscription billing exists.

### Gate 9 — replace admin behavior with governed `/OPS`

Build the read-only canonical control tower, Work Queue and Ops Cases, typed non-money commands, approval interface, fake-adapter financial commands, reconciliation, and certification surfaces. Use named short-lived operator sessions, scoped RBAC, MFA/step-up, expected versions, immutable results, and two-person approval where required.

Exit: no shared browser admin credential, direct lifecycle-table editing, or arbitrary status control remains; every exception has an owner, deadline, next lawful action, and resolution condition; AI recommendations never count as approval.

### Gate 10 — certify Universal V1A

Certify one immutable signed V1A release-manifest digest that binds backend/API, worker, web, migrations/database, policy, fixtures, and nonproduction infrastructure identities. Reproduce the complete stack from clean clones; pass the full local and hosted matrix with zero failure, skip, todo, quarantine, false-green retry, unexplained reconciliation mismatch, release-scope P0/P1, or `UNKNOWN`; complete independent review, last-push approval, resolved conversations, protected linear merges, and zero bypass; promote the exact manifest only to isolated synthetic staging and read its identity back from every component.

Exit: one transaction root and lifecycle, PostgreSQL-owned transitions, typed versioned audited commands, fake-adapter contract, ledger, webhook replay, reconciliation, capability gating, kill switches, and authoritative customer, provider, and `/OPS` experiences are proved on the exact manifest. Production deployment, production database change, live communication, real money, and real hard assignment remain excluded and frozen.

### Gate 11 — live-processor V1B adapter (`EXCLUDED / LATER GOAL`)

Gate 11 may begin only after written processor, topology, merchant, tokenization, Financial Security Event, economics, replacement, amount-change, refund/dispute, limit/reserve, category, restriction, termination, and reconciliation decisions are imported as versioned authority. It must run the same scenario identifiers against a separately certified sandbox adapter without changing core lifecycle semantics.

This document authorizes no Gate 11 implementation or activation.

### Gate 12 — controlled production pilot (`EXCLUDED / LATER GOAL`)

A pilot may consider only the explicitly approved capability intersection across environment, geography, category, provider type and identity, trust tier, ticket range, relationship origin, processor program, and financial capability. There is no global `paymentsEnabled = true`.

This document authorizes no Gate 12 pilot, production deployment, customer-money effect, banking effect, or hard assignment.

## 11. Documentation contract

Every maintained documentation surface must have one status declared in its header or the repository documentation status register:

- `DRAFT_REVIEW_INPUT`
- `PUBLICATION_CANDIDATE_TEAM_TARGET`
- `LOCAL_WORKSPACE_INDEX`
- `ARCHITECTURE_RECORD_BRANCH`
- `CURRENT_DOCUMENTATION_LINE`
- `CURRENT_TEAM_TARGET`
- `CURRENT_TEAM_TARGET_POINTER`
- `CURRENT_IMPLEMENTATION_REFERENCE`
- `CURRENT_IMPLEMENTATION_INVENTORY`
- `CURRENT_WORKFLOW_AUTHORITY`
- `CURRENT_REVIEW_POLICY`
- `CURRENT_RUNBOOK`
- `CURRENT_RUNBOOK_TEMPLATE`
- `HISTORICAL_IMPLEMENTATION_SNAPSHOT`
- `HISTORICAL_EVIDENCE`
- `LEGACY_NON_EXECUTABLE`
- `FROZEN_EVIDENCE`
- `PROPOSED_NOT_BUILT`

Rules:

1. The first token on a `Status:` line is the primary status and must appear in the closed list above or the repository status register. Zero or more slash-separated qualifiers may follow; each qualifier must match `[A-Z][A-Z0-9_-]*`, may only narrow or date the primary status, and cannot grant authority.
2. A document's header and its registry entry must use the same primary status. Qualifiers may be omitted from a compact registry entry only when the registry does not contradict them.
3. The copy on the repository's accepted default branch is the team target only after an independent Reviewer accepts the exact commit. A branch or working-copy modification remains review input until merged; it never changes adopted policy by itself.
4. Current documents link here rather than restating the mission inconsistently.
5. Historical evidence remains byte-preserved except for a clearly delimited supersession banner where the artifact is not content-addressed.
6. Content-addressed evidence packages are immutable and receive no edits.
7. A current runbook may contain only currently authorized actions and must state required authority.
8. A target document never claims deployment or provider approval.
9. Test counts, dependency versions, production identities, provider states, and readiness claims must be recomputed or labeled source-dated.
10. No document may instruct payment enablement, processor use, database migration, deployment, or provider mutation solely through configuration.

## 12. Team operating contract

- One write-capable owner per repository concern.
- Builder, Reviewer, and Certifier are three distinct identities for the same candidate. The Reviewer does not edit the candidate under review; the Certifier reproduces the accepted exact signed candidate from a clean environment.
- Every change identifies exact base, head, dirty state, risk class, authority, effects, tests, rollback/forward-repair, and unresolved gates.
- Tests prove only their asserted surface.
- Real PostgreSQL is required for migration and database-invariant claims.
- Provider sandbox receipts are required for provider-mechanics claims.
- Production effects require fresh root-specific authority; broad objectives and prior consent do not carry forward.
- A reviewer rejection triggers bounded repair; it is not reworded into acceptance.
- No accepted evidence package is rebuilt without a measured defect.

## 13. Objective definition of done

The Universal V1A Gates 0–10 convergence mission is complete only when all are proven on one immutable signed release-manifest digest:

- Gate 0 evidence identifies the exact repositories, SHAs, signatures, dirty states, rulesets, bypass state, required checks, deployment triggers, runtime provenance, capability policy, payment freeze, database and migrations, competing writers, staging resources, credential state, and unresolved decisions;
- every relevant PR has an evidence-backed final disposition;
- the capture-before-task path and every other unauthorized positive-money path are unreachable;
- all acquisition origins converge on one lifecycle and each recurring occurrence has its own root;
- Task Draft, Financial Security Event, Work Order, capture, settlement, funding, payout, and reconciliation remain distinct;
- provider processor eligibility and HustleXP task eligibility remain distinct;
- Express Interest cannot assign or reveal private data;
- hard assignment and exact-address release require a successful, unexpired, reconciled Financial Security Event;
- every money/obligation action is typed, claimed before provider I/O, idempotent, audited, recoverable, and reconciled;
- browser and Supabase hold no canonical mutation authority or shared human credential;
- `/OPS` uses named MFA sessions, RBAC, step-up, dual approval where required, expected versions, immutable results, and exception ownership;
- processor-dependent capabilities fail closed while decisions are unresolved;
- fake-adapter Section 16 certification, webhooks, retries, races, reconciliation, and kill switches pass on one exact candidate;
- the Work Order command-authority HOLD is resolved through approved authenticated actor propagation, least-privilege roles, sealed command functions, direct-DML revocation, and authorization evidence rather than an invented decision;
- TypeScript, zero-warning lint, every test suite, migration and clean-database checks, security audit, dependency review, CodeQL, Build Validation, privacy, authorization, concurrency, recovery, accessibility, API, worker, web, and end-to-end checks pass with zero failure, skip, todo, quarantine, or false-green exception;
- clean clones reproduce PostgreSQL, Redis, API, worker, web, synthetic storage and communications sinks, fixtures, and fake providers without global tooling, `.local-tools`, or production credentials;
- the exact signed manifest is protected-merged with zero bypass, independent human and last-push approval, resolved conversations, and every required hosted context green on the exact SHAs;
- the same exact manifest is promoted only to isolated synthetic staging and every component reads back its bound identity;
- repository ownership and Enterprise controls enforce the accepted release policy without bypass;
- no P0/P1 remains unowned or hidden by a readiness score;
- production effects remain `NONE`; production money creation and real hard assignment remain `FROZEN`;
- live-processor Gate 11 and controlled-pilot Gate 12 remain excluded and production remains blocked until their separate external underwriting, legal, commercial, KYC/KYB, configuration, certification, reconciliation, incident, termination, and independent release gates pass.

The final V1A standard is one canonical business model, one governed transaction lifecycle, no hidden payment path, no unsupported authority, no unproven readiness claim, and a fake-provider boundary that a later approved processor adapter can implement without rewriting the core backend. A branch, PR, backend, green local suite, merge, local demo, or staging deployment alone is not completion.

## 14. Current execution

The source-dated next action, active-node acceptance contract, migration lock, PR disposition, unresolved evidence targets, and operative-control alignment status live in the [Current Backend Checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md). A stale checkpoint blocks execution that depends on it; it does not defer publication or adoption of this stable mission contract. Publication of this contract does not by itself align `AGENTS.md`, `CLAUDE.md`, or `.greptile/rules.md`; full team alignment requires a separately authorized, independently accepted exact control candidate.

The current goal covers V1A Gates 0–10 only. Gate 11 live-processor work and Gate 12 controlled-pilot work require separate later goals and authority. The checked-in Work Order command-authority design is owner-authorized for local/nonproduction implementation only and remains release-blocking until implementation, genuine role/ACL readback, exact authorization evidence, and independent human review succeed. Production remains `NO-GO`; production effects are `NONE`, production money remains `FROZEN`, and real hard assignment remains `FROZEN`.
