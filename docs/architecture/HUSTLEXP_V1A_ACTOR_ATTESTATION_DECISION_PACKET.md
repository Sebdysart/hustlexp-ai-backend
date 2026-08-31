# HustleXP V1A PostgreSQL Actor-Attestation Decision Packet

- Status: `HOLD — EXTERNAL_DECISION_REQUIRED / RELEASE_BLOCKING`
- Prepared: 2026-08-30
- Scope: Universal V1A consequential PostgreSQL commands
- Affected gates: Gate 2 directly; the authoritative Gate 3 end-to-end command lane transitively

## Decision required

Approve one independently verifiable way for PostgreSQL to bind a consequential command to the authenticated human who authorized its exact payload. Until that decision is approved and implemented, the application may continue safe read-model, routing, fake-provider, orchestration, and test work, but no Universal V1A command lane may be certified as release-authoritative.

- Decision owner: `UNASSIGNED — human Platform/Security owner required`
- Security approver: `UNASSIGNED`
- Approval evidence: `ABSENT`
- Target environments: local, preview, staging; production remains held

## Current evidence

The application currently establishes a strong identity chain through token verification with revocation checking, a named active user, current Operations RBAC, and fresh MFA/step-up. It then passes `ctx.user.id` to PostgreSQL over a shared runtime connection.

That UUID is useful audit provenance, but PostgreSQL cannot prove that it came from the verified token. Code running with the shared runtime login can supply a different UUID. API, worker, and migration processes also are not yet proven to use separate least-privilege roles. Direct runtime DML remains possible on some command-owned relations.

The current Work Order role-authority verifier therefore correctly reports actor binding as absent and the protocol as unapproved. Existing HMAC secrets held by the same runtime do not create an independent trust boundary.

## Recommended decision: isolated one-time identity attestation

Approve an identity-attestation service and role that are separate from the API and worker runtimes.

1. The attester re-verifies the Firebase bearer token with revocation checking, exact issuer/audience, token expiry, MFA, and authentication recency.
2. The attester canonicalizes the exact command and records an append-only assertion containing:
   - Firebase UID rather than a caller-selected database UUID;
   - environment and command kind;
   - exact canonical request SHA-256;
   - MFA/authentication facts and verification time;
   - a random 256-bit one-time token digest/JTI;
   - an expiry no longer than 60 seconds.
3. Only an attester-specific PostgreSQL login can insert assertion facts. API and worker roles receive no insert, update, delete, or truncate privilege on assertion relations and cannot mint assertions.
4. The API receives only the opaque one-time token and passes it with the command. It never accepts an actor UUID from the client.
5. A sealed command function resolves the Firebase UID to the canonical user, consumes the assertion exactly once, recomputes the request hash, and rechecks active identity, role, capability, step-up, expected versions, and domain authority inside the same serializable transaction.
6. Assertion consumption is an append-only fact. Replays return the original result only for the exact command and cannot consume or mutate a second assertion.

The initial estimate-lane command shape should be:

```sql
public.issue_universal_v1_initial_eligibility_invitation_v1(
  p_actor_assertion_token text,
  p_task_draft_id uuid,
  p_provider_user_id uuid,
  p_expected_draft_version integer,
  p_idempotency_key text,
  p_client_ts timestamptz
)
```

The client must not supply actor, organization, credential, provider class, category, region, risk, proof, availability, price, financial eligibility, or policy fields.

## Required PostgreSQL authority shape

- Separate logins for migrations, API runtime, identity attester, and preferably worker runtime.
- Separate `NOLOGIN` owners for sealed commands and assertion relations.
- Command functions are `SECURITY DEFINER`, `VOLATILE`, and set the exact search path `pg_catalog, public`.
- Runtime roles receive `EXECUTE` only on sealed commands and read-only access required by their projections.
- Runtime direct DML is revoked from eligibility, quote, invitation, hold, Work Order, assignment, address-grant, command-evidence, and assertion relations.
- `PUBLIC` and migration/runtime roles cannot execute internal trigger helpers or mint assertions.
- Runtime roles do not have `CREATE` on `public` and cannot set a custom session value that substitutes for identity proof.
- Existing alternate writers, including post-estimate eligibility insertion, must be sealed or held before protected-relation DML is revoked.

## Domain requirements for the first sealed command

Inside one `SERIALIZABLE` transaction, the function must:

- lock the exact TaskDraft, active route, provider, organization, credential, service-cell authority, and relevant restriction facts;
- require the expected active `ESTIMATE_REQUIRED` route version;
- derive all seven eligibility dimensions from current server/database authority;
- record a negative eligibility fact without creating a quote or invitation;
- for an eligible result, atomically create the eligibility fact, empty provider-estimate quote shell, and immutable invitation;
- keep `processor_payment_eligible=false` and `payout_funding_eligible=false`;
- record `final_availability_confirmation_required=true`;
- create no payment, escrow, Financial Security Event, hold, assignment, address grant, Task, or Work Order.

## Alternatives requiring an explicit decision

### A. Isolated one-time attester — recommended

Strong request binding and clean role separation. Adds one small service/credential boundary and operational rotation/monitoring obligations.

### B. Per-request database identity through an approved gateway

Acceptable only if the gateway cryptographically authenticates the end user and PostgreSQL can independently verify the bound identity and request. A freely settable session variable, JWT decoded only by application code, or shared runtime role is not sufficient.

### C. Keep the command lane held

Safest default when A or B is not approved. Continue all unaffected build/test work, but do not certify or promote the end-to-end command lane.

## Rejected shortcuts

- Trusting a client-supplied or application-supplied actor UUID.
- Signing with a secret available to the same API/worker runtime.
- Treating application RBAC alone as PostgreSQL command authority.
- Granting broad table DML and relying only on repository conventions.
- Using mutable session settings as the authorization proof.
- Marking the verifier ready without independent readback evidence.

## Acceptance evidence

Approval and implementation are complete only when automated tests and live readback prove:

- forged, expired, reused, wrong-environment, wrong-command, wrong-request-hash, and non-MFA assertions are denied;
- client actor spoofing is impossible;
- role/capability revocation after assertion minting is rechecked and denied;
- direct runtime insert, update, delete, and truncate are denied on every protected relation;
- exact retries replay one result and changed payloads conflict;
- negative eligibility creates no quote or invitation;
- concurrent calls produce one authoritative eligibility/invitation result;
- assertion, consumption, command, and audit facts are append-only;
- function owner, ACL, volatility, fixed search path, role shape, and relation privileges match the approved manifest;
- API, worker, migration, and attester identities are distinct in local/preview/staging health readback.

## Safe work while held

The hold does not block deterministic routing, privacy-safe occurrence projections, provider-neutral fake financial behavior, nonproduction refusal guards, tests, clean-clone orchestration, synthetic fixtures, or documentation. It blocks only claims that consequential PostgreSQL command authority—or an end-to-end release candidate depending on it—is complete.

Production payment creation, hard assignment, deployment, and production database changes remain frozen regardless of this decision.
