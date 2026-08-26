import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const { Client } = pg;
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const MANIFEST_PATH = resolve(REPOSITORY_ROOT, 'scripts/required-postgres-suites.json');
const VITEST_PATH = resolve(REPOSITORY_ROOT, 'node_modules/vitest/vitest.mjs');

const TEMPLATE_DATABASE = 'hx_ci_fresh_test';
const MIGRATION_OWNER = 'hx_ci_migrator';
const TEST_DATABASE = 'hx_unit_test_guard';
const TEST_RUNTIME_ROLE = 'hx_test_unit_guard';
const TEST_RUNTIME_PASSWORD = 'hx_test_unit_guard_password';

const ENABLED_TEST_ENVIRONMENT = Object.freeze({
  NODE_ENV: 'test',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  STRIPE_SECRET_KEY: 'sk_test_required_postgres_fake_provider',
  HX_STRIPE_STUB: '1',
  HX_PAYMENT_CREATION_MODE: 'enabled',
  HXOS_LOCAL_TEST_DATABASE_ATTESTATION: 'DISPOSABLE_LOOPBACK_RESTRICTED_PAYMENT_TEST_DATABASE_V1',
  HXOS_LOCAL_TEST_DATABASE_NAME: TEST_DATABASE,
  HX_ALLOW_E2E_LIFECYCLE: '1',
  HX_ALLOW_E2E_LIQUIDITY_EXPANSION: '1',
  HX_ALLOW_WORKER_COUNTER_E2E: '1',
  HX_ALLOW_NOTIFICATION_PG: '1',
  HXOS_ALLOW_LOCAL_TEST_IDENTITY: 'true',
  HXOS_ALLOW_LOCAL_TEST_SCREENING: 'true',
  HXOS_ALLOW_LOCAL_TEST_PAYOUT: 'true',
  HXOS_ALLOW_LOCAL_TEST_DURATION_EVIDENCE: 'true',
  HXOS_ALLOW_LOCAL_TEST_PROVIDER_CAPABILITY: 'true',
  HXOS_ALLOW_LOCAL_TEST_OFFER_REVIEW: 'true',
  HXOS_ALLOW_LOCAL_TEST_LIQUIDITY: 'true',
  HXOS_LOCAL_TEST_IDENTITY_SECRET: 'i'.repeat(64),
  HXOS_LOCAL_TEST_SCREENING_SECRET: 's'.repeat(64),
  HXOS_LOCAL_TEST_PAYOUT_SECRET: 'p'.repeat(64),
  HXOS_LOCAL_TEST_DURATION_EVIDENCE_SECRET: 'd'.repeat(64),
  HXOS_LOCAL_TEST_PROVIDER_CAPABILITY_SECRET: 'c'.repeat(64),
  HXOS_LOCAL_TEST_OFFER_REVIEW_SECRET: 'o'.repeat(64),
  HXOS_LOCAL_TEST_LIQUIDITY_SECRET: 'l'.repeat(64),
  TASK_LOCATION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  TASK_LOCATION_ENCRYPTION_KEY_ID: 'hx-ci-location-v1',
  QUEUE_HMAC_SECRET: 'hx-ci-required-postgres-queue-hmac-secret-v1',
  FIREBASE_PROJECT_ID: 'test-project',
});

function normalizedRepositoryPath(pathValue, repositoryRoot = REPOSITORY_ROOT) {
  const resolved = isAbsolute(pathValue) ? pathValue : resolve(repositoryRoot, pathValue);
  return relative(repositoryRoot, resolved).split(sep).join('/');
}

function validatedManifest(manifest) {
  assert.equal(manifest?.schemaVersion, 1, 'required PostgreSQL manifest schema must be v1');
  assert.ok(Array.isArray(manifest.profiles) && manifest.profiles.length > 0);
  const names = new Set();
  const files = new Set();
  for (const profile of manifest.profiles) {
    assert.match(profile.name, /^[a-z][a-z0-9_]+$/u);
    assert.ok(!names.has(profile.name), `duplicate PostgreSQL profile ${profile.name}`);
    names.add(profile.name);
    assert.ok(['runtime', 'admin_fixture'].includes(profile.authority));
    assert.ok(Array.isArray(profile.suites) && profile.suites.length > 0);
    for (const suite of profile.suites) {
      assert.match(
        suite.file,
        /^backend\/tests\/(?:invariants|system)\/[a-z0-9-]+\.pg\.test\.ts$/u
      );
      assert.ok(!files.has(suite.file), `duplicate required PostgreSQL suite ${suite.file}`);
      files.add(suite.file);
      assert.ok(Number.isSafeInteger(suite.expectedTests) && suite.expectedTests > 0);
    }
  }
  return manifest;
}

export function verifyRequiredPostgresReports(
  manifestInput,
  reports,
  repositoryRoot = REPOSITORY_ROOT
) {
  const manifest = validatedManifest(manifestInput);
  assert.equal(
    reports.length,
    manifest.profiles.length,
    'one Vitest report is required per profile'
  );

  const expected = new Map();
  for (const profile of manifest.profiles) {
    for (const suite of profile.suites) {
      expected.set(suite.file, { expectedTests: suite.expectedTests, profile: profile.name });
    }
  }

  const observed = new Map();
  for (const { profileName, report } of reports) {
    const profile = manifest.profiles.find((candidate) => candidate.name === profileName);
    assert.ok(profile, `unexpected PostgreSQL report profile ${profileName}`);
    assert.equal(report.success, true, `${profileName} Vitest report did not succeed`);
    assert.equal(report.numFailedTests, 0, `${profileName} contains failed tests`);
    assert.equal(report.numPendingTests, 0, `${profileName} contains skipped/pending tests`);
    assert.equal(report.numTodoTests, 0, `${profileName} contains todo tests`);
    assert.ok(Array.isArray(report.testResults), `${profileName} has no Vitest testResults`);

    for (const result of report.testResults) {
      const file = normalizedRepositoryPath(result.name, repositoryRoot);
      const expectation = expected.get(file);
      assert.ok(expectation, `unexpected PostgreSQL suite reported: ${file}`);
      assert.equal(
        expectation.profile,
        profileName,
        `${file} ran under the wrong authority profile`
      );
      assert.ok(!observed.has(file), `duplicate PostgreSQL suite report: ${file}`);
      assert.equal(result.status, 'passed', `${file} did not pass`);
      assert.ok(Array.isArray(result.assertionResults), `${file} has no assertion results`);
      assert.equal(
        result.assertionResults.length,
        expectation.expectedTests,
        `${file} test count drifted; update the reviewed manifest intentionally`
      );
      for (const assertion of result.assertionResults) {
        assert.equal(
          assertion.status,
          'passed',
          `${file}: ${assertion.fullName ?? assertion.title} did not pass`
        );
      }
      observed.set(file, result.assertionResults.length);
    }
  }

  assert.deepEqual(
    [...observed.keys()].sort(),
    [...expected.keys()].sort(),
    'a required PostgreSQL suite was absent from the reports'
  );
  const testCount = [...observed.values()].reduce((sum, value) => sum + value, 0);
  return { profileCount: manifest.profiles.length, suiteCount: observed.size, testCount };
}

function checkedAdminUrl(rawValue) {
  assert.ok(rawValue, 'HX_REQUIRED_PG_ADMIN_DATABASE_URL is required');
  const parsed = new URL(rawValue);
  assert.ok(['postgres:', 'postgresql:'].includes(parsed.protocol));
  assert.ok(['127.0.0.1', 'localhost'].includes(parsed.hostname));
  assert.equal(parsed.username, 'hx_ci_admin');
  assert.equal(parsed.pathname, '/hx_ci_admin_test');
  assert.ok(parsed.password.length > 0);
  return parsed;
}

function databaseUrl(source, database, username, password) {
  const target = new URL(source);
  target.pathname = `/${database}`;
  target.username = username;
  target.password = password;
  target.search = '';
  target.hash = '';
  return target.toString();
}

async function provisionRequiredTestDatabase(adminUrl) {
  const [{ REQUIRED_MIGRATION_FILES }, { engineMigrationManifest }] = await Promise.all([
    import(
      pathToFileURL(
        resolve(REPOSITORY_ROOT, 'dist/backend/src/jobs/engine-automation-migration-files.js')
      ).href
    ),
    import(
      pathToFileURL(resolve(REPOSITORY_ROOT, 'dist/backend/src/jobs/engine-migration-manifest.js'))
        .href
    ),
  ]);
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const server = await admin.query("SELECT current_setting('server_version') AS version");
    assert.equal(
      server.rows[0]?.version,
      '17.7',
      'required CI must execute PostgreSQL 17.7 exactly'
    );
    const template = await admin.query(
      'SELECT datname FROM pg_catalog.pg_database WHERE datname=$1',
      [TEMPLATE_DATABASE]
    );
    assert.equal(template.rows.length, 1, 'the exact migrated fresh database is absent');
    await admin.query(`
      DO $role$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname='${TEST_RUNTIME_ROLE}') THEN
          CREATE ROLE ${TEST_RUNTIME_ROLE} LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}' NOINHERIT;
        END IF;
      END;
      $role$;
      ALTER ROLE ${TEST_RUNTIME_ROLE} WITH LOGIN PASSWORD '${TEST_RUNTIME_PASSWORD}'
        NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
      ALTER ROLE ${TEST_RUNTIME_ROLE} SET search_path = pg_catalog, public;
    `);
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`);
    await admin.query(
      `CREATE DATABASE ${TEST_DATABASE} WITH TEMPLATE ${TEMPLATE_DATABASE} OWNER ${MIGRATION_OWNER}`
    );
    await admin.query(`REVOKE CREATE, TEMPORARY ON DATABASE ${TEST_DATABASE} FROM PUBLIC`);
    await admin.query(
      `REVOKE CREATE, TEMPORARY ON DATABASE ${TEST_DATABASE} FROM ${TEST_RUNTIME_ROLE}`
    );
    await admin.query(`GRANT CONNECT ON DATABASE ${TEST_DATABASE} TO ${TEST_RUNTIME_ROLE}`);
  } finally {
    await admin.end();
  }

  const testAdminUrl = databaseUrl(adminUrl, TEST_DATABASE, adminUrl.username, adminUrl.password);
  const testAdmin = new Client({ connectionString: testAdminUrl });
  await testAdmin.connect();
  try {
    await testAdmin.query(`
      ALTER TABLE public.hx_database_identity
        DISABLE TRIGGER migration_control_destructive_guard;
      UPDATE public.hx_database_identity identity
         SET cluster_system_identifier=control.system_identifier::text,
             database_oid=database_row.oid,
             database_name=database_row.datname,
             recorded_at=clock_timestamp()
        FROM pg_catalog.pg_database database_row
        CROSS JOIN pg_catalog.pg_control_system() control
       WHERE identity.singleton IS TRUE
         AND database_row.datname=pg_catalog.current_database();
      ALTER TABLE public.hx_database_identity
        ENABLE TRIGGER migration_control_destructive_guard;

      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      REVOKE CREATE ON SCHEMA public FROM ${TEST_RUNTIME_ROLE};
      GRANT USAGE ON SCHEMA public TO ${TEST_RUNTIME_ROLE};
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TEST_RUNTIME_ROLE};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TEST_RUNTIME_ROLE};
      REVOKE TRIGGER, TRUNCATE, REFERENCES ON ALL TABLES IN SCHEMA public FROM ${TEST_RUNTIME_ROLE};
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON public.applied_migrations,
           public.schema_versions,
           public.hx_database_identity
        FROM ${TEST_RUNTIME_ROLE};
      REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
        ON public.ops_business_claim_links,
           public.hxos_local_test_business_payout_destinations,
           public.hxos_local_test_business_payout_transfers
        FROM ${TEST_RUNTIME_ROLE};
      REVOKE EXECUTE ON FUNCTION public.reject_pr276_incident_table_mutation()
        FROM ${TEST_RUNTIME_ROLE};
      REVOKE EXECUTE ON FUNCTION public.reject_control_table_destructive_mutation()
        FROM ${TEST_RUNTIME_ROLE};
    `);
  } finally {
    await testAdmin.end();
  }

  const runtimeUrl = databaseUrl(adminUrl, TEST_DATABASE, TEST_RUNTIME_ROLE, TEST_RUNTIME_PASSWORD);
  const runtime = new Client({ connectionString: runtimeUrl });
  await runtime.connect();
  try {
    const expectedLedger = await engineMigrationManifest();
    assert.equal(expectedLedger.length, REQUIRED_MIGRATION_FILES.length);
    const ledger = await runtime.query(`
      SELECT name,ordinal,source_sha256
        FROM public.applied_migrations
       ORDER BY ordinal
    `);
    assert.deepEqual(
      ledger.rows,
      expectedLedger.map(({ name, ordinal, sha256 }) => ({
        name,
        ordinal,
        source_sha256: sha256,
      })),
      'required suite database must preserve the exact ordered, hash-bound migration ledger'
    );
    const boundary = await runtime.query(`
      SELECT current_database() AS database_name,
             current_user AS database_role,
             current_setting('server_version') AS server_version,
             (role.rolsuper OR role.rolcreatedb OR role.rolcreaterole
               OR role.rolreplication OR role.rolbypassrls) AS elevated_role,
             role.rolinherit AS inherits_roles,
             pg_catalog.has_database_privilege(current_user,current_database(),'CREATE') AS can_create,
             pg_catalog.has_database_privilege(current_user,current_database(),'TEMPORARY') AS can_temp,
             pg_catalog.has_schema_privilege(current_user,'public','CREATE') AS can_create_schema,
             pg_catalog.has_parameter_privilege(
               current_user,'session_replication_role','SET'
             ) AS can_set_replication_role,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_auth_members membership
                WHERE membership.member=role.oid
             ) AS has_role_memberships,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_database database_row
                WHERE database_row.datname=current_database()
                  AND pg_catalog.pg_has_role(current_user,database_row.datdba,'MEMBER')
             ) AS owns_database,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_namespace namespace_row
                WHERE namespace_row.nspname='public'
                  AND pg_catalog.pg_has_role(current_user,namespace_row.nspowner,'MEMBER')
             ) AS owns_public_schema,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_class class_row
               JOIN pg_catalog.pg_namespace namespace_row
                 ON namespace_row.oid=class_row.relnamespace
                WHERE namespace_row.nspname='public'
                  AND pg_catalog.pg_has_role(current_user,class_row.relowner,'MEMBER')
             ) AS owns_public_objects,
             EXISTS (
               SELECT 1 FROM pg_catalog.pg_class trigger_target
               JOIN pg_catalog.pg_namespace trigger_namespace
                 ON trigger_namespace.oid=trigger_target.relnamespace
                WHERE trigger_namespace.nspname='public'
                  AND trigger_target.relkind IN ('r','p')
                  AND pg_catalog.has_table_privilege(
                    current_user,trigger_target.oid,'TRIGGER'
                  )
             ) AS can_create_triggers,
             current_user=session_user AS direct_session_identity,
             current_setting('session_replication_role')='origin' AS replication_role_is_origin,
             pg_catalog.current_setting('search_path') AS search_path,
             identity.database_name::text AS recorded_database_name,
             identity.migration_owner::text AS migration_owner,
             (SELECT COUNT(*)::integer FROM public.applied_migrations) AS migration_count
        FROM public.hx_database_identity identity
        CROSS JOIN pg_catalog.pg_roles role
       WHERE identity.singleton IS TRUE
         AND role.rolname=current_user
    `);
    assert.deepEqual(boundary.rows, [
      {
        database_name: TEST_DATABASE,
        database_role: TEST_RUNTIME_ROLE,
        server_version: '17.7',
        elevated_role: false,
        inherits_roles: false,
        can_create: false,
        can_temp: false,
        can_create_schema: false,
        can_set_replication_role: false,
        has_role_memberships: false,
        owns_database: false,
        owns_public_schema: false,
        owns_public_objects: false,
        can_create_triggers: false,
        direct_session_identity: true,
        replication_role_is_origin: true,
        search_path: 'pg_catalog, public',
        recorded_database_name: TEST_DATABASE,
        migration_owner: MIGRATION_OWNER,
        migration_count: REQUIRED_MIGRATION_FILES.length,
      },
    ]);
  } finally {
    await runtime.end();
  }

  return { runtimeUrl, adminUrl: testAdminUrl };
}

export function childEnvironment(databaseUrlValue, authority, baseEnvironment = process.env) {
  const environment = { ...baseEnvironment, ...ENABLED_TEST_ENVIRONMENT };
  for (const key of [
    'ADMIN_DATABASE_URL',
    'DATABASE_PUBLIC_URL',
    'DATABASE_REPLICA_URL',
    'DIRECT_URL',
    'HX_REQUIRED_PG_ADMIN_DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'PGDATABASE',
    'PGHOST',
    'PGPASSFILE',
    'PGPASSWORD',
    'PGPORT',
    'PGSERVICE',
    'PGSERVICEFILE',
    'PGUSER',
    'REDIS_URL',
    'UPSTASH_REDIS_URL',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'TEST_DATABASE_URL',
    'TEST_UPSTASH_REDIS_REST_URL',
    'TEST_UPSTASH_REDIS_REST_TOKEN',
  ]) {
    delete environment[key];
  }
  environment.DATABASE_URL = databaseUrlValue;
  environment.HXOS_LOCAL_TEST_DATABASE_ROLE =
    authority === 'runtime' ? TEST_RUNTIME_ROLE : 'hx_ci_admin';
  return environment;
}

async function run() {
  const manifest = validatedManifest(JSON.parse(await readFile(MANIFEST_PATH, 'utf8')));
  const adminUrl = checkedAdminUrl(process.env.HX_REQUIRED_PG_ADMIN_DATABASE_URL?.trim());
  const databases = await provisionRequiredTestDatabase(adminUrl);
  const reportDirectory = await mkdtemp(join(tmpdir(), 'hx-required-postgres-'));
  const reports = [];

  for (const profile of manifest.profiles) {
    const reportPath = join(reportDirectory, `${profile.name}.json`);
    const selectedDatabaseUrl =
      profile.authority === 'runtime' ? databases.runtimeUrl : databases.adminUrl;
    const execution = spawnSync(
      process.execPath,
      [
        VITEST_PATH,
        'run',
        ...profile.suites.map((suite) => suite.file),
        '--reporter=verbose',
        '--reporter=json',
        `--outputFile.json=${reportPath}`,
        '--maxWorkers=1',
        '--minWorkers=1',
      ],
      {
        cwd: REPOSITORY_ROOT,
        env: childEnvironment(selectedDatabaseUrl, profile.authority),
        stdio: 'inherit',
      }
    );
    assert.equal(execution.error, undefined, `${profile.name} Vitest process could not start`);
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    reports.push({ profileName: profile.name, report });
    assert.equal(execution.status, 0, `${profile.name} Vitest process failed`);
  }

  const result = verifyRequiredPostgresReports(manifest, reports);
  process.stdout.write(
    `HX_REQUIRED_POSTGRES_SUITES_OK ${result.profileCount}_PROFILES ${result.suiteCount}_SUITES ${result.testCount}_TESTS ZERO_SKIPS\n`
  );
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  run().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`
    );
    process.exitCode = 1;
  });
}

export { validatedManifest };
