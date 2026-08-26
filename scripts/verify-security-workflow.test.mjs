import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const workflowUrl = new URL('../.github/workflows/security.yml', import.meta.url);
const ciWorkflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);
const deployWorkflowUrl = new URL('../.github/workflows/deploy.yml', import.meta.url);
const railwayConfigUrl = new URL('../railway.json', import.meta.url);
const procfileUrl = new URL('../Procfile', import.meta.url);

test('public-repository security checks cannot be disabled by a repository variable', async () => {
  const source = await readFile(workflowUrl, 'utf8');
  const workflow = yaml.load(source);

  assert.equal(typeof workflow, 'object');
  assert.equal(workflow.permissions.contents, 'read');
  assert.ok(workflow.on.pull_request);
  assert.deepEqual(workflow.on.push.branches, ['main']);
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
  assert.ok(codeql.steps.some(
    (step) => step.uses === 'github/codeql-action/init@42947a340483f03ba47bb1a039b2c519aab3df85'
  ));
  assert.ok(codeql.steps.some(
    (step) => step.uses === 'github/codeql-action/analyze@42947a340483f03ba47bb1a039b2c519aab3df85'
  ));

  const dependencyReview = workflow.jobs['dependency-review'];
  assert.equal(dependencyReview['continue-on-error'], undefined);
  assert.equal(dependencyReview.if, "${{ github.event_name == 'pull_request' }}");
  assert.ok(dependencyReview.steps.some(
    (step) => step.uses === 'actions/dependency-review-action@2031cfc080254a8a887f58cffee85186f0e49e48'
  ));

  const snyk = workflow.jobs.snyk;
  assert.equal(snyk.env, undefined, 'SNYK_TOKEN must not be exposed to setup or install steps');
  const snykScan = snyk.steps.find((step) => step.name === 'Snyk scan');
  assert.match(snykScan.uses, /^snyk\/actions\/node@[a-f0-9]{40}$/);
  assert.equal(snykScan.env.SNYK_TOKEN, '${{ secrets.SNYK_TOKEN }}');

  assert.doesNotMatch(source, /ENABLE_GITHUB_ADVANCED_SECURITY/);
});

test('production migration authority exists only in the protected release job', async () => {
  const source = await readFile(deployWorkflowUrl, 'utf8');
  const workflow = yaml.load(source);
  const release = workflow.jobs['migrate-and-deploy-production'];
  const railwayConfig = JSON.parse(await readFile(railwayConfigUrl, 'utf8'));
  const procfile = await readFile(procfileUrl, 'utf8');

  assert.ok(workflow.on.workflow_dispatch !== undefined);
  assert.equal(release.environment, 'production');
  assert.match(source, /test "\$\(git rev-parse origin\/main\)" = "\$GITHUB_SHA"/);
  assert.match(source, /Governor admission/);

  const migration = release.steps.find(
    (step) => step.name === 'Revalidate then apply only checksummed registered migrations'
  );
  assert.equal(migration.env.DATABASE_URL, '${{ secrets.PRODUCTION_DATABASE_URL }}');
  assert.equal(
    migration.env.MIGRATION_DATABASE_URL,
    '${{ secrets.PRODUCTION_MIGRATION_DATABASE_URL }}'
  );
  assert.equal(
    migration.env.HX_MIGRATION_EXPECTED_DATABASE_NAME,
    '${{ vars.HX_MIGRATION_EXPECTED_DATABASE_NAME }}'
  );
  assert.equal(
    migration.env.HX_MIGRATION_EXPECTED_DATABASE_OID,
    '${{ vars.HX_MIGRATION_EXPECTED_DATABASE_OID }}'
  );
  assert.equal(
    migration.env.HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER,
    '${{ vars.HX_MIGRATION_EXPECTED_CLUSTER_SYSTEM_IDENTIFIER }}'
  );

  const runtimeProofs = release.steps.filter((step) =>
    step.run?.includes('has("MIGRATION_DATABASE_URL") | not')
  );
  assert.equal(runtimeProofs.length, 2);
  assert.ok(runtimeProofs.every((step) => step.env.MIGRATION_DATABASE_URL === undefined));
  assert.equal(railwayConfig.deploy.preDeployCommand, undefined);
  assert.doesNotMatch(procfile, /^release:/m);
  assert.match(source, /\.meta\.commitHash/);
  assert.match(source, /\.meta\.imageDigest/);
  assert.match(source, /RAILWAY_WORKER_SERVICE: 5295aa04-9c34-489f-a5be-2535468c959a/);
  assert.match(source, /GITHUB_ACTIONS_APP_ID: '15368'/);
  assert.match(source, /dependency-review/);
  assert.match(source, /refs\/pull\/\$\{pr_number\}\/head/);
  assert.match(source, /governor-control:\(\[0-9a-f\]\{40\}\):sha256/);
  assert.match(source, /INDEPENDENT_REVIEWER_ID: '19916085'/);
  assert.match(source, /GOVERNOR_PUBLISHER_ID: '192952981'/);
  assert.doesNotMatch(source, /railway variable set/);
  assert.doesNotMatch(source, /\$\{observed:-\{\}\}/);
  assert.equal(source.match(/railway up /gu)?.length, 2);
  assert.match(source, /test "\$image_digest" = "\$\{\{ steps\.web\.outputs\.image_digest \}\}"/);
  assert.match(source, /\.paymentCreation\.mode == "frozen"/);
  for (const action of [
    'actions/checkout@11d5960a326750d5838078e36cf38b85af677262',
    'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020',
  ]) {
    assert.ok(source.includes(action));
  }
});

test('release admission shell rejects spoofed check publishers', async (context) => {
  const source = await readFile(deployWorkflowUrl, 'utf8');
  const workflow = yaml.load(source);
  const admission = workflow.jobs['verify-exact-revision'].steps.find(
    (step) => step.name === 'Require exact-tree checks and authenticated Governor admission'
  );
  assert.equal(typeof admission.run, 'string');

  const directory = await mkdtemp(join(tmpdir(), 'hx-release-admission-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const mainSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const treeSha = 'c'.repeat(40);
  const governorControlSha = 'f'.repeat(40);
  const checks = [
    'TypeScript — zero errors',
    'Lint — zero warnings (backend/src/)',
    'Security audit — no high/critical production vulnerabilities',
    'Tests — zero failures',
    'Build Validation',
    'audit',
    'codeql',
  ].map((name, index) => ({
    id: index + 1,
    name,
    status: 'completed',
    conclusion: 'success',
    app: { id: 15368 },
  }));
  const mainChecksPath = join(directory, 'main-checks.json');
  const headChecksPath = join(directory, 'head-checks.json');
  const pullsPath = join(directory, 'pulls.json');
  const reviewsPath = join(directory, 'reviews.json');
  const statusPath = join(directory, 'status.json');
  await writeFile(mainChecksPath, JSON.stringify({ check_runs: checks }));
  await writeFile(headChecksPath, JSON.stringify({
    check_runs: [{
      id: 20,
      name: 'dependency-review',
      status: 'completed',
      conclusion: 'success',
      app: { id: 15368 },
    }],
  }));
  await writeFile(pullsPath, JSON.stringify([{
    number: 77,
    merged_at: '2026-08-25T00:00:00Z',
    merge_commit_sha: mainSha,
    base: { ref: 'main' },
    head: { sha: headSha, repo: { full_name: 'Sebdysart/hustlexp-ai-backend' } },
  }]));
  await writeFile(reviewsPath, JSON.stringify([{
    id: 30,
    state: 'APPROVED',
    commit_id: headSha,
    user: { id: 19916085 },
  }]));
  await writeFile(statusPath, JSON.stringify({
    statuses: [{
      context: 'Governor admission',
      state: 'success',
      description: `governor-control:${governorControlSha}:sha256:${'d'.repeat(64)}`,
      target_url: `https://github.com/Sebdysart/hustlexp-site/commit/${governorControlSha}`,
      creator: { id: 192952981, type: 'User' },
    }],
  }));

  const ghPath = join(directory, 'gh');
  const gitPath = join(directory, 'git');
  await writeFile(ghPath, `#!/usr/bin/env bash
set -eu
request="\${!#}"
case "$request" in
  *"/commits/${mainSha}/check-runs"*) cat "${mainChecksPath}" ;;
  *"/commits/${headSha}/check-runs"*) cat "${headChecksPath}" ;;
  *"/commits/${mainSha}/pulls"*) cat "${pullsPath}" ;;
  *"/pulls/77/reviews"*) cat "${reviewsPath}" ;;
  *"/commits/${mainSha}/status"*) cat "${statusPath}" ;;
  *) exit 91 ;;
esac
`);
  await writeFile(gitPath, `#!/usr/bin/env bash
set -eu
case "$*" in
  "fetch "*) exit 0 ;;
  *"refs/remotes/hx-release/pr-77-head"*) echo "${headSha}" ;;
  *"${headSha}^{tree}"*|*"${mainSha}^{tree}"*) echo "${treeSha}" ;;
  *) exit 92 ;;
esac
`);
  await chmod(ghPath, 0o755);
  await chmod(gitPath, 0o755);
  const env = {
    ...process.env,
    PATH: `${directory}${delimiter}${process.env.PATH}`,
    GH_TOKEN: 'fixture-token',
    GITHUB_REPOSITORY: 'Sebdysart/hustlexp-ai-backend',
    GITHUB_SHA: mainSha,
    GITHUB_ACTIONS_APP_ID: '15368',
    GOVERNOR_PUBLISHER_ID: '192952981',
    GOVERNOR_CONTROL_REPOSITORY: 'Sebdysart/hustlexp-site',
    INDEPENDENT_REVIEWER_ID: '19916085',
  };
  const executeAdmission = () => execFileSync('bash', ['-c', admission.run], {
    env,
    stdio: 'pipe',
  });

  assert.doesNotThrow(executeAdmission);
  checks[0].app.id = 1;
  await writeFile(mainChecksPath, JSON.stringify({ check_runs: checks }));
  assert.throws(executeAdmission);
  checks[0].app.id = 15368;
  await writeFile(mainChecksPath, JSON.stringify({ check_runs: checks }));
  await writeFile(reviewsPath, JSON.stringify([{
    id: 31,
    state: 'DISMISSED',
    commit_id: headSha,
    user: { id: 19916085 },
  }]));
  assert.throws(executeAdmission);
  await writeFile(reviewsPath, JSON.stringify([{
    id: 32,
    state: 'APPROVED',
    commit_id: headSha,
    user: { id: 19916085 },
  }]));
  await writeFile(statusPath, JSON.stringify({
    statuses: [{
      context: 'Governor admission',
      state: 'success',
      description: `governor-control:${governorControlSha}:sha256:${'d'.repeat(64)}`,
      target_url: `https://github.com/Sebdysart/hustlexp-site/commit/${governorControlSha}`,
      creator: { id: 1, type: 'User' },
    }],
  }));
  assert.throws(executeAdmission);
});

test('release upload shell captures one new deployment ID and rejects ambiguity', async (context) => {
  const source = await readFile(deployWorkflowUrl, 'utf8');
  const workflow = yaml.load(source);
  const upload = workflow.jobs['migrate-and-deploy-production'].steps.find(
    (step) => step.name === 'Upload and capture the exact web deployment'
  );
  assert.equal(typeof upload.run, 'string');

  const directory = await mkdtemp(join(tmpdir(), 'hx-release-upload-'));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const mainSha = 'a'.repeat(40);
  const digest = 'd'.repeat(64);
  const imageDigest = `sha256:${'e'.repeat(64)}`;
  const oldId = '11111111-1111-4111-8111-111111111111';
  const deploymentId = '22222222-2222-4222-8222-222222222222';
  const serviceId = 'e3996482-fa94-489b-b474-985437dda612';
  const statePath = join(directory, 'uploaded');
  const outputPath = join(directory, 'github-output');
  const sourceArchive = join(directory, 'source.tar');
  const contextDirectory = join(directory, 'context');
  const provenancePath = join(contextDirectory, '.hx-release-provenance.json');
  await writeFile(sourceArchive, 'fixture');
  await mkdir(contextDirectory);
  await writeFile(provenancePath, 'fixture');

  const railwayPath = join(directory, 'railway');
  const gitPath = join(directory, 'git');
  const shaPath = join(directory, 'sha256sum');
  await writeFile(railwayPath, `#!/usr/bin/env bash
set -eu
message="hx-release:\${GITHUB_RUN_ID}:\${GITHUB_RUN_ATTEMPT}:web:\${GITHUB_SHA}:\${HX_RELEASE_PROVENANCE_SHA256}"
case "$1 $2" in
  "deployment list")
    if [ ! -e "\${RAILWAY_FIXTURE_STATE}" ]; then
      printf '[{"id":"${oldId}","status":"SUCCESS","meta":{}}]\\n'
    elif [ "\${RAILWAY_FIXTURE_AMBIGUOUS:-0}" = 1 ]; then
      printf '[{"id":"${deploymentId}","status":"SUCCESS","meta":{"cliMessage":"%s","imageDigest":"${imageDigest}"}},{"id":"${deploymentId}","status":"SUCCESS","meta":{"cliMessage":"%s","imageDigest":"${imageDigest}"}}]\\n' "$message" "$message"
    else
      printf '[{"id":"${deploymentId}","status":"SUCCESS","meta":{"cliMessage":"%s","imageDigest":"${imageDigest}"}}]\\n' "$message"
    fi
    ;;
  "up ${contextDirectory}")
    : > "\${RAILWAY_FIXTURE_STATE}"
    printf '{"deploymentId":"${deploymentId}"}\\n'
    ;;
  "service list")
    printf '[{"id":"${serviceId}","deploymentId":"${deploymentId}","status":"SUCCESS","replicas":{"running":1}}]\\n'
    ;;
  *) exit 93 ;;
esac
`);
  await writeFile(gitPath, `#!/usr/bin/env bash
set -eu
case "$*" in
  "fetch "*) exit 0 ;;
  "rev-parse HEAD"|"rev-parse origin/main") echo "${mainSha}" ;;
  "status --porcelain=v1") exit 0 ;;
  *) exit 94 ;;
esac
`);
  await writeFile(shaPath, `#!/usr/bin/env bash
printf '%s  %s\\n' "${digest}" "$1"
`);
  await Promise.all([
    chmod(railwayPath, 0o755),
    chmod(gitPath, 0o755),
    chmod(shaPath, 0o755),
  ]);
  const env = {
    ...process.env,
    PATH: `${directory}${delimiter}${process.env.PATH}`,
    GITHUB_SHA: mainSha,
    GITHUB_RUN_ID: '9001',
    GITHUB_RUN_ATTEMPT: '2',
    GITHUB_OUTPUT: outputPath,
    RUNNER_TEMP: directory,
    HX_RAILWAY_LINK_DIR: directory,
    HX_SOURCE_ARCHIVE: sourceArchive,
    HX_SOURCE_ARCHIVE_SHA256: digest,
    HX_WEB_CONTEXT: contextDirectory,
    HX_RELEASE_PROVENANCE_SHA256: digest,
    RAILWAY_FIXTURE_STATE: statePath,
    RAILWAY_PROJECT_ID: 'project',
    RAILWAY_ENVIRONMENT: 'environment',
    RAILWAY_WEB_SERVICE: serviceId,
  };
  const executeUpload = (overrides = {}) => execFileSync('bash', ['-c', upload.run], {
    env: { ...env, ...overrides },
    stdio: 'pipe',
  });

  assert.doesNotThrow(() => executeUpload());
  assert.equal(
    await readFile(outputPath, 'utf8'),
    `deployment_id=${deploymentId}\nimage_digest=${imageDigest}\n`
  );
  await rm(statePath, { force: true });
  await writeFile(outputPath, '');
  assert.throws(() => executeUpload({ RAILWAY_FIXTURE_AMBIGUOUS: '1' }));
});

test('build validation executes migrations on PostgreSQL and verifies the exact image artifact', async () => {
  const workflow = yaml.load(await readFile(ciWorkflowUrl, 'utf8'));
  const build = workflow.jobs.build;
  assert.equal(build.services.postgres.image, 'postgres:17.7-alpine');
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
  assert.match(postgresProof.env.DATABASE_URL, /127\.0\.0\.1.*hx_ci_fresh_test/);
  assert.match(migrationProof.run, /docker run --rm --entrypoint node/);
  assert.match(migrationProof.run, /engine-migration-artifact\.sha256/);
  assert.match(migrationProof.run, /test "\$image_digest" = "\$expected_digest"/);
});

test('arbitrary pull-request tests receive no persistent database or Redis secrets', async () => {
  const workflow = yaml.load(await readFile(ciWorkflowUrl, 'utf8'));
  const testJob = workflow.jobs.test;
  assert.equal(testJob.env.DATABASE_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_URL, undefined);
  assert.equal(testJob.env.UPSTASH_REDIS_REST_TOKEN, undefined);
  const testStep = testJob.steps.find((step) => step.name === 'Tests — zero failures');
  assert.equal(testStep.env, undefined);

  const postgresStep = workflow.jobs.build.steps.find(
    (step) => step.name === 'Run required PostgreSQL money and lifecycle suites with zero skips'
  );
  assert.equal(postgresStep.run, 'node scripts/run-required-postgres-suites.mjs');
  assert.match(postgresStep.env.HX_REQUIRED_PG_ADMIN_DATABASE_URL, /^postgresql:\/\/hx_ci_admin:/);
  assert.doesNotMatch(JSON.stringify(postgresStep), /\$\{\{\s*secrets\./);
});
