# PostgreSQL schema and migrations

Status: `CURRENT_IMPLEMENTATION_REFERENCE / RELEASE_BLOCKED`

Production effects authorized: `NONE`

Read [the team goal](HUSTLEXP_TEAM_ALIGNMENT.md) and source-dated [current checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md). The active Governor node is `D1_CI_INCIDENT_RECOVERY_20260825`. It permits bounded local containment work, not application to a persistent database. A fresh independently accepted Governor revision must bind the exact candidate, migration manifest, artifact digest, target identity, and evidence before publication or migration.

## Authoritative artifacts

- `backend/database/constitutional-schema.sql` is the fresh-database baseline and invariant definition.
- `backend/database/migrations/` contains incremental forward migrations.
- `backend/src/jobs/engine-automation-migration-files.ts` is the authoritative ordered file/name registry.
- `backend/src/jobs/engine-migration-manifest.ts` hashes the baseline and every registered migration into one artifact identity.
- `backend/database/engine-migration-artifact.sha256` stores the expected exact artifact digest and must change whenever a registered SQL byte, order, name, or baseline byte changes.
- `applied_migrations` records exact names and checksums. A numeric ordinal or filename scan is not persisted migration identity.

The local candidate appends `20260825_pr276_incident_containment`. Production contains the preceding PR276 lineage but not this containment migration. Its SQL adds role separation, immutable migration/audit/escrow evidence, exact terminal authorities, refund-claim protection, dispute/release restoration, and runtime admission backstops. Presence in source is not authority to apply it.

## Runtime versus migrator

Long-lived processes never migrate:

- `npm start` and `npm run start:workers` explicitly unset `MIGRATION_DATABASE_URL` before starting;
- the web runtime uses the non-owner `DATABASE_URL`, connects, and runs read-only `verifyRuntimeSchema` admission before serving;
- the worker runtime uses the non-owner `DATABASE_URL`, verifies the same schema/role boundary before processing jobs;
- runtime admission fails if required migrations, checksums, owners, grants, triggers, pinned function definitions, or immutable migration controls drift;
- web/worker roles must not own or assume the migrator role, create database/public-schema objects, or retain migrator/build-identity variables.

Migrations execute only through the explicit one-shot command:

```sh
npm run compile
npm run db:migrate:engine
```

That command requires both `DATABASE_URL` for the runtime-role contract and `MIGRATION_DATABASE_URL` for the dedicated migrator. Production release additionally binds `HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER`, `HX_MIGRATION_EXPECTED_DATABASE_NAME`, and `HX_MIGRATION_EXPECTED_DATABASE_OID`, revalidates the exact protected `main`, and verifies the artifact digest before mutation.

## Verification matrix

The protected Node 22/PostgreSQL 17.7 build must prove:

1. fresh bootstrap from the constitutional schema;
2. upgrade from the exact predecessor lineage;
3. exact-name/checksum replay idempotency;
4. drift rejection for changed source, ledger, owner, grant, trigger, or function bytes;
5. preservation of existing rows and financial invariants;
6. runtime/migrator role separation and credential exclusion;
7. PR276 prefix equivalence and the D1 containment PostgreSQL harness;
8. refund claim, dispute release, append-only evidence, recovery, and hostile authorization cases;
9. exact source/image migration-artifact identity.

Focused static tests have passed locally, but no real PostgreSQL harness was available in the current session. Only the protected `Build Validation` job can close that proof for the final candidate.

## Operator commands

| Command | Effect and boundary |
|---|---|
| `npm run db:validate` / `npm run db:check` | Read-only schema/invariant validation against the explicitly selected target |
| `npm run db:migrate:engine` | Checksummed one-shot migration; requires exact authority and dedicated credentials |
| `node scripts/verify-engine-migrations-postgres.mjs` | Destructive disposable-PostgreSQL fresh/upgrade/replay/recovery harness; never point at persistent or production data |
| `node scripts/verify-pr276-incident-containment-postgres.mjs` | Destructive disposable-PostgreSQL prefix/drift/preservation/role/containment harness; never point at persistent or production data |
| `npm run db:migrate` | Disabled because the former implementation was destructive |
| `npm run db:reset:destructive` | Drops and rebuilds `public`; explicitly verified disposable local database only |

## Adding a forward migration

1. Obtain an accepted Governor path/name/base boundary.
2. Add one idempotent forward SQL file; never rewrite an applied migration.
3. Register its stable exact name and filename in `REQUIRED_MIGRATION_FILES` in dependency order.
4. Fold the final invariant shape into `constitutional-schema.sql` so fresh and upgraded databases converge.
5. Add static, fresh, upgrade, replay, drift, authorization, concurrency, and preservation tests proportional to risk.
6. Regenerate and independently verify `engine-migration-artifact.sha256` only after the SQL/order freezes.
7. Run the complete disposable PostgreSQL matrix, full CI, and independent review on one exact tree.
8. Apply only through the protected one-shot release transaction with exact target identity and forward-repair/containment behavior.

Fresh-install success does not prove upgrade safety. Upgrade success does not prove replay, drift, recovery, authorization, or concurrency safety. A local database, provider-project list, secret name, or zero-row query never authorizes a persistent migration.
