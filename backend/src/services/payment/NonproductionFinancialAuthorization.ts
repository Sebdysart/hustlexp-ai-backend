import {
  buildIdentity as runtimeBuildIdentity,
  isTrustedBuildIdentity,
  type BuildIdentity,
} from '../../buildIdentity.js';
import {
  isAuthenticatedReleaseManifest,
  readReleaseManifest,
  releaseManifestDigest,
  type ReleaseManifest,
  type ReleaseManifestEvidence,
} from '../../releaseManifest.js';

const REVISION = /^[0-9a-f]{40}$/u;
const NONPRODUCTION_ENVIRONMENTS = ['local', 'preview', 'staging'] as const;
const TRUSTED_NONLOCAL_BUILD_SOURCES = new Set([
  'RAILWAY_GIT_COMMIT_SHA',
  'GITHUB_SHA',
  'SOURCE_VERSION',
]);
const FINANCIAL_CREDENTIAL_NAME =
  /^(?:STRIPE|ADYEN|BRAINTREE|PAYPAL|PLAID|DWOLLA|SQUARE|BANK|LIVE_(?:PAYMENT|PAYOUT)|(?:PAYMENT|PAYOUT)_PROVIDER).*?(?:SECRET|PRIVATE|API_?KEY|ACCESS_?TOKEN)/iu;
const LIVE_FINANCIAL_CREDENTIAL = /^(?:sk|rk|pk)_live_/iu;

export type NonproductionFinancialEnvironment = typeof NONPRODUCTION_ENVIRONMENTS[number];
export type NonproductionFinancialComponent = 'backend' | 'worker' | 'migration';

export interface NonproductionFinancialAuthorizationOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  release?: ReleaseManifestEvidence;
  identity?: BuildIdentity;
  component?: NonproductionFinancialComponent;
}

function fail(reason: string): never {
  throw new Error(`NONPRODUCTION_FAKE_FINANCE_REFUSED:${reason}`);
}

function exactEnvironment(value: string | undefined): NonproductionFinancialEnvironment {
  if (NONPRODUCTION_ENVIRONMENTS.includes(value as NonproductionFinancialEnvironment)) {
    return value as NonproductionFinancialEnvironment;
  }
  return fail('HX_ENVIRONMENT_MUST_BE_LOCAL_PREVIEW_OR_STAGING');
}

function assertRailwayBoundary(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  environment: NonproductionFinancialEnvironment,
): void {
  const projectName = env.RAILWAY_PROJECT_NAME?.trim();
  const railwayEnvironments = [
    env.RAILWAY_ENVIRONMENT_NAME,
    env.RAILWAY_ENVIRONMENT,
  ]
    .map((value) => value?.trim().toLowerCase() ?? '')
    .filter(Boolean);
  const uniqueRailwayEnvironments = [...new Set(railwayEnvironments)];
  const railwayPresent = Object.entries(env).some(([name, value]) =>
    name.startsWith('RAILWAY_') && Boolean(value?.trim()),
  );

  if (uniqueRailwayEnvironments.includes('production')) {
    fail('RAILWAY_PRODUCTION_ENVIRONMENT');
  }
  if (uniqueRailwayEnvironments.length > 1) {
    fail('RAILWAY_ENVIRONMENT_METADATA_CONFLICT');
  }
  if (environment === 'local') {
    if (railwayPresent) fail('LOCAL_MANIFEST_CANNOT_RUN_ON_RAILWAY');
    return;
  }
  if (!railwayPresent) fail('RAILWAY_CONTEXT_REQUIRED');
  if (projectName !== 'hustlexp-nonprod') {
    fail('RAILWAY_PROJECT_IS_NOT_HUSTLEXP_NONPROD');
  }
  if (!env.RAILWAY_PROJECT_ID?.trim()) fail('RAILWAY_PROJECT_ID_REQUIRED');
  if (!env.RAILWAY_ENVIRONMENT_ID?.trim()) fail('RAILWAY_ENVIRONMENT_ID_REQUIRED');
  const railwayEnvironment = uniqueRailwayEnvironments[0];
  if (!railwayEnvironment) fail('RAILWAY_ENVIRONMENT_NAME_REQUIRED');
  if (environment === 'staging' && railwayEnvironment !== 'staging') {
    fail('RAILWAY_ENVIRONMENT_DOES_NOT_MATCH_STAGING_MANIFEST');
  }
  if (
    environment === 'preview'
    && !railwayEnvironment.startsWith('pr-')
    && !railwayEnvironment.startsWith('preview-')
  ) {
    fail('RAILWAY_ENVIRONMENT_DOES_NOT_MATCH_PREVIEW_MANIFEST');
  }
}

function normalizedOptionalFlag(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return null;
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  return fail('EXTERNAL_ACCESS_FLAG_INVALID');
}

function assertComponentRole(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  environment: NonproductionFinancialEnvironment,
  component: NonproductionFinancialComponent,
): void {
  const serviceRole = env.SERVICE_ROLE?.trim().toLowerCase();
  if (!serviceRole) {
    if (environment !== 'local') fail('SERVICE_ROLE_REQUIRED');
    return;
  }
  const roleComponent = serviceRole === 'worker'
    ? 'worker'
    : ['api', 'backend'].includes(serviceRole)
      ? 'backend'
      : serviceRole === 'migration'
        ? 'migration'
        : fail('SERVICE_ROLE_INVALID');
  if (roleComponent !== component) fail('MANIFEST_COMPONENT_ROLE_MISMATCH');
}

function assertRuntimeMoneyFreeze(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
): void {
  if (env.HX_PAYMENT_CREATION_MODE !== 'frozen') {
    fail('HX_PAYMENT_CREATION_MODE_MUST_BE_FROZEN');
  }
  if (normalizedOptionalFlag(env.HX_EXTERNAL_VALUE) === true) {
    fail('EXTERNAL_VALUE_MUST_BE_FALSE');
  }
  if (normalizedOptionalFlag(env.HX_LIVE_PROVIDER_ACCESS) === true) {
    fail('LIVE_PROVIDER_ACCESS_MUST_BE_FALSE');
  }

  for (const [name, value] of Object.entries(env)) {
    const normalizedValue = value?.trim() ?? '';
    if (LIVE_FINANCIAL_CREDENTIAL.test(normalizedValue)) {
      fail(`LIVE_FINANCIAL_CREDENTIAL_${name}`);
    }
    if (FINANCIAL_CREDENTIAL_NAME.test(name) && normalizedValue) {
      fail(`FINANCIAL_CREDENTIAL_NOT_ALLOWED_${name}`);
    }
  }
}

function assertCapabilities(manifest: ReleaseManifest): void {
  const capabilities = manifest.capabilities;
  if (capabilities.financialProvider !== 'fake') fail('MANIFEST_PROVIDER_MUST_BE_FAKE');
  if (capabilities.fakeFinancialEvents !== true) fail('FAKE_EVENTS_MUST_BE_ENABLED');
  if (capabilities.customerMoneyCreation !== false) fail('CUSTOMER_MONEY_CREATION_NOT_FROZEN');
  if (capabilities.hardAssignment !== false) fail('HARD_ASSIGNMENT_NOT_FROZEN');
  if (capabilities.realSettlement !== false) fail('REAL_SETTLEMENT_NOT_FROZEN');
  if (capabilities.outboundCommunication !== 'sink') fail('OUTBOUND_COMMUNICATION_NOT_SINKED');
  if (capabilities.dataClass !== 'synthetic') fail('DATA_CLASS_NOT_SYNTHETIC');
}

/**
 * Authorize fake financial effects from the exact release manifest.
 *
 * No feature flag grants authority. The manifest, immutable build identity,
 * environment boundary, and runtime money freeze must all agree. This gate is
 * deliberately reusable by both the migration entrypoint and the provider.
 */
export function assertNonproductionFakeFinanceAuthorized(
  options: NonproductionFinancialAuthorizationOptions = {},
): ReleaseManifest {
  const env = options.env ?? process.env;
  const release = options.release ?? readReleaseManifest();
  const identity = options.identity ?? runtimeBuildIdentity;
  const component = options.component ?? 'backend';
  const environment = exactEnvironment(env.HX_ENVIRONMENT);

  assertRailwayBoundary(env, environment);
  assertComponentRole(env, environment, component);
  assertRuntimeMoneyFreeze(env);

  if (release.status !== 'valid' || !release.manifest) fail('EXACT_MANIFEST_REQUIRED');
  const manifest = release.manifest;
  if (release.digest !== releaseManifestDigest(manifest)) fail('MANIFEST_DIGEST_MISMATCH');
  if (manifest.environment !== environment) fail('MANIFEST_ENVIRONMENT_MISMATCH');
  if (environment !== 'local' && release.source !== 'HX_RELEASE_MANIFEST_JSON') {
    fail('RUNTIME_MANIFEST_INPUT_REQUIRED');
  }
  if (environment !== 'local' && !isAuthenticatedReleaseManifest(release)) {
    fail('AUTHENTICATED_RELEASE_MANIFEST_REQUIRED');
  }
  assertCapabilities(manifest);

  if (!REVISION.test(identity.revision)) fail('EXACT_BUILD_REVISION_REQUIRED');
  if (environment !== 'local' && !isTrustedBuildIdentity(identity)) {
    fail('MEASURED_IMMUTABLE_BUILD_REQUIRED');
  }
  if (
    environment !== 'local'
    && !TRUSTED_NONLOCAL_BUILD_SOURCES.has(identity.source)
  ) {
    fail('TRUSTED_NONLOCAL_BUILD_SOURCE_REQUIRED');
  }
  if (environment !== 'local') {
    for (const source of TRUSTED_NONLOCAL_BUILD_SOURCES) {
      const runtimeRevision = env[source]?.trim().toLowerCase();
      if (runtimeRevision && runtimeRevision !== identity.revision) {
        fail(`RUNTIME_BUILD_REVISION_MISMATCH_${source}`);
      }
    }
  }
  if (manifest.components[component].revision !== identity.revision) {
    fail(`MANIFEST_${component.toUpperCase()}_REVISION_MISMATCH`);
  }
  if (environment !== 'local') {
    const executableComponent = component === 'migration' ? 'backend' : component;
    if (manifest.components[executableComponent].artifactDigest !== identity.artifact_digest) {
      fail(`MANIFEST_${executableComponent.toUpperCase()}_ARTIFACT_MISMATCH`);
    }
  }

  return manifest;
}

export function nonproductionFakeFinanceEnabled(
  options: NonproductionFinancialAuthorizationOptions = {},
): boolean {
  try {
    assertNonproductionFakeFinanceAuthorized(options);
    return true;
  } catch {
    return false;
  }
}
