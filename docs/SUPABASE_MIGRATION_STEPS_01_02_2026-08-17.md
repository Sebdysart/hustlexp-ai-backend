# Supabase migration Steps 1–2 checkpoint and inventory

**Report date:** 17 August 2026

## Status

- Step 1 — safe migration checkpoint: **complete**
- Step 2 — Supabase inventory: **repository inventory complete; live inventory awaiting database access**
- Production writes performed: **none**

## Step 1: recovery checkpoint

Both repositories now use the branch `migration/supabase-to-railway`.

| Repository | Starting branch | Starting commit | Checkpoint |
|---|---|---|---|
| `hustlexp-ai-backend` | `main` | `15b5c3219ed9ceb91a93f07ba87bdd82cf934247` | `f9fc1c97` |
| `hustlexp-site` | `master` | `2af4b3e1500331c980d7c389211aaa60241f10f7` | Clean starting commit; inventory work follows on the migration branch |

The backend checkpoint preserves the pre-existing 260-file cleanup, migration rename, test-tooling, and documentation change set before any new inventory work. The ignored local test environment file was not committed. Files containing secret-like strings were existing unit-test fixtures, not runtime credentials.

### Rollback rules

1. Do not delete Supabase migrations, functions, buckets, users, or production data during inventory and design.
2. Do not apply backend migrations to either production database during Steps 1–2.
3. Run live discovery only through the read-only transaction in `hustlexp-site/scripts/supabaseLiveInventory.sql`.
4. Keep live inventory output outside Git because it describes production structure and volumes.
5. Keep Supabase authoritative until the production cutover and rollback gates pass.
6. Never commit or paste `SUPABASE_DATABASE_URL`, database passwords, service-role keys, webhook secrets, or provider credentials.

## Step 2: verified repository inventory

The inventory script scans runtime website callers, Supabase Edge Functions, checked-in SQL migrations, configured JWT behavior, environment variable names, table references, and RPC references. It records names only; it does not collect secret values.

| Repository evidence | Count |
|---|---:|
| Edge Functions | 49 |
| SQL migration files | 145 |
| Supabase-bound non-test runtime files | 55 |
| Edge endpoints detected in frontend runtime code | 27 |
| Functions configured with gateway JWT verification disabled | 26 |
| Distinct environment variable names used by Edge Functions | 36 |
| Tables referenced by Edge Functions | 73 |
| RPCs referenced by Edge Functions | 86 |
| Table declarations found in migrations | 105 |
| Function declarations found in migrations | 208 |
| Trigger declarations found in migrations | 107 |
| Policy declarations found in migrations | 11 |
| Extension declarations found in migrations | 4 |
| `cron.schedule` statements found in migrations | 4 |

These SQL-object counts describe checked-in source declarations, not the effective live schema. Repeated replacements and conditional definitions can make them differ from production.

The repository inventory is reproducible from `hustlexp-site`:

```bash
node scripts/inventorySupabase.mjs --output /tmp/hustlexp-supabase-static-inventory.json
```

## Live inventory status

The live database was not queried because this workstation currently has:

- no `SUPABASE_DATABASE_URL` environment variable;
- no Supabase CLI installation;
- no linked project reference under `supabase/.temp`;
- no locally stored production credential available to the migration tooling.

PostgreSQL `psql` and `pg_dump` are installed. A credential-safe runner and a read-only SQL inventory are ready. The runner converts the URL to libpq environment variables so the password is not placed in the `psql` argument list.

To finish the live portion, set the connection URL locally without putting it in shell history:

```bash
read -rsp "Supabase PostgreSQL URL: " SUPABASE_DATABASE_URL
export SUPABASE_DATABASE_URL
node scripts/runSupabaseLiveInventory.mjs --output /tmp/hustlexp-supabase-live-inventory.txt
unset SUPABASE_DATABASE_URL
```

The live command performs a `BEGIN TRANSACTION READ ONLY`, collects metadata and exact accessible table row counts, excludes application rows and function bodies, and writes the output with owner-only permissions.

## Step 2 completion gate

Step 2 becomes complete only after the live output confirms:

1. server version, database, runtime role, and extensions;
2. public, Auth, and Storage tables with exact accessible row counts;
3. columns, constraints, indexes, RLS state, and policy names;
4. routine and trigger names;
5. scheduled-job metadata without commands or secrets;
6. comparison of live objects with the repository inventory;
7. separate inventory of deployed Edge Functions, Auth providers, Storage buckets, webhooks, and secret **names** from the Supabase dashboard or management API.

No later migration step should start until this live evidence is collected and reviewed.

## Verification results

| Check | Result |
|---|---|
| Inventory unit and repository-contract tests | Passed |
| Static inventory generation and JSON parsing | Passed |
| Missing-credential fail-closed behavior | Passed with expected exit code 2 |
| Website ESLint with zero warnings | Passed |
| Backend schema structure audit | Passed with the documented 14-table historical warning |
| Website TypeScript | Blocked because the interrupted dependency installation is missing `zod` |
| Website production build | Blocked because the interrupted dependency installation is missing `zod` |
| Website full Vitest suite | Blocked because the interrupted dependency installation is missing `whatwg-url`; 418 test files could not initialize their JSDOM environment |
| Backend lint, TypeScript, and Vitest | Blocked because the existing backend `node_modules` installation is incomplete |

Dependency installation was attempted with the pinned npm 11.6.2 tool and an available npm 10.9.8 tool. npm 11 repeatedly failed with its internal `Exit handler never called` error; npm 10 progressed but encountered registry timeouts and also left an incomplete installation. These are test-environment failures, so full-suite verification must be rerun after a clean lockfile install. No failing application assertion was accepted as a migration defect.
