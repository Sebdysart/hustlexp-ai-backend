# Backend documentation

This directory contains maintained engineering and operations references. Historical implementation plans belong in issue tracking, not in the runtime repository.

| Document | Purpose |
|---|---|
| [HustleXP-current-architecture.png](HustleXP-current-architecture.png) | Verified current architecture image; editable source is the adjacent SVG |
| [API_LIST.md](API_LIST.md) | tRPC API inventory |
| [CI_CD.md](CI_CD.md) | CI and Railway deployment flow |
| [CONTROLLING_SPEC.md](CONTROLLING_SPEC.md) | Backend authority and invariants |
| [ENV.md](ENV.md) | Environment-variable reference |
| [MIGRATIONS.md](MIGRATIONS.md) | Database schema and migration process |
| [SUPABASE_TO_RAILWAY_CUTOVER.md](SUPABASE_TO_RAILWAY_CUTOVER.md) | Evidence-based website backend migration sequence and gates |
| [SCRIPTS.md](SCRIPTS.md) | Supported repository scripts |
| [production-role-readiness-evidence-2026-07-22.md](production-role-readiness-evidence-2026-07-22.md) | Retained certification evidence |

Additional production material lives under `ops/`:

- `ops/runbooks/` — deployment and incident procedures
- `ops/security/` — security operations
- `ops/compliance/` — legal and financial controls
