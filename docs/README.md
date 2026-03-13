# Documentation index

Quick reference to all docs in this repo.

## Planning and schedule

| Doc | Description |
|-----|-------------|
| [PROJECT_SUCCESS_PLAN.md](PROJECT_SUCCESS_PLAN.md) | Shared opinion and phased roadmap to make the codebase handleable |
| [PROJECT_SCHEDULE.md](PROJECT_SCHEDULE.md) | Time schedule and milestones (shareable with teammates) |
| [REQUIREMENTS_CHECKLIST.md](REQUIREMENTS_CHECKLIST.md) | Verification that the eight core requirements are implemented |

## Operations and reference

| Doc | Description |
|-----|-------------|
| [MIGRATIONS.md](MIGRATIONS.md) | How schema is applied: `npm run db:migrate` and `constitutional-schema.sql` |
| [ENV.md](ENV.md) | Environment variables (single reference); copy `.env.template` to `.env` |
| [SCRIPTS.md](SCRIPTS.md) | Where scripts live: repo-root `scripts/` vs `backend/scripts/` |
| [API_LIST.md](API_LIST.md) | Full tRPC API list by router and procedure (public/protected/admin) |

## Root-level docs

- **README.md** — Main project overview, quick start, API surface
- **AGENTS.md** — Cursor/IDE instructions and caveats
- **CLAUDE.md** — Claude-specific implementation protocol and invariants
- **PRODUCTION_HARDENING.md** — Production checklist (Procfile, CORS, AI governor, etc.)
- **CREDENTIAL_ROTATION.md** — Short credential rotation checklist
- **KEY_ROTATION_GUIDE.md** — Full key rotation and history purge guide

## Ops

- **ops/security/** — Pentest playbook
- **ops/compliance/** — 1099, PCI, ToS tracking
- **ops/runbooks/** — Production launch checklist
