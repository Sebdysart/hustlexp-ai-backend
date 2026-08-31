import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import yaml from 'js-yaml';

const workflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);

async function workflowSource() {
  return readFile(workflowPath, 'utf8');
}

async function workflowDocument() {
  return yaml.load(await workflowSource());
}

function findStep(job, name) {
  const step = job.steps.find((candidate) => candidate.name === name);
  assert.ok(step, `workflow step must exist: ${name}`);
  return step;
}

function stepIndex(job, name) {
  const index = job.steps.findIndex((step) => step.name === name);
  assert.ok(index >= 0, `workflow step must exist: ${name}`);
  return index;
}

function installsDependencies(step) {
  return typeof step.run === 'string'
    && /(?:^|\n)\s*(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install)\b/u.test(step.run);
}

test('required CI has read-only repository authority and never persists checkout credentials', async () => {
  const workflow = await workflowDocument();
  assert.equal(workflow.permissions.contents, 'read');

  const checkoutSteps = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps || []).filter((step) => step.uses === 'actions/checkout@v4')
  );
  assert.ok(checkoutSteps.length > 0);
  assert.ok(checkoutSteps.every((step) => step.with?.['persist-credentials'] === false));
  assert.ok(checkoutSteps.every((step) => step.with?.ref === '${{ env.HX_CANDIDATE_SHA }}'));
  assert.equal(
    workflow.env.HX_CANDIDATE_SHA,
    '${{ github.event.pull_request.head.sha || github.sha }}'
  );
  assert.equal(workflow.env.HX_BUILD_REVISION, workflow.env.HX_CANDIDATE_SHA);
  assert.equal(workflow.env.HX_BUILD_SOURCE_CLEAN, 'true');
});

test('every install lane proves exact-candidate local-tooling absence before npm install', async () => {
  const workflow = await workflowDocument();
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const install = (job.steps || []).findIndex(installsDependencies);
    if (install < 0) continue;
    const checkout = job.steps.findIndex((step) => step.uses === 'actions/checkout@v4');
    const hygieneIndex = stepIndex(job, 'Verify exact candidate excludes bundled local tooling');
    const hygiene = job.steps[hygieneIndex];

    assert.equal(hygiene.run, 'node scripts/verify-local-tools-absence.mjs', jobName);
    assert.equal(hygiene.env.HX_EXACT_CANDIDATE_SHA, '${{ env.HX_CANDIDATE_SHA }}', jobName);
    assert.equal(hygiene['continue-on-error'], undefined, jobName);
    assert.ok(checkout >= 0 && checkout < hygieneIndex && hygieneIndex < install, jobName);
  }
});

test('required test check provisions only isolated PostgreSQL and loopback Redis services', async () => {
  const workflow = await workflowDocument();
  const job = workflow.jobs.test;
  const suite = findStep(job, 'Tests — zero failures and zero skipped/todo');

  assert.equal(job.name, 'Tests — zero failures');
  assert.equal(job.needs, 'typecheck');
  assert.equal(job.services.postgres.image, 'postgres:16-alpine');
  assert.equal(job.services.postgres.env.POSTGRES_DB, 'hx_ci_admin_test');
  assert.equal(job.services.redis.image, 'redis:7-alpine');
  assert.deepEqual(job.services.redis.ports, ['16379:6379']);
  assert.equal(
    suite.env.DATABASE_URL,
    'postgresql://hx_ci_runner:hx_ci_password@127.0.0.1:5432/hx_ci_admin_test'
  );
  assert.equal(suite.env.REDIS_URL, 'redis://127.0.0.1:16379');
  assert.equal(suite.env.HX_EXACT_CANDIDATE_SHA, '${{ env.HX_CANDIDATE_SHA }}');
  assert.equal(suite.env.LOCAL_TEST_DB_URL, undefined);
});

test('CI delegates the complete suite and deterministic provider policy to one runner', async () => {
  const workflow = await workflowSource();
  const document = await workflowDocument();
  const suite = findStep(document.jobs.test, 'Tests — zero failures and zero skipped/todo');

  assert.equal(suite.run, 'npm run test:required');
  assert.equal(suite['timeout-minutes'], 60);
  assert.equal(suite.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.deepEqual(
    Object.keys(suite.env).filter((name) => name.startsWith('HX_ALLOW_E2E_')),
    []
  );
  assert.equal(suite.env.HX_PAYMENT_CREATION_MODE, undefined);
  assert.doesNotMatch(workflow, /run: node scripts\/prepare-test-databases\.mjs/u);
  assert.doesNotMatch(workflow, /npx vitest run/u);
  assert.doesNotMatch(workflow, /continue-on-error/u);
  assert.doesNotMatch(workflow, /\|\|\s*true/u);
});

test('database recreation authority is scoped only to the runner and migration proof', async () => {
  const workflow = await workflowDocument();
  const suite = findStep(workflow.jobs.test, 'Tests — zero failures and zero skipped/todo');
  const postgresProof = findStep(
    workflow.jobs.build,
    'Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL'
  );

  assert.equal(suite.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.equal(postgresProof.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.equal(workflow.jobs.test.env.HX_ALLOW_CI_DB_RECREATE, undefined);
  assert.equal(workflow.jobs.build.env?.HX_ALLOW_CI_DB_RECREATE, undefined);
  assert.equal(workflow.jobs.test.env.NODE_ENV, 'test');
  assert.equal(postgresProof.env.NODE_ENV, 'test');

  const authorized = [];
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    for (const step of job.steps || []) {
      if (step.env?.HX_ALLOW_CI_DB_RECREATE !== undefined) {
        authorized.push(`${jobName}:${step.name}`);
      }
    }
  }
  assert.deepEqual(authorized.sort(), [
    'build:Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL',
    'test:Tests — zero failures and zero skipped/todo',
  ]);
});

test('required test stages preserve install-runner-evidence-role-legal ordering', async () => {
  const workflow = await workflowDocument();
  const job = workflow.jobs.test;
  const ordered = [
    job.steps.findIndex(installsDependencies),
    stepIndex(job, 'Tests — zero failures and zero skipped/todo'),
    stepIndex(job, 'Preserve exact Vitest evidence'),
    stepIndex(job, 'Production role readiness contract'),
    stepIndex(job, 'Production legal approval contract'),
  ];
  assert.ok(ordered.every((index) => index >= 0));
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
  assert.equal(new Set(ordered).size, ordered.length);
});

test('required test evidence is exact-SHA named and cannot pass without a report', async () => {
  const workflow = await workflowSource();
  const document = await workflowDocument();
  const evidence = findStep(document.jobs.test, 'Preserve exact Vitest evidence');

  assert.equal(evidence.if, 'always()');
  assert.equal(evidence.with.name, 'vitest-${{ env.HX_CANDIDATE_SHA }}');
  assert.equal(evidence.with.path, 'reports/vitest-required.json');
  assert.equal(evidence.with['if-no-files-found'], 'error');
  assert.doesNotMatch(workflow, /reports\/vitest\.json/u);
});

test('required test check does not depend on ambient shared infrastructure secrets', async () => {
  const workflow = await workflowSource();

  assert.doesNotMatch(workflow, /secrets\.TEST_DATABASE_URL/u);
  assert.doesNotMatch(workflow, /secrets\.UPSTASH_/u);
  assert.doesNotMatch(workflow, /neon\.tech/u);
  assert.doesNotMatch(workflow, /supabase/u);
  assert.doesNotMatch(workflow, /FIREBASE_PROJECT_ID: test-project/u);
});

test('package exposes cross-platform fail-closed required and hygiene runners', async () => {
  const packageDocument = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(packageDocument.scripts['test:required'], 'node scripts/run-required-tests.mjs');
  assert.equal(
    packageDocument.scripts['verify:consequential-admin'],
    'node scripts/verify-consequential-admin-mutations.mjs'
  );
  assert.equal(
    packageDocument.scripts['verify:no-local-tools'],
    'node scripts/verify-local-tools-absence.mjs'
  );
  assert.doesNotMatch(
    packageDocument.scripts['test:required'],
    /(?:&&|\|\||;|\bset\b|\bexport\b)/u
  );
});
