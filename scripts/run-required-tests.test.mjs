import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AMBIENT_AUTHORITY_EXACT_VARIABLES,
  AMBIENT_AUTHORITY_VARIABLE_SUFFIX,
  EXTERNAL_PROVIDER_CREDENTIAL_VARIABLES,
  EXTERNAL_PROVIDER_SELECTOR_VARIABLES,
  FIXED_SYNTHETIC_TEST_PROVIDER_ENV,
  REQUIRED_TEST_GATES,
  isDirectExecution,
  requiredTestEnvironments,
  validateRequiredTestPolicy,
} from './run-required-tests.mjs';

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

test('required Vitest uses the cross-platform runner config loader', () => {
  assert.match(requiredRunnerSource, /'--configLoader=runner'/u);
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
  assert.equal(environments.vitest.HX_ALLOW_CI_DB_RECREATE, undefined);
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

test('required local test gates are exact and do not grant database recreate authority', () => {
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
    [...REQUIRED_TEST_GATES].sort()
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
    [...REQUIRED_TEST_GATES].sort()
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
  assert.equal(
    AMBIENT_AUTHORITY_VARIABLE_SUFFIX.test('ENGINE_BRIDGE_WRITE_KEY'),
    true,
  );
  assert.deepEqual(AMBIENT_AUTHORITY_EXACT_VARIABLES, [
    'HX_COMPLETION_DELIVERY_SINK_ACTOR_ID',
  ]);
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
