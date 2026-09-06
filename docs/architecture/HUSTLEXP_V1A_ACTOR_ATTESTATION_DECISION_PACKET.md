# HustleXP V1A PostgreSQL actor-attestation decision packet

- Owner-decision status: `AUTHORIZED_LOCAL_NONPROD_IMPLEMENTATION_PENDING`
- Release status: `RELEASE_BLOCKED_PENDING_IMPLEMENTATION_AND_INDEPENDENT_REVIEW`
- Decision: `OPTION_A_ISOLATED_ONE_TIME_ACTOR_ATTESTER`
- Scope: Universal V1A consequential PostgreSQL commands in isolated local,
  preview, and staging environments using synthetic data and fake value
- Production effects: `NONE`
- Production money: `FROZEN`
- Production hard assignment: `FROZEN`
- Independent security/release approval: `ABSENT`

The owner has authorized Option A as the implementation direction for
local/nonproduction work. That authorization selects the design; it is not an
independent security review, release approval, database provisioning receipt,
or proof that any function or role exists. The machine-readable record is
`backend/database/work-order-command-authority.HOLD.json`, which remains
non-authorizing and release-blocking.

## Authorized decision

Use an isolated identity-attestation service and a PostgreSQL login that are
separate from API, worker, migration, command-owner, assertion-owner, and
finance-owner identities.

For each consequential command, the attester must independently reverify the
original bearer, including revocation, issuer, audience, and expiry. It resolves
the verified subject rather than accepting an actor UUID selected by the
browser or API. Command-specific authentication and step-up facts are recorded
and rechecked according to the command policy; this decision does not invent a
blanket MFA policy for ordinary customer or provider commands.

The attester creates a random 256-bit opaque one-time token. Only its SHA-256
digest may be persisted. The plaintext token may exist transiently in attester
and API memory but must never be stored, logged, placed in a URL, returned in
health output, or included in immutable audit. PostgreSQL owns issuance time and
expiry. The database-owned maximum assertion lifetime is exactly 60 seconds;
the effective lifetime must be shorter when the verified bearer expires sooner.

The assertion binds all of the following:

- exact environment;
- command kind;
- canonical command/request SHA-256;
- independently verified subject;
- relevant authentication and step-up facts;
- verification and expiry time.

Issuance and consumption are separate append-only facts. Consumption is
one-time and occurs inside the same serializable transaction as the protected
command. A sealed function maps the verified subject to the canonical user,
recomputes or rechecks the exact command binding, and rechecks current account,
role, capability, version, and domain authority. A custom PostgreSQL setting,
caller-supplied actor UUID, or secret shared with the API/worker is not identity
authority.

## Required eight-role topology

The exact configured database identifiers remain unprovisioned and therefore
`null` in the HOLD. Their logical responsibilities are fixed:

| Logical role | Login | Authorized shape |
|---|---:|---|
| Migrator | Yes, one-shot | Applies the exact approved migration manifest; never an API/worker credential and cannot execute runtime command entrypoints |
| API | Yes | Read access required by API projections and `EXECUTE` only on approved human command entrypoints; no direct protected DML |
| Worker | Yes | Read access required by workers and `EXECUTE` only on approved worker/recovery entrypoints; no direct protected DML |
| Attester | Yes | May issue assertions only through the sealed issuer; cannot consume assertions or execute Work Order commands |
| Command owner | `NOLOGIN` | Owns sealed Work Order commands; no elevated attributes or cross-role membership |
| Assertion owner | `NOLOGIN` | Owns assertion relations, issuer, and consumer; no elevated attributes or cross-role membership |
| Finance owner | `NOLOGIN` | Owns separately certified provider-neutral financial commands; its existence grants no Work Order, payment, settlement, payout, or production capability |
| Telemetry owner | `NOLOGIN` | Owns the sealed major-action telemetry functions; receives only their exact read/insert dependencies and no command, finance, or protected-table ownership |

All eight roles must be pairwise distinct, have no superuser, role-creation,
database-creation, replication, or row-security-bypass attribute, and have no
cross-membership. API, worker, and attester logins must lack `CREATE` on
`public`. Migration credentials remain outside API, worker, and attester
services.

## Planned database objects and function identities

The implementation may create a protected `hx_authority` schema containing
immutable assertion-issuance and assertion-consumption facts. It must not store
the opaque token itself.

The planned sealed identities are:

```text
public.hxos_issue_universal_v1_actor_assertion_v1(
  text,text,text,text,jsonb,timestamptz
)

hx_authority.consume_universal_v1_actor_assertion_v1(
  text,text,jsonb,text
)

public.hxos_express_universal_v1_post_estimate_interest_v1(
  text,uuid,integer,text,timestamptz
)

public.hxos_place_universal_v1_conditional_hold_v1(
  text,uuid,integer,text,timestamptz
)

public.hxos_prepare_universal_v1_fake_work_order_v1(
  text,uuid,integer,text,timestamptz
)

public.hxos_materialize_universal_v1_fake_work_order_v1(
  text,text,text,uuid
)

public.hxos_request_universal_v1_fake_work_order_recovery_v1(
  text,text,text,uuid
)

public.hxos_claim_universal_v1_work_order_compensation_v2(
  integer,integer
)
```

The attester alone may execute the issuer. The assertion consumer is internal
and executable only by the no-login command owner. The API may execute only the
five API entrypoints. The worker may execute only the bounded recovery claimant.
`PUBLIC` and the migrator may execute none of them.

Every entrypoint is planned as `SECURITY DEFINER`, `VOLATILE`, with the exact
fixed search path `pg_catalog`. It must fully qualify protected objects,
derive the actor from the consumed assertion, bind expected versions and
idempotency, and emit immutable command/audit evidence. These are planned
identities, not implemented or provisioned facts.

The finance owner remains distinct because fake financial execution has a
separate authority boundary. A Work Order command may verify an exact successful
fake Financial Security Event; it does not receive direct financial-table write
authority and cannot activate real money.

## Protected write surface and alternate writers

API, worker, and attester direct `INSERT`, `UPDATE`, `DELETE`, and `TRUNCATE`
must ultimately be absent from:

- `public.task_work_order_command_requests`;
- `public.task_provider_eligibility_decisions`;
- `public.task_work_orders`;
- `public.task_work_order_execution_facts`;
- `public.task_reservations`;
- `public.task_applications`.

Direct DML must not be revoked prematurely. Every existing writer must first be
ported to a typed sealed command or structurally held. This includes Work Order
interest, hold, prepare, materialize and recovery; execution, fulfillment and
change-order facts; opportunity and legacy application writers; legacy
reservation/assignment writers; and privacy erasure. Universal V1 privacy
redaction must preserve immutable authority evidence rather than generically
rewriting a canonical actor fact.

Production hard assignment remains frozen. Interest is not assignment, a
conditional hold is not assignment, and Work Order materialization under this
local/nonproduction plan must continue returning
`hard_assignment_created=false` and `payment_creation_performed=false`.

## Required implementation sequence

1. Preserve this decision and the machine-readable HOLD without granting
   runtime authority.
2. Implement the assertion schema and sealed functions in an append-only
   migration.
3. Provision and read back the eight exact roles in disposable local
   PostgreSQL, then in isolated preview/staging through approved secret
   references.
4. Add the isolated attester and bind the API request without exposing the
   bearer or token.
5. Port or structurally hold every protected-relation writer.
6. Revoke direct DML only after the writer inventory is proven complete.
7. Run genuine distinct-login authorization, concurrency, recovery, migration,
   and public API/worker tests.
8. Obtain independent security review and the normal exact-SHA protected-release
   approvals. Owner authorization and Codex review do not satisfy this step.

## Acceptance evidence

The release block remains until exact candidate evidence proves:

- the eight configured roles exist, are pairwise distinct, and match their
  login, ownership, membership, and elevated-attribute requirements;
- runtime database target v3 binds the canonical eight-role-topology digest to
  the database, environment, release, build, and target identity before any
  listener or worker may be treated as authoritative;
- forged, expired, reused, wrong-environment, wrong-command, wrong-binding, and
  wrong-actor assertions are denied;
- only a SHA-256 token digest is persisted and the maximum assertion lifetime is
  60 seconds;
- assertion issuance, consumption, command, and audit facts are append-only;
- API, worker, and attester direct protected DML is denied;
- exact retry returns one result and changed payloads conflict;
- current actor, role, capability, expected-version, and domain authority are
  rechecked at consumption;
- Work Order materialization versus recovery produces exactly one winner under
  concurrency and crash-boundary tests;
- function owner, ACL, volatility, fixed search path, schema privileges, and
  live session identities match the approved manifest;
- a real authenticated HTTP to attester to API to worker journey succeeds on
  synthetic data and fake value without creating hard assignment or production
  money;
- an independent human reviewer approves the exact implementation and the
  normal last-push, hosted-check, conversation-resolution, signature, and
  protected-merge gates remain satisfied.

## Non-authority and exclusions

This decision does not authorize a migration, role creation, credential
distribution, deployment, persistent-target mutation, live communication,
processor call, payment creation, capture, settlement, payout, banking effect,
production database change, production deployment, or real hard assignment.
It does not count as independent security or release approval.

Safe unrelated local work may continue. The dependent Work Order authority and
end-to-end certification lanes remain release-blocked until implementation,
live readback, tests, and independent review all succeed on the exact candidate.
