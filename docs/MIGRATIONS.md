# PostgreSQL schema and migrations

Status: `CURRENT_IMPLEMENTATION_REFERENCE / MIGRATION_SELECTION_HOLD`

Production effects authorized: `NONE`

Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md) and the source-dated [Current Backend Checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md). The last canonical diagnostic reports node `TASK_FIRST_FAKE_FSE_POSTGRES_AUTHORITY_REBUILD`, but the current Governor preflight fails and grants no execution admission. Both exact-name conditional paths are `LOCKED`. `20260824_task_first_fake_fse_vertical` has a prospective clean-baseline append ordinal of 112 that is explicitly not authorized. `20260825_task_first_fake_fse_postgres_authority_repair` has no assigned source ordinal pending legacy-chain reconstruction. The persisted ledger identity is the migration name; no numeric alias identifies a persisted migration. Do not create, rename, register, apply, or choose either path until every relevant persistent PostgreSQL target is closed with admissible evidence and a fresh canonical revision lock selects one exact name and assigns its source ordinal.

Observed on 2026-08-25: the canonical Railway ledger contained 103 distinct applied migration names and did not contain the exact proposed task-first migration name. Homebrew clone-only review root `313fd8537feb1f503b11ff1459c4f63809961ce027ffdaa116c5671cf4fd25c0` (`SHA-256(SHA256SUMS)`) excludes only PostgreSQL system identifiers `7590278899115318006` and `7665324946412008239`; it does not close Colima or any other persistent target. Seven Neon project/branch/database tuples and other historical or opaque persistent targets remained unresolved.

The non-authorizing C0 and provider-unbound query packages identify no persistent Neon ledger and close no migration target. Provider identity remains `UNKNOWN`, and the entire A0 successor line remains rejected; its single exact candidate/review lineage is maintained in the [source-dated checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md) rather than duplicated here. No predecessor or successor package selects a path, assigns an ordinal, or authorizes provider interaction. These are source-dated observations, not permission to assume absence elsewhere.

There are two intentionally different schema artifacts:

- `backend/database/constitutional-schema.sql` is the fresh-database baseline and core invariant definition.
- `backend/database/migrations/` contains incremental production changes. The authoritative ordered subset is `backend/src/jobs/engine-automation-migration-files.ts`.

## Production startup

`npm start` and `npm run start:workers` call `runEngineAutomationMigration()` before starting their process. The runner:

1. connects with `DATABASE_URL` using the standard `pg` driver;
2. installs the constitutional baseline only when `schema_versions` is absent;
3. takes a PostgreSQL advisory lock for each migration;
4. applies each required migration transactionally;
5. records it in `applied_migrations`, making subsequent starts idempotent.

The API also performs narrow startup checks for the baseline, legacy user columns, the missing-table compatibility migration, and performance indexes. These paths are idempotent and exist to support local API-only startup.

## Operator commands

| Command | Effect |
|---|---|
| `npm run db:validate` | Read-only live schema and invariant validation |
| `npm run db:check` | Alias of the schema validator |
| `npm run db:migrate` | Disabled because the old command was destructive |
| `npm run db:reset:destructive` | Drops and rebuilds `public`; disposable development databases only |

## Adding a migration

These mechanics apply only after the Governor dependency gate authorizes an exact migration name and base.

1. Add an idempotent SQL file under `backend/database/migrations/`.
2. Add its stable name and filename to `REQUIRED_MIGRATION_FILES` in order.
3. Add tests for the schema contract and repeat-application behavior.
4. Fold the final shape into `constitutional-schema.sql` so new databases and upgraded databases converge.
5. Run schema validation against a disposable PostgreSQL database before production.

Never rewrite or delete an already-applied production migration. Add a repair migration instead.

Never infer a safe path from a filename scan, one database ledger, a provider project list, a secret name, or a local test. Fresh-install success does not prove upgrade safety; upgrade success does not prove replay, drift, rollback/forward-repair, or concurrency safety.
