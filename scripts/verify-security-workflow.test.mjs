import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import yaml from 'js-yaml';

const workflowUrl = new URL('../.github/workflows/security.yml', import.meta.url);
const ciWorkflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);

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
  assert.match(migrationProof.run, /docker run --rm --entrypoint node/);
  assert.match(migrationProof.run, /engine-migration-artifact\.sha256/);
  assert.match(migrationProof.run, /test "\$image_digest" = "\$expected_digest"/);
});

test('pull-request database and Redis secrets reach only the test execution step', async () => {
  const workflow = yaml.load(await readFile(ciWorkflowUrl, 'utf8'));
  const testJob = workflow.jobs.test;
  assert.equal(testJob.env.DATABASE_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_TOKEN, undefined);
  const testStep = testJob.steps.find((step) => step.name === 'Tests — zero failures');
  assert.equal(testStep.env.DATABASE_URL, '${{ secrets.TEST_DATABASE_URL }}');
  assert.equal(testStep.env.UPSTASH_REDIS_REST_URL, '${{ secrets.TEST_UPSTASH_REDIS_REST_URL }}');
  assert.equal(testStep.env.UPSTASH_REDIS_REST_TOKEN, '${{ secrets.TEST_UPSTASH_REDIS_REST_TOKEN }}');
});
