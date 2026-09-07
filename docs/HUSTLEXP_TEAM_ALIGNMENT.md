> **Canonical authority pointer:** `docs/canonical/HUSTLEXP_CANONICAL_AUTHORITY.md` and [HustleXP Canonical Document Index v1.0](https://docs.google.com/document/d/1QTrT40LK5zo-DN6ER7naM3p43WlyxkBxKsjL23p20mY/edit).
> **Production effect:** NONE. Current implementation, deployment, payment, provider, and outcome claims require source-dated exact evidence.

# HustleXP Team Goal and Execution Contract

Status: `CURRENT_TEAM_TARGET / NOT_PRODUCTION_AUTHORITY`

Publication resolution: `EXACT_COMMIT_AND_INDEPENDENT_ACCEPTANCE_REQUIRED`

Last target-document authority refresh: `2026-09-04 UTC`

Decision: `RESHAPE`

Production launch: `NO-GO`

Production effects authorized by this document: `NONE`

This is the stable human-readable engineering target for the active HustleXP backend convergence mission. It defines the mission, ownership boundaries, target invariants, execution order, and objective definition of done. The repository copy becomes team-operative only at an exact commit accepted by an independent Reviewer; mutable working-copy text receives no adoption credit. Current implementation and external-state claims live in the separately refreshable [Current Backend Checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md), so a changed PR or runtime identity can stale the checkpoint without invalidating this target contract. This document does not approve a processor, migration, merge, deployment, legal position, category, provider cohort, market cell, or money movement.

## 1. Mission

Build the smallest maintainable system that can safely execute the complete local-work transaction loop:

```text
qualified demand
→ durable Task Draft
→ approved scope and commercial terms
→ payment-method reference ready
→ processor eligibility and HustleXP task eligibility
→ expiring Conditional Provider Hold
→ approved Financial Security Event
→ Canonical Work Order and hard assignment
→ controlled private-detail release
→ verified fulfillment
→ capture
→ processor settlement
→ platform funding and provider payout
→ reconciliation
→ closure
→ repeat or a new recurring occurrence
```

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
| Target product and architecture | Underwriting target, approved policy, this contract, the backend mission, and the `/OPS` target specification | What HustleXP intends to build and the invariants it must satisfy | Current implementation, deployment, provider approval, or outcomes |
| Implementation | Exact commit/tree source, migrations, manifests, tests, build configuration, and static call graphs | What the identified source revision implements and what its tests actually cover | Deployment, production configuration, provider behavior, authority, or business outcomes |
| Runtime, provider, and outcomes | Trusted deployment identity, database ledgers, provider receipts, reconciliations, bank arrival, incident records, and canonical outcome metrics | What was observed at a stated target and time | Permission outside the approved boundary or target correctness by itself |

Resolve conflicts inside a plane using the freshest exact primary source and retain contradictions across planes as explicit blockers. Authority never rewrites implementation fact; code never grants authority; deployment never proves processor reconciliation or business outcome.

Target-plane sources for this mission are:

- [HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3.4](https://docs.google.com/document/d/1lbxM2D4vPX3NfzEPa6JvnvdS3EWzfL48aNY8piTBrYg/edit), current subordinate payment-design authority effective `2026-09-03`; record a fresh Docs revision and observed-at timestamp before any source-exact claim;
- the explicitly historical [Backend PR Audit, Architecture Convergence, and Processor-Readiness Mission](source-contracts/HUSTLEXP_BACKEND_PR_AUDIT_AND_CONVERGENCE_MISSION.md), retained only as source-dated evidence and not as current authority;
- the current proposed [`/OPS` Internal Operations Control Plane Specification v1.1](source-contracts/HUSTLEXP_OPS_CONTROL_PLANE_SPEC.md); bind any source-exact claim to the reviewed blob SHA rather than a mutable filename;
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
18. All 20 unresolved processor-dependent capabilities fail closed.
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

### Gate 0 — admissible truth

Keep Governor, repository identity, production state, migration ledgers, and evidence roots fresh and mutually consistent.

Exit: one exact baseline, one active code-changing node, one allowed migration path, and no unresolved persistent target relevant to that path.

### Gate 1 — containment and repository enforcement

Establish and then preserve structural payment-creation containment, negative/recovery lanes, strict required checks, no bypass, independent approval, and signed exact commits.

Exit: no callable positive production money path in the asserted cohort and no repository-control exception.

### Gate 2 — task-first fake-FSE vertical

Build one PostgreSQL-owned path:

```text
Task Draft
→ approved quote and fake token-readiness witness
→ redacted opportunity
→ separate processor and HustleXP eligibility snapshots
→ expiring conditional provider hold
→ durable fake CREATE_FSE operation
→ reconciled fake Financial Security Event
→ atomic Canonical Work Order + hard assignment
```

Failure after fake FSE must void or open reconciliation without creating a Work Order or releasing an address. The Gate 2 execution envelope authorizes production effects `NONE`.

Exit: fresh, upgrade, replay, race, timeout, failure, and recovery PostgreSQL tests pass against the exact selected migration lineage.

### Gate 3 — authority and `/OPS` convergence

Remove shared-key human authority, install named `opsProcedure`, closed capabilities, step-up, dual approval, strict commands, immutable results, and versioned read models. Route overlay automation through narrow service identities and engine commands.

Exit: browser and Supabase cannot mutate canonical lifecycle or money state directly.

### Gate 4 — processor-neutral lifecycle

Connect the processor-neutral operation boundary, webhook inbox, FSE aggregate, capture, settlement, funding, payout, ledger, dispute, and reconciliation owners using the fake adapter only.

Exit: every Section 16 simulated scenario is deterministic, replay-safe, and fully reconciled.

### Gate 5 — external processor and controlled pilot

Only after written decisions, commercial terms, onboarding, exact category/limit approval, sandbox certification, independent review, and production authority may a live adapter or pilot be considered.

Exit: exact source/build/deployment identity, provider receipts, bank arrival, daily reconciliation, incident/termination handling, kill switches, and rollback are independently certified.

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

The backend convergence mission is complete only when all are proven:

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
- repository ownership and Enterprise controls enforce the accepted release policy without bypass;
- no P0/P1 remains unowned or hidden by a readiness score;
- production remains blocked until all external underwriting, legal, commercial, KYC/KYB, configuration, certification, pilot, reconciliation, incident, termination, and independent release gates pass.

The final standard is one canonical business model, one governed transaction lifecycle, no hidden payment path, no unsupported authority, no unproven readiness claim, and no processor integration that requires rewriting the core backend.

## 14. Current execution

The source-dated next action, active-node acceptance contract, migration lock, PR disposition, unresolved evidence targets, and operative-control alignment status live in the [Current Backend Checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md). A stale checkpoint blocks execution that depends on it; it does not defer publication or adoption of this stable mission contract. Publication of this contract does not by itself align `AGENTS.md`, `CLAUDE.md`, or `.greptile/rules.md`; full team alignment requires a separately authorized, independently accepted exact control candidate.

Production remains `NO-GO` until every Gate 5 condition is independently certified and explicitly authorized.
