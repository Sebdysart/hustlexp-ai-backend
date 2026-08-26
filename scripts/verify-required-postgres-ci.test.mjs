import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import {
  childEnvironment,
  validatedManifest,
  verifyRequiredPostgresReports,
} from './run-required-postgres-suites.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(repositoryRoot, '.github/workflows/ci.yml');
const manifestPath = resolve(repositoryRoot, 'scripts/required-postgres-suites.json');

async function loadManifest() {
  return validatedManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
}

function passingReports(manifest) {
  return manifest.profiles.map((profile) => {
    const testResults = profile.suites.map((suite) => ({
      name: resolve(repositoryRoot, suite.file),
      status: 'passed',
      assertionResults: Array.from({ length: suite.expectedTests }, (_, index) => ({
        status: 'passed',
        fullName: `${suite.file} proof ${index + 1}`,
      })),
    }));
    return {
      profileName: profile.name,
      report: {
        success: true,
        numFailedTests: 0,
        numPendingTests: 0,
        numTodoTests: 0,
        testResults,
      },
    };
  });
}

test('required CI isolates arbitrary unit tests from persistent database and Redis secrets', async () => {
  const source = await readFile(workflowPath, 'utf8');
  const workflow = yaml.load(source);
  const testJob = workflow.jobs.test;
  const build = workflow.jobs.build;

  assert.doesNotMatch(source, /secrets\.TEST_DATABASE_URL/u);
  assert.doesNotMatch(source, /secrets\.TEST_UPSTASH_REDIS_REST_(?:URL|TOKEN)/u);
  assert.equal(testJob.services, undefined);
  assert.equal(testJob.env.DATABASE_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_TOKEN, undefined);

  const contractIndex = testJob.steps.findIndex(
    (step) => step.name === 'Required PostgreSQL CI contract'
  );
  const unitIndex = testJob.steps.findIndex((step) => step.name === 'Tests — zero failures');
  assert.ok(contractIndex >= 0 && contractIndex < unitIndex);
  assert.equal(
    testJob.steps[contractIndex].run,
    'node --test scripts/verify-required-postgres-ci.test.mjs'
  );
  assert.equal(testJob.steps[unitIndex].env, undefined);

  assert.deepEqual(build.needs, ['typecheck', 'lint', 'test']);
  assert.equal(build.services.postgres.image, 'postgres:17.7-alpine');
  assert.equal(build.services.postgres.env.POSTGRES_USER, 'hx_ci_admin');
  assert.equal(build.services.postgres.env.POSTGRES_DB, 'hx_ci_admin_test');
  const buildCheckout = build.steps.find((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(buildCheckout.with['fetch-depth'], 0);
});

test('required PostgreSQL suites run after the exact separated-role migration proof', async () => {
  const workflow = yaml.load(await readFile(workflowPath, 'utf8'));
  const steps = workflow.jobs.build.steps;
  const compileIndex = steps.findIndex((step) => step.run === 'npm run compile');
  const migrationIndex = steps.findIndex(
    (step) => step.name === 'Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL'
  );
  const suiteIndex = steps.findIndex(
    (step) => step.name === 'Run required PostgreSQL money and lifecycle suites with zero skips'
  );
  assert.ok(compileIndex >= 0 && compileIndex < migrationIndex && migrationIndex < suiteIndex);

  const migration = steps[migrationIndex];
  assert.match(migration.env.ADMIN_DATABASE_URL, /hx_ci_admin.*hx_ci_admin_test/u);
  assert.match(migration.env.MIGRATION_DATABASE_URL, /hx_ci_migrator.*hx_ci_fresh_test/u);
  assert.match(migration.env.DATABASE_URL, /hx_ci_runtime.*hx_ci_fresh_test/u);
  assert.equal(migration.run, 'node scripts/verify-engine-migrations-postgres.mjs');

  const suite = steps[suiteIndex];
  assert.equal(suite.run, 'node scripts/run-required-postgres-suites.mjs');
  assert.match(suite.env.HX_REQUIRED_PG_ADMIN_DATABASE_URL, /^postgresql:\/\/hx_ci_admin:/u);
  assert.doesNotMatch(JSON.stringify(suite), /\$\{\{\s*secrets\./u);
});

test('suite subprocesses cannot inherit migrator, admin, persistent database, or Redis credentials', () => {
  const environment = childEnvironment(
    'postgresql://hx_test_unit_guard:local@127.0.0.1:5432/hx_unit_test_guard',
    'runtime',
    {
      ADMIN_DATABASE_URL: 'persistent-admin',
      DATABASE_PUBLIC_URL: 'persistent-public',
      DATABASE_REPLICA_URL: 'persistent-replica',
      DIRECT_URL: 'persistent-direct',
      HX_REQUIRED_PG_ADMIN_DATABASE_URL: 'disposable-admin',
      MIGRATION_DATABASE_URL: 'persistent-migrator',
      PGPASSWORD: 'persistent-password',
      REDIS_URL: 'persistent-redis',
      TEST_DATABASE_URL: 'persistent-test-database',
      TEST_UPSTASH_REDIS_REST_TOKEN: 'persistent-test-redis-token',
      UPSTASH_REDIS_REST_TOKEN: 'persistent-redis-token',
    }
  );
  for (const key of [
    'ADMIN_DATABASE_URL',
    'DATABASE_PUBLIC_URL',
    'DATABASE_REPLICA_URL',
    'DIRECT_URL',
    'HX_REQUIRED_PG_ADMIN_DATABASE_URL',
    'MIGRATION_DATABASE_URL',
    'PGPASSWORD',
    'REDIS_URL',
    'TEST_DATABASE_URL',
    'TEST_UPSTASH_REDIS_REST_TOKEN',
    'UPSTASH_REDIS_REST_TOKEN',
  ]) {
    assert.equal(environment[key], undefined, `${key} escaped into the suite process`);
  }
  assert.equal(
    environment.DATABASE_URL,
    'postgresql://hx_test_unit_guard:local@127.0.0.1:5432/hx_unit_test_guard'
  );
  assert.equal(environment.HXOS_LOCAL_TEST_DATABASE_ROLE, 'hx_test_unit_guard');
  assert.equal(environment.HX_ALLOW_E2E_LIFECYCLE, '1');
  assert.equal(environment.HX_ALLOW_E2E_LIQUIDITY_EXPANSION, '1');
  assert.equal(environment.HX_ALLOW_WORKER_COUNTER_E2E, '1');
  assert.equal(environment.HX_ALLOW_NOTIFICATION_PG, '1');
  assert.equal(environment.HX_STRIPE_STUB, '1');
  assert.equal(environment.STRIPE_MODE, 'test');
  assert.match(environment.STRIPE_SECRET_KEY, /^sk_test_/u);
});

test('reviewed manifest names every required PostgreSQL money/lifecycle suite exactly', async () => {
  const manifest = await loadManifest();
  assert.deepEqual(
    manifest.profiles.map(({ name, authority, suites }) => ({
      name,
      authority,
      suites: suites.map(({ file, expectedTests }) => [file, expectedTests]),
    })),
    [
      {
        name: 'least_privilege_runtime',
        authority: 'runtime',
        suites: [
          ['backend/tests/invariants/n6-mutation-eligibility.pg.test.ts', 9],
          ['backend/tests/system/hxos-canonical-lifecycle.pg.test.ts', 1],
          ['backend/tests/system/hxos-lifecycle-exceptions.pg.test.ts', 1],
          ['backend/tests/system/liquidity-expansion.pg.test.ts', 3],
          ['backend/tests/system/worker-counter-offer.pg.test.ts', 1],
        ],
      },
      {
        name: 'superuser_fixture_only',
        authority: 'admin_fixture',
        suites: [
          ['backend/tests/system/escrow-release-outbox.pg.test.ts', 2],
          ['backend/tests/system/notification-delivery-contract.pg.test.ts', 5],
        ],
      },
    ]
  );
});

test('report admission rejects skips, count drift, missing suites, and wrong authority', async () => {
  const manifest = await loadManifest();
  const reports = passingReports(manifest);
  assert.deepEqual(verifyRequiredPostgresReports(manifest, reports, repositoryRoot), {
    profileCount: 2,
    suiteCount: 7,
    testCount: 22,
  });

  const skipped = structuredClone(reports);
  skipped[0].report.numPendingTests = 1;
  skipped[0].report.testResults[0].assertionResults[0].status = 'skipped';
  assert.throws(
    () => verifyRequiredPostgresReports(manifest, skipped, repositoryRoot),
    /contains skipped\/pending tests/u
  );

  const countDrift = structuredClone(reports);
  countDrift[0].report.testResults[0].assertionResults.pop();
  assert.throws(
    () => verifyRequiredPostgresReports(manifest, countDrift, repositoryRoot),
    /test count drifted/u
  );

  const missing = structuredClone(reports);
  missing[0].report.testResults.pop();
  assert.throws(
    () => verifyRequiredPostgresReports(manifest, missing, repositoryRoot),
    /required PostgreSQL suite was absent/u
  );

  const wrongAuthority = structuredClone(reports);
  wrongAuthority[1].report.testResults.push(wrongAuthority[0].report.testResults.pop());
  assert.throws(
    () => verifyRequiredPostgresReports(manifest, wrongAuthority, repositoryRoot),
    /ran under the wrong authority profile/u
  );
});
