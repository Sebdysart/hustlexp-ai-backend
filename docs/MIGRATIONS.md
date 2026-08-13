# PostgreSQL schema and migrations

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

1. Add an idempotent SQL file under `backend/database/migrations/`.
2. Add its stable name and filename to `REQUIRED_MIGRATION_FILES` in order.
3. Add tests for the schema contract and repeat-application behavior.
4. Fold the final shape into `constitutional-schema.sql` so new databases and upgraded databases converge.
5. Run schema validation against a disposable PostgreSQL database before production.

Never rewrite or delete an already-applied production migration. Add a repair migration instead.
