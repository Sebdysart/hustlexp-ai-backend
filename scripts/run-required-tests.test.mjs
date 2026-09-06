import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AMBIENT_AUTHORITY_EXACT_VARIABLES,
  AMBIENT_AUTHORITY_VARIABLE_SUFFIX,
  CONTRACT_TESTS,
  EXTERNAL_PROVIDER_CREDENTIAL_VARIABLES,
  EXTERNAL_PROVIDER_SELECTOR_VARIABLES,
  FIXED_SYNTHETIC_TEST_PROVIDER_ENV,
  REQUIRED_TEST_GATES,
  isDirectExecution,
  requiredTestEnvironments,
  validateRequiredTestPolicy,
} from './run-required-tests.mjs';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

const expectedGateSources = Object.freeze({
  HX_ALLOW_E2E_LIFECYCLE: [
    'backend/tests/system/escrow-release-outbox.pg.test.ts',
    'backend/tests/system/hxos-canonical-lifecycle.pg.test.ts',
    'backend/tests/system/hxos-lifecycle-exceptions.pg.test.ts',
    'backend/tests/system/xp-daily-cap-concurrency.pg.test.ts',
  ],
  HX_ALLOW_E2E_LIQUIDITY_EXPANSION: ['backend/tests/system/liquidity-expansion.pg.test.ts'],
  HX_ALLOW_NOTIFICATION_PG: [
    'backend/tests/system/notification-batching-idempotency.pg.test.ts',
    'backend/tests/system/notification-delivery-contract.pg.test.ts',
    'backend/tests/system/notification-delivery-recovery-concurrency.pg.test.ts',
  ],
  HX_ALLOW_LEAD_INGRESS_PG: ['backend/tests/system/universal-v1-lead-ingress.pg.test.ts'],
  HX_ALLOW_TASK_DRAFT_INGRESS_PG: [
    'backend/tests/system/stage1-legacy-authority-containment.pg.test.ts',
    'backend/tests/system/universal-v1-dispute-recovery.pg.test.ts',
    'backend/tests/system/universal-v1-double-entry-ledger.pg.test.ts',
    'backend/tests/system/universal-v1-estimate-materialization.pg.test.ts',
    'backend/tests/system/universal-v1-relationship-origin.pg.test.ts',
    'backend/tests/system/universal-v1-standardized-quote-readiness.pg.test.ts',
    'backend/tests/system/universal-v1-task-draft-claim.pg.test.ts',
    'backend/tests/system/universal-v1-task-draft-legacy-port.pg.test.ts',
    'backend/tests/system/universal-v1-task-draft-public.pg.test.ts',
    'backend/tests/system/universal-v1-task-opportunities.pg.test.ts',
  ],
  HX_ALLOW_WORKER_COUNTER_E2E: ['backend/tests/system/worker-counter-offer.pg.test.ts'],
});

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(fullPath));
    if (entry.isFile() && /\.test\.ts$/u.test(entry.name)) files.push(fullPath);
  }
  return files;
}

function sourceGateMap() {
  const result = new Map();
  for (const file of sourceFiles(join(projectRoot, 'backend', 'tests'))) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/process\.env\.(HX_ALLOW_[A-Z0-9_]+)\s*===\s*'1'/gu)) {
      const paths = result.get(match[1]) || [];
      paths.push(relative(projectRoot, file).replaceAll('\\', '/'));
      result.set(match[1], paths);
    }
  }
  return Object.fromEntries(
    [...result.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([gate, paths]) => [gate, [...new Set(paths)].sort()])
  );
}

const safeEnv = {
  NODE_ENV: 'test',
  HX_ALLOW_CI_DB_RECREATE: 'true',
  DATABASE_URL: 'postgresql://hx_ci_runner:hx_ci_password@127.0.0.1:5432/hx_ci_admin_test',
  REDIS_URL: 'redis://127.0.0.1:16379',
};

const providerSource = [
  '../backend/src/config.ts',
  '../backend/src/services/BiometricVerificationService.ts',
  '../backend/src/services/KnowledgeGraphService.ts',
  '../backend/src/services/PhotoVerificationService.ts',
]
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
  .join('\n');
const requiredRunnerSource = readFileSync(
  new URL('./run-required-tests.mjs', import.meta.url),
  'utf8'
);
const requiredConfigSource = readFileSync(
  new URL('../vitest.required.config.ts', import.meta.url),
  'utf8'
);

test('required Vitest uses the bounded two-project config and cross-platform loader', () => {
  assert.match(requiredRunnerSource, /'--config',\s*'vitest\.required\.config\.ts'/u);
  assert.match(requiredRunnerSource, /'--configLoader=runner'/u);
  assert.match(requiredRunnerSource, /await rm\(reportPath, \{ force: true \}\)/u);

  assert.match(requiredConfigSource, /name: 'isolated'/u);
  assert.match(requiredConfigSource, /backend\/tests\/unit\/\*\*\/\*\.test\.ts/u);
  assert.match(requiredConfigSource, /backend\/tests\/integration\/\*\*\/\*\.test\.ts/u);
  assert.match(requiredConfigSource, /fileParallelism: true/u);
  assert.match(requiredConfigSource, /maxWorkers: 4/u);
  assert.match(requiredConfigSource, /groupOrder: 0/u);
  assert.match(requiredConfigSource, /name: 'database-serial'/u);
  const databaseProject = requiredConfigSource.slice(requiredConfigSource.indexOf("name: 'database-serial'"));
  const isolatedProject = requiredConfigSource.slice(0, requiredConfigSource.indexOf("name: 'database-serial'"));
  assert.match(databaseProject, /setupFiles:\s*\[\s*\.\.\.commonRequiredTestConfig\.setupFiles,\s*'\.\/backend\/tests\/disposable-database-runtime\.setup\.ts'/u);
  assert.doesNotMatch(isolatedProject, /disposable-database-runtime\.setup\.ts/u);
  assert.match(requiredConfigSource, /backend\/tests\/invariants\/\*\*\/\*\.test\.ts/u);
  assert.match(requiredConfigSource, /backend\/tests\/system\/\*\*\/\*\.test\.ts/u);
  assert.match(requiredConfigSource, /fileParallelism: false/u);
  assert.match(requiredConfigSource, /groupOrder: 1/u);
  assert.match(requiredConfigSource, /pool: 'forks'/u);
  assert.match(requiredConfigSource, /bail: 0/u);
  assert.doesNotMatch(requiredConfigSource, /\bshard\b\s*:/u);
});

test('required Vitest preserves console diagnostics alongside exact JSON accounting', () => {
  assert.match(requiredRunnerSource, /'--reporter=default'/u);
  assert.match(requiredRunnerSource, /'--reporter=json'/u);
  assert.match(requiredRunnerSource, /`--outputFile\.json=\$\{reportPath\}`/u);
  assert.doesNotMatch(requiredRunnerSource, /dangerouslyIgnoreUnhandledErrors/u);
});

test('direct-execution detection canonicalizes aliases and covers platform path semantics', () => {
  const runnerUrl = new URL('./run-required-tests.mjs', import.meta.url);
  const runnerPath = fileURLToPath(runnerUrl);
  const testPath = fileURLToPath(import.meta.url);

  assert.equal(isDirectExecution(runnerUrl, runnerPath), true);
  assert.equal(isDirectExecution(runnerUrl, testPath), false);

  const lexicalCanonicalize = (candidate) => candidate;
  assert.equal(
    isDirectExecution(runnerUrl, runnerPath.toUpperCase(), 'win32', lexicalCanonicalize),
    true
  );
  assert.equal(isDirectExecution(runnerUrl, testPath, 'win32', lexicalCanonicalize), false);

  const aliasPath = `${runnerPath}.portable-alias`;
  const aliasCanonicalize = (candidate) => (candidate === aliasPath ? runnerPath : candidate);
  assert.equal(isDirectExecution(runnerUrl, aliasPath, process.platform, aliasCanonicalize), true);
});

test('direct-execution detection fails closed when canonical identity is unavailable', () => {
  const runnerUrl = new URL('./run-required-tests.mjs', import.meta.url);
  const runnerPath = fileURLToPath(runnerUrl);
  assert.throws(
    () =>
      isDirectExecution(runnerUrl, runnerPath, process.platform, () => {
        throw new Error('canonicalization unavailable');
      }),
    /REQUIRED_TEST_DIRECT_EXECUTION_PATH_UNRESOLVED/u
  );
});

test('direct required-test invocation fails closed for an invalid policy', () => {
  const runnerPath = fileURLToPath(new URL('./run-required-tests.mjs', import.meta.url));
  const invokedPath =
    process.platform === 'win32'
      ? `${runnerPath[0].toLowerCase()}${runnerPath.slice(1)}`
      : runnerPath;
  const result = spawnSync(process.execPath, [invokedPath], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HX_ALLOW_CI_DB_RECREATE: 'false',
      DATABASE_URL: 'not-a-postgresql-url',
    },
    timeout: 10_000,
    windowsHide: true,
  });

  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Refusing required local tests:/u);
});

test('required local test environment derives only fixed isolated database targets', () => {
  assert.deepEqual(validateRequiredTestPolicy(safeEnv), []);
  const environments = requiredTestEnvironments(safeEnv);

  assert.equal(environments.prepare.DATABASE_URL, safeEnv.DATABASE_URL);
  assert.equal(environments.prepare.HX_ALLOW_CI_DB_RECREATE, 'true');
  assert.equal(
    environments.vitest.DATABASE_URL,
    'postgresql://hx_ci_runner:hx_ci_password@127.0.0.1:5432/hx_ci_invariant_test'
  );
  assert.equal(
    environments.vitest.LOCAL_TEST_DB_URL,
    'postgresql://hx_ci_runner:hx_ci_password@127.0.0.1:5432/hx_ci_system_test'
  );
  assert.equal(environments.vitest.REDIS_URL, 'redis://127.0.0.1:16379');
  assert.equal(environments.vitest.HX_ALLOW_CI_DB_RECREATE, 'true');
  for (const gate of REQUIRED_TEST_GATES) {
    assert.equal(environments.vitest[gate], '1');
  }
});

test('required local tests reject remote, production, and mismatched test infrastructure', () => {
  for (const env of [
    { ...safeEnv, NODE_ENV: 'production' },
    { ...safeEnv, HX_ALLOW_CI_DB_RECREATE: undefined },
    {
      ...safeEnv,
      DATABASE_URL: 'postgresql://hx_ci_runner:ci@db.example.com:5432/hx_ci_admin_test',
    },
    { ...safeEnv, DATABASE_URL: 'postgresql://postgres:ci@127.0.0.1:5432/hx_ci_admin_test' },
    { ...safeEnv, DATABASE_URL: 'postgresql://hx_ci_runner:ci@127.0.0.1:5432/postgres' },
    { ...safeEnv, REDIS_URL: 'rediss://production.example.com:6379' },
    {
      ...safeEnv,
      LOCAL_TEST_DB_URL: 'postgresql://hx_ci_runner:ci@127.0.0.1:5432/postgres',
    },
    { ...safeEnv, DATABASE_REPLICA_URL: 'postgresql://production.example.com/hustlexp' },
    { ...safeEnv, UPSTASH_REDIS_REST_URL: 'https://production.example.com' },
  ]) {
    assert.notEqual(validateRequiredTestPolicy(env).length, 0);
  }
});

test('required local test gates are exact and bind the container flag to non-admin targets', () => {
  assert.deepEqual(REQUIRED_TEST_GATES, [
    'HX_ALLOW_E2E_LIFECYCLE',
    'HX_ALLOW_E2E_LIQUIDITY_EXPANSION',
    'HX_ALLOW_NOTIFICATION_PG',
    'HX_ALLOW_LEAD_INGRESS_PG',
    'HX_ALLOW_TASK_DRAFT_INGRESS_PG',
    'HX_ALLOW_WORKER_COUNTER_E2E',
  ]);
  const environments = requiredTestEnvironments(safeEnv);
  assert.deepEqual(
    Object.keys(environments.vitest)
      .filter((name) => name.startsWith('HX_ALLOW_'))
      .sort(),
    ['HX_ALLOW_CI_DB_RECREATE', ...REQUIRED_TEST_GATES].sort()
  );

  const withAmbientGates = requiredTestEnvironments({
    ...safeEnv,
    HX_ALLOW_UNKNOWN_DESTRUCTIVE_ACTION: '1',
    HX_ALLOW_E2E_LIFECYCLE: 'wrong',
  });
  assert.deepEqual(
    Object.keys(withAmbientGates.prepare).filter((name) => name.startsWith('HX_ALLOW_')),
    ['HX_ALLOW_CI_DB_RECREATE']
  );
  assert.deepEqual(
    Object.keys(withAmbientGates.vitest)
      .filter((name) => name.startsWith('HX_ALLOW_'))
      .sort(),
    ['HX_ALLOW_CI_DB_RECREATE', ...REQUIRED_TEST_GATES].sort()
  );
  assert.equal(withAmbientGates.vitest.HX_ALLOW_E2E_LIFECYCLE, '1');
});

test('required child environments scrub every external provider credential and selector', () => {
  const ambientExternalProvider = Object.fromEntries(
    [...EXTERNAL_PROVIDER_CREDENTIAL_VARIABLES, ...EXTERNAL_PROVIDER_SELECTOR_VARIABLES].map(
      (name) => [name, `ambient-${name.toLowerCase()}`]
    )
  );
  const environments = requiredTestEnvironments({
    ...safeEnv,
    ...ambientExternalProvider,
    TWILIO_API_KEY: 'ambient-unknown-provider-addition',
    HXOS_ALLOW_LOCAL_TEST_IDENTITY: 'ambient',
    HXOS_LOCAL_TEST_IDENTITY_SECRET: 'ambient',
  });

  for (const name of Object.keys(ambientExternalProvider)) {
    const expected = FIXED_SYNTHETIC_TEST_PROVIDER_ENV[name];
    assert.equal(environments.prepare[name], expected, `${name} leaked into database preparation`);
    assert.equal(environments.vitest[name], expected, `${name} leaked into Vitest`);
  }
  assert.equal(environments.vitest.TWILIO_API_KEY, undefined);
  assert.equal(
    environments.vitest.HXOS_LOCAL_TEST_IDENTITY_SECRET,
    FIXED_SYNTHETIC_TEST_PROVIDER_ENV.HXOS_LOCAL_TEST_IDENTITY_SECRET
  );
  assert.deepEqual(
    Object.keys(environments.vitest).filter((name) => name.startsWith('AI_ROUTE_')),
    []
  );
});

test('required child environments scrub ambient internal authority credentials and actors', () => {
  const ambientAuthority = {
    HX_COMPLETION_DELIVERY_WEBHOOK_SECRET: 'ambient-live-secret',
    HX_COMPLETION_DELIVERY_SINK_ACTOR_ID: '00000000-0000-0000-0000-000000000001',
    ENGINE_BRIDGE_WRITE_KEY: 'ambient-bridge-key',
    INTERNAL_API_KEY: 'ambient-internal-key',
    QUEUE_HMAC_SECRET: 'ambient-queue-key',
    OPS_ADMIN_KEY: 'ambient-ops-key',
    POSTGRES_PASSWORD: 'ambient-postgres-password',
  };
  const environments = requiredTestEnvironments({ ...safeEnv, ...ambientAuthority });

  for (const [name, value] of Object.entries(ambientAuthority)) {
    assert.equal(environments.prepare[name], undefined, `${name} leaked into preparation`);
    assert.equal(environments.vitest[name], undefined, `${name} leaked into Vitest`);
    assert.notEqual(environments.vitest[name], value);
  }
  assert.equal(AMBIENT_AUTHORITY_VARIABLE_SUFFIX.test('ENGINE_BRIDGE_WRITE_KEY'), true);
  assert.deepEqual(AMBIENT_AUTHORITY_EXACT_VARIABLES, ['HX_COMPLETION_DELIVERY_SINK_ACTOR_ID']);
});

test('external provider scrub inventory covers every matching backend environment read', () => {
  const scrubbed = new Set([
    ...EXTERNAL_PROVIDER_CREDENTIAL_VARIABLES,
    ...EXTERNAL_PROVIDER_SELECTOR_VARIABLES,
    ...Object.keys(FIXED_SYNTHETIC_TEST_PROVIDER_ENV),
  ]);
  const referenced = new Set(
    [...providerSource.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)]
      .map((match) => match[1])
      .filter((name) =>
        /^(?:AI_ROUTE_|OPENAI_|DEEPSEEK_|GROQ_|ALIBABA_|ANTHROPIC_|GOOGLE_|AWS_|R2_|S3_|BUCKET_NAME$|FIREBASE_|TWILIO_|SENDGRID_|CHECKR_|TURNSTILE_|STRIPE_|SENTRY_|DATADOG_|DD_|SMTP_URL$|HX_SMS_SINK_URL$)/.test(
          name
        )
      )
  );

  assert.notEqual(referenced.size, 0);
  for (const name of referenced) {
    assert.equal(
      scrubbed.has(name),
      true,
      `${name} is read by an advisory provider but not scrubbed`
    );
  }
});

test('required child environments replace ambient providers with fixed synthetic values only', () => {
  const environments = requiredTestEnvironments({
    ...safeEnv,
    OPENAI_API_KEY: 'must-not-survive',
    ANTHROPIC_API_KEY: 'must-not-survive',
    AI_ROUTE_PRIMARY: 'openai',
    AWS_REGION: 'us-east-1',
    HXOS_ALLOW_LOCAL_TEST_IDENTITY: 'ambient-true',
    HXOS_LOCAL_TEST_IDENTITY_SECRET: 'ambient-identity-secret',
  });

  for (const [name, value] of Object.entries(FIXED_SYNTHETIC_TEST_PROVIDER_ENV)) {
    assert.equal(environments.prepare[name], value);
    assert.equal(environments.vitest[name], value);
    if (name.endsWith('_SECRET')) {
      assert.ok(String(value).length >= 32, `${name} must satisfy the controlled-provider minimum`);
    }
  }
  assert.equal(environments.vitest.OPENAI_API_KEY, undefined);
  assert.equal(environments.vitest.ANTHROPIC_API_KEY, undefined);
  assert.equal(environments.vitest.AI_ROUTE_PRIMARY, undefined);
  assert.equal(environments.vitest.AWS_REGION, undefined);
});

test('required runner owns the exact source gate inventory and scopes every gate to Vitest', () => {
  assert.deepEqual(sourceGateMap(), expectedGateSources);
  assert.deepEqual(REQUIRED_TEST_GATES, Object.keys(expectedGateSources));

  const environments = requiredTestEnvironments(safeEnv);
  for (const gate of Object.keys(expectedGateSources)) {
    assert.equal(environments.prepare[gate], undefined, `${gate} leaked into preparation`);
    assert.equal(environments.vitest[gate], '1', `${gate} missing from complete Vitest`);
  }
});

test('required runner fixes money creation frozen and preserves exact hosted commit identity', () => {
  const githubSha = 'fedcba9876543210fedcba9876543210fedcba98';
  const environments = requiredTestEnvironments({
    ...safeEnv,
    GITHUB_SHA: githubSha,
    HX_EXACT_CANDIDATE_SHA: githubSha,
    HX_PAYMENT_CREATION_MODE: 'live',
  });

  assert.equal(environments.prepare.GITHUB_SHA, githubSha);
  assert.equal(environments.vitest.GITHUB_SHA, githubSha);
  assert.equal(environments.prepare.HX_EXACT_CANDIDATE_SHA, githubSha);
  assert.equal(environments.vitest.HX_EXACT_CANDIDATE_SHA, githubSha);
  assert.equal(environments.prepare.HX_PAYMENT_CREATION_MODE, 'frozen');
  assert.equal(environments.vitest.HX_PAYMENT_CREATION_MODE, 'frozen');
});

test('required runner owns every release contract and executes in fail-closed order', () => {
  for (const requiredContract of [
    'scripts/verify-security-workflow.test.mjs',
    'scripts/verify-consequential-admin-mutations.test.mjs',
    'scripts/verify-local-tools-absence.test.mjs',
    'scripts/verify-team-alignment.test.mjs',
    'scripts/verify-vitest-outcome.test.mjs',
  ]) {
    assert.ok(CONTRACT_TESTS.includes(requiredContract), requiredContract);
  }

  const orderedFragments = [
    'await rm(reportPath, { force: true })',
    "await runNode(['scripts/verify-local-tools-absence.mjs']",
    "await runNode(['node_modules/typescript/bin/tsc']",
    "await runNode(['scripts/write-build-identity.mjs']",
    "await runNode(['--test', ...CONTRACT_TESTS]",
    "await runNode(['scripts/prepare-test-databases.mjs']",
    "'node_modules/vitest/vitest.mjs'",
    "await runNode(['scripts/verify-vitest-outcome.mjs', reportPath]",
  ];
  const positions = orderedFragments.map((fragment) => requiredRunnerSource.indexOf(fragment));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(positions, [...positions].sort((left, right) => left - right));
});
