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

test('build validation executes the production image and verifies packaged migrations', async () => {
  const workflow = yaml.load(await readFile(ciWorkflowUrl, 'utf8'));
  const steps = workflow.jobs.build.steps;
  const containerBuild = steps.find((step) => step.name === 'Build production container');
  const migrationProof = steps.find(
    (step) => step.name === 'Verify production image migration packaging'
  );

  assert.match(containerBuild.run, /docker build/);
  assert.match(containerBuild.run, /--build-arg GITHUB_SHA=/);
  assert.match(migrationProof.run, /docker run --rm --entrypoint node/);
  assert.match(migrationProof.run, /backend\/database\/migrations/);
  assert.match(migrationProof.run, /test "\$actual_count" = "\$expected_count"/);
});
