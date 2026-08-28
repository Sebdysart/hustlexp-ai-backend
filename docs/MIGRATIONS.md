# PostgreSQL schema and migrations

Status: `CURRENT_IMPLEMENTATION_REFERENCE / MIGRATION_SELECTION_HOLD`

Production effects authorized: `NONE`

Read [the Team Goal and Execution Contract](HUSTLEXP_TEAM_ALIGNMENT.md) and the source-dated [Current Backend Checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md). The last canonical diagnostic reports node `TASK_FIRST_FAKE_FSE_POSTGRES_AUTHORITY_REBUILD`, but the current Governor preflight fails and grants no execution admission. Both exact-name conditional paths are `LOCKED`. `20260824_task_first_fake_fse_vertical` has a prospective clean-baseline append ordinal of 112 that is explicitly not authorized. `20260825_task_first_fake_fse_postgres_authority_repair` has no assigned source ordinal pending legacy-chain reconstruction. The persisted ledger identity is the migration name; no numeric alias identifies a persisted migration. Do not create, rename, register, apply, or choose either path until every relevant persistent PostgreSQL target is closed with admissible evidence and a fresh canonical revision lock selects one exact name and assigns its source ordinal.

That lock is specific to the two named task-first money paths and to all persistent-target execution. The Universal V1 working mission permits unrelated append-only contracts to be authored and exercised against explicitly disposable local databases as review candidates. This source-dated local review snapshot has 121 ordered registry entries: `20260903_universal_v1_task_draft_account_claim` at source ordinal 112, `20260904_canonical_user_email_identity` at 113, `20260905_universal_v1_task_draft_legacy_claim_import_repair` at 114, `20260906_universal_v1_estimate_acceptance_materialization` at 115, `20260907_universal_v1_provider_estimate_invitation` at 116, `20260908_universal_v1_provider_work_order_authority` at 117, `20260909_universal_v1_reconciliation_alias_repair` at 118, `20260911_universal_v1_change_order_application` at 119, `20260912_universal_v1_work_order_execution_facts` at 120, and `20260913_universal_v1_completion_delivery_receipt` at 121. The exact source artifact digest for that registry and migration directory is `6937ff0c82abc87f8391cb0e22de1c0ff163ca8a6bc8e61bbfc11f5252efd9f5`. These entries are uncommitted review-candidate bytes and are explicitly unpromotable: they have no immutable signed candidate, hosted checks, independent approval, persistent-database, merge, deployment, or production authority. The append-only contracts implement payment-free estimate invitation and acceptance, provider interest and eligibility, a fake-secured unassigned Work Order, exact change-order and execution facts, evidence and completion facts, an HMAC-authenticated synthetic completion-delivery receipt, and a fake-only capture-through-reconciliation proof. They create no hard assignment, exact-address release, escrow or legacy quote payment, live provider operation, customer-money effect, deployment capability, or external authority. `20260909` repairs a reconciliation-function alias defect without rewriting the historical migration; the separate `20260910_fake_financial_settlement_completion_v3` remains a nonproduction-only fake-provider vocabulary migration and is not an engine-registry production migration. None of these paths selects, renames, repairs, or authorizes either locked task-first money path.

Disposable PostgreSQL can demonstrate that lifecycle and schema behavior, but it cannot seal the callable Work Order command boundary. The machine-readable `backend/database/work-order-command-authority.HOLD.json` and [Work Order database authority boundary](architecture/HUSTLEXP_WORK_ORDER_DATABASE_AUTHORITY_BOUNDARY.md) remain `EXTERNAL_DECISION_REQUIRED / RELEASE_BLOCKING`: authenticated actor binding, role provisioning, sealed functions, direct-DML revocation, and exact live privilege readback are still required before any release claim.

Observed on 2026-08-25: the canonical Railway ledger contained 103 distinct applied migration names and did not contain the exact proposed task-first migration name. Homebrew clone-only review root `313fd8537feb1f503b11ff1459c4f63809961ce027ffdaa116c5671cf4fd25c0` (`SHA-256(SHA256SUMS)`) excludes only PostgreSQL system identifiers `7590278899115318006` and `7665324946412008239`; it does not close Colima or any other persistent target. Seven Neon project/branch/database tuples and other historical or opaque persistent targets remained unresolved.

The non-authorizing C0 and provider-unbound query packages identify no persistent Neon ledger and close no migration target. Provider identity remains `UNKNOWN`, and the entire A0 successor line remains rejected; its single exact candidate/review lineage is maintained in the [source-dated checkpoint](HUSTLEXP_CURRENT_BACKEND_CHECKPOINT.md) rather than duplicated here. No predecessor or successor package selects a path, assigns an ordinal, or authorizes provider interaction. These are source-dated observations, not permission to assume absence elsewhere.

There are two intentionally different schema artifacts:

- `backend/database/constitutional-schema.sql` is the fresh-database baseline and core invariant definition.
- `backend/database/migrations/` contains incremental production changes. The authoritative ordered subset is `backend/src/jobs/engine-automation-migration-files.ts`.

## Production startup

`npm start` and `npm run start:workers` never apply schema changes. Both call the
read-only `runStartupMigrations()` attestor before becoming ready. It hashes the
packaged canonical SQL and performs one `SELECT` against `applied_migrations`;
missing, duplicated, malformed, or drifted evidence fails startup closed.

The only general schema writer is the explicit one-shot migration role:

- `npm run db:migrate:local` is for disposable local/test databases and refuses
  Railway metadata or a production runtime.
- `npm run db:migrate:apply` is the compiled deployment command. Preview and
  staging require `SERVICE_ROLE=migration`, a detached Ed25519 signature made by
  a public key pinned in protected source, a runtime-measured executable digest,
  the exact migration-artifact digest, exact Railway target metadata, and
  `HX_MIGRATION_ENVIRONMENT_APPROVAL_DIGEST` equal to that signed manifest.
- Production execution is additionally held until the exact production Railway
  project ID and an approved release-authority public key are enrolled by a
  protected source change. Runtime variables cannot enroll either trust anchor.

The nonproduction fake-finance bootstrap performs the same authority preflight
before its canonical migration chain opens a database connection. Local test
and migration-certification scripts may continue calling the migration library
against explicitly disposable databases; that library is not an application
startup path.

## Operator commands

| Command                                                     | Effect                                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run db:validate`                                       | Read-only live schema and invariant validation                                                       |
| `npm run db:check`                                          | Alias of the schema validator                                                                        |
| `npm run db:migrate`                                        | Disabled because the old command was destructive                                                     |
| `npm run db:migrate:local`                                  | Explicit migration command for verified disposable local/test databases; refuses Railway             |
| `npm run db:migrate:apply`                                  | One-shot deployed migration role; signed exact-manifest and environment approval required            |
| `npm run db:migrations:checksum-plan -- --manifest <path>`  | Read-only validation of an exact legacy-checksum reconciliation manifest                             |
| `npm run db:migrations:checksum-apply -- --manifest <path>` | Guarded reconciliation of reviewed `NULL` checksum rows; held unless every authority gate is present |
| `npm run db:reset:destructive`                              | Drops and rebuilds `public`; disposable development databases only                                   |

## Legacy checksum reconciliation

Old versions of `applied_migrations` could record a migration name without its SQL checksum. Startup now refuses such rows with `MIGRATION_CHECKSUM_MISSING`; it does not guess that the current local file is the SQL that originally ran. The reconciliation rail is an exceptional evidence-backed repair, not a migration runner and not production authorization.

The checked-in `backend/database/legacy-migration-checksum-reconciliation.HOLD.json` is deliberately empty and non-authorizing. Its schemas are:

- `backend/database/legacy-migration-checksum-reconciliation.schema.json`
- `backend/database/legacy-migration-checksum-signature.schema.json`

An authorized candidate must be stored under `backend/database/migration-checksum-manifests/` and must bind all of the following:

1. The exact reviewed source commit and distinct preparer and reviewer identities.
2. The exact target database, role, server address and port, PostgreSQL version, cluster name, and SHA-256 fingerprint of that canonical identity object.
3. Every row in the target `applied_migrations` ledger, sorted by migration name. Each row names one repository-relative SQL file, its exact local SHA-256, and whether the reviewed ledger value is `NULL_CHECKSUM` or `VERIFIED_CHECKSUM`. Missing, extra, duplicate, drifted, or partially reconciled rows are blockers.
4. The SHA-256 of the canonical payload plus separate Ed25519 review evidence under `backend/database/migration-checksum-signatures/`. The evidence signer must be the named reviewer and must bind the same payload and source commit.

`npm run db:migrations:checksum-plan -- --manifest <path>` only reads target identity, the ledger, and local files. It never starts a transaction, acquires a write lock, or issues an update. A plan that would update zero rows fails as a no-op instead of reporting false success.

Apply additionally requires all of these exact, out-of-band values:

- `NODE_ENV=maintenance`
- `HX_ALLOW_LEGACY_MIGRATION_CHECKSUM_RECONCILIATION=APPLY_EXACT_REVIEWED_MANIFEST`
- `HX_LEGACY_MIGRATION_CHECKSUM_MANIFEST_SHA256=<exact raw manifest SHA-256>`
- `HX_LEGACY_MIGRATION_CHECKSUM_SIGNATURE_SHA256=<exact raw signature-evidence SHA-256>`
- `HX_LEGACY_MIGRATION_CHECKSUM_SIGNER_KEY_SHA256=<exact reviewer public-key SHA-256>`
- for a non-loopback `DATABASE_URL`, `HX_LEGACY_MIGRATION_CHECKSUM_TARGET_FINGERPRINT=<exact observed target fingerprint>`

Apply re-reads the target identity, opens one serializable transaction, takes one transaction-scoped PostgreSQL advisory lock, re-reads the complete ledger, and updates only rows whose checksum remains `NULL`. It then re-reads the complete ledger and commits only when every checksum equals the reviewed local hash. Any failed precondition or update rolls the entire transaction back. It never inserts a ledger row, changes a non-`NULL` checksum, applies SQL, or changes schema.

Do not copy a plan or manifest between targets. Do not infer a checksum from a filename, an equivalent schema, a fresh install, or a successful migration replay. The preparer must assemble evidence from the exact target and exact commit; the independent reviewer must verify and sign it; normal protected-release and environment-approval controls still apply before any persistent-target execution.

## Adding a migration

Persistent-target use of these mechanics requires the Governor dependency gate to authorize an exact migration name and base. An isolated review candidate may complete the same mechanics against disposable local databases, but its registry entry is only a source proposal and grants no authority outside that disposable lane.

1. Add an idempotent SQL file under `backend/database/migrations/`.
2. Add its stable name and filename to `REQUIRED_MIGRATION_FILES` in order.
3. Add tests for the schema contract and repeat-application behavior.
4. Prove that a fresh baseline plus the complete ordered chain and every supported upgrade lineage converge on the same final shape. Fold a final shape into `constitutional-schema.sql` only when the baseline already owns that object and doing so preserves every migration prerequisite. Objects introduced after the baseline remain established by their append-only canonical migrations; do not move them backward across dependencies merely to duplicate their shape.
5. Run schema validation against a disposable PostgreSQL database before production.

Never rewrite or delete an already-applied production migration. Add a repair migration instead.

Never infer a safe path from a filename scan, one database ledger, a provider project list, a secret name, or a local test. Fresh-install success does not prove upgrade safety; upgrade success does not prove replay, drift, rollback/forward-repair, or concurrency safety.
