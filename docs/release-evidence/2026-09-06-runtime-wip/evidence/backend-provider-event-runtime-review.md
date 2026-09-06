# Provider-event worker runtime integration

Recorded 2026-09-06T21:09:08.098Z. Backend incomplete; this is local implementation evidence, not release certification.

Normal nonproduction startup previously launched the retained legacy provider-event replay poller. Its repository queries and mutates legacy processing tables and invokes an owner-only normalization function. The new PostgreSQL proof reproduces SQLSTATE 42501 through the genuine restricted worker connection, while the supported sealed recovery discovery command succeeds. API and attester logins remain denied that worker command. No database privilege was widened.

Startup now uses the existing sealed durable financial recovery loop for independently authenticated observations. It awaits initial recovery before proceeding and retains the existing publisher, compensation and change-order requirements. The providerEventReplay health response field is preserved, with processor SEALED_FINANCIAL_COMMAND_RECOVERY and state derived from the same captured recovery health. It cannot independently claim health while that recovery path is degraded, stopped or missing. Legacy repository, normalizer, migration evidence and opt-in library tests remain intact; the obsolete poller is no longer scheduled by normal boot.

Regression evidence: **8 failures before the behavior change; 103 tests pass across eight complete files afterward**. Coverage includes boot wiring, actual HTTP health responses, unchanged staging/production holds, initial-start failure cleanup, shutdown ordering, scheduling, retained legacy replay and durable recovery sweeps. **Two real PostgreSQL authority cases pass**. Expanded TypeScript, zero-warning lint and whitespace checks pass.

These checks do not prove a complete signed OS-process boot or every end-to-end financial journey. The old provider-observation-normalization PostgreSQL file still requires historical/current coverage integration; it is not repaired by changing startup. Remaining work-order compensation, provider-account, estimate/history and terminal financial callers remain open.

All eight Docs metadata values match the current snapshots at 2026-09-06 21:05:59 UTC. All 242 SQL files are unchanged. There are **15 source changes relative to public 1da48ae**, including the prior preparation/readiness changes. A new complete required run is RUNNING on session **97960**, started 2026-09-06T21:05:12.960Z, against a frozen 1809-source-entry / 1918-entry isolated inventory. The primary checkout is available for safe independent work. Do not run overlapping PostgreSQL suites or change the frozen checkout while it runs.

The last completed full gate remains **11,034 passed, 24 failed, 15 skipped, 0 todo across 697 files; FAIL**. That run excludes the later preparation and worker-runtime changes. No new full totals or release eligibility are claimed. No commit, push, deployment, customer-money effect or hard assignment occurred.

[Exact sources and validation evidence](backend-provider-event-runtime-review-manifest.json).
