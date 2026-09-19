# Terms and policy acceptance contract

Status: `PROPOSED_NOT_BUILT / COUNSEL_APPROVAL_REQUIRED`

Production effects authorized: `NONE`

This file does not declare a current Terms of Service version, effective date, route, retention rule, or legal requirement. Those must be supplied and approved by qualified counsel for the exact entity, jurisdiction, user role, category, relationship origin, processor model, and release.

## Target version registry

An approved registry must record:

- immutable policy/version ID and content hash;
- document type, entity, jurisdiction, role, category, origin, and language;
- approved/effective/retired timestamps;
- counsel and policy-owner approval references;
- material-change and re-acceptance decision;
- public artifact/build identity;
- superseded version and change summary;
- retention, legal-hold, deletion/unlinking, and access policy.

## Acceptance evidence

Acceptance must be:

- affirmative, purpose-specific, and tied to the exact content hash/version;
- recorded with server time and server-derived authenticated principal where authentication is required;
- linked to the relevant task/transaction and policy snapshot when used as a gate;
- immutable except for approved privacy unlinking that preserves legal/financial evidence;
- unavailable to AI or browser code as an authority decision;
- separately versioned for terms, privacy, communications consent, category-specific disclosures, price/scope, and other legally distinct decisions.

Absence, stale acceptance, wrong role/jurisdiction, content drift, or withdrawn consent must fail closed for the exact dependent capability without rewriting historical evidence.

## Change process

1. Counsel and policy owner approve exact content and applicability.
2. Engineering packages content/hash/version and deterministic eligibility rules.
3. Independent review verifies routes, UI, accessibility, storage, audit, and fail-closed behavior.
4. Deployment and user communication require separate current authority.
5. Re-acceptance, expiry, withdrawal, and recovery are monitored and tested.

**Done Criteria:** Counsel-approved versions, applicability rules, public artifacts, acceptance evidence, withdrawal/re-acceptance, privacy/retention, and independent tests agree on the exact candidate.

**Test Plan:** Change content hash, role, jurisdiction, category, origin, or effective time. Existing acceptance must not silently authorize the changed contract.

See [the Team Goal and Execution Contract](../../docs/HUSTLEXP_TEAM_ALIGNMENT.md) and `production-legal-approval-handoff.md`.
