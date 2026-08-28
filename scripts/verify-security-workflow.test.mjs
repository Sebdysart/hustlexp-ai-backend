import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import yaml from 'js-yaml';
import { REQUIRED_TEST_GATES } from './run-required-tests.mjs';

const workflowUrl = new URL('../.github/workflows/security.yml', import.meta.url);
const ciWorkflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);
const exactGateSources = Object.freeze({
  HX_ALLOW_E2E_LIFECYCLE: [
    '../backend/tests/system/escrow-release-outbox.pg.test.ts',
    '../backend/tests/system/hxos-canonical-lifecycle.pg.test.ts',
    '../backend/tests/system/hxos-lifecycle-exceptions.pg.test.ts',
  ],
  HX_ALLOW_E2E_LIQUIDITY_EXPANSION: [
    '../backend/tests/system/liquidity-expansion.pg.test.ts',
  ],
  HX_ALLOW_NOTIFICATION_PG: [
    '../backend/tests/system/notification-delivery-contract.pg.test.ts',
  ],
  HX_ALLOW_LEAD_INGRESS_PG: [
    '../backend/tests/system/universal-v1-lead-ingress.pg.test.ts',
  ],
  HX_ALLOW_TASK_DRAFT_INGRESS_PG: [
    '../backend/tests/system/universal-v1-task-draft-claim.pg.test.ts',
    '../backend/tests/system/universal-v1-task-draft-legacy-port.pg.test.ts',
    '../backend/tests/system/universal-v1-task-draft-public.pg.test.ts',
  ],
  HX_ALLOW_WORKER_COUNTER_E2E: [
    '../backend/tests/system/worker-counter-offer.pg.test.ts',
  ],
});

function requiredStep(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `workflow step must exist: ${name}`);
  return step;
}

function requiredStepIndex(job, name) {
  const index = job.steps.findIndex((step) => step.name === name);
  assert.ok(index >= 0, `workflow step must exist: ${name}`);
  return index;
}

test('public-repository security checks cannot be disabled by a repository variable', async () => {
  const source = await readFile(workflowUrl, 'utf8');
  const workflow = yaml.load(source);

  assert.equal(typeof workflow, 'object');
  assert.equal(workflow.permissions.contents, 'read');
  assert.ok(workflow.on.pull_request);
  assert.ok(workflow.on.schedule);

  const audit = workflow.jobs.audit;
  const installIndex = audit.steps.findIndex((step) => step.run === 'npm ci');
  const contractIndex = audit.steps.findIndex(
    (step) => step.run === 'npm run verify:security-workflow:contract'
  );
  assert.ok(installIndex >= 0);
  assert.ok(contractIndex > installIndex, 'workflow contract requires installed parser dependencies');

  const codeql = workflow.jobs.codeql;
  assert.equal(codeql['continue-on-error'], undefined);
  assert.equal(codeql.permissions['security-events'], 'write');
  assert.ok(codeql.steps.some((step) => step.uses === 'github/codeql-action/init@v3'));
  assert.ok(codeql.steps.some((step) => step.uses === 'github/codeql-action/analyze@v3'));

  const dependencyReview = workflow.jobs['dependency-review'];
  assert.equal(dependencyReview['continue-on-error'], undefined);
  assert.equal(dependencyReview.if, "${{ github.event_name == 'pull_request' }}");
  assert.ok(dependencyReview.steps.some(
    (step) => step.uses === 'actions/dependency-review-action@v4'
  ));

  const snyk = workflow.jobs.snyk;
  assert.equal(snyk.env, undefined, 'SNYK_TOKEN must not be exposed to setup or install steps');
  const snykScan = snyk.steps.find((step) => step.name === 'Snyk scan');
  assert.match(snykScan.uses, /^snyk\/actions\/node@[a-f0-9]{40}$/);
  assert.equal(snykScan.env.SNYK_TOKEN, '${{ secrets.SNYK_TOKEN }}');

  assert.doesNotMatch(source, /ENABLE_GITHUB_ADVANCED_SECURITY/);
});

test('build validation executes migrations on PostgreSQL and verifies the exact image artifact', async () => {
  const workflow = yaml.load(await readFile(ciWorkflowUrl, 'utf8'));
  const build = workflow.jobs.build;
  assert.equal(build.services.postgres.image, 'postgres:16-alpine');
  const steps = workflow.jobs.build.steps;
  const containerBuild = steps.find((step) => step.name === 'Build production container');
  const postgresProof = steps.find(
    (step) => step.name === 'Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL'
  );
  const migrationProof = steps.find(
    (step) => step.name === 'Verify exact production image migration artifact'
  );

  assert.match(containerBuild.run, /docker build/);
  assert.match(containerBuild.run, /--build-arg GITHUB_SHA=/);
  assert.equal(postgresProof.run, 'node scripts/verify-engine-migrations-postgres.mjs');
  assert.match(postgresProof.env.DATABASE_URL, /127\.0\.0\.1.*hx_ci_admin_test/);
  assert.equal(postgresProof.env.NODE_ENV, 'test');
  assert.equal(postgresProof.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.match(migrationProof.run, /docker run --rm --entrypoint node/);
  assert.match(migrationProof.run, /engine-migration-artifact\.sha256/);
  assert.match(migrationProof.run, /test "\$image_digest" = "\$expected_digest"/);

  const ordered = [
    steps.findIndex((step) => step.run === 'npm ci'),
    requiredStepIndex(build, 'Validate build compiles cleanly'),
    requiredStepIndex(build, 'Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL'),
    requiredStepIndex(build, 'Build production container'),
    requiredStepIndex(build, 'Verify exact production image migration artifact'),
  ];
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
  assert.equal(new Set(ordered).size, ordered.length);
});

test('required tests use isolated loopback PostgreSQL and Redis without shared secrets', async () => {
  const source = await readFile(ciWorkflowUrl, 'utf8');
  const workflow = yaml.load(source);
  const testJob = workflow.jobs.test;
  assert.equal(testJob.env.DATABASE_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_TOKEN, undefined);

  const prepareStep = testJob.steps.find(
    (step) => step.name === 'Prepare isolated invariant and system PostgreSQL databases'
  );
  assert.match(prepareStep.env.DATABASE_URL, /127\.0\.0\.1.*hx_ci_admin_test/);

  const testStep = testJob.steps.find(
    (step) => step.name === 'Tests — zero failures and zero skipped\/todo'
  );
  assert.match(testStep.env.DATABASE_URL, /127\.0\.0\.1.*hx_ci_invariant_test/);
  assert.match(testStep.env.LOCAL_TEST_DB_URL, /127\.0\.0\.1.*hx_ci_system_test/);
  assert.equal(testStep.env.REDIS_URL, 'redis://127.0.0.1:16379');
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(testStep.env)
        .filter(([name]) => name.startsWith('HX_ALLOW_'))
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    Object.fromEntries(REQUIRED_TEST_GATES.map((name) => [name, '1'])),
  );
  assert.equal(testStep.env.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(testStep.env.UPSTASH_REDIS_REST_TOKEN, undefined);

  assert.doesNotMatch(source, /secrets\.TEST_DATABASE_URL/u);
  assert.doesNotMatch(source, /secrets\.TEST_UPSTASH_/u);
});

test('source opt-in gates and workflow gates remain an exact one-to-one contract', async () => {
  assert.deepEqual(Object.keys(exactGateSources), REQUIRED_TEST_GATES);
  for (const [gate, paths] of Object.entries(exactGateSources)) {
    for (const path of paths) {
      const source = await readFile(new URL(path, import.meta.url), 'utf8');
      assert.match(
        source,
        new RegExp(`process\\.env\\.${gate}\\s*===\\s*'1'`, 'u'),
        `${path} must retain its explicit ${gate} opt-in`,
      );
    }
  }

  const workflow = yaml.load(await readFile(ciWorkflowUrl, 'utf8'));
  const testStep = requiredStep(
    workflow.jobs.test,
    'Tests — zero failures and zero skipped/todo',
  );
  for (const gate of REQUIRED_TEST_GATES) assert.equal(testStep.env[gate], '1');
  assert.equal(testStep.env.ENGINE_API_MODE, 'test');
  assert.equal(testStep.env.STRIPE_MODE, 'test');
  for (const provider of [
    'IDENTITY',
    'SCREENING',
    'PAYOUT',
    'DURATION_EVIDENCE',
    'PROVIDER_CAPABILITY',
    'LIQUIDITY',
    'OFFER_REVIEW',
  ]) {
    assert.equal(testStep.env[`HXOS_ALLOW_LOCAL_TEST_${provider}`], 'true');
    assert.ok(testStep.env[`HXOS_LOCAL_TEST_${provider}_SECRET`].length >= 32);
  }
});

test('recreate authority and required-test ordering stay narrow and fail closed', async () => {
  const workflow = yaml.load(await readFile(ciWorkflowUrl, 'utf8'));
  const testJob = workflow.jobs.test;
  const buildJob = workflow.jobs.build;
  const prepare = requiredStep(
    testJob,
    'Prepare isolated invariant and system PostgreSQL databases',
  );
  const execute = requiredStep(
    testJob,
    'Tests — zero failures and zero skipped/todo',
  );
  const migrationProof = requiredStep(
    buildJob,
    'Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL',
  );
  assert.equal(prepare.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.equal(execute.env.HX_ALLOW_CI_DB_RECREATE, undefined);
  assert.equal(migrationProof.env.HX_ALLOW_CI_DB_RECREATE, 'true');

  const recreateScopes = Object.entries(workflow.jobs).flatMap(([jobName, job]) =>
    (job.steps || [])
      .filter((step) => step.env?.HX_ALLOW_CI_DB_RECREATE !== undefined)
      .map((step) => `${jobName}:${step.name}`)
  ).sort();
  assert.deepEqual(recreateScopes, [
    'build:Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL',
    'test:Prepare isolated invariant and system PostgreSQL databases',
  ]);

  const ordered = [
    requiredStepIndex(testJob, 'Compile exact test runtime'),
    requiredStepIndex(testJob, 'Test database and outcome verifier contracts'),
    requiredStepIndex(testJob, 'Prepare isolated invariant and system PostgreSQL databases'),
    requiredStepIndex(testJob, 'Tests — zero failures and zero skipped/todo'),
    requiredStepIndex(testJob, 'Preserve exact Vitest evidence'),
  ];
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
  assert.equal(new Set(ordered).size, ordered.length);
});
