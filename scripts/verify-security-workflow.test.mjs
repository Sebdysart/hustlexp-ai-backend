import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import yaml from 'js-yaml';

const workflowUrl = new URL('../.github/workflows/security.yml', import.meta.url);
const ciWorkflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);

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

function installsDependencies(step) {
  return typeof step.run === 'string'
    && /(?:^|\n)\s*(?:npm\s+(?:ci|install)|pnpm\s+install|yarn\s+install)\b/u.test(step.run);
}

test('public-repository security checks are enforcing and bind to the PR head candidate', async () => {
  const source = await readFile(workflowUrl, 'utf8');
  const workflow = yaml.load(source);

  assert.equal(workflow.permissions.contents, 'read');
  assert.ok(workflow.on.pull_request);
  assert.ok(workflow.on.schedule);
  assert.equal(
    workflow.env.HX_CANDIDATE_SHA,
    '${{ github.event.pull_request.head.sha || github.sha }}'
  );

  const checkoutSteps = Object.values(workflow.jobs).flatMap((job) =>
    (job.steps || []).filter((step) => step.uses === 'actions/checkout@v4')
  );
  assert.equal(checkoutSteps.length, 4);
  assert.ok(checkoutSteps.every((step) => step.with?.['persist-credentials'] === false));
  assert.ok(checkoutSteps.every((step) => step.with?.ref === '${{ env.HX_CANDIDATE_SHA }}'));

  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    const checkoutIndex = job.steps.findIndex((step) => step.uses === 'actions/checkout@v4');
    const hygieneIndex = requiredStepIndex(
      job,
      'Verify exact candidate excludes bundled local tooling'
    );
    const hygiene = job.steps[hygieneIndex];
    assert.equal(hygiene.run, 'node scripts/verify-local-tools-absence.mjs', jobName);
    assert.equal(
      hygiene.env.HX_EXACT_CANDIDATE_SHA,
      '${{ env.HX_CANDIDATE_SHA }}',
      jobName
    );
    assert.equal(hygiene['continue-on-error'], undefined, jobName);
    assert.ok(checkoutIndex >= 0 && checkoutIndex < hygieneIndex, jobName);
    const installIndex = job.steps.findIndex(installsDependencies);
    if (installIndex >= 0) assert.ok(hygieneIndex < installIndex, jobName);
  }

  const audit = workflow.jobs.audit;
  const installIndex = audit.steps.findIndex(installsDependencies);
  const contractIndex = audit.steps.findIndex(
    (step) => step.run === 'npm run verify:security-workflow:contract'
  );
  assert.ok(contractIndex > installIndex, 'workflow contract requires installed parser dependencies');

  const codeql = workflow.jobs.codeql;
  assert.equal(codeql['continue-on-error'], undefined);
  assert.equal(codeql.permissions['security-events'], 'write');
  const codeqlHygiene = requiredStepIndex(
    codeql,
    'Verify exact candidate excludes bundled local tooling'
  );
  const codeqlInit = codeql.steps.findIndex(
    (step) => step.uses === 'github/codeql-action/init@v3'
  );
  const codeqlBuild = codeql.steps.findIndex(
    (step) => step.uses === 'github/codeql-action/autobuild@v3'
  );
  const codeqlAnalyze = codeql.steps.findIndex(
    (step) => step.uses === 'github/codeql-action/analyze@v3'
  );
  assert.ok(codeqlHygiene < codeqlInit && codeqlInit < codeqlBuild && codeqlBuild < codeqlAnalyze);

  const dependencyReview = workflow.jobs['dependency-review'];
  assert.equal(dependencyReview['continue-on-error'], undefined);
  assert.equal(dependencyReview.if, "${{ github.event_name == 'pull_request' }}");
  assert.ok(
    requiredStepIndex(
      dependencyReview,
      'Verify exact candidate excludes bundled local tooling'
    ) <
      dependencyReview.steps.findIndex(
        (step) => step.uses === 'actions/dependency-review-action@v4'
      )
  );

  const snyk = workflow.jobs.snyk;
  assert.equal(snyk.env, undefined, 'SNYK_TOKEN must not be exposed to setup or install steps');
  const snykScan = requiredStep(snyk, 'Snyk scan');
  assert.match(snykScan.uses, /^snyk\/actions\/node@[a-f0-9]{40}$/u);
  assert.equal(snykScan.env.SNYK_TOKEN, '${{ secrets.SNYK_TOKEN }}');

  assert.doesNotMatch(source, /ENABLE_GITHUB_ADVANCED_SECURITY/u);
});

test('build validation executes PostgreSQL proofs and verifies the exact candidate image', async () => {
  const workflow = yaml.load(await readFile(ciWorkflowUrl, 'utf8'));
  const build = workflow.jobs.build;
  const steps = build.steps;
  const hygiene = requiredStepIndex(
    build,
    'Verify exact candidate excludes bundled local tooling'
  );
  const install = steps.findIndex(installsDependencies);
  const compile = requiredStepIndex(build, 'Validate build compiles cleanly');
  const postgresProofIndex = requiredStepIndex(
    build,
    'Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL'
  );
  const containerBuildIndex = requiredStepIndex(build, 'Build production container');
  const migrationProofIndex = requiredStepIndex(
    build,
    'Verify exact production image migration artifact'
  );
  const postgresProof = steps[postgresProofIndex];
  const containerBuild = steps[containerBuildIndex];
  const migrationProof = steps[migrationProofIndex];

  assert.equal(build.services.postgres.image, 'postgres:16-alpine');
  assert.match(postgresProof.env.DATABASE_URL, /127\.0\.0\.1.*hx_ci_admin_test/u);
  assert.equal(postgresProof.env.NODE_ENV, 'test');
  assert.equal(postgresProof.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.match(containerBuild.run, /docker build/u);
  assert.match(containerBuild.run, /--build-arg GITHUB_SHA="\$\{HX_CANDIDATE_SHA\}"/u);
  assert.match(migrationProof.run, /docker run --rm --entrypoint node/u);
  assert.match(migrationProof.run, /engine-migration-artifact\.sha256/u);
  assert.match(migrationProof.run, /test "\$image_digest" = "\$expected_digest"/u);
  assert.deepEqual(
    [hygiene, install, compile, postgresProofIndex, containerBuildIndex, migrationProofIndex],
    [hygiene, install, compile, postgresProofIndex, containerBuildIndex, migrationProofIndex].sort(
      (left, right) => left - right
    )
  );
});

test('required tests delegate isolated infrastructure and frozen-provider policy to one runner', async () => {
  const source = await readFile(ciWorkflowUrl, 'utf8');
  const workflow = yaml.load(source);
  const testJob = workflow.jobs.test;
  const suite = requiredStep(testJob, 'Tests — zero failures and zero skipped/todo');

  assert.equal(testJob.needs, 'typecheck');
  assert.equal(testJob.env.DATABASE_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_TOKEN, undefined);
  assert.equal(suite.run, 'npm run test:required');
  assert.match(suite.env.DATABASE_URL, /127\.0\.0\.1.*hx_ci_admin_test/u);
  assert.equal(suite.env.REDIS_URL, 'redis://127.0.0.1:16379');
  assert.equal(suite.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.equal(suite.env.HX_EXACT_CANDIDATE_SHA, '${{ env.HX_CANDIDATE_SHA }}');
  assert.equal(suite.env.LOCAL_TEST_DB_URL, undefined);
  assert.deepEqual(
    Object.keys(suite.env).filter((name) => name.startsWith('HX_ALLOW_E2E_')),
    []
  );
  assert.doesNotMatch(source, /secrets\.TEST_DATABASE_URL/u);
  assert.doesNotMatch(source, /secrets\.TEST_UPSTASH_/u);
  assert.doesNotMatch(source, /npx vitest run/u);
  assert.doesNotMatch(source, /run: node scripts\/prepare-test-databases\.mjs/u);
});

test('recreate authority and required-test ordering stay narrow and fail closed', async () => {
  const workflow = yaml.load(await readFile(ciWorkflowUrl, 'utf8'));
  const testJob = workflow.jobs.test;
  const buildJob = workflow.jobs.build;
  const execute = requiredStep(testJob, 'Tests — zero failures and zero skipped/todo');
  const migrationProof = requiredStep(
    buildJob,
    'Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL'
  );
  assert.equal(execute.env.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.equal(migrationProof.env.HX_ALLOW_CI_DB_RECREATE, 'true');

  const recreateScopes = Object.entries(workflow.jobs)
    .flatMap(([jobName, job]) =>
      (job.steps || [])
        .filter((step) => step.env?.HX_ALLOW_CI_DB_RECREATE !== undefined)
        .map((step) => `${jobName}:${step.name}`)
    )
    .sort();
  assert.deepEqual(recreateScopes, [
    'build:Execute fresh, upgrade, replay, and recovery migrations on PostgreSQL',
    'test:Tests — zero failures and zero skipped/todo',
  ]);

  const ordered = [
    testJob.steps.findIndex(installsDependencies),
    requiredStepIndex(testJob, 'Tests — zero failures and zero skipped/todo'),
    requiredStepIndex(testJob, 'Preserve exact Vitest evidence'),
  ];
  assert.deepEqual(ordered, [...ordered].sort((left, right) => left - right));
  assert.equal(new Set(ordered).size, ordered.length);
});
