# HustleXP Backend — Project Success Plan

**Purpose:** Shared opinion and roadmap for making this codebase **understandable, navigable, and safe to change** without a full rewrite.

**Status:** Proposed  
**Audience:** Team, stakeholders, future maintainers  
**Last updated:** 2026-03-13

---

## 1. Shared Opinion: What “Success” Means

Success for this project is **not** “perfectly clean code.” It is:

- **Handleable** — Any developer can find where a feature lives and what it depends on.
- **Documented** — One place describes how the system works and how to work in it.
- **Stable** — Changes don’t surprise us; deployment and migrations are predictable.
- **Improving** — New work follows clear rules so the codebase doesn’t get more mixed over time.

We treat the current state as **legacy-but-valuable**: the architecture (Hono, tRPC, services, workers) is sound; the issue is discoverability, duplication, and missing guardrails.

---

## 2. Current State (Why This Plan Exists)

| Area | Situation |
|------|-----------|
| **Size** | 48 tRPC routers, 68+ services, 23 workers, 39+ migrations, 700+ files. |
| **Migrations** | **Resolved:** Canonical schema is `backend/database/constitutional-schema.sql`; applied via `npm run db:migrate`. Root `migrations/` folder removed; reference SQL lives in `backend/database/migrations/`. |
| **Scripts** | Duplicates (e.g. `analyze-migration-safety.ts` in both `scripts/` and `backend/scripts/`). |
| **Deployment** | README/Procfile describe Railway; Terraform provisions full AWS (ECS, ALB, WAF, CDN). Both valid but not clearly “when to use which.” |
| **Docs** | README is strong; no single architecture doc that maps request flow, layers, and conventions. |
| **Onboarding** | “Where do I add a new API?” and “How do I run migrations?” require digging. |

The plan below turns this into a **phased, low-risk path** to a handleable project.

---

## 3. Guiding Principles

1. **Stabilize first, refactor later** — Fix “where things live” and “how we work” before big code moves.
2. **One source of truth per concern** — One migration folder, one architecture doc, one env/config reference.
3. **Document the “why”** — Short decision notes so the current mix is intentional, not accidental.
4. **Guardrails for new work** — Conventions and rules so new code doesn’t re-mix the codebase.
5. **No big-bang rewrite** — Improve incrementally; avoid “rewrite the backend” unless there is a clear business reason.

---

## 4. Phase 1 — Single Source of Truth (Priority: High)

**Goal:** One place to understand the system and one place to start as a new developer.

**Effort:** 1–2 days  
**Owner:** TBD

### 4.1 Create `docs/ARCHITECTURE.md`

A single architecture document that defines:

- **Request flow:** Client → Hono → tRPC (or REST) → Router → Service → DB / Redis / external APIs.
- **Layers:** Layer 0 (DB, triggers), Layer 1 (services), Layer 2 (routers), Layer 3 (AI agents). What lives where.
- **Entry points:** `backend/src/server.ts` (API), `backend/src/jobs/workers.ts` (workers). What each does.
- **Migrations:** Where migration files live, how they are run (`npm run db:migrate` or equivalent), and which directory is canonical (see Phase 2).
- **Deployment:** When to use Railway (quick deploys, staging) vs Terraform/AWS (production, full control). One paragraph each.
- **Key domains:** Core (task, escrow, user), payments, AI, trust/safety, platform features. Point to representative routers and services.

**Deliverable:** `docs/ARCHITECTURE.md` checked in and linked from README.

### 4.2 “Start Here” for New Developers

Add a short **“Start here”** section (in README or a small `CONTRIBUTING.md`) that covers:

- Prerequisites (Node, env vars, `.env` from template).
- How to run the app: `npm run dev` and `npm run dev:workers`.
- How to run migrations: single command and where migrations live.
- How to run tests: `npm test`, `npm run test:invariants`, etc.
- Where to add a new feature: “New API = procedure in router X + logic in service Y; see ARCHITECTURE.”

**Deliverable:** README updated and/or `CONTRIBUTING.md` created; link from README.

---

## 5. Phase 2 — Consolidation (Priority: High)

**Goal:** Remove ambiguity about “where does X live?” and “which Y do we use?”

**Effort:** 2–5 days  
**Owner:** TBD

### 5.1 Migrations: One Canonical Location

- **Decision:** Canonical schema is `backend/database/constitutional-schema.sql`; applied by `migrate-pg.mjs` via `npm run db:migrate`. Root `migrations/` folder was removed; reference SQL lives in `backend/database/migrations/`.
- **Actions:**
  - Document in ARCHITECTURE and README: “All migrations live in `migrations/`. Run with `npm run db:migrate`.”
  - If other directories contain migrations, either move them into `migrations/` with a naming convention (e.g. `YYYYMMDD_NNN_description.sql`) or document clearly that they are legacy/read-only and only `migrations/` is used for new work.
  - Ensure the migrate script (e.g. `migrate-pg.mjs` or equivalent) reads only from the chosen folder.
- **Deliverable:** Single migration story — **Done.** See [MIGRATIONS.md](MIGRATIONS.md). root migrations/ removed.

### 5.2 Config and Environment

- **Single reference:** One place that lists every env var the app can use (required vs optional, per environment). Use `docs/ENV.md` and copy `.env.template` to `.env`.
- **Deliverable:** New devs and deployers can copy `.env.template` to `.env` and use `docs/ENV.md` for the full list.

### 5.3 Scripts: One Place, No Duplicates

- **Decision:** One canonical location for operational/analysis scripts (recommendation: repo-root `scripts/`).
- **Actions:**
  - For each duplicate (e.g. `analyze-migration-safety.ts`), keep one version, remove or redirect the other.
  - Document in ARCHITECTURE: “Operational and analysis scripts live in `scripts/`. Backend-specific scripts that are part of the app (e.g. DB seed) may live under `backend/scripts/` or `backend/database/`.”
- **Deliverable:** No two scripts doing the same thing in different places; README/ARCHITECTURE point to the right place.

---

## 6. Phase 3 — Conventions and Guardrails (Priority: Medium, Ongoing)

**Goal:** New code and changes follow shared rules so the codebase doesn’t get more mixed.

**Effort:** Ongoing (initial setup ~0.5–1 day)  
**Owner:** TBD

### 6.1 Development Rules (Cursor / IDE)

- Add `.cursor/rules` or a single `AGENTS.md` / `RULES.md` that states:
  - New API = new procedure in the appropriate router + logic in a service under `backend/src/services/`; routers stay thin.
  - New migration = single file in the canonical migrations folder, with a consistent naming scheme.
  - New env vars must be documented in the single config/env reference.
  - No new duplicate scripts; place new scripts in the agreed location.
- **Deliverable:** File(s) in repo; team (and AI assistants) use them when making changes.

### 6.2 Lightweight Decision Log

- Record important “why” decisions (e.g. “We use Terraform for AWS prod; Railway for staging.” “Migrations: constitutional-schema.sql is canonical; root migrations/ removed.”). Options:
  - Short “Decisions” section in `docs/ARCHITECTURE.md`, or
  - `docs/decisions/` with one file per decision (e.g. `001-migrations-location.md`).
- **Deliverable:** Future maintainers understand why the project is structured as it is.

### 6.3 Optional: Router–Service Map

- A document or generated list: “Router X calls services A, B.” Helps answer “if I change this service, which APIs are affected?”
- Can be maintained by hand at first or generated later by script.
- **Deliverable:** Easier impact analysis for changes.

---

## 7. Phase 4 — Optional Deeper Improvements (Priority: Low)

**Goal:** Better dependency and scope clarity; no obligation to do all of this.

- **Critical paths:** Document 3–5 main flows (e.g. “Create task → fund escrow → complete → release”) and list the routers/services involved. Helps when debugging or refactoring.
- **Service grouping:** If the team decides to reorganize services, do it incrementally (one domain at a time) and only after Phases 1–3 are in place.
- **Test and coverage:** Keep existing thresholds; gradually add tests for critical paths and new code, guided by ARCHITECTURE.

---

## 8. What We Explicitly Avoid

- **Full rewrite** — High risk and cost; current stack is workable.
- **Cleaning everything at once** — Prefer one clear win per phase (e.g. “one migration folder”) then iterate.
- **New framework or language** — Would add another layer of “mixed”; we stabilize first.

---

## 9. Success Criteria (How We Know We Succeeded)

- A new developer can, within one day:
  - Run the app and workers locally.
  - Run migrations and tests.
  - Find where to add a new API and what service to call.
- There is exactly one documented place for: architecture, migration location, env vars, and script location.
- New changes follow the documented conventions (routers thin, services for logic, migrations in one folder).

---

## 10. Summary Table

| Phase | Focus | Effort | Deliverables |
|-------|--------|--------|---------------|
| **1** | Single source of truth | 1–2 days | `docs/ARCHITECTURE.md`, “Start here” (README / CONTRIBUTING) |
| **2** | Consolidation | 2–5 days | One migration story, one env/config reference, one script location |
| **3** | Conventions & guardrails | Ongoing | `.cursor/rules` or AGENTS.md, decision log, optional router–service map |
| **4** | Optional deeper work | As needed | Critical-path docs, incremental service reorg, test focus |

---

## 11. References

- **README.md** — Product and API overview; will link to ARCHITECTURE and “Start here.”
- **[docs/README.md](README.md)** — Documentation index.
- **[Project Schedule](PROJECT_SCHEDULE.md)** — Time schedule and target dates for phases; shareable with teammates.

---

*This document is the shared opinion for making the HustleXP backend successful: not by rewriting it, but by mapping it, consolidating duplicates, and guarding how we add to it.*
