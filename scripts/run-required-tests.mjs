import { mkdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TEST_DATABASES,
  testDatabaseUrls,
  validatePreparationPolicy,
  validatePreparedDatabaseUrl,
} from './prepare-test-databases.mjs';

export const REQUIRED_TEST_GATES = Object.freeze([
  'HX_ALLOW_E2E_LIFECYCLE',
  'HX_ALLOW_E2E_LIQUIDITY_EXPANSION',
  'HX_ALLOW_NOTIFICATION_PG',
  'HX_ALLOW_LEAD_INGRESS_PG',
  'HX_ALLOW_TASK_DRAFT_INGRESS_PG',
  'HX_ALLOW_WORKER_COUNTER_E2E',
]);

// Required tests prove deterministic local behavior. Ambient credentials must
// never turn any provider fallback into an external request. Keep this list
// aligned with every live provider variable read by backend configuration and
// services; the prefix scrub below contains unknown provider additions too.
export const EXTERNAL_PROVIDER_CREDENTIAL_VARIABLES = Object.freeze([
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'ALIBABA_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_MAPS_API_KEY',
  'GOOGLE_CLOUD_VISION_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'FIREBASE_PRIVATE_KEY',
  'FIREBASE_WEB_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VERIFY_SERVICE_SID',
  'SENDGRID_API_KEY',
  'CHECKR_WEBHOOK_SECRET',
  'TURNSTILE_SECRET_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_CONNECT_WEBHOOK_SECRET',
  'SENTRY_DSN',
  'DD_API_KEY',
  'DD_APP_KEY',
  'HX_FAKE_FINANCIAL_WEBHOOK_SECRET',
  'HX_SYNTHETIC_OPERATOR_AUTH_SECRET',
]);

// Route, model, and region overrides are scrubbed with credentials so an
// ambient developer shell cannot choose a different external advisory lane.
export const EXTERNAL_PROVIDER_SELECTOR_VARIABLES = Object.freeze([
  'AI_ROUTE_PRIMARY',
  'AI_ROUTE_FAST',
  'AI_ROUTE_REASONING',
  'AI_ROUTE_SAFETY',
  'AI_ROUTE_BACKUP',
  'OPENAI_MODEL',
  'DEEPSEEK_MODEL',
  'GROQ_MODEL',
  'ALIBABA_MODEL',
  'ANTHROPIC_MODEL',
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'R2_ACCOUNT_ID',
  'R2_ENDPOINT',
  'R2_BUCKET_NAME',
  'R2_REGION',
  'S3_ENDPOINT',
  'BUCKET_NAME',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'TWILIO_FROM_PHONE',
  'SENDGRID_FROM_EMAIL',
  'SMTP_URL',
  'HX_SMS_SINK_URL',
  'STRIPE_MODE',
  'STRIPE_FREE_PRICE_ID',
  'STRIPE_PREMIUM_PRICE_ID',
  'STRIPE_PREMIUM_MONTHLY_PRICE_ID',
  'STRIPE_PREMIUM_YEARLY_PRICE_ID',
  'STRIPE_PRO_PRICE_ID',
  'STRIPE_PRO_MONTHLY_PRICE_ID',
  'STRIPE_PRO_YEARLY_PRICE_ID',
  'SENTRY_FORCE_ENABLE',
  'SENTRY_TRACES_SAMPLE_RATE',
  'DATADOG_ENABLED',
  'DD_AGENT_HOST',
  'DD_AGENT_PORT',
  'DD_ENV',
  'DD_SERVICE',
  'DD_VERSION',
]);

export const FIXED_SYNTHETIC_TEST_PROVIDER_ENV = Object.freeze({
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  HX_PAYMENT_CREATION_MODE: 'frozen',
  FIREBASE_PROJECT_ID: 'hustlexp-required-test-synthetic',
  HX_AI_PROVIDER_MODE: 'deterministic',
  HX_MAPS_PROVIDER_MODE: 'deterministic',
  HX_VISION_PROVIDER_MODE: 'deterministic',
  HX_BIOMETRIC_PROVIDER_MODE: 'deterministic',
  HX_IDENTITY_PROVIDER_MODE: 'synthetic',
  HX_SCREENING_PROVIDER_MODE: 'synthetic',
  HX_CREDENTIAL_VERIFICATION_MODE: 'synthetic',
  HX_OBJECT_STORAGE_MODE: 'synthetic',
  HX_FINANCIAL_PROVIDER_MODE: 'fake',
  HX_OUTBOUND_COMMUNICATION_MODE: 'sink',
  HX_EMAIL_DELIVERY_MODE: 'sink',
  HX_SMS_DELIVERY_MODE: 'sink',
  HX_LIVE_DELIVERY: 'false',
  HX_EXTERNAL_VALUE: 'false',
  HX_LIVE_PROVIDER_ACCESS: 'false',
  HX_TELEMETRY_EXPORT_MODE: 'disabled',
  HX_FAKE_FINANCIAL_PROVIDER_ENABLED: 'true',
  HX_FAKE_FINANCIAL_WEBHOOK_SECRET: 'required-tests-fake-webhook-hmac-v1',
  HXOS_ALLOW_LOCAL_TEST_IDENTITY: 'true',
  HXOS_LOCAL_TEST_IDENTITY_SECRET: 'required-tests-identity-provider-v1',
  HXOS_ALLOW_LOCAL_TEST_SCREENING: 'true',
  HXOS_LOCAL_TEST_SCREENING_SECRET: 'required-tests-screening-provider-v1',
  HXOS_ALLOW_LOCAL_TEST_PAYOUT: 'true',
  HXOS_LOCAL_TEST_PAYOUT_SECRET: 'required-tests-payout-provider-v1',
  HXOS_ALLOW_LOCAL_TEST_DURATION_EVIDENCE: 'true',
  HXOS_LOCAL_TEST_DURATION_EVIDENCE_SECRET: 'required-tests-duration-evidence-v1',
  HXOS_ALLOW_LOCAL_TEST_PROVIDER_CAPABILITY: 'true',
  HXOS_LOCAL_TEST_PROVIDER_CAPABILITY_SECRET: 'required-tests-provider-capability-v1',
  HXOS_ALLOW_LOCAL_TEST_LIQUIDITY: 'true',
  HXOS_LOCAL_TEST_LIQUIDITY_SECRET: 'required-tests-liquidity-provider-v1',
  HXOS_ALLOW_LOCAL_TEST_OFFER_REVIEW: 'true',
  HXOS_LOCAL_TEST_OFFER_REVIEW_SECRET: 'required-tests-offer-review-secret-v1',
});

const EXTERNAL_PROVIDER_PREFIX =
  /^(?:AI_ROUTE_|OPENAI_|DEEPSEEK_|GROQ_|ALIBABA_|ANTHROPIC_|GOOGLE_|GCP_|AZURE_|AWS_|R2_|S3_|BUCKET_NAME$|FIREBASE_|TWILIO_|SENDGRID_|MAILGUN_|POSTMARK_|RESEND_|SES_|SNS_|FCM_|APNS_|PUSHER_|ONESIGNAL_|CHECKR_|TURNSTILE_|STRIPE_|PLAID_|DWOLLA_|ADYEN_|BRAINTREE_|PAYPAL_|SQUARE_|BANK_|SENTRY_|DATADOG_|DD_|SMTP_URL$|HX_SMS_SINK_URL$|HX_(?:AI|MAPS|VISION|BIOMETRIC|IDENTITY|SCREENING|CREDENTIAL_VERIFICATION|OBJECT_STORAGE|FINANCIAL|OUTBOUND_COMMUNICATION|EMAIL_DELIVERY|SMS_DELIVERY|LIVE_DELIVERY|LIVE_PROVIDER_ACCESS|EXTERNAL_VALUE|TELEMETRY_EXPORT|FAKE_FINANCIAL|SYNTHETIC_OPERATOR_AUTH)_)/;

// Do not reuse the conventional local Redis service port. Required tests own
// this exact loopback-only port so they cannot read, overwrite, or flush keys
// belonging to an ambient developer service.
const LOOPBACK_REDIS_URL = 'redis://127.0.0.1:16379';
const FORBIDDEN_AMBIENT_DATABASE_VARIABLES = Object.freeze([
  'DATABASE_REPLICA_URL',
  'NEON_DATABASE_URL',
  'SUPABASE_DATABASE_URL',
  'TEST_DATABASE_URL',
]);
const FORBIDDEN_AMBIENT_REDIS_VARIABLES = Object.freeze([
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_URL',
  'REDIS_TOKEN',
]);
const CONTRACT_TESTS = Object.freeze([
  'scripts/prepare-test-databases.test.mjs',
  'scripts/run-required-tests.test.mjs',
  'scripts/verify-consequential-admin-mutations.test.mjs',
  'scripts/verify-engine-migrations-postgres.test.mjs',
  'scripts/verify-required-ci.test.mjs',
  'scripts/verify-security-workflow.test.mjs',
  'scripts/verify-team-alignment.test.mjs',
  'scripts/verify-vitest-outcome.test.mjs',
]);

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function withoutKeys(env, keys) {
  const sanitized = { ...env };
  for (const key of keys) delete sanitized[key];
  return sanitized;
}

export function validateRequiredTestPolicy(env = process.env) {
  const errors = validatePreparationPolicy(env);
  const urls = errors.length === 0 ? testDatabaseUrls(env.DATABASE_URL) : null;
  if (urls) {
    errors.push(...validatePreparedDatabaseUrl(urls.invariant, TEST_DATABASES.invariant));
    errors.push(...validatePreparedDatabaseUrl(urls.system, TEST_DATABASES.system));
    if (env.LOCAL_TEST_DB_URL && env.LOCAL_TEST_DB_URL !== urls.system) {
      errors.push(`LOCAL_TEST_DB_URL, when set, must equal ${urls.system}`);
    }
  }
  const redisUrl = env.REDIS_URL || LOOPBACK_REDIS_URL;
  if (redisUrl !== LOOPBACK_REDIS_URL) {
    errors.push(`REDIS_URL must equal ${LOOPBACK_REDIS_URL}`);
  }
  for (const name of [
    ...FORBIDDEN_AMBIENT_DATABASE_VARIABLES,
    ...FORBIDDEN_AMBIENT_REDIS_VARIABLES,
  ]) {
    if (env[name]) errors.push(`${name} must be unset for required local tests`);
  }
  return errors;
}

export function requiredTestEnvironments(env = process.env) {
  const errors = validateRequiredTestPolicy(env);
  if (errors.length > 0) {
    throw new Error(`Refusing required local tests: ${errors.join('; ')}`);
  }
  const urls = testDatabaseUrls(env.DATABASE_URL);
  const forbiddenVariables = [
    ...FORBIDDEN_AMBIENT_DATABASE_VARIABLES,
    ...FORBIDDEN_AMBIENT_REDIS_VARIABLES,
    ...EXTERNAL_PROVIDER_CREDENTIAL_VARIABLES,
    ...EXTERNAL_PROVIDER_SELECTOR_VARIABLES,
    ...Object.keys(env).filter((name) => EXTERNAL_PROVIDER_PREFIX.test(name)),
    ...Object.keys(env).filter((name) => name.startsWith('HXOS_')),
    ...Object.keys(env).filter((name) => name.startsWith('HX_ALLOW_')),
  ];
  const base = {
    ...withoutKeys(env, forbiddenVariables),
    ...FIXED_SYNTHETIC_TEST_PROVIDER_ENV,
  };
  const prepare = {
    ...base,
    NODE_ENV: 'test',
    DATABASE_URL: env.DATABASE_URL,
    HX_ALLOW_CI_DB_RECREATE: 'true',
    TASK_LOCATION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    TASK_LOCATION_ENCRYPTION_KEY_ID: 'hx-required-tests-location-v1',
  };
  const vitest = withoutKeys(
    {
      ...base,
      NODE_ENV: 'test',
      DATABASE_URL: urls.invariant,
      LOCAL_TEST_DB_URL: urls.system,
      REDIS_URL: LOOPBACK_REDIS_URL,
      TASK_LOCATION_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      TASK_LOCATION_ENCRYPTION_KEY_ID: 'hx-required-tests-location-v1',
      ...Object.fromEntries(REQUIRED_TEST_GATES.map((name) => [name, '1'])),
    },
    ['HX_ALLOW_CI_DB_RECREATE']
  );
  return { prepare, vitest };
}

function runNode(args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env,
      shell: false,
      stdio: 'inherit',
    });
    child.once('error', rejectRun);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          `Required-test command failed (${signal || `exit ${code}`}): node ${args.join(' ')}`
        )
      );
    });
  });
}

export async function main(env = process.env) {
  const environments = requiredTestEnvironments(env);
  const reportPath = resolve(projectRoot, 'reports', 'vitest-required.json');
  await mkdir(dirname(reportPath), { recursive: true });

  await runNode(['node_modules/typescript/bin/tsc'], environments.vitest);
  await runNode(['scripts/write-build-identity.mjs'], environments.vitest);
  await runNode(['--test', ...CONTRACT_TESTS], environments.vitest);
  await runNode(['scripts/prepare-test-databases.mjs'], environments.prepare);
  await runNode(
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      // Avoid esbuild config-discovery permission drift on locked-down Windows
      // workspaces while executing the same TypeScript config directly.
      '--configLoader=runner',
      '--reporter=json',
      `--outputFile=${reportPath}`,
    ],
    environments.vitest
  );
  await runNode(['scripts/verify-vitest-outcome.mjs', reportPath], environments.vitest);
}

export function isDirectExecution(
  moduleUrl,
  invokedPath = process.argv[1],
  platform = process.platform,
  canonicalizePath = realpathSync.native
) {
  if (!invokedPath) return false;
  let modulePath;
  let entryPath;
  try {
    modulePath = resolve(canonicalizePath(resolve(fileURLToPath(moduleUrl))));
    entryPath = resolve(canonicalizePath(resolve(invokedPath)));
  } catch (cause) {
    throw new Error('REQUIRED_TEST_DIRECT_EXECUTION_PATH_UNRESOLVED', { cause });
  }
  return platform === 'win32'
    ? modulePath.toLowerCase() === entryPath.toLowerCase()
    : modulePath === entryPath;
}

if (isDirectExecution(import.meta.url)) {
  await main();
}
