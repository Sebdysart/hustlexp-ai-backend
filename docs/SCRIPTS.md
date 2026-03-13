# Scripts — Where They Live

**Last updated:** 2026-03-13

---

## Canonical location: repo-root `scripts/`

**Operational, analysis, and migration-related scripts** live in **`scripts/`** at the repo root.

Use these when you need to:

- Run migration safety checks: `npx tsx scripts/analyze-migration-safety.ts`
- Consolidate migration metadata: `npm run db:migrate:consolidate` → `scripts/consolidate-migrations.ts`
- Validate schema: `npx tsx scripts/validate-schema.ts`
- Generate manifests: `scripts/generate-error-manifest.ts`, `scripts/generate-flag-manifest.ts`, etc.
- Schema apply: `npm run db:migrate` (see [MIGRATIONS.md](MIGRATIONS.md)); legacy one-off migration runners were removed.

**Tests** that depend on script logic (e.g. migration safety) import from **`scripts/`** (e.g. `scripts/analyze-migration-safety.ts`).

---

## Backend-only scripts: `backend/scripts/`

Scripts that are **specific to the backend app** (revenue replay, concurrency load test, alpha telemetry smoke, readiness score, PR classification) live in **`backend/scripts/`**. Duplicate copies of shared tooling have been removed; use **`scripts/`** for those.

---

## Summary

| Need | Location |
|------|----------|
| Migration safety, schema diff, consolidate, validate, PR/analysis | `scripts/` |
| Backend-specific (revenue replay, concurrency load test, etc.) | `backend/scripts/` |
| DB schema apply | `migrate-pg.mjs` (see [MIGRATIONS.md](MIGRATIONS.md)) |
