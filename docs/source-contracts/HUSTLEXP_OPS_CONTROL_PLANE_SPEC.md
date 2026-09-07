> **Canonical authority pointer:** `docs/canonical/HUSTLEXP_CANONICAL_AUTHORITY.md` and [HustleXP Canonical Document Index v1.0](https://docs.google.com/document/d/1QTrT40LK5zo-DN6ER7naM3p43WlyxkBxKsjL23p20mY/edit).
> **Production effect:** NONE. Current implementation, deployment, payment, provider, and outcome claims require source-dated exact evidence.

# HustleXP `/OPS` — Internal Operations Control Plane Specification

**Version:** 1.1
**Status:** CURRENT_TEAM_TARGET / PROPOSED_NOT_BUILT / NOT_PRODUCTION_AUTHORITY
**Primary audience:** Product, operations, engineering, risk, finance, support, independent reviewers, processor solutions architecture
**Product surface:** Internal HustleXP operator application at `/ops`
**Controlling business model:** Managed local-work transaction network with MARKETPLACE, PROVIDER_OS, and BRING_YOUR_OWN_PROVIDER origins; WorkLinks, Task Opportunities, recurring occurrences, general services, and regulated trades share one lifecycle
**Controlling payment design:** Processor-neutral architecture defined in the HustleXP Payment Infrastructure Pre-Integration Underwriting Package v3.4
**Production boundary:** Processor-specific mechanics remain disabled until written underwriting approval, commercial terms, configuration, sandbox certification, and independent release approval exist.

---

# 0. Executive Decision

## Verdict: RESHAPE

Do not build `/OPS` as:

* a collection of disconnected admin tables;
* a KPI dashboard;
* a direct database editor;
* a prettier processor dashboard;
* a generic CRM;
* an AI chatbot with permission to modify business state;
* a second marketplace lifecycle;
* a place where operators manually select arbitrary task or payment statuses.

Build `/OPS` as:

> **The governed internal control plane through which HustleXP observes, advances, blocks, repairs, reconciles, and proves every real-world service transaction.**

At every point in the lifecycle, an authorized operator must be able to answer:

1. What canonical object exists?
2. What is its exact state in each domain?
3. What evidence supports that state?
4. What blocks the next transition?
5. What action is currently permitted?
6. Who or what owns the next action, and by when?
7. What financial, privacy, safety, or compliance exposure exists?
8. What happened automatically, what happened manually, and why?
9. Has processor state been reconciled with HustleXP state?
10. What should happen next to complete or retain the transaction?

## Objective

Create one internal operating surface that supports the complete HustleXP loop:

> **Qualified demand → structured Task Draft → approved commercial scope → eligible provider → conditional provider hold → Financial Security Event → Canonical Work Order → controlled assignment → verified fulfillment → capture → settlement/funding → reconciliation → repeat usage**

## Dominant Constraint

The dominant constraint is **state and authority fragmentation**, not the lack of dashboard components.

HustleXP cannot safely scale if task state, provider state, payment state, processor state, fulfillment state, and operator intent are spread across separate interfaces without one canonical control model.

## Primary Success Standard

An authorized operator must be able to process or supervise one transaction from request through reconciliation without:

* manually editing database rows;
* opening a processor dashboard to determine basic truth;
* relying on founder memory;
* using private spreadsheets;
* creating a parallel task object;
* describing tokenization, authorization, capture, settlement, and payout as one generic “payment” state;
* exposing an address or customer details prematurely;
* moving money through an untyped action;
* closing a task with an unresolved ledger or processor mismatch.

---

# 1. Specification Authority and Truth Boundaries

## 1.1 Precedence

Where sources conflict, `/OPS` must follow this precedence:

1. Executed processor agreement and written program approval.
2. Processor underwriting, risk, compliance, and solutions-architecture redlines.
3. Approved HustleXP legal, category, risk, privacy, and payment policies.
4. Canonical HustleXP state machine and hard invariants.
5. This `/OPS` specification.
6. UI copy, analytics definitions, and operator convenience.

The interface must never silently interpret an unresolved underwriting issue as approved production behavior.

## 1.2 Truth classifications

Configuration, policy, and underwriting records must retain one of the following evidence classifications:

| Classification              | Meaning                                               | `/OPS` treatment                                              |
| --------------------------- | ----------------------------------------------------- | ------------------------------------------------------------- |
| `APPLICANT_SUPPLIED`        | Supplied by HUSTLR LLC                                | Display with source and verification requirement              |
| `CANDIDATE_CONFIRMED`       | Confirmed in candidate processor correspondence       | Usable only when contract and production configuration agree  |
| `OFFICIAL_PROCESSOR_DOC`    | Derived from current official processor documentation | Mechanically informative but not necessarily program-approved |
| `ENGINEERING_CURRENT_STATE` | Observed or reported implementation behavior          | Historical/current-state evidence, not automatic target truth |
| `PROPOSED_CONTROL`          | HustleXP target policy or architecture                | Cannot be represented as live until implemented and tested    |
| `OPEN_DECISION`             | Underwriting, legal, commercial, or program decision  | Related capability fails closed                               |

Every governance record must include:

* `source_type`;
* `source_reference`;
* `effective_at`;
* `observed_at`;
* `verified_at`;
* `verified_by`;
* `supersedes_id`;
* `status`;
* `notes`.

## 1.3 Operational data truth labels

Every metric or derived status shown in `/OPS` must be tagged as one of:

* **Actual:** Recorded from canonical operational events.
* **Processor-observed:** Received from signed webhook, processor API, or official report.
* **Reconciled:** Internal and processor records agree.
* **Derived:** Computed from actual records using a documented rule.
* **Estimate:** Operational estimate not yet financially final.
* **Planning assumption:** Forecast or underwriting planning case.
* **Unknown:** Required evidence is absent or stale.

Forecasts must never appear as achieved performance.

---

# 2. Non-Negotiable Product Principles

## 2.1 One lifecycle

Marketplace-originated work, externally sourced work, Bring Your Own Provider work, Provider OS work, and recurring occurrences must converge into the same canonical lifecycle.

Different origins may change:

* sourcing behavior;
* fee policy;
* disclosures;
* support promises;
* merchant context;
* attribution.

They must not create parallel task, payment, fulfillment, or reconciliation systems.

## 2.2 Orthogonal state domains

A single generic `task_status` is insufficient.

`/OPS` must separately represent:

* commercial/request state;
* provider eligibility state;
* sourcing/assignment state;
* financial-security state;
* fulfillment state;
* capture state;
* settlement/funding state;
* reconciliation state;
* incident/dispute state;
* retention state.

The overall lifecycle state is derived from those domains. Operators cannot edit the derived state directly.

## 2.3 Fail closed

When a required decision, capability, credential, processor state, approval, or evidence item is missing:

* the action is unavailable;
* the UI states the exact block reason;
* the system creates or updates an owned Ops Case;
* no hidden fallback bypasses the gate.

## 2.4 Typed commands only

No interface may offer:

* “Mark paid”;
* “Force completed”;
* “Set status”;
* “Assign anyway”;
* “Release funds”;
* “Override risk”;
* “Reveal address” without a governed command.

Every state change must be caused by a named command with:

* defined preconditions;
* defined authority;
* idempotency behavior;
* expected postconditions;
* audit evidence;
* recovery behavior.

## 2.5 Processor neutrality

HustleXP owns task and economic state.

The approved processor executes regulated payment movement.

Processor IDs are external references. Processor-specific terminology must be normalized through the payment adapter and must not become the primary business model.

## 2.6 No generic “payment” state

The interface must explicitly distinguish:

1. Payment method tokenized.
2. Financial Security Event pending.
3. Financially secured.
4. Capture pending.
5. Captured.
6. Settling or batched.
7. Payout pending.
8. Funded or paid out.
9. Reconciled.
10. Subject to refund, return, dispute, or post-funding recovery.

## 2.7 AI interprets; typed systems authorize

AI may:

* classify intake;
* identify missing scope questions;
* summarize evidence;
* rank provider candidates;
* draft communications;
* detect anomalies;
* recommend next actions;
* prepare an incident or dispute evidence package.

AI may not independently:

* set final price;
* create a Financial Security Event;
* capture;
* refund;
* change merchant context;
* reassign a provider;
* reveal an exact address;
* override a restriction;
* close an unreconciled task;
* enable a production capability.

## 2.8 Evidence before closure

No transaction may enter `CLOSED` until:

* the work order outcome is known;
* financial events are known;
* the internal ledger and processor records agree;
* any refund, dispute, return, or incident state is represented;
* closure evidence is attached;
* the relationship is routed into retention or a documented non-repeat outcome.

## 2.9 Exception-driven operations

The system should autonomously advance deterministic, reversible happy-path work where approved.

Humans should work primarily from a prioritized exception queue.

Automation that merely hides unresolved work is prohibited.

## 2.10 No marketplace theater

`/OPS` must not optimize for:

* lead count without downstream conversion;
* provider registrations without payment eligibility;
* task-opportunity clicks without qualified interest;
* gross payment volume without contribution margin;
* tasks “completed” without evidence;
* provider earnings before funded or payable truth;
* AI activity volume;
* unqualified marketplace “liquidity.”

---

# 3. System Modes and Capability Registry

## 3.1 Global operating modes

The top of every `/OPS` page must show the current environment and program mode.

| Mode                | Meaning                                                    |
| ------------------- | ---------------------------------------------------------- |
| `DESIGN_ONLY`       | No processor-specific payment implementation is authorized |
| `SANDBOX`           | Test transactions only                                     |
| `CERTIFICATION`     | Formal sandbox evidence is being produced                  |
| `CONTROLLED_PILOT`  | Restricted live production cohort                          |
| `LIVE`              | Approved production capabilities enabled                   |
| `RESTRICTED`        | Processor, risk, legal, or operational restriction active  |
| `PAYMENTS_DISABLED` | No new payment operations permitted                        |
| `EMERGENCY_STOP`    | Platform-wide money and assignment controls disabled       |

Environment indicators must be visually unmistakable. Sandbox and production must never use the same visual treatment.

## 3.2 Capability registry

Capabilities must be data-driven, not scattered boolean flags.

Each capability record must include:

* capability key;
* environment;
* status;
* scope;
* processor program;
* approved categories;
* approved geographies;
* transaction limits;
* provider tiers;
* effective date;
* expiration or review date;
* controlling underwriting decision;
* controlling policy version;
* certification evidence;
* enabled by;
* enabled at;
* disabled reason.

Required capability examples:

* `individual_sole_prop_boarding`;
* `business_provider_boarding`;
* `marketplace_checkout`;
* `provider_os_checkout`;
* `byop_checkout`;
* `task_opportunity_onboarding`;
* `financial_security_event_create`;
* `hard_assignment`;
* `private_details_release`;
* `payment_capture`;
* `provider_replacement`;
* `credential_cross_context_reuse`;
* `change_order_processing`;
* `refund_automation`;
* `dispute_automation`;
* `recurring_occurrence_payments`;
* `high_ticket_processing`;
* `category_yard_basic`;
* `category_moving_hauling`;
* `category_cleaning`;
* `category_furniture_assembly`;
* `category_pressure_washing`;
* `category_errands`;
* `category_basic_technology`;
* `regulated_trade_processing`.

Every governed action must query the capability registry at execution time, not merely when the page loads.

---

# 4. Roles, Permissions, and Separation of Duties

## 4.1 Internal roles

| Role                                | Primary authority                                                                                   | Explicit restrictions                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Executive / Product and Policy Lead | Category policy, commercial policy, exception policy, operating targets                             | Cannot self-certify payment code or processor configuration                          |
| Marketplace Operator                | Scope coordination, sourcing, scheduling, provider communications, non-money task recovery          | Cannot capture, refund, modify merchant context, or enable capabilities              |
| Support and Risk Operator           | Incidents, disputes, evidence collection, customer/provider remediation, restrictions               | Cannot directly alter ledger records or silently close incidents                     |
| Payment Operations                  | Review Financial Security Events, captures, settlements, refunds, payout exceptions, reconciliation | Cannot change fulfillment evidence or provider eligibility without governed workflow |
| Lead Engineer                       | Adapter, state-machine, webhooks, idempotency, reconciliation implementation                        | Cannot approve own production release                                                |
| Independent Reviewer / Release Gate | Review money-moving code, certification evidence, production configuration                          | Cannot modify evidence being reviewed                                                |
| Auditor / Underwriter               | Read-only access to approved evidence and reports                                                   | No operational actions                                                               |
| System Automation                   | Execute policy-approved deterministic commands                                                      | Cannot exceed capability, action class, or policy authority                          |
| AI Operator                         | Recommend, summarize, classify, draft, detect                                                       | No independent money, assignment, private-data, or policy authority                  |

## 4.2 High-risk controls

The following require step-up authentication and a documented reason:

* manual Financial Security Event creation;
* manual capture;
* refund above the policy-defined threshold;
* provider replacement after financial security;
* exact-address break-glass access;
* provider restriction or termination;
* global kill-switch change;
* policy or capability enablement;
* reconciliation exception write-off;
* production release approval.

The following require two distinct human identities:

* enabling production payment capabilities;
* disabling the platform-wide emergency stop;
* approving a manual ledger adjustment;
* approving an unexplained reconciliation exception;
* changing the merchant-context mapping;
* enabling a category previously blocked by underwriting;
* overriding a processor restriction.

Thresholds must be versioned policy, not hard-coded into UI components.

---

# 5. Information Architecture

The existing concept of a flat set of unrelated tabs is rejected.

Use a grouped left-side navigation with contextual subnavigation.

## 5.1 Primary navigation

### CONTROL

1. **Command Center**
2. **Work Queue**
3. **Approvals**

### TRANSACTIONS

4. **Requests & Quotes**
5. **Work Orders**
6. **Task Opportunities**
7. **Recurring Occurrences**

### PARTICIPANTS

8. **Providers**
9. **Customers**
10. **Provider OS**

### MONEY

11. **Payments**
12. **Reconciliation**
13. **Refunds & Disputes**

### GOVERNANCE

14. **Incidents & Risk**
15. **Categories & Trust**
16. **Underwriting Decisions**
17. **Certification & Releases**
18. **Audit & Evidence**

### INTELLIGENCE

19. **AI Ops**
20. **Analytics**

## 5.2 Route structure

Recommended route model:

```text
/ops
/ops/queue
/ops/approvals
/ops/requests
/ops/requests/:requestId
/ops/work-orders
/ops/work-orders/:workOrderId
/ops/opportunities
/ops/opportunities/:opportunityId
/ops/providers
/ops/providers/:providerId
/ops/customers/:customerId
/ops/provider-os
/ops/recurring
/ops/payments
/ops/payments/:financialEventId
/ops/reconciliation
/ops/reconciliation/:runId
/ops/refunds-disputes
/ops/incidents/:incidentId
/ops/governance/categories
/ops/governance/underwriting
/ops/governance/certification
/ops/audit
/ops/ai
/ops/analytics
```

---

# 6. Global Application Shell

## 6.1 Truth ribbon

A persistent top ribbon must display:

* environment;
* processor program;
* program mode;
* new payment actions enabled/disabled;
* hard assignments enabled/disabled;
* exact-address release enabled/disabled;
* latest successful reconciliation;
* webhook health;
* open P0 incident count;
* approved monthly GPV capacity;
* current utilization;
* data freshness timestamp.

Example:

```text
PRODUCTION | PROGRAM: CANDIDATE-01 | PAYMENTS: PILOT
Assignments: Enabled | Capture: Enabled | Recurring: Disabled
Last reconciliation: 07:12 PT — Complete
GPV capacity: 41% of approved limit
P0 incidents: 0
```

Unknown or stale information must appear as unknown, not healthy.

## 6.2 Global search

Search must support:

* Request ID;
* Work Order ID;
* customer;
* provider;
* processor transaction reference;
* Financial Security Event ID;
* capture ID;
* payout or funding ID;
* refund;
* dispute;
* incident;
* opportunity link;
* external source attribution;
* idempotency key.

Sensitive fields must not be searchable unless the role is authorized.

## 6.3 Global action controls

Persistent controls:

* create manual request;
* create Ops Case;
* open incident;
* view approvals;
* invoke emergency controls.

Emergency controls must be visually separated from routine actions and require step-up authentication.

## 6.4 Data freshness

Every page must show:

* last event time;
* last internal read-model update;
* last processor synchronization;
* whether the page is live, delayed, or stale.

A cached processor snapshot may not be presented as current without a timestamp.

---

# 7. Command Center

## 7.1 Purpose

The Command Center answers:

> **What threatens a safely completed paid task right now?**

It must not lead with total users, page views, or raw leads.

## 7.2 Desktop layout

```text
┌──────────────────────────────── Truth Ribbon ────────────────────────────────┐
│ Environment | Program | Capabilities | Reconciliation | Kill Switches       │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────────── Needs Action Now ────────────────────────────────────────┐
│ P0/P1 cases, owner, age, amount/exposure, next lawful action, SLA            │
└───────────────────────────────────────────────────────────────────────────────┘

┌──────────────── Transaction Belt ──────────────┬──── Money Integrity ────────┐
│ Counts/value/age by lifecycle state            │ Open FSEs                   │
│ Stalled conversion points                      │ Expiring security events    │
│ End-to-end conversion                          │ Capture pending             │
│                                                │ Unreconciled amount         │
└────────────────────────────────────────────────┴────────────────────────────┘

┌──────────────── Fulfillment Today ─────────────┬──── Supply & Liquidity ─────┐
│ Assigned / en route / in progress              │ Zone × category coverage    │
│ Late / no-show / incident risk                 │ Eligible providers          │
│ Completion evidence pending                    │ Median credible response    │
└────────────────────────────────────────────────┴────────────────────────────┘

┌──────────────── Unit Economics ────────────────┬──── Capacity & Program ─────┐
│ Completed GMV                                  │ Approved GPV limit          │
│ Provider earnings                              │ 60% / 75% / 90% triggers   │
│ Contribution margin                            │ Ticket-limit exceptions     │
│ Human-ops time and rescue rate                 │ Underwriting blockers       │
└────────────────────────────────────────────────┴────────────────────────────┘

┌──────────────── Retention Queue ───────────────┬──── Release Readiness ──────┐
│ Repeat booking candidates                      │ Certification gates         │
│ Recurring conversion candidates                │ Open redlines               │
│ Provider-originated expansion opportunities    │ Failed tests / evidence     │
└────────────────────────────────────────────────┴────────────────────────────┘
```

## 7.3 “Needs Action Now” queue

Rows must show:

* severity;
* case ID;
* entity;
* concise problem statement;
* exact block code;
* amount or exposure;
* owner;
* age;
* SLA status;
* next permitted action;
* evidence completeness;
* whether the issue blocks customer, provider, money, or closure.

There must be no alert without:

* an owner;
* a resolution condition;
* a next action;
* a deduplication key;
* an escalation policy.

## 7.4 Transaction Belt

For each canonical lifecycle state, show:

* object count;
* total task value;
* median age;
* oldest object;
* stale count;
* conversion from prior state;
* expected next action;
* open cases.

Required states:

```text
TASK_DRAFT
SCOPE_READY
QUOTED / ESTIMATE_REQUIRED
QUOTE_APPROVED
PAYMENT_METHOD_READY
PROVIDER_SOURCING
PAYMENT_ELIGIBLE
PROVIDER_SOFT_RESERVED
FINANCIAL_SECURITY_PENDING
FINANCIALLY_SECURED
WORK_ORDER_MATERIALIZED
ASSIGNED
IN_PROGRESS
COMPLETION_SUBMITTED
CAPTURE_PENDING
CAPTURED
SETTLING / PAYOUT_PENDING
FUNDED / PAID_OUT
RECONCILED
CLOSED
```

## 7.5 Money Integrity panel

Display separately:

* tokenized payment methods;
* open Financial Security Events;
* amount financially secured;
* events approaching processor expiry;
* failed financial-security attempts;
* capture-ready transactions;
* capture failures;
* settling amounts;
* payout/funding pending;
* returned or failed funding;
* unreconciled amount;
* refunds;
* disputes;
* reserve exposure;
* negative-balance exposure;
* processor webhook lag.

## 7.6 Capacity panel

Display:

* processor-approved monthly GPV capacity;
* actual month-to-date GPV;
* reconciled GPV;
* projected month-end GPV;
* utilization;
* 60% forecast-update trigger;
* 75% capacity-increase request trigger;
* 90% escalation trigger;
* approved standard automated ticket ceiling;
* manually reviewed higher-ticket transactions;
* provider-count limit;
* category and geography restrictions.

The underwriting planning case must be shown separately from actual performance.

---

# 8. Unified Work Queue and Ops Case Model

## 8.1 Ops Case object

Every exception must become an `OpsCase`.

Required fields:

```text
id
case_type
severity
status
entity_type
entity_id
customer_id
provider_id
work_order_id
financial_event_id
block_code
title
description
source_event_id
dedupe_key
owner_user_id
owner_team
opened_at
acknowledged_at
due_at
escalate_at
resolved_at
resolution_code
next_action_key
allowed_action_keys[]
policy_version_id
evidence_refs[]
amount_exposure_cents
privacy_exposure
safety_exposure
processor_exposure
created_by_type
created_by_id
```

## 8.2 Case statuses

* `OPEN`
* `ACKNOWLEDGED`
* `IN_PROGRESS`
* `WAITING_CUSTOMER`
* `WAITING_PROVIDER`
* `WAITING_PROCESSOR`
* `WAITING_REVIEW`
* `RESOLVED`
* `DISMISSED_AS_DUPLICATE`
* `CLOSED`

A case cannot be closed by deleting it.

## 8.3 Severity model

| Severity | Definition                                                                                                    | Default response target                                 |
| -------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `P0`     | Active money-integrity, privacy, severe safety, processor, or platform-control failure                        | Acknowledge within 5 minutes; contain within 15 minutes |
| `P1`     | Transaction at material risk, dispute deadline, expiring security event, provider no-show, high-value failure | Acknowledge within 30 minutes                           |
| `P2`     | Conversion or operational blockage without immediate loss                                                     | Resolve or establish plan within 4 business hours       |
| `P3`     | Routine follow-up, data quality, non-urgent remediation                                                       | Process in scheduled daily queue                        |

These are proposed defaults and must remain versioned policy.

## 8.4 Case generation

Cases may be created by:

* invariant violation;
* state timeout;
* processor webhook;
* reconciliation mismatch;
* customer or provider report;
* operator;
* AI anomaly recommendation accepted by policy;
* failed automated command;
* certification failure.

Polling may be used only as a fallback. State transitions and events should generate cases directly.

---

# 9. Canonical Lifecycle Representation

## 9.1 State rails

The Work Order view must show separate rails.

| Rail        | Representative states                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commercial  | `TASK_DRAFT`, `SCOPE_READY`, `ESTIMATE_REQUIRED`, `QUOTED`, `QUOTE_APPROVED`, `PAYMENT_METHOD_READY`                                                          |
| Supply      | `PROVIDER_SOURCING`, `PAYMENT_ELIGIBLE`, `PROVIDER_SOFT_RESERVED`, `WORK_ORDER_MATERIALIZED`, `ASSIGNED`                                                      |
| Financial   | `NONE`, `TOKENIZED`, `FINANCIAL_SECURITY_PENDING`, `FINANCIALLY_SECURED`, `CAPTURE_PENDING`, `CAPTURED`, `SETTLING`, `PAYOUT_PENDING`, `FUNDED`, `RECONCILED` |
| Fulfillment | `NOT_STARTED`, `EN_ROUTE`, `ARRIVED`, `IN_PROGRESS`, `COMPLETION_SUBMITTED`, `COMPLETED`, `REWORK_REQUIRED`                                                   |
| Exception   | `NONE`, `MANUAL_REVIEW`, `PAYMENT_RECOVERY`, `PROVIDER_REPLACEMENT`, `INCIDENT_OPEN`, `DISPUTED`, `REFUND_PENDING`, `CANCELLED`, `RESTRICTED`                 |
| Retention   | `NOT_EVALUATED`, `REPEAT_ELIGIBLE`, `RECURRING_PROPOSED`, `REBOOKED`, `NOT_REPEATABLE`                                                                        |

## 9.2 Hard invariants

The UI and command service must enforce:

1. No real `TaskDraft` → no `TaskOpportunity`.
2. No approved provider payment eligibility → no Financial Security Event.
3. No candidate-approved merchant context → no Financial Security Event.
4. No provider conditional acceptance → no Financial Security Event attempt.
5. No successful Financial Security Event → no Canonical Work Order.
6. No successful Financial Security Event → no hard assignment.
7. No successful Financial Security Event and assignment → no exact-address release.
8. No approved completion evidence → no capture.
9. No approved final amount → no capture.
10. Unresolved incident that blocks capture → no capture.
11. Missing customer notice or approved timeout → no capture.
12. No processor and ledger agreement → no task closure.
13. No operation record and idempotency key → no money-moving API call.
14. No approved amount-change path → no automated change-order processing.
15. No reversed Provider A security event → no new Provider B security event where merchant context requires reversal first.
16. No approved recurring-payment capability → no automatic recurring Financial Security Event.
17. No approved category, provider credential, geography, and transaction limit → no payment-enabled execution.

## 9.3 Customer-facing semantic boundaries

The dashboard must verify that customer messaging uses correct language:

| Internal event                                           | Permitted customer meaning                               |
| -------------------------------------------------------- | -------------------------------------------------------- |
| Task Draft created                                       | “Your request exists and is being scoped or sourced.”    |
| Payment method tokenized                                 | “Your payment method was saved.”                         |
| Provider soft reserved                                   | “A provider is being confirmed.”                         |
| Financially secured + Work Order materialized + assigned | “Your job is confirmed and assigned.”                    |
| Capture completed                                        | “Your charge has been finalized.”                        |
| Funding/payout processor-confirmed                       | “Payout was sent or funded.”                             |
| Reconciled                                               | Internal financial records agree with processor records. |

The system must never tell a customer that a job is confirmed merely because a payment method was tokenized.

---

# 10. Requests and Quotes Module

## 10.1 Purpose

Convert messy demand into a qualified, structured, commercially approvable request.

## 10.2 Request list columns

* Request ID;
* customer;
* source;
* relationship origin;
* category intake;
* proposed category;
* geography;
* service date/window;
* qualification state;
* pricing lane;
* quote state;
* payment-method state;
* sourcing state;
* age;
* next action;
* case count;
* owner.

## 10.3 Request detail sections

### Intake

* original request;
* source and attribution;
* customer contact status;
* submitted media;
* requested date;
* approximate location;
* consent records.

### Scope

* scope versions;
* open questions;
* assumptions;
* exclusions;
* risk signals;
* category mapping;
* credential requirements;
* estimated duration;
* required tools or vehicle;
* property-access requirements.

### Eligibility

* category status;
* geography status;
* customer eligibility;
* transaction-size policy;
* processor program;
* legal or manual-review gates.

### Commercial lane

One of:

* `PLATFORM_PRICED`;
* `PROVIDER_ESTIMATE`;
* `REFERRAL_ONLY`;
* `MANUAL_REVIEW`;
* `UNSUPPORTED`.

### Quote

* quote versions;
* customer amount;
* provider economics;
* platform economics;
* processor cost estimate;
* price-policy version;
* cancellation policy;
* change-order policy;
* expiration;
* customer approval evidence.

## 10.4 Platform-priced lane

The operator may generate a firm quote only where:

* scope is sufficiently bounded;
* category permits platform pricing;
* pricing policy supports the scope;
* provider economics are feasible;
* no unknown materially changes the price;
* category and transaction size are approved.

## 10.5 Provider-estimate lane

Required for uncertain scope such as:

* large landscaping;
* uncertain hauling volume;
* complex repairs;
* work requiring inspection;
* scope with material property risk;
* tasks where available-provider count does not prove a valid price.

The interface must show:

* estimate requested;
* provider selected;
* estimate version;
* customer approval;
* provider final availability;
* exact Financial Security Event amount.

No firm customer price may be represented before the provider estimate is approved.

---

# 11. Work Order Detail Page

## 11.1 Header

The sticky header must show:

* Request ID;
* Work Order ID, if materialized;
* relationship origin;
* category;
* geography;
* schedule;
* customer;
* assigned provider;
* customer amount;
* provider economics;
* risk status;
* lifecycle state;
* owner;
* next lawful action;
* open cases;
* environment.

Request ID and Work Order ID must remain distinct.

## 11.2 Primary layout

### Left: lifecycle and evidence

* multi-rail state display;
* event timeline;
* state duration;
* stale-state warnings;
* source and evidence for each major transition.

### Center: operating record

Contextual subpages:

1. Summary
2. Scope and Quotes
3. Supply and Assignment
4. Payment and Ledger
5. Fulfillment
6. Communications
7. Incidents
8. Audit

### Right: governed action rail

Only actions currently permitted by:

* state;
* role;
* policy;
* capability;
* processor program;
* approvals;
* idempotency;
* evidence.

Blocked actions remain visible with exact block reasons where useful.

## 11.3 Summary card

Must show:

* what the customer requested;
* what was approved;
* who accepted;
* what payment state exists;
* whether the task is assigned;
* what happens next;
* current operational risk;
* current financial exposure;
* whether exact address is releasable;
* whether capture is currently authorized by policy;
* whether the transaction is reconciled.

## 11.4 Scope versioning

Every material change must create a new scope version.

Show:

* prior version;
* changed fields;
* actor;
* reason;
* customer approval;
* provider approval;
* amount effect;
* scheduling effect;
* risk effect;
* payment effect.

Operators cannot overwrite an accepted scope.

## 11.5 Exact-address control

Before valid financial security and assignment:

* show only general area;
* mask full address;
* mask access instructions;
* mask direct customer contact details.

After valid financial security and assignment:

* authorized operational roles may access required details;
* all access is logged;
* provider access is limited to the assigned Work Order;
* break-glass internal access requires reason and step-up authentication.

---

# 12. Task Opportunities and Claim Links

## 12.1 Internal terminology

“Claim” may be used in customer-facing growth copy.

The internal pre-approval authority is only:

> **Express Interest**

Expressing interest must not create:

* reservation;
* assignment;
* customer authorization;
* provider payable;
* earnings guarantee;
* private-data access.

## 12.2 Opportunity list

Columns:

* Opportunity ID;
* linked Task Draft;
* source state;
* category;
* general area;
* schedule;
* pricing lane;
* estimated gross provider-earnings range;
* approved-provider count;
* external-link count;
* interest count;
* earliest link expiration;
* task still open;
* sourcing owner;
* next action.

## 12.3 Opportunity detail

Must show:

* canonical Task Draft reference;
* open/filled/expired status;
* redacted preview snapshot;
* eligibility requirements;
* category and credential requirements;
* active links;
* intended recipients;
* link expiration;
* click and interest events;
* provider onboarding status;
* abuse signals;
* task revalidation result;
* revocation history.

## 12.4 Link controls

Every link must be:

* signed;
* expiring;
* auditable;
* revocable;
* rate-limited;
* recipient-bound where appropriate;
* linked to a real open Task Opportunity.

The preview may include:

* category;
* general area;
* schedule;
* scope summary;
* requirements;
* pricing lane;
* estimated gross provider-earnings range.

It must not include:

* exact address;
* customer direct contact information;
* access instructions;
* full customer identity;
* payment information;
* guaranteed earnings;
* guaranteed assignment.

## 12.5 Revalidation before financial security

Required checks:

* task remains open;
* quote remains current;
* schedule remains valid;
* customer remains committed;
* provider remains available;
* provider payment eligibility is approved;
* category and credential eligibility pass;
* final scope is accepted;
* final economics are accepted;
* merchant context is approved.

If the task is filled while onboarding occurs, the provider may remain eligible for future work, but the task is not promised.

---

# 13. Providers Module

## 13.1 Separate eligibility dimensions

The provider record must never collapse all eligibility into “approved.”

Display separately:

* HustleXP profile status;
* processor application status;
* processor payment eligibility;
* payout/funding capability;
* HustleXP task eligibility;
* category eligibility;
* credential eligibility;
* geography eligibility;
* trust tier;
* current restrictions;
* availability freshness.

## 13.2 Provider states

* `PROSPECT`
* `APPLICATION_SUBMITTED`
* `PAYMENT_ELIGIBILITY_APPROVED`
* `TASK_ELIGIBILITY_PENDING`
* `ACTIVE`
* `SOFT_RESERVED`
* `ASSIGNED`
* `RESTRICTED_REMEDIATION`
* `TERMINATED`

## 13.3 Trust tiers

| Tier                    | Meaning                                                 | Permitted capability                                         |
| ----------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| `T0_PROSPECT`           | Profile only; no approved payment eligibility           | Redacted opportunities and Express Interest only             |
| `T1_PAYMENT_ELIGIBLE`   | Processor payment eligibility and basic low-risk checks | Low-risk, non-home-entry tasks within approved limits        |
| `T2_VERIFIED_CATEGORY`  | Additional credential and category evidence             | Broader approved categories                                  |
| `T3_TRUSTED_PROVIDER`   | Reconciled successful history and low incident rate     | Faster matching or expanded limits where policy permits      |
| `T4_BUSINESS_REGULATED` | Business evidence, insurance, licensing where required  | Commercial or regulated work under separately approved rules |

## 13.4 Provider detail

Sections:

1. Profile
2. Processor eligibility
3. Categories and credentials
4. Service area and availability
5. Performance
6. Work history
7. Earnings and funding
8. Incidents and disputes
9. Restrictions
10. Audit

Performance must include:

* acceptance rate;
* response time;
* cancellation rate;
* no-show rate;
* completion rate;
* rework rate;
* evidence quality;
* customer complaints;
* dispute rate;
* reconciled transaction count.

## 13.5 Sensitive provider data

`/OPS` must not store or display:

* full SSN;
* full EIN where unnecessary;
* bank-account number;
* routing number;
* government-ID image;
* raw KYC documents;
* full date of birth;
* processor secrets.

Display only safe status and references, such as:

* identity information submitted;
* review pending;
* remediation required;
* payment eligible;
* payouts enabled;
* restriction reason code;
* processor external reference.

---

# 14. Provider OS and Relationship Origin

## 14.1 Relationship origin

Every Work Order and Payment Order must carry one immutable origin:

* `MARKETPLACE`;
* `PROVIDER_OS`;
* `BRING_YOUR_OWN_PROVIDER`.

Origin controls:

* fee policy;
* disclosures;
* sourcing behavior;
* merchant presentation;
* support obligations;
* attribution;
* retention analytics.

## 14.2 Same provider identity

The same approved provider identity should support both:

* HustleXP-originated customers;
* provider-originated customers.

If the processor requires separate underwritten resources, `/OPS` must still present one operational provider identity with explicit account topology.

## 14.3 Provider OS work

Provider OS detail must show:

* provider-originated customer;
* estimate versions;
* scope versions;
* customer approval;
* payment method;
* merchant identity;
* Financial Security Event;
* service occurrence;
* evidence;
* capture;
* settlement;
* provider funding;
* platform economics;
* reconciliation.

Open-marketplace sourcing is not required when a provider is already known.

## 14.4 Merchant presentation

For every Provider OS transaction, `/OPS` must expose:

* legal or DBA merchant identity;
* HustleXP platform branding;
* checkout identity;
* receipt ownership;
* statement descriptor;
* refund authority;
* support responsibility.

These remain blocked while the merchant-of-record decision is open.

---

# 15. Recurring Work

## 15.1 Core rule

A recurring agreement is a template.

Each service occurrence is a discrete transaction with its own:

* Work Order;
* service date;
* scope;
* assigned provider;
* Financial Security Event;
* fulfillment evidence;
* capture;
* settlement/funding;
* reconciliation.

## 15.2 Recurring template view

Display:

* customer;
* provider;
* relationship origin;
* category;
* cadence;
* service window;
* scope template;
* consent;
* payment-method reference;
* next occurrence;
* generation horizon;
* provider continuity preference;
* fee policy;
* status;
* exceptions.

## 15.3 Occurrence controls

For each occurrence:

* create in advance;
* verify schedule;
* verify provider;
* verify token consent;
* create Financial Security Event inside the processor-approved authorization window;
* capture after occurrence completion;
* reconcile separately.

## 15.4 Prohibited initial behavior

Unless separately underwritten:

* no annual prepayment;
* no long-term captured customer funds;
* no one authorization spanning unlimited occurrences;
* no silent provider substitution;
* no automatic reuse across merchant contexts unless approved.

---

# 16. Payments Module

## 16.1 Primary tabs

1. Payment Methods
2. Financial Security Events
3. Captures
4. Settlement and Funding
5. Ledger
6. Refunds
7. Disputes
8. Webhooks

## 16.2 Financial Security Event row

Required fields:

* internal event ID;
* Work Order or Task Draft;
* provider;
* Provider Account reference;
* merchant context;
* processor program;
* amount;
* currency;
* status;
* created time;
* expiry time;
* fee/routing policy;
* operation ID;
* idempotency key;
* processor external reference;
* processor raw status;
* normalized status;
* internal/processor agreement;
* next action;
* open case.

## 16.3 Financial Security Event creation preview

Before execution, show:

* customer amount;
* provider identity;
* merchant context;
* merchant of record;
* provider account;
* platform fee or routing mechanism;
* payment-method reference;
* expiry;
* customer consent;
* quote version;
* scope version;
* provider conditional acceptance;
* category approval;
* transaction-limit check;
* policy version;
* recovery behavior if creation fails.

## 16.4 Work Order materialization

After the Financial Security Event succeeds:

1. Processor event is persisted.
2. Internal financial state is updated.
3. Ledger and event state agree.
4. Canonical Work Order is created.
5. Provider soft hold becomes hard assignment.
6. Private fulfillment details become eligible for release.
7. Customer and provider receive semantically accurate notifications.

If atomic materialization fails:

* no assignment;
* no private-data release;
* create a P0/P1 Ops Case;
* reverse or void the Financial Security Event where required;
* preserve operation evidence.

## 16.5 Capture gate

Capture is allowed only after all required gates pass:

* service completion submitted;
* evidence valid;
* final scope version known;
* final amount known;
* customer approval or disclosed timeout condition met;
* no blocking incident;
* no cancellation conflict;
* change-order requirements satisfied;
* processor event remains capturable;
* idempotency operation exists.

The interface must present each gate individually.

## 16.6 Settlement and funding

Capture does not equal funding.

The interface must separately show:

* captured;
* settlement batch or balance movement;
* transfer or payout state;
* provider funding;
* platform funding;
* processor fees;
* reserve or hold;
* return;
* reconciliation.

## 16.7 Internal economics

Store and display separately:

* service GMV;
* customer fee;
* provider economics;
* HustleXP platform fee;
* processor cost;
* refund amount;
* dispute amount;
* chargeback fee;
* loss allocation;
* recovery amount;
* net revenue;
* contribution margin.

A fee percentage must come from a versioned pricing policy based on:

* relationship origin;
* category;
* provider agreement;
* processor program;
* effective date.

---

# 17. Provider Replacement and Amount Changes

## 17.1 Provider replacement

Required flow:

1. Identify Provider A withdrawal or failure.
2. Determine current Financial Security Event state.
3. Reverse or void Provider A’s event where required.
4. Disclose possible temporary hold overlap to the customer.
5. Select eligible Provider B.
6. Determine credential portability.
7. Reuse the vaulted credential only where approved and consented.
8. Otherwise obtain renewed customer authorization.
9. Create a new Financial Security Event in Provider B’s merchant context.
10. Materialize or update assignment only after success.
11. Reconcile all events.

The UI must prevent Provider B assignment while Provider A’s unresolved financial event creates an invalid merchant-context state.

## 17.2 Amount changes

No amount change may be processed without:

* documented reason;
* new scope or change-order version;
* customer approval;
* provider approval;
* processor-approved adjustment path.

Possible processor-approved paths:

* incremental authorization;
* partial capture;
* void and reauthorization;
* separate change-order transaction.

Until one is explicitly approved, the fail-closed default is:

* exact capture of approved amount; or
* void and reauthorize; or
* separately approved change-order transaction.

---

# 18. Reconciliation Module

## 18.1 Purpose

Reconciliation is a daily launch requirement, not a finance afterthought.

It must compare HustleXP records with processor records for:

* open Financial Security Events;
* captures;
* settlement batches;
* transfers;
* payouts;
* provider funding;
* platform funding;
* processor fees;
* reserves;
* refunds;
* disputes;
* chargebacks;
* returns;
* adjustments;
* negative balances.

## 18.2 Reconciliation run

Each `ReconciliationRun` must include:

```text
id
processor_program_id
environment
period_start
period_end
started_at
completed_at
status
initiated_by
source_reports[]
internal_record_count
processor_record_count
matched_count
mismatch_count
unexplained_amount_cents
stale_event_count
reviewer_id
approved_at
export_reference
```

## 18.3 Reconciliation item statuses

* `MATCHED`
* `PENDING_PROCESSOR`
* `PENDING_INTERNAL`
* `AMOUNT_MISMATCH`
* `STATE_MISMATCH`
* `DESTINATION_MISMATCH`
* `FEE_MISMATCH`
* `DUPLICATE`
* `MISSING`
* `STALE`
* `APPROVED_EXCEPTION`
* `RESOLVED`

## 18.4 Reconciliation dashboard

Display:

* last completed run;
* current run;
* completion percentage;
* matched amount;
* unexplained amount;
* oldest mismatch;
* number of tasks blocked from closure;
* number of providers with funding exceptions;
* number of disputes lacking ledger allocation;
* raw event ingestion health;
* report import health.

## 18.5 Closure rule

A Work Order cannot become `CLOSED` until:

* capture and funding states are known;
* internal ledger entries balance;
* processor events match;
* refunds and disputes are represented;
* any approved exception has independent review.

## 18.6 Daily failure behavior

If daily reconciliation does not complete:

* create a P0 or P1 case according to exposure;
* block new production release;
* block capacity expansion;
* surface the failure in the truth ribbon;
* optionally disable affected money actions under policy.

---

# 19. Refunds, Disputes, and Loss Exposure

## 19.1 State-specific actions

| Transaction state                 | Permitted target action                                             |
| --------------------------------- | ------------------------------------------------------------------- |
| Before financial security         | Close or expire request; no processor action                        |
| Financially secured, not assigned | Reverse or void security event                                      |
| Assigned, before service          | Apply disclosed cancellation policy; no silent full capture         |
| Captured, batch open              | Use processor-supported void or refund action for exact state       |
| Settled or funded                 | Issue approved refund and reconcile provider/platform allocation    |
| Disputed                          | Create incident, preserve evidence, block conflicting refund action |

## 19.2 Dispute workspace

Required sections:

* dispute metadata;
* processor deadline;
* customer request;
* accepted scope;
* quote or estimate;
* payment authorization;
* provider identity and eligibility;
* assignment;
* service timestamps;
* communications;
* completion evidence;
* customer confirmation or timeout;
* change orders;
* refund or cancellation history;
* processor events;
* ledger;
* evidence package;
* response submission;
* outcome;
* loss allocation;
* provider recovery.

## 19.3 Loss waterfall

The interface must represent, but not invent, the approved answer to:

* who bears principal loss;
* who bears chargeback fee;
* who bears recovery cost;
* whether HustleXP may offset provider balances;
* whether one provider’s funds may ever cover another provider’s loss;
* what reserve applies;
* what recovery rights exist;
* what happens if provider recovery fails.

Until written approval exists, the loss waterfall remains `OPEN_DECISION` and unit-economics models must show the uncertainty.

---

# 20. Incidents and Risk

## 20.1 Incident types

* customer safety;
* provider safety;
* property damage;
* service quality;
* no-show;
* fraud;
* identity;
* payment;
* privacy;
* exact-address disclosure;
* prohibited service;
* category or credential;
* harassment;
* dispute;
* processor restriction;
* platform integrity;
* data breach.

## 20.2 Incident record

Required fields:

* severity;
* incident type;
* affected participants;
* Work Order;
* financial events;
* description;
* opened time;
* event time;
* current risk;
* immediate containment;
* evidence;
* assigned owner;
* provider/customer restrictions;
* capture block;
* refund block;
* dispute relationship;
* processor notification requirement;
* legal notification requirement;
* resolution;
* postmortem;
* policy change.

## 20.3 Capture-blocking incident

The incident page must explicitly show:

* whether capture is blocked;
* the rule causing the block;
* who may resolve it;
* what evidence is required;
* whether the customer has been notified;
* whether the provider is restricted.

An operator may not bypass a capture-blocking incident with a generic override.

---

# 21. Categories, Trust, and Eligibility Policy

## 21.1 Finite category taxonomy

Broad intake does not equal universal payment authorization.

Every category record must include:

* approved scope;
* explicit exclusions;
* risk posture;
* processor approval;
* MCC mapping where applicable;
* provider credentials;
* insurance requirements;
* trust tier;
* ticket limits;
* geography;
* manual-review rules;
* evidence requirements;
* current capability status.

## 21.2 Initial category presentation

| Category                             | Initial posture                          |
| ------------------------------------ | ---------------------------------------- |
| Yard work / basic landscaping        | Initially enabled within permitted scope |
| Moving labor / qualified hauling     | Manual review and credential gate        |
| Furniture assembly                   | Initially enabled within low-risk policy |
| General cleaning                     | Home-entry controls                      |
| Pressure washing / exterior cleaning | Manual review                            |
| Local errands                        | Low-ticket only                          |
| Basic technology help                | Scope controls                           |
| Licensed or regulated trades         | Future and gated                         |

## 21.3 Category action behavior

Unsupported requests may be:

* referred;
* routed to manual review;
* waitlisted;
* declined;
* retained as demand intelligence.

They may not proceed to payment merely because a provider is willing.

## 21.4 Policy versioning

Policy changes must preserve:

* previous version;
* effective date;
* author;
* reviewer;
* affected categories;
* affected capabilities;
* migration impact;
* open Work Orders affected;
* approval evidence.

---

# 22. Underwriting Decision Board

The 20 processor decisions must exist as first-class governance objects.

| ID | Decision                                       | Capability blocked while unresolved       |
| -: | ---------------------------------------------- | ----------------------------------------- |
|  1 | Casual sole-proprietor eligibility             | Individual provider supply                |
|  2 | Eligible provider bank-account type            | Sole-proprietor funding eligibility       |
|  3 | Unified Marketplace + Provider OS relationship | Provider OS payments                      |
|  4 | Merchant of record, topology, descriptors      | Checkout                                  |
|  5 | Conditional provider before financial security | Open-marketplace assignment flow          |
|  6 | Capture or controlled-disbursement model       | Payment implementation                    |
|  7 | Tokenization and credential portability        | Automated replacement and recurring reuse |
|  8 | Platform economics mechanism                   | Platform monetization                     |
|  9 | Amount-change pattern                          | Change-order automation                   |
| 10 | Provider replacement                           | Automated replacement                     |
| 11 | Ultimate loss waterfall                        | Reserve and unit-economics confidence     |
| 12 | Provider versus platform isolation             | Per-provider containment                  |
| 13 | Category and MCC approval                      | Category enablement                       |
| 14 | Limits, reserves, settlement, payout delay     | Capacity and expansion                    |
| 15 | Restriction and termination handling           | Continuity plan                           |
| 16 | Recurring occurrences                          | Recurring payments                        |
| 17 | Regulatory role                                | Legal launch                              |
| 18 | Commercial terms                               | Financial model                           |
| 19 | Task-opportunity onboarding                    | External provider acquisition             |
| 20 | Written architecture signoff                   | Processor-specific coding                 |

## 22.1 Decision record

Each decision must include:

* current status;
* HustleXP proposal;
* processor response;
* redlines;
* controlling correspondence;
* official documentation;
* commercial agreement reference;
* owner;
* submitted date;
* response deadline;
* affected capabilities;
* affected tests;
* effective date;
* superseded decisions.

Statuses:

* `NOT_SUBMITTED`
* `SUBMITTED`
* `IN_REVIEW`
* `REDLINED`
* `APPROVED`
* `REJECTED`
* `SUPERSEDED`
* `EXPIRED`

## 22.2 Feature-gate linkage

When a decision changes:

1. Affected capabilities are recalculated.
2. Any production enablement requires independent review.
3. Open Work Orders are evaluated.
4. Required policy or code changes are identified.
5. Certification tests become stale if the approved architecture changed.

---

# 23. Certification and Release Gate

## 23.1 Required certification tests

| Test                       | Required proof                                                                                        | Fail-closed result                     |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Sole-proprietor boarding   | New SSN-based sole proprietor, remediation, approval, hosted profile handling                         | Individual supply disabled             |
| Token portability          | Vaulted credential reused across approved contexts or customer reauthorization proven                 | Automated cross-context reuse disabled |
| Existing-provider flow     | Quote → tokenize → soft reserve → FSE → materialize → assign → complete → capture → fund → reconcile  | Marketplace payments disabled          |
| Task-link flow             | Real link → redacted preview → interest → onboarding → revalidation → soft reserve → FSE → assignment | External provider acquisition disabled |
| Provider-estimate flow     | Estimate version → customer approval → exact FSE → service → capture                                  | Complex categories disabled            |
| Provider replacement       | Reverse A → secure B → no duplicate capture                                                           | Automated replacement disabled         |
| Amount change              | Candidate-approved adjustment path                                                                    | Automated change orders disabled       |
| Authorization expiry       | Event created inside approved window; expiry alert and recovery                                       | Long-scheduled paid work disabled      |
| Void and refund            | Correct action for actual transaction state; allocation reconciled                                    | Refund automation disabled             |
| Chargeback                 | Webhook → incident → evidence → ledger adjustment                                                     | Dispute automation disabled            |
| Webhook replay             | Duplicate/out-of-order events produce no duplicate money or state                                     | Production launch blocked              |
| Daily reconciliation       | All money states reconcile                                                                            | Production launch blocked              |
| Kill switch and continuity | Provider-level and platform-level controls tested; exports available                                  | Production launch blocked              |

## 23.2 Certification evidence

Each test record must include:

* environment;
* processor program;
* build commit;
* policy versions;
* test data;
* execution steps;
* expected result;
* actual result;
* processor event IDs;
* internal event IDs;
* screenshots or logs;
* ledger output;
* reconciliation output;
* tester;
* independent reviewer;
* pass/fail;
* known limitations;
* expiration or invalidation conditions.

## 23.3 Production release definition

Production payment capability requires all of:

* written underwriting approval;
* executed commercial terms;
* secure KYC/KYB readiness;
* approved merchant topology;
* approved categories and limits;
* successful sandbox certification;
* independent code review;
* controlled production pilot;
* daily reconciliation;
* incident handling;
* termination handling;
* tested kill switches;
* evidence export.

A percentage readiness score must not override a failed hard gate.

---

# 24. AI Ops and Approval System

## 24.1 AI Ops purpose

AI Ops should reduce operator cognition and communication load without becoming an authority bypass.

## 24.2 AI activities

Permitted:

* summarize request;
* identify missing scope;
* classify category;
* identify policy conflicts;
* recommend pricing lane;
* rank eligible providers;
* draft customer/provider messages;
* detect stalled state;
* summarize reconciliation mismatch;
* prepare dispute evidence;
* recommend next action;
* identify repeat-work opportunity.

## 24.3 AI log

Every AI action or recommendation must create an append-only record with:

```text
id
created_at
model_identifier
model_version
action_type
entity_refs[]
input_source_refs[]
policy_refs[]
recommendation
structured_rationale
uncertainties[]
risk_flags[]
proposed_command
authority_class
approval_required
approval_id
execution_status
executed_command_id
outcome
operator_feedback
```

Do not store hidden model reasoning. Store a concise, reviewable decision summary, cited data, applied rules, uncertainty, and proposed action.

## 24.4 Approval card

Every approval card must include:

* requested command;
* entity;
* customer/provider effect;
* amount;
* merchant context;
* current state;
* prerequisites;
* policy rule;
* evidence;
* risk;
* recovery behavior;
* expiration;
* approver role;
* executor path.

An approval card without a downstream executor is invalid and must not be generated.

## 24.5 Approval states

* `PENDING`
* `APPROVED`
* `REJECTED`
* `EXPIRED`
* `CANCELLED`
* `EXECUTING`
* `EXECUTED`
* `FAILED`

Expired approvals must generate an owned follow-up case when the underlying transaction remains unresolved.

---

# 25. Command and Action Architecture

## 25.1 Command envelope

Every write action must use:

```text
command_id
action_key
entity_type
entity_id
expected_entity_version
requested_by
requested_at
reason_code
reason_text
policy_version_id
capability_snapshot_id
approval_id
idempotency_key
correlation_id
causation_id
metadata
```

Use optimistic concurrency. A stale command must fail rather than overwrite a newer state.

## 25.2 Action classes

| Class                     | Examples                                                                | Automation                                                                              |
| ------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `A0_READ`                 | View, search, export safe data                                          | Allowed                                                                                 |
| `A1_REVERSIBLE_NON_MONEY` | Reminder, request information, internal assignment of case              | Policy-approved automation allowed                                                      |
| `A2_GOVERNED_OPERATIONAL` | Open opportunity, soft reserve, schedule, completion review             | Deterministic automation only when capability and policy permit                         |
| `A3_MONEY_OR_PRIVATE`     | FSE, capture, refund, provider replacement, address reveal              | Typed service plus required human or deterministic policy authority; never free-form AI |
| `A4_GOVERNANCE`           | Enable capability, change policy, release production, ledger adjustment | Two-person control                                                                      |

## 25.3 Required command registry

| Command                            | Critical preconditions                                                          | Result                                 |
| ---------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| `OPEN_TASK_OPPORTUNITY`            | Real open Task Draft, eligible intake                                           | Creates sourcing object                |
| `ISSUE_OPPORTUNITY_LINK`           | Open opportunity, redacted snapshot, expiry                                     | Creates signed link                    |
| `SOFT_RESERVE_PROVIDER`            | Payment eligibility, task eligibility, final acceptance                         | Creates short conditional hold         |
| `CREATE_FINANCIAL_SECURITY_EVENT`  | Approved merchant context, conditional provider, customer approval, idempotency | Attempts reversible financial security |
| `MATERIALIZE_WORK_ORDER`           | Successful FSE and internal/processor agreement                                 | Creates executable Work Order          |
| `HARD_ASSIGN_PROVIDER`             | Materialized Work Order and valid provider hold                                 | Creates final assignment               |
| `RELEASE_PRIVATE_DETAILS`          | Financially secured, assigned, authorized viewer                                | Releases permitted fulfillment data    |
| `SUBMIT_COMPLETION`                | Assigned provider, service evidence                                             | Starts completion review               |
| `CAPTURE_PAYMENT`                  | Completion, amount, incident, notice gates pass                                 | Finalizes customer charge              |
| `REVERSE_FINANCIAL_SECURITY_EVENT` | Event reversible under processor state                                          | Releases or reverses hold              |
| `REPLACE_PROVIDER`                 | Replacement policy and merchant-context path approved                           | Reverses A and secures B               |
| `PROCESS_CHANGE_ORDER`             | New scope, approvals, approved adjustment path                                  | Changes amount safely                  |
| `ISSUE_REFUND`                     | Exact processor state and allocation known                                      | Executes approved refund               |
| `RESTRICT_PROVIDER`                | Incident/risk authority                                                         | Blocks new work under defined scope    |
| `CLOSE_WORK_ORDER`                 | Outcome, funding, ledger, reconciliation complete                               | Closes transaction                     |
| `CREATE_RECURRING_OCCURRENCE`      | Approved template and recurring capability                                      | Creates discrete occurrence            |

---

# 26. Notifications and Escalations

## 26.1 Design principles

Notifications must be:

* event-driven;
* semantically accurate;
* deduplicated;
* owned;
* actionable;
* rate-limited;
* tied to a state transition or Ops Case;
* recorded in the audit log.

No notification should exist merely to create activity.

## 26.2 Internal alert classes

### P0

Examples:

* duplicate money movement;
* unexplained ledger mismatch;
* unauthorized private-data disclosure;
* processor restriction;
* failed kill switch;
* compromised webhook verification;
* severe safety incident.

Channels:

* `/OPS` interrupt;
* on-call page;
* SMS or equivalent;
* email;
* approved collaboration channel.

### P1

Examples:

* Financial Security Event nearing expiry;
* assigned provider no-show;
* capture failure;
* dispute deadline approaching;
* daily reconciliation failure;
* funding return;
* high-ticket exception;
* active provider replacement.

### P2

Examples:

* stale quote;
* missing customer information;
* onboarding remediation;
* expiring opportunity link;
* recurring occurrence awaiting authorization;
* incomplete completion evidence.

### P3

Examples:

* routine follow-up;
* data quality;
* non-urgent policy review;
* low-priority retention suggestion.

## 26.3 Customer and provider messaging guardrails

Never message:

* “Task claimed” before valid assignment;
* “Payment received” after tokenization only;
* “Provider paid” before processor-confirmed funding;
* “Guaranteed earnings” for opportunity interest;
* exact address in a sourcing message;
* final price while in provider-estimate lane;
* annual prepaid commitment when disabled.

## 26.4 Notification audit

Record:

* template version;
* recipient;
* channel;
* trigger event;
* rendered semantic state;
* delivery state;
* provider response;
* customer response;
* suppression;
* consent;
* failure;
* retry.

---

# 27. Analytics and Operating Metrics

## 27.1 North Star hierarchy

1. Successfully completed paid tasks.
2. Provider earnings from completed work.
3. Repeat and recurring completed GMV.
4. Contribution margin.
5. Transactions per human-operations hour.

## 27.2 Transaction funnel

```text
Completed GMV =
Qualified Demand
× Quote Rate
× Customer Approval Rate
× Payment-Method Readiness
× Eligible Supply Rate
× Financial-Security Success Rate
× Assignment Rate
× Completion Rate
× Capture Success Rate
× Average Order Value
```

Every stage must be drillable to the underlying entities.

## 27.3 Required operating metrics

### Demand

* qualified requests;
* source attribution;
* qualification rate;
* time to scope;
* unsupported category rate;
* quote rate;
* quote acceptance rate;
* repeat demand.

### Supply

* payment-eligible providers;
* active providers;
* providers by zone and category;
* credible response time;
* acceptance rate;
* cancellation rate;
* no-show rate;
* utilization;
* provider earnings.

### Fulfillment

* fill rate;
* assignment rate;
* on-time rate;
* completion rate;
* rework rate;
* incident rate;
* completion-evidence pass rate.

### Money

* completed GMV;
* financially secured value;
* captured value;
* funded value;
* provider economics;
* platform revenue;
* processor costs;
* refunds;
* disputes;
* losses;
* contribution margin;
* unreconciled amount.

### Operations

* founder rescue rate;
* human touches per completed task;
* transactions per ops hour;
* cases by type;
* case resolution time;
* automated-action success;
* false-positive case rate;
* approval expiration rate.

### Retention

* second-task rate;
* recurring conversion;
* same-provider rebooking;
* provider-originated customers;
* customer referral;
* provider referral.

## 27.4 Liquidity

Liquidity must be measured by:

> **Zone × Category × Time Window × Eligibility**

A provider in Bellevue furniture assembly does not solve qualified hauling supply in Issaquah.

## 27.5 Source attribution

Persist attribution through:

```text
Source
→ Lead
→ Task Draft
→ Quote
→ Work Order
→ Financial Security Event
→ Capture
→ Funding
→ Contribution Margin
→ Repeat
```

Raw leads are not channel success.

## 27.6 Metric integrity

Every metric must expose:

* definition;
* numerator;
* denominator;
* date range;
* source;
* actual versus planning;
* last refresh;
* excluded records;
* reconciliation requirement.

---

# 28. Canonical Data Model

| Entity                        | Purpose                                             | Critical invariant                              |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------- |
| `Lead`                        | Contact and acquisition record                      | Not a paid task                                 |
| `TaskDraft`                   | Real customer request and scope-development record  | Exists before any opportunity or Work Order     |
| `ScopeVersion`                | Immutable scope history                             | Accepted versions cannot be overwritten         |
| `Quote`                       | Commercial proposal container                       | Must reference versioned policy                 |
| `QuoteVersion`                | Immutable price and terms                           | Customer approval references exact version      |
| `TaskOpportunity`             | Provider sourcing object                            | Must reference real open Task Draft             |
| `OpportunityLink`             | Signed external opportunity access                  | Redacted, expiring, auditable                   |
| `ProviderProfile`             | Operational provider identity                       | Separate from processor eligibility             |
| `ProviderAccountRef`          | Processor payment eligibility and funding reference | No raw KYC or banking data                      |
| `ProviderCategoryEligibility` | Category-specific provider authority                | Must be approved for task category              |
| `ConditionalProviderHold`     | Short provider soft reservation                     | No hard assignment or private details           |
| `PaymentMethodRef`            | Safe token/vault reference                          | No PAN/CVV                                      |
| `MerchantContext`             | Approved transaction topology                       | Required before financial security              |
| `FinancialSecurityEvent`      | Reversible authorization/guarantee state            | Required before Work Order and assignment       |
| `CanonicalWorkOrder`          | Executable financially secured task                 | Created only after successful FSE               |
| `Assignment`                  | Final provider commitment                           | Requires materialized Work Order                |
| `FulfillmentEvent`            | Arrival, progress, completion events                | Append-only                                     |
| `CompletionEvidence`          | Proof of service                                    | Required by category policy                     |
| `ChangeOrder`                 | Approved scope/amount change                        | Versioned and processor-path aware              |
| `PaymentCapture`              | Final charge action                                 | Requires pre-capture gates                      |
| `SettlementFundingRecord`     | Processor settlement or payout state                | Not equivalent to completion                    |
| `LedgerEntry`                 | Immutable double-entry economics                    | Must reconcile to processor events              |
| `Refund`                      | Post-charge reversal                                | State-specific and allocated                    |
| `Dispute`                     | Chargeback or payment dispute                       | Blocks conflicting refund workflow              |
| `Incident`                    | Safety, quality, compliance, or risk event          | May block capture or provider                   |
| `RecurringTemplate`           | Recurring service agreement                         | Not one prepaid transaction                     |
| `RecurringOccurrence`         | Discrete service occurrence                         | Separate Work Order and payment                 |
| `WebhookInbox`                | Raw signed processor events                         | Deduplicated and replayable                     |
| `ReconciliationRun`           | Internal/processor comparison                       | Required daily                                  |
| `ReconciliationItem`          | Specific match or mismatch                          | Must resolve or receive independent exception   |
| `OpsCase`                     | Owned operational exception                         | Must have next action and resolution condition  |
| `ActionIntent`                | Proposed command                                    | Does not itself change state                    |
| `ActionApproval`              | Human authority record                              | Must reference exact intent                     |
| `ActionExecution`             | Executed command result                             | Idempotent and auditable                        |
| `AuditEvent`                  | Append-only activity history                        | Immutable                                       |
| `UnderwritingDecision`        | Processor decision and evidence                     | Drives capability gate                          |
| `Capability`                  | Approved operational authority                      | Checked at command execution                    |
| `PolicyVersion`               | Versioned business rule                             | Historical transactions retain original version |
| `CertificationTest`           | Release evidence                                    | Failed hard gate blocks capability              |
| `NotificationEvent`           | Communication trigger and delivery                  | State-semantic and deduplicated                 |

---

# 29. Technical Architecture

## 29.1 Target architecture

```text
/OPS Browser
    ↓
Ops BFF / Internal API
    ↓
Authentication + MFA + RBAC + Field-Level Authorization
    ↓
Capability Registry + Policy Engine + Command Validator
    ↓
Canonical Domain Services
    ├── Request / Quote Service
    ├── Provider Eligibility Service
    ├── Opportunity Service
    ├── Assignment Service
    ├── Fulfillment Service
    ├── Payment Service
    ├── Ledger Service
    ├── Incident Service
    └── Reconciliation Service
    ↓
Processor-Neutral Payment Adapter
    ↓
Candidate Processor
```

Supporting infrastructure:

```text
Domain Events
    ↓
Transactional Outbox
    ↓
Read Models / Case Generator / Notifications / Analytics

Processor Webhooks
    ↓
WebhookInbox
    ↓
Authentication / Dedupe / Normalization
    ↓
Domain Command or State Reconciliation
```

## 29.2 No direct client writes

The browser must not:

* update canonical tables directly;
* call processor APIs;
* hold a permanent admin key;
* execute money actions through generic database RPCs;
* infer authority from hidden UI buttons;
* create parallel lifecycle records.

All writes must flow through the governed command service.

## 29.3 Authentication

Production `/OPS` requires:

* named user accounts;
* MFA;
* short-lived sessions;
* server-side role checks;
* step-up authentication for high-risk actions;
* immediate revocation;
* device/session visibility;
* audit of authentication events.

Any client-held shared admin-key pattern must be removed.

## 29.4 Event and webhook handling

Requirements:

* webhook signature validation;
* raw payload preservation under restricted access;
* event deduplication;
* out-of-order handling;
* replay capability;
* normalized processor events;
* dead-letter queue;
* alerting for backlog or signature failures;
* correlation to operation and idempotency IDs.

## 29.5 Ledger

Use an immutable double-entry ledger for:

* service GMV;
* provider economics;
* platform fee;
* processor cost;
* refunds;
* disputes;
* chargeback losses;
* recoveries;
* reserves;
* funding;
* adjustments.

No operator may edit ledger rows in place.

Corrections use compensating entries with approval.

## 29.6 Read models

Dashboard performance should come from read models, not from weakening canonical transactional rules.

Required read models:

* command-center summary;
* transaction-belt counts;
* active Work Order projection;
* provider eligibility projection;
* payment integrity projection;
* reconciliation projection;
* case queue projection;
* capacity projection;
* analytics funnel projection.

## 29.7 Non-functional targets

Proposed V1 targets:

* P95 primary page load under 2 seconds for normal operating volumes;
* command acceptance response under 1 second, with asynchronous completion where required;
* critical processor events visible within 60 seconds;
* 100% money actions recorded with idempotency and audit evidence;
* 100% exact-address accesses logged;
* zero raw card or KYC secrets in `/OPS`;
* accessible keyboard navigation;
* WCAG 2.1 AA color contrast;
* no status communicated by color alone.

---

# 30. Visual and Interaction Design

## 30.1 Design posture

`/OPS` should feel:

* controlled;
* dense but legible;
* evidence-oriented;
* sober;
* fast;
* predictable.

It should not feel:

* gamified;
* celebratory;
* cinematic;
* consumer-social;
* like an XP leaderboard.

## 30.2 Color semantics

* HustleXP purple: navigation, selection, neutral brand emphasis.
* Green: verified successful state.
* Amber: waiting, approaching threshold, manual review.
* Red: blocked, failed, material risk.
* Blue: informational processor or system state.
* Gray: unknown, unavailable, not applicable.

Color must be accompanied by text and icons.

## 30.3 Interaction rules

* Sticky identity and state header.
* Sticky governed action rail.
* Dense tables with saved views.
* Inline evidence preview.
* Deep links between related objects.
* Side-by-side internal and processor state.
* Confirmation preview before high-risk action.
* No hidden destructive actions.
* No generic editable status dropdown.
* Keyboard shortcuts for navigation, not money execution.
* Mobile version is read-focused; high-risk production actions require desktop and step-up authentication.

---

# 31. Migration From Current `/OPS`

## 31.1 Reverify before migration

Historical implementation notes must not be assumed current.

Before coding:

* inventory current routes;
* inventory current tables;
* inventory current admin functions;
* inventory state owners;
* inventory processor integrations;
* inventory client-held secrets;
* inventory duplicated task/payment objects;
* inventory active feature flags;
* identify every path capable of capturing or moving money.

## 31.2 Freeze dangerous legacy paths

The reported legacy path that captures before canonical task materialization must remain disabled.

Do not rename it and call it the new Financial Security Event flow.

Do not port it unchanged to a new processor.

## 31.3 One canonical owner

For each domain, formally nominate the single canonical owner:

* request;
* quote;
* opportunity;
* provider eligibility;
* Financial Security Event;
* Work Order;
* assignment;
* fulfillment;
* ledger;
* reconciliation.

All duplicate lifecycle tables or functions must be:

* quarantined;
* made non-callable;
* documented;
* retained only if required for historical evidence;
* removed after approved migration.

## 31.4 Historical records

Historical processor records must:

* retain their original processor label;
* retain original external IDs;
* not be rewritten as transactions from a future processor;
* remain distinguishable from new target-state records;
* be reconciled from original evidence where possible.

## 31.5 Migration sequence

1. Build read-only canonical projections.
2. Verify projections against source records.
3. Add Ops Case generation.
4. Add RBAC and audit.
5. Add governed non-money commands.
6. Add processor-neutral payment read model.
7. Add Financial Security Event command path in sandbox.
8. Add capture gates.
9. Add reconciliation.
10. Complete certification.
11. Run controlled pilot.
12. Retire or quarantine legacy write paths.

---

# 32. Delivery Phases

## Phase 0 — Truth and Safety

Deliver:

* current-state inventory;
* canonical ownership map;
* capability registry;
* underwriting decision board;
* RBAC;
* audit foundation;
* legacy payment-path disablement;
* environment and kill-switch ribbon.

**Exit gate:** no unknown production money path remains callable.

## Phase 1 — Read-Only Control Tower

Deliver:

* Command Center;
* Work Queue;
* Request detail;
* Work Order projection;
* Provider projection;
* payment-state projection;
* processor-state freshness;
* source attribution.

**Exit gate:** operator can determine accurate end-to-end state without database access.

## Phase 2 — Governed Transaction Operations

Deliver:

* typed commands;
* task opportunities;
* provider soft reservations;
* scope and quote versioning;
* assignment controls;
* exact-address gate;
* completion evidence;
* Ops Case lifecycle;
* notifications.

**Exit gate:** non-payment transaction operations occur without direct database edits.

## Phase 3 — Payment and Reconciliation

Deliver:

* processor adapter;
* Payment Method references;
* Financial Security Events;
* work-order materialization;
* capture gate;
* settlement/funding projections;
* immutable ledger;
* webhooks;
* daily reconciliation;
* refund and dispute controls.

**Exit gate:** complete sandbox transaction reconciles without manual data repair.

## Phase 4 — Governance and Certification

Deliver:

* all Section 16 certification tests;
* evidence exports;
* independent review;
* restriction and termination controls;
* provider-level and platform-wide kill switches;
* controlled pilot controls.

**Exit gate:** production definition of done passes.

## Phase 5 — Controlled Automation

Deliver only after repeated manual patterns are proven:

* automatic case generation;
* reversible customer/provider reminders;
* provider candidate ranking;
* deterministic soft-reservation support;
* approved expiry recovery;
* completion-evidence triage;
* reconciliation anomaly detection;
* retention recommendations.

**Exit gate:** automation lowers human touches without increasing failure, refund, dispute, or rescue rates.

---

# 33. Scope Deliberately Excluded From V1

Do not spend V1 engineering capacity on:

* cinematic dashboards;
* 3D marketplace maps;
* gamified operator badges;
* AI voice control;
* arbitrary natural-language money commands;
* predictive surge pricing;
* complex workforce scheduling;
* full enterprise accounting;
* unlimited category support;
* annual prepaid service contracts;
* automatic regulated-trade activation;
* fully autonomous disputes;
* fully autonomous refunds;
* autonomous provider replacement before processor approval;
* elaborate executive vanity dashboards.

---

# 34. Stop Conditions and Emergency Controls

Immediately disable the affected capability when any of the following occurs:

* duplicate customer charge;
* duplicate capture;
* duplicate provider funding;
* unexplained ledger mismatch;
* processor and internal state materially disagree;
* exact address released before valid assignment;
* unsupported category reaches payment;
* unapproved provider receives final assignment;
* Financial Security Event occurs in the wrong merchant context;
* capture occurs without completion gates;
* webhook replay changes money twice;
* refund and dispute workflows conflict;
* kill switch fails;
* processor restriction is not enforced;
* daily reconciliation is missed without containment;
* AI executes a prohibited action;
* operator can directly edit canonical money state;
* shared admin credentials are exposed;
* one provider’s restriction unexpectedly halts or contaminates unrelated providers.

Emergency controls must support:

* disable new Financial Security Events;
* disable capture;
* disable refunds;
* disable assignments;
* disable exact-address release;
* disable task-opportunity links;
* restrict one provider;
* restrict one category;
* restrict one geography;
* disable one processor program;
* platform-wide emergency stop.

Disabling a capability must not erase or abandon open obligations. `/OPS` must generate a recovery queue for affected transactions.

---

# 35. Required Acceptance Tests

## State and lifecycle

* [ ] No opportunity can exist without a real open Task Draft.
* [ ] A Task Draft receives a Request ID before payment.
* [ ] A Work Order is not created before a successful Financial Security Event.
* [ ] A provider cannot be hard-assigned from an Express Interest event.
* [ ] A customer address is not released before financial security and assignment.
* [ ] A Task Draft, Work Order, and Payment object remain distinct.
* [ ] The overall lifecycle state cannot be manually edited.

## Provider

* [ ] Processor payment eligibility and HustleXP task eligibility are separate.
* [ ] T0 prospects can only view redacted opportunities.
* [ ] A restricted provider cannot receive a new Financial Security Event.
* [ ] No raw SSN, bank details, or ID image appears in `/OPS`.

## Payments

* [ ] Tokenization is not displayed as financial security.
* [ ] Financial security is not displayed as capture.
* [ ] Capture is not displayed as funding.
* [ ] Funding is not displayed as reconciliation.
* [ ] Every money command has an operation record and idempotency key.
* [ ] Duplicate command submission does not duplicate money.
* [ ] Out-of-order webhooks do not regress or duplicate state.
* [ ] Capture is blocked when any required completion gate fails.

## Replacement and changes

* [ ] Provider A is reversed or resolved before Provider B is secured where required.
* [ ] Customer reauthorization occurs when credential portability is unavailable.
* [ ] Amount changes require scope version and customer approval.
* [ ] Unsupported adjustment paths fail closed.

## Reconciliation

* [ ] Every open Financial Security Event appears in reconciliation.
* [ ] Every capture appears in reconciliation.
* [ ] Every refund and dispute appears in the ledger.
* [ ] A Work Order cannot close with an unexplained mismatch.
* [ ] Daily reconciliation failure creates an owned case.
* [ ] Reconciliation exports are reproducible.

## Security and authority

* [ ] Production `/OPS` requires MFA.
* [ ] No shared permanent admin key is stored in the browser.
* [ ] Every exact-address access is logged.
* [ ] Every production capability change has independent approval.
* [ ] AI cannot execute money, reassignment, private-data, or policy overrides.
* [ ] Kill switches work at provider, category, processor, and platform scope.

## Business-model alignment

* [ ] Marketplace, Provider OS, and BYOP work use one canonical lifecycle.
* [ ] Every Work Order stores relationship origin.
* [ ] Provider OS may use a distinct fee policy without a second hidden payment model.
* [ ] Each recurring occurrence creates a separate transaction.
* [ ] Source attribution survives through completion and contribution margin.
* [ ] Repeat-work opportunities are created after successful completion.

---

# 36. Immediate Execution Checklist

* [ ] Appoint one owner for the canonical task lifecycle.
* [ ] Appoint one owner for the processor-neutral payment adapter.
* [ ] Reaudit the current `/OPS`, database, functions, and payment paths.
* [ ] Disable the legacy captured-payment-before-task path.
* [ ] Replace any browser-held shared admin credential.
* [ ] Create the Underwriting Decision and Capability tables first.
* [ ] Encode the canonical lifecycle and hard invariants as executable rules.
* [ ] Create the immutable audit event model.
* [ ] Create the Ops Case model and severity policy.
* [ ] Build the global truth ribbon and emergency controls.
* [ ] Build the read-only Request, Work Order, Provider, and Payment projections.
* [ ] Build the Work Order multi-rail state display.
* [ ] Build the governed command envelope and action registry.
* [ ] Build task-opportunity link controls with redaction and revalidation.
* [ ] Build Financial Security Event support only after written architecture approval.
* [ ] Build capture gates before exposing a capture action.
* [ ] Build the ledger and reconciliation module before production processing.
* [ ] Implement provider replacement and amount-change paths as fail-closed.
* [ ] Implement all certification tests and independent review.
* [ ] Run one complete sandbox transaction through reconciliation.
* [ ] Run one task-link sandbox flow.
* [ ] Run one provider-estimate sandbox flow.
* [ ] Run one Provider OS sandbox flow.
* [ ] Run one recurring-occurrence sandbox flow.
* [ ] Test per-provider and platform-wide kill switches.
* [ ] Begin a controlled production pilot only after every hard gate passes.

---

# 37. Objective Definition of Done

`/OPS` V1 is done only when an authorized operator can:

1. See a real customer request immediately as a Task Draft.
2. Determine whether the request is qualified, supported, and serviceable.
3. Create either a platform-priced quote or provider-estimate path.
4. Source an existing provider or issue a governed task-opportunity link.
5. Verify processor payment eligibility and HustleXP task eligibility separately.
6. Record a provider’s conditional acceptance without creating a hard assignment.
7. Create the approved Financial Security Event in the correct merchant context.
8. Materialize one Canonical Work Order only after financial security succeeds.
9. Release private fulfillment information only after assignment.
10. Monitor service execution and completion evidence.
11. Block capture when amount, evidence, incident, or notice gates fail.
12. Capture the exact approved amount.
13. Observe settlement and provider/platform funding separately.
14. Reconcile internal ledger and processor records.
15. Handle cancellation, replacement, refund, dispute, and failure without direct database editing.
16. See every automated and human action in an append-only audit record.
17. Identify the owner, deadline, exposure, and next lawful action for every exception.
18. Measure completed paid tasks, provider earnings, repeat behavior, contribution margin, and human-operations leverage.
19. Export a complete underwriting, certification, transaction, or dispute evidence package.
20. Shut down the affected capability immediately without corrupting open obligations.

The final standard is not that `/OPS` looks comprehensive.

The final standard is:

> **Every real transaction has one canonical truth, every transition has explicit authority, every exception has an owner, every money movement reconciles, and the business can fulfill safely without relying on founder memory or hidden manual rescue.**
