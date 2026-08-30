import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import yaml from 'js-yaml';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowPath = new URL('../.github/workflows/ci.yml', import.meta.url);
const packagePath = new URL('../package.json', import.meta.url);
const expectedGateSources = Object.freeze({
  HX_ALLOW_E2E_LIFECYCLE: [
    'backend/tests/system/escrow-release-outbox.pg.test.ts',
    'backend/tests/system/hxos-canonical-lifecycle.pg.test.ts',
    'backend/tests/system/hxos-lifecycle-exceptions.pg.test.ts',
    'backend/tests/system/xp-daily-cap-concurrency.pg.test.ts',
  ],
  HX_ALLOW_E2E_LIQUIDITY_EXPANSION: [
    'backend/tests/system/liquidity-expansion.pg.test.ts',
  ],
  HX_ALLOW_NOTIFICATION_PG: [
    'backend/tests/system/notification-batching-idempotency.pg.test.ts',
    'backend/tests/system/notification-delivery-contract.pg.test.ts',
    'backend/tests/system/notification-delivery-recovery-concurrency.pg.test.ts',
  ],
  HX_ALLOW_LEAD_INGRESS_PG: [
    'backend/tests/system/universal-v1-lead-ingress.pg.test.ts',
  ],
  HX_ALLOW_TASK_DRAFT_INGRESS_PG: [
    'backend/tests/system/universal-v1-estimate-materialization.pg.test.ts',
    'backend/tests/system/universal-v1-task-draft-claim.pg.test.ts',
    'backend/tests/system/universal-v1-task-draft-legacy-port.pg.test.ts',
    'backend/tests/system/universal-v1-task-draft-public.pg.test.ts',
  ],
  HX_ALLOW_WORKER_COUNTER_E2E: [
    'backend/tests/system/worker-counter-offer.pg.test.ts',
  ],
});

async function workflowSource() {
  return readFile(workflowPath, 'utf8');
}

async function workflowDocument() {
  return yaml.load(await workflowSource());
}

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(fullPath));
    if (entry.isFile() && /\.(?:ts|mjs)$/u.test(entry.name)) files.push(fullPath);
  }
  return files;
}

async function sourceGateMap() {
  const result = new Map();
  const root = join(projectRoot, 'backend', 'tests');
  for (const file of await sourceFiles(root)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(
      /process\.env\.(HX_ALLOW_[A-Z0-9_]+)\s*===\s*'1'/gu,
    )) {
      const paths = result.get(match[1]) || [];
      paths.push(relative(projectRoot, file).replaceAll('\\', '/'));
      result.set(match[1], paths);
    }
  }
  return Object.fromEntries(
    [...result.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([gate, paths]) => [gate, [...new Set(paths)].sort()]),
  );
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

test('required CI has read-only repository authority and never persists checkout credentials', async () => {
  const workflow = await workflowDocument();
  assert.equal(workflow.permissions.contents, 'read');

  const checkoutSteps = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps || []).filter((step) => step.uses === 'actions/checkout@v4')
  );
  assert.ok(checkoutSteps.length > 0);
  assert.ok(checkoutSteps.every((step) => step.with?.['persist-credentials'] === false));
});

test('required test check provisions isolated PostgreSQL and Redis services', async () => {
  const workflow = await workflowSource();

  assert.match(workflow, /name: "Tests — zero failures"/u);
  assert.match(workflow, /image: postgres:16-alpine/u);
  assert.match(workflow, /POSTGRES_DB: hx_ci_admin_test/u);
  assert.match(workflow, /image: redis:7-alpine/u);
  assert.match(workflow, /run: node scripts\/prepare-test-databases\.mjs/u);
  assert.match(workflow, /hx_ci_invariant_test/u);
  assert.match(workflow, /hx_ci_system_test/u);
  assert.match(workflow, /16379:6379/u);
  assert.match(workflow, /redis:\/\/127\.0\.0\.1:16379/u);
});

test('every exact source opt-in gate is enabled only on the complete Vitest step', async () => {
  assert.deepEqual(await sourceGateMap(), expectedGateSources);
  const workflow = await workflowDocument();
  const testJob = workflow.jobs.test;
  const testStep = findStep(testJob, 'Tests — zero failures and zero skipped/todo');
  const workflowGates = Object.fromEntries(
    Object.entries(testStep.env)
      .filter(([name]) => name.startsWith('HX_ALLOW_'))
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  assert.deepEqual(
    workflowGates,
    Object.fromEntries(Object.keys(expectedGateSources).sort().map((name) => [name, '1'])),
  );
  for (const step of testJob.steps) {
    if (step === testStep) continue;
    for (const gate of Object.keys(expectedGateSources)) {
      assert.equal(step.env?.[gate], undefined, `${gate} must be scoped to the full suite`);
    }
  }
});

test('database recreate authority is scoped only to the two fixed recreation steps', async () => {
  const workflow = await workflowDocument();
  const testJob = workflow.jobs.test;
  const buildJob = workflow.jobs.build;
  const prepareStep = findStep(
    testJob,
    'Prepare isolated invariant and system PostgreSQL databases',
  );
  const postgresProof = findStep(
    buildJob,
    'Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL',
  );

  assert.equal(testJob.env.HX_ALLOW_CI_DB_RECREATE, undefined);
  assert.equal(buildJob.env?.HX_ALLOW_CI_DB_RECREATE, undefined);
  assert.equal(prepareStep.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.equal(postgresProof.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.equal(testJob.env.NODE_ENV, 'test');
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
    'test:Prepare isolated invariant and system PostgreSQL databases',
  ]);
});

test('required test stages preserve compile-contract-prepare-test-evidence ordering', async () => {
  const workflow = await workflowDocument();
  const job = workflow.jobs.test;
  const install = job.steps.findIndex((step) => step.run === 'npm ci');
  const ordered = [
    install,
    stepIndex(job, 'Compile exact test runtime'),
    stepIndex(job, 'Test database and outcome verifier contracts'),
    stepIndex(job, 'Prepare isolated invariant and system PostgreSQL databases'),
    stepIndex(job, 'Tests — zero failures and zero skipped/todo'),
    stepIndex(job, 'Preserve exact Vitest evidence'),
    stepIndex(job, 'Production role readiness contract'),
    stepIndex(job, 'Production legal approval contract'),
  ];
  assert.ok(ordered.every((index) => index >= 0));
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
  assert.equal(new Set(ordered).size, ordered.length);
});

test('required test check runs the complete suite and rejects non-passing outcomes', async () => {
  const workflow = await workflowSource();

  assert.match(
    workflow,
    /npx vitest run --reporter=default --reporter=json --outputFile\.json=reports\/vitest\.json/u,
  );
  assert.match(
    workflow,
    /node scripts\/verify-vitest-outcome\.mjs reports\/vitest\.json/u,
  );
  assert.match(workflow, /if: always\(\)/u);
  assert.match(workflow, /name: vitest-\$\{\{ github\.sha \}\}/u);
  assert.doesNotMatch(workflow, /continue-on-error/u);
  assert.doesNotMatch(workflow, /\|\|\s*true/u);
});

test('required test check does not depend on ambient shared database secrets', async () => {
  const workflow = await workflowSource();

  assert.doesNotMatch(workflow, /secrets\.TEST_DATABASE_URL/u);
  assert.doesNotMatch(workflow, /secrets\.UPSTASH_/u);
  assert.doesNotMatch(workflow, /neon\.tech/u);
  assert.doesNotMatch(workflow, /supabase/u);
});

test('package exposes the cross-platform fail-closed required-test orchestrator', async () => {
  const packageDocument = JSON.parse(await readFile(packagePath, 'utf8'));
  assert.equal(packageDocument.scripts['test:required'], 'node scripts/run-required-tests.mjs');
  assert.equal(
    packageDocument.scripts['verify:consequential-admin'],
    'node scripts/verify-consequential-admin-mutations.mjs',
  );
  assert.doesNotMatch(packageDocument.scripts['test:required'], /(?:&&|\|\||;|\bset\b|\bexport\b)/u);
});

test('required CI fails closed on the consequential-admin inventory contract', async () => {
  const workflow = await workflowSource();
  assert.match(workflow, /scripts\/verify-consequential-admin-mutations\.test\.mjs/u);
  assert.ok(
    workflow.indexOf('scripts/verify-consequential-admin-mutations.test.mjs')
      < workflow.indexOf('Tests — zero failures and zero skipped/todo'),
  );
});

test('required CI executes the team-alignment contract before the complete suite', async () => {
  const workflow = await workflowSource();
  assert.match(workflow, /scripts\/verify-team-alignment\.test\.mjs/u);
  assert.ok(
    workflow.indexOf('scripts/verify-team-alignment.test.mjs')
      < workflow.indexOf('Tests — zero failures and zero skipped/todo'),
  );
});
