# Migrations — Single Source of Truth

**Last updated:** 2026-03-13

---

## How migrations work

The **canonical** way to apply the schema is:

```bash
npm run db:migrate
# or
npm run db:check
```

Both run **`migrate-pg.mjs`** at the repo root, which:

1. Connects using `DATABASE_URL`
2. **Drops** the `public` schema and recreates it
3. Reads **one file**: `backend/database/constitutional-schema.sql`
4. Applies that full schema (tables, triggers, functions, etc.)
5. Verifies tables and triggers and reads `schema_versions`

So the **single source of truth** for “what the database looks like” is:

- **File:** `backend/database/constitutional-schema.sql`
- **Runner:** `migrate-pg.mjs` (via `npm run db:migrate`)

---

## Other SQL files in the repo

| Location | Purpose |
|----------|--------|
| `backend/database/migrations/` | Reference / incremental SQL; **not** run by `migrate-pg.mjs`. Used for docs and one-off reference. |
| `backend/src/migrations/` | Schema alignment / seed scripts; **not** run by `migrate-pg.mjs`. |

The **canonical** schema is `backend/database/constitutional-schema.sql`. For a fresh or reset database, use only:

```bash
npm run db:migrate
```

For “consolidating” many migration files into one schema, the project has:

```bash
npm run db:migrate:consolidate
```

That runs `scripts/consolidate-migrations.ts` and produces a registry; it does **not** replace `migrate-pg.mjs` as the migration runner.

---

## Summary

| Question | Answer |
|----------|--------|
| How do I apply the schema? | `npm run db:migrate` |
| Which file is the schema? | `backend/database/constitutional-schema.sql` |
| Where do I add new schema changes? | Edit `constitutional-schema.sql` (or add a new migration file and then fold it into that schema when appropriate). |
| Are `backend/database/migrations/` files applied automatically? | No; only `constitutional-schema.sql` is applied by `npm run db:migrate`. |
