# Backend system-test setup

**Repository role:** define the disposable PostgreSQL/Redis setup for complete backend system and invariant testing.

**Lifecycle status:** `ACTIVE_TEST_CONTRACT / NONPRODUCTION_ONLY`.

**Canonical authority:** [HustleXP Business and Universal V1 Charter v1.1.0](https://github.com/Sebdysart/HUSTLEXP-DOCS/blob/0b80c71e118d7cab70474bbbf6df778811fe4fe8/governance/HUSTLEXP_BUSINESS_AND_UNIVERSAL_V1_CHARTER.md); exact backend tests own only implementation evidence.

**Supported runtime:** Node.js 22, disposable loopback PostgreSQL databases, and an isolated Redis instance.

**Local start:** configure the explicitly permitted disposable services, then run `npm run test:required` from the backend root.

**Staging path:** required tests bind to an exact signed candidate in CI before any immutable artifact can enter a synthetic preview or staging manifest.

**Payment posture:** tests use synthetic fixtures only; production payment creation, hard assignment, payout, and settlement remain frozen.

**Deployment authority:** none; test success is necessary evidence but cannot itself authorize staging or production.

**Known limitations:** the complete command requires disposable PostgreSQL and Redis; plain `npm test` can skip database cohorts and is not release evidence.

System and invariant tests use disposable loopback PostgreSQL databases and an isolated Redis instance. They never require Neon, Supabase, a production database, or live provider credentials.

The required release-oriented command is:

```bash
npm run test:required
```

Before running it, provide only the exact local administrator database URL required by `scripts/prepare-test-databases.mjs` and start Redis on the required isolated port. The runner:

1. rejects non-loopback, wrongly named, wrongly owned, or wrong-port database targets;
2. derives and recreates only `hx_ci_invariant_test` and `hx_ci_system_test` after its explicit disposable-database policy passes;
3. scrubs ambient database, provider, and live-value configuration;
4. compiles the exact source and runs every Vitest cohort; and
5. rejects any failure, skipped test, pending test, or todo.

`npm test` remains a developer diagnostic command. Because its database-dependent suites use conditional declarations, it can report skips when the disposable services are absent and must not be presented as complete release evidence.

The company `hustlexp-platform` repository is the canonical one-command path for the complete synthetic web/API/worker/PostgreSQL/Redis/support-service stack. Production data and credentials are forbidden in both lanes.
