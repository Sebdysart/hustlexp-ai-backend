# HustleXP backend execution contract

Production launch: `NO-GO`

This file is the repository workflow contract for coding agents and IDE tools. Read
[the team goal](docs/HUSTLEXP_TEAM_ALIGNMENT.md), [the current checkpoint](docs/HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md), and [CLAUDE.md](CLAUDE.md) before changing money, lifecycle, Operations, migration, queue, or deployment behavior.

## Authority and evidence

1. For every HustleXP task, run `$hustlexp-governor` preflight from `/Users/sebastiandysart/Documents/New project/hustlexp-governor-control/.hustlexp/governor.json` before substantive work. Load only the manifest-selected current state, checkpoint, evidence ledger, dependency graph, requirements registry, revision lock, manifest, and accepted proof artifacts.
2. Fail closed when canonical evidence is missing, stale, contradictory, malformed, or unauthorized. Conversation history and documentation are context, never program authority.
3. Keep workflow admission, implementation, evidence freshness, independent review, release authority, deployment identity, and production health separate. A green test proves only its exact command on its exact tree.
4. Enforce one code-changing Governor node. Normal work must never edit, install, regenerate, weaken, accept, or approve the Governor. Governor maintenance requires a fresh `$hustlexp-governor-maintainer` session and a different independent acceptor.
5. Never perform a provider, persistent-database, GitHub publication, merge, deployment, or production write without exact current authority for that effect.

## Binding architecture

- Railway PostgreSQL is canonical for transaction, task, provider, financial, audit, outbox, and reconciliation truth. Supabase is acquisition/read-model overlay only.
- New production customer-money creation is structurally disabled. Environment values, Stripe mode, or test receipts cannot enable it. Preserve refund, void, recovery, webhook, dispute, and reconciliation lanes.
- Task identity and eligibility precede any future financial-security event. Never restore processor-first task materialization.
- Consequential Operations writes use named authenticated `opsProcedure`/`opsSensitiveProcedure` boundaries and typed engine commands. Reject browser shared keys, caller-supplied actors, direct canonical status writes, and arbitrary status strings.
- Money and lifecycle mutations require immutable evidence, deterministic idempotency, optimistic version checks, and database backstops. `escrow_events`, ledgers, and security evidence are append-only except an explicitly reviewed narrow privacy transform.
- BullMQ `job.id` is transport identity only. Database claim/ACK authority uses the durable `_outbox_key`; consumers must validate `job.id === outboxTransportJobId(_outbox_key)` before using that key. Financial payloads also require exact signature verification.
- External calls use shared clients, circuit breakers, bounded retry/replay rules, and durable pre-provider claims. Never retry a money-creating provider call after its safe replay window without exact provider discovery.

## Required local evidence

CI uses Node 22 and the committed lockfile. Do not commit vendored package-manager trees or generated caches.

```sh
npm run typecheck
npm run lint -- --max-warnings 0
npm test -- --maxWorkers=1
npm run compile
npm audit --omit=dev --audit-level=high
git diff --check
```

The protected build also executes fresh, upgrade, replay, recovery, and PR276 containment migrations on PostgreSQL 17.7, builds the production image, and verifies exact migration/build identity. Database-dependent tests skipping locally is not database proof.

## Publication and release

- Use a `codex/` branch; never push directly to `main`.
- Preserve user changes and never weaken tests, rulesets, workflows, evidence, or assertions to obtain green checks.
- Publication requires a clean exact tree, fresh Governor admission, signed commits, all required checks, resolved review threads, and independent approval of the exact final push.
- `main` is protected by the active repository ruleset. No bypass is authorized.
- Railway Git integration can make a `main` merge production-consequential. Disable or contain that path under accepted authority before merge, then prove web source SHA, worker source/image, database migration identity, and `/health` revision agree exactly.
- Production remains `NO-GO` after containment. Enabling money requires the separately accepted underwriting, processor, legal, sandbox, reconciliation, incident, and two-person release gates.

## Documentation discipline

Update current documents with every accepted change. Preserve files labeled `FROZEN_EVIDENCE`, `SOURCE_CONTRACT`, `HISTORICAL_SNAPSHOT`, or `TEMPLATE`; do not rewrite history to look current. Exact mutable facts belong in the current checkpoint, while the stable objective belongs in the team goal.
