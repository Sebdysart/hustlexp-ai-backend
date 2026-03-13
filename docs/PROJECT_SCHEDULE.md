# HustleXP Backend — Project Completion Schedule

**Purpose:** Time schedule and milestones so we know when things are done. Safe to share with teammates or friends.

**Last updated:** 2026-03-13  
**Fill in the “Target date” column with your real dates.**

---

## Overview

| Phase | What we do | Effort | Target date | Status |
|-------|------------|--------|-------------|--------|
| **1** | Single source of truth (architecture doc + start guide) | 1–2 days | _e.g. 2026-03-20_ | ⬜ Not started |
| **2** | Consolidation (migrations, env, scripts) | 2–5 days | _e.g. 2026-03-27_ | ✅ Started / in progress |
| **3** | Conventions & guardrails (rules, decision log) | ~1 day + ongoing | _e.g. 2026-04-03_ | ⬜ Not started |
| **4** | Optional: deeper docs, critical paths | As needed | _TBD_ | ⬜ Not started |

---

## Phase 1 — Single source of truth (1–2 days)

| Task | Deliverable | Target date | Done |
|------|-------------|-------------|------|
| Write architecture doc | `docs/ARCHITECTURE.md` (request flow, layers, migrations, deployment) | | ⬜ |
| Add “Start here” for new devs | README or `CONTRIBUTING.md` (run app, workers, migrations, tests) | | ⬜ |

**Phase 1 complete when:** New dev can find how the system works and how to run it in one place.

---

## Phase 2 — Consolidation (2–5 days)

| Task | Deliverable | Target date | Done |
|------|-------------|-------------|------|
| Pick one migration folder | Single migration story in `docs/MIGRATIONS.md` | | ✅ |
| Env/config reference | `docs/ENV.md` + `.env.template` | | ✅ |
| Single scripts location | `docs/SCRIPTS.md`; canonical `scripts/`; duplicate removed | | ✅ |

**Phase 2 complete when:** No confusion about where migrations live or which script to run — **Done.**

---

## Phase 3 — Conventions & guardrails (~1 day + ongoing)

| Task | Deliverable | Target date | Done |
|------|-------------|-------------|------|
| Dev rules (Cursor/IDE) | `.cursor/rules` or `AGENTS.md` (where to add API, migrations, env) | | ⬜ |
| Decision log | Short “why” notes (e.g. migrations location, Railway vs AWS) | | ⬜ |
| Optional: router–service map | Doc or list of “router X → services A, B” | | ⬜ |

**Phase 3 complete when:** New changes follow the same conventions.

---

## Optional: Product / launch milestones

*Use this section if you want to track “when is the project/product done” for your friend.*

| Milestone | Description | Target date | Done |
|-----------|--------------|-------------|------|
| Backend stable | Phases 1–3 done; codebase handleable | _e.g. 2026-04-03_ | ⬜ |
| Beta / internal launch | Seattle Metro beta live, invite-only | _your date_ | ⬜ |
| General availability | Public launch (if applicable) | _your date_ | ⬜ |

---

## Quick view (copy-paste for your friend)

**What we’re doing:** Making the HustleXP backend easy to work on (one architecture doc, one place for migrations and scripts, clear rules for new code).

**Rough timeline:**

- **Week 1:** Architecture doc + “Start here” guide.
- **Week 2:** One migration folder, one env reference, no duplicate scripts.
- **Week 3:** Conventions and rules so new code stays consistent.
- **After that:** Optional docs and improvements as needed.

**Target to be “stable and handleable”:** _[Put your date here, e.g. by end of March 2026]_

---

*Update the “Target date” and “Done” columns as you go. You can share this file as-is or export the tables to a message.*
