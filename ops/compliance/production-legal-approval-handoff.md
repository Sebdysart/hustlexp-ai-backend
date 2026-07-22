# HustleXP Washington production legal approval handoff

**Gate:** `EXT-LEGAL-001`

**Current decision:** `PENDING_COUNSEL`

**Production effect:** production activation is forbidden

**Controlled policy:** `US-WA` / `us-wa-price-book-2026-07-20-v2`

**Controlled implementation:** `5936ea0b675f17038feaf9565e5baa7d3b1e8211`

This is an engineering control and review packet, not legal advice or legal approval. The machine-readable source of truth is `ops/compliance/production-legal-approval.json`; the verifier must remain red until qualified Washington counsel and the named HustleXP policy owner approve the exact policy, public copy, launch jurisdictions, release revisions, and exceptions.

## Decision requested

Counsel must approve or reject every determination below. Silence, email acknowledgement, a generic engagement letter, a Terms page, or prior review of a different revision is not approval.

1. Worker classification and the public independent-contractor model for each approved provider type and launch locality.
2. Category boundaries, including licensing, registration, bonding, insurance, hauling, home-entry, screening, and credential rules.
3. Screening purpose and timing, standalone consent, individualized assessment, notices, waiting periods, report access, disputes, appeals, delivery, retention, and staffed operations.
4. Precise-location, address, proof-media, identity, processor/subprocessor, analytics, deletion, and retention language and controls.
5. Protected-funds language, payout timing, fees, cancellations, refunds, tax reporting, worker economics, and provider contracts.
6. Dispute remedies, arbitration, class waiver, liability limits, governing law, notices, and affirmative acceptance.
7. Safety intake, emergency boundaries, check-ins, home-entry controls, location retention, proof capture, and the recording prohibition.

## Exact controlled scope

The policy currently permits only:

| Category             | Risk levels          | Screening    | License      | Insurance    | Proof      |
| -------------------- | -------------------- | ------------ | ------------ | ------------ | ---------- |
| `moving`             | LOW, MEDIUM          | Required     | Not required | Not required | 2–5 photos |
| `yard`               | LOW                  | Not required | Not required | Not required | 1–5 photos |
| `cleaning`           | LOW, MEDIUM, IN_HOME | Required     | Not required | Not required | 2–5 photos |
| `furniture_assembly` | LOW, MEDIUM, IN_HOME | Required     | Not required | Not required | 2–5 photos |

Recording is disabled. The policy requires standalone screening consent, report access, dispute and appeal, adverse-action notice, incident intake, timed check-ins for MEDIUM/HIGH/IN_HOME work, an alternate emergency action, and a 30-day location-retention ceiling. The financial floors are USD 50 customer total, USD 40 worker payout, and USD 5 platform margin.

Counsel must explicitly decide whether each boundary is sufficient. In particular, the absence of license and insurance requirements in the four current categories must not be inferred to be lawful merely because the database encodes it.

## Public copy requiring review

The bound site revision is `b55ae5a1815feda78054eb284e5d5ccf6883ac2d`.

- Terms v1.2 states that Hustlers are independent contractors, promises 1099 issuance as required, uses Washington governing law, binding arbitration, a class waiver, a liability cap, payment/payout language, and a soft-launch notice.
- Privacy v1.1 states collection and retention rules, names processors/providers, describes analytics, and makes deletion and notice commitments.
- The screening-rights grounding document explicitly states that it is not legal approval and lists classification, screening, notice, retention, waiting-period, provider, accessibility, delivery, and Operations blockers.

Counsel must approve corrected public copy if any statement is inaccurate. Any correction changes its SHA-256 and invalidates this packet until the manifest and approval are rebound.

## Required approval record

The approval evidence must be a signed, immutable external record. Store only its HTTPS location, SHA-256, and signature method in the packet; do not commit privileged advice or unnecessary personal identifiers.

The completed JSON record must include:

- counsel name, organization, and Washington qualification;
- named policy and activation owners;
- approval, effective, and mandatory review timestamps;
- `US-WA` plus every approved local jurisdiction;
- exact allowed categories, prohibited scope, and exceptions;
- exact regional policy version and runtime database policy hash;
- exact approved and deployed engine/site revisions and deployment identities;
- an `APPROVED` result for all seven determinations;
- the signed record's HTTPS URI, SHA-256, and signature method.

## Activation and expiry rule

Approval is invalidated by any policy, category, risk, jurisdiction, public legal copy, worker model, provider contract, screening flow, retention, money-flow, deployment revision, or material legal change. It also expires at `review_at`. A generic approval cannot be carried forward.

Production activation may proceed only after:

1. the target engine revision containing the controlled policy is deployed;
2. the runtime `region_policies.policy_hash` is captured through a read-only, trusted connection;
3. the exact site and engine deployment identities are written into the packet;
4. the signed external approval is attached and all seven determinations are `APPROVED`;
5. `npm run verify:production-legal-approval` exits zero;
6. the regional production flag is activated through a reviewed, append-only database event; and
7. the verifier is rerun against the post-activation deployment.

## Falsifiable exit test

The gate is closed unless the production legal verifier exits zero with no findings, the target database reports the same active `US-WA` policy version and SHA-256, the exact approved revisions equal the exact deployed revisions, and the signed approval is current. Any mismatch returns the launch decision to NO-GO.
