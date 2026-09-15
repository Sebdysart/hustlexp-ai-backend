# Scripts — Where They Live

Status: `CURRENT_IMPLEMENTATION_REFERENCE / LOCAL_ONLY_UNLESS_AUTHORIZED`

Script presence never authorizes provider, database, GitHub, deployment, or production effects. Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md) and the script itself before execution.

## Canonical location: repo-root `scripts/`

Operational, analysis, migration, provider-certification, database-repair, role-mutation, evidence-packaging, and repository-history scripts live in `scripts/`. The examples below are deliberately non-exhaustive; inventory the exact directory and inspect defaults before execution.

Safe-by-default local analysis examples, still subject to the active node and exact inputs:

- Run migration safety checks: `npx tsx scripts/analyze-migration-safety.ts`
- Validate schema: `npx tsx scripts/validate-schema.ts`
- Generate manifests: `scripts/generate-error-manifest.ts`, `scripts/generate-flag-manifest.ts`, etc.
- Schema validation: `npm run db:validate`; runtime migrations are applied by the web and worker startup command (see [MIGRATIONS.md](MIGRATIONS.md)).

**Tests** that depend on script logic (e.g. migration safety) import from **`scripts/`** (e.g. `scripts/analyze-migration-safety.ts`).

---

## Quarantined or authority-gated writers

Do not run any item below from general onboarding, documentation review, or the current migration `HOLD`:

| Script | Classification | Why it is gated |
|---|---|---|
| `scripts/consolidate-migrations.ts` / `npm run db:migrate:consolidate` | `LEGACY_NON_EXECUTABLE` | Default source and target are both `backend/database/migrations`; it writes sequentially renamed copies and `registry.json`, which conflicts with exact-name ledger authority. Even `--dry-run` output is analysis only and cannot select or rename a migration. |
| `scripts/epic03-stripe-test-cert.mjs`, `scripts/verify-stripe-webhook.sh` | `LEGACY_PROVIDER_EFFECT / EXPLICIT_AUTHORITY_REQUIRED` | Can contact Stripe or exercise processor-shaped certification paths. |
| `scripts/repair-hustler-payouts.ts` | `DATABASE_OR_PROVIDER_REPAIR / EXPLICIT_AUTHORITY_REQUIRED` | Repairs payout state and may touch consequential financial records. |
| `scripts/set-hustler-role.ts` | `IDENTITY_DATABASE_MUTATION / EXPLICIT_AUTHORITY_REQUIRED` | Changes a user role. |
| `scripts/purge-env-from-history.sh` | `DESTRUCTIVE_REPOSITORY_HISTORY_OPERATION / FRESH_EXPLICIT_AUTHORITY_REQUIRED` | Rewrites Git history; normal execution is forbidden. |
| `scripts/probe-object-storage.ts`, `scripts/inspect-disputes.ts`, incident/production verifiers | `TARGET_BOUND_READ_OR_WRITE / EXACT_AUTHORITY_REQUIRED` | Environment values can point them at persistent or production systems; script names do not prove read-only scope. |

Every unlisted script is `UNCLASSIFIED / DO_NOT_EXECUTE` until its source, inputs, defaults, targets, credentials, and side effects are inspected for the exact revision.

## Backend-only scripts: `backend/scripts/`

Backend-specific scripts live in `backend/scripts/`. That directory includes stateful and legacy scripts; read its [classified inventory](../backend/scripts/README.md) before execution.

---

## Summary

| Need | Location |
|------|----------|
| Migration safety, schema diff, validation, PR/analysis | `scripts/` |
| Migration consolidation/renaming | `LEGACY_NON_EXECUTABLE`; no routine command |
| Backend-specific analysis or mutation | `backend/scripts/`; inspect classified inventory |
| Disposable development DB reset | `npm run db:reset:destructive` (see [MIGRATIONS.md](MIGRATIONS.md)) |
