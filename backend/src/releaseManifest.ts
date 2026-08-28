import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS } from './releaseAuthorityKeys.js';

const REVISION = /^[0-9a-f]{40}$/u;
const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID = /^[a-z0-9][a-z0-9._-]{7,127}$/u;
const ZERO_REVISION = /^0{40}$/u;
const ZERO_DIGEST = /^sha256:0{64}$/u;
const SECRET_KEY = /(secret|password|private.?key|token|credential)/iu;
const FORBIDDEN_VALUE = /(github_pat_|ghp_|sk_live_|rk_live_|whsec_|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const BASE64_SIGNATURE = /^[A-Za-z0-9+/]{84,88}={0,2}$/u;

export const RELEASE_CHARTER_AUTHORITY = Object.freeze({
  document: 'HustleXP Business and Universal V1 Charter',
  version: '1.1.0',
  revision: '0b80c71e118d7cab70474bbbf6df778811fe4fe8',
});

export const RELEASE_COMPONENTS = [
  'backend',
  'worker',
  'web',
  'migration',
  'policy',
  'fixtures',
] as const;

export type ReleaseEnvironment = 'local' | 'preview' | 'staging' | 'production';
export type ReleaseService = 'backend' | 'worker' | 'web';
export type ReleaseComponent = typeof RELEASE_COMPONENTS[number];

interface RevisionComponent {
  revision: string;
  artifactDigest: string;
}

export type ReleaseImageEvidence = 'VERIFIED_IMMUTABLE_IMAGE' | 'IMAGE_UNAVAILABLE_HELD';

interface ImageComponent extends RevisionComponent {
  imageEvidence: ReleaseImageEvidence;
  imageDigest: string | null;
}

interface HealthTarget {
  component: ReleaseService;
  path: string;
}

export interface ReleaseManifest {
  $schema?: string;
  version: 1;
  environment: ReleaseEnvironment;
  releaseId: string;
  createdAt: string;
  authority: {
    document: typeof RELEASE_CHARTER_AUTHORITY.document;
    charterVersion: typeof RELEASE_CHARTER_AUTHORITY.version;
    charterRevision: typeof RELEASE_CHARTER_AUTHORITY.revision;
    capabilityPolicyDigest: string;
  };
  components: {
    backend: ImageComponent;
    worker: ImageComponent;
    web: ImageComponent;
    migration: RevisionComponent;
    policy: RevisionComponent;
    fixtures: ImageComponent;
  };
  capabilities: {
    financialProvider: 'fake' | 'disabled';
    fakeFinancialEvents: boolean;
    customerMoneyCreation: false;
    hardAssignment: false;
    realSettlement: false;
    outboundCommunication: 'sink' | 'bounded_live';
    dataClass: 'synthetic' | 'approved_customer';
  };
  promotion: {
    baseManifestDigest: string | null;
    changedComponents: ReleaseComponent[];
  };
  health: {
    backend: HealthTarget;
    worker: HealthTarget;
    web: HealthTarget;
  };
}

export interface ReleaseManifestEvidence {
  schema_version: 1;
  status: 'valid' | 'invalid' | 'unattributed';
  digest: string;
  source: string;
  errors: string[];
  manifest: ReleaseManifest | null;
  authentication: ReleaseManifestAuthentication;
}

export interface ReleaseManifestAuthentication {
  status: 'verified' | 'missing' | 'invalid' | 'untrusted_key';
  algorithm: 'ed25519' | null;
  keyId: string | null;
  keyFingerprint: string | null;
  signatureDigest: string | null;
  source: string;
  errors: string[];
}

export interface ReleaseManifestSignatureEnvelope {
  version: 1;
  algorithm: 'ed25519';
  keyId: string;
  manifestDigest: string;
  signature: string;
}

export interface ReleaseManifestTrustOptions {
  signatureRaw?: string;
  signatureSource?: string;
  trustedPublicKeys?: Readonly<Record<string, string>>;
}

export interface RuntimeReleaseManifestEvidence
  extends Omit<ReleaseManifestEvidence, 'status'> {
  status: 'compatible' | 'invalid' | 'unattributed';
}

interface RuntimeReleaseIdentity {
  service: ReleaseService;
  revision: string;
  environment: string;
  artifactDigest?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

export function releaseManifestDigest(manifest: unknown): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify(canonicalize(manifest)), 'utf8')
    .digest('hex')}`;
}

export function releaseManifestSignaturePayload(manifestDigest: string): Buffer {
  return Buffer.from(`HUSTLEXP_RELEASE_MANIFEST_V1\n${manifestDigest}\n`, 'utf8');
}

function unauthenticated(
  status: ReleaseManifestAuthentication['status'],
  source: string,
  errors: string[],
  envelope?: Partial<ReleaseManifestSignatureEnvelope>,
): ReleaseManifestAuthentication {
  return {
    status,
    algorithm: envelope?.algorithm === 'ed25519' ? 'ed25519' : null,
    keyId: typeof envelope?.keyId === 'string' ? envelope.keyId : null,
    keyFingerprint: null,
    signatureDigest: typeof envelope?.signature === 'string'
      ? `sha256:${createHash('sha256').update(envelope.signature, 'utf8').digest('hex')}`
      : null,
    source,
    errors,
  };
}

function authenticateManifestDigest(
  manifestDigest: string,
  raw: string | undefined,
  source: string,
  trustedPublicKeys: Readonly<Record<string, string>>,
): ReleaseManifestAuthentication {
  if (!raw?.trim()) return unauthenticated('missing', source, ['detached release signature is unavailable']);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unauthenticated('invalid', source, ['detached release signature must be valid JSON']);
  }
  if (!isRecord(parsed)) {
    return unauthenticated('invalid', source, ['detached release signature must be an object']);
  }
  const envelope = parsed as Partial<ReleaseManifestSignatureEnvelope>;
  const allowed = ['version', 'algorithm', 'keyId', 'manifestDigest', 'signature'];
  const errors: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!allowed.includes(key)) errors.push(`signature.${key} is not allowed`);
  }
  for (const key of allowed) {
    if (!(key in parsed)) errors.push(`signature.${key} is required`);
  }
  if (envelope.version !== 1) errors.push('signature.version must be 1');
  if (envelope.algorithm !== 'ed25519') errors.push('signature.algorithm must be ed25519');
  if (typeof envelope.keyId !== 'string' || !KEY_ID.test(envelope.keyId)) {
    errors.push('signature.keyId is invalid');
  }
  if (envelope.manifestDigest !== manifestDigest) {
    errors.push('signature.manifestDigest does not match the canonical manifest digest');
  }
  if (typeof envelope.signature !== 'string' || !BASE64_SIGNATURE.test(envelope.signature)) {
    errors.push('signature.signature must be one canonical Ed25519 base64 signature');
  }
  if (errors.length > 0) return unauthenticated('invalid', source, errors, envelope);

  const publicKeyPem = trustedPublicKeys[envelope.keyId!];
  if (!publicKeyPem) {
    return unauthenticated(
      'untrusted_key',
      source,
      [`release signing key is not pinned in protected source: ${envelope.keyId}`],
      envelope,
    );
  }
  try {
    const publicKey = createPublicKey(publicKeyPem);
    const keyFingerprint = `sha256:${createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')}`;
    const signature = Buffer.from(envelope.signature!, 'base64');
    if (!verify(null, releaseManifestSignaturePayload(manifestDigest), publicKey, signature)) {
      return unauthenticated('invalid', source, ['detached release signature verification failed'], envelope);
    }
    return {
      status: 'verified',
      algorithm: 'ed25519',
      keyId: envelope.keyId!,
      keyFingerprint,
      signatureDigest: `sha256:${createHash('sha256').update(signature).digest('hex')}`,
      source,
      errors: [],
    };
  } catch {
    return unauthenticated('invalid', source, ['pinned release public key is invalid'], envelope);
  }
}

export function isAuthenticatedReleaseManifest(evidence: ReleaseManifestEvidence): boolean {
  return evidence.status === 'valid' && evidence.authentication.status === 'verified';
}

function exactRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION.test(value) && !ZERO_REVISION.test(value);
}

function exactDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value) && !ZERO_DIGEST.test(value);
}

function normalizeEnvironment(value: string): ReleaseEnvironment | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'development' || normalized === 'test' || normalized === 'local') {
    return 'local';
  }
  if (normalized === 'preview' || normalized === 'staging' || normalized === 'production') {
    return normalized;
  }
  return null;
}

function checkObjectKeys(
  errors: string[],
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push(`${path}.${key} is not allowed`);
  }
  for (const key of required) {
    if (!(key in value)) errors.push(`${path}.${key} is required`);
  }
  return true;
}

function inspectSecretMaterial(errors: string[], value: unknown, path = 'manifest'): void {
  if (typeof value === 'string') {
    if (FORBIDDEN_VALUE.test(value)) errors.push(`${path} contains forbidden secret material`);
    return;
  }
  if (!isRecord(value) && !Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) errors.push(`${path}.${key} may not contain secret material`);
    inspectSecretMaterial(errors, child, `${path}.${key}`);
  }
}

function validateManifest(value: unknown): { manifest: ReleaseManifest | null; errors: string[] } {
  const errors: string[] = [];
  const topLevel = [
    '$schema',
    'version',
    'environment',
    'releaseId',
    'createdAt',
    'authority',
    'components',
    'capabilities',
    'promotion',
    'health',
  ] as const;
  if (!checkObjectKeys(
    errors,
    value,
    'manifest',
    topLevel,
    topLevel.filter((key) => key !== '$schema'),
  )) return { manifest: null, errors };

  if (value.version !== 1) errors.push('version must be 1');
  const environment = typeof value.environment === 'string'
    ? normalizeEnvironment(value.environment)
    : null;
  if (!environment || value.environment !== environment) {
    errors.push('environment must be local, preview, staging, or production');
  }
  if (typeof value.releaseId !== 'string' || !RELEASE_ID.test(value.releaseId)) {
    errors.push('releaseId must be a stable lowercase identifier');
  }
  if (
    typeof value.createdAt !== 'string'
    || Number.isNaN(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    errors.push('createdAt must be an exact UTC ISO timestamp');
  }

  if (checkObjectKeys(
    errors,
    value.authority,
    'authority',
    ['document', 'charterVersion', 'charterRevision', 'capabilityPolicyDigest'],
  )) {
    if (value.authority.document !== RELEASE_CHARTER_AUTHORITY.document) {
      errors.push('authority.document must name the canonical Charter');
    }
    if (value.authority.charterVersion !== RELEASE_CHARTER_AUTHORITY.version) {
      errors.push('authority.charterVersion must be 1.1.0');
    }
    if (value.authority.charterRevision !== RELEASE_CHARTER_AUTHORITY.revision) {
      errors.push('authority.charterRevision must be the signed Charter authority SHA');
    }
    if (!exactDigest(value.authority.capabilityPolicyDigest)) {
      errors.push('authority.capabilityPolicyDigest must be a non-placeholder sha256 digest');
    }
  }

  const imageComponents = new Set<ReleaseComponent>(['backend', 'worker', 'web', 'fixtures']);
  if (checkObjectKeys(errors, value.components, 'components', RELEASE_COMPONENTS)) {
    for (const name of RELEASE_COMPONENTS) {
      const component = value.components[name];
      const allowed = imageComponents.has(name)
        ? ['revision', 'artifactDigest', 'imageEvidence', 'imageDigest']
        : ['revision', 'artifactDigest'];
      if (!checkObjectKeys(errors, component, `components.${name}`, allowed)) continue;
      if (!exactRevision(component.revision)) {
        errors.push(`${name}.revision must be a non-placeholder 40-character Git SHA`);
      }
      if (!exactDigest(component.artifactDigest)) {
        errors.push(`${name}.artifactDigest must be a non-placeholder sha256 digest`);
      }
      if (imageComponents.has(name)) {
        if (
          !['VERIFIED_IMMUTABLE_IMAGE', 'IMAGE_UNAVAILABLE_HELD'].includes(
            String(component.imageEvidence)
          )
        ) {
          errors.push(
            `${name}.imageEvidence must be VERIFIED_IMMUTABLE_IMAGE or IMAGE_UNAVAILABLE_HELD`
          );
        } else if (
          component.imageEvidence === 'VERIFIED_IMMUTABLE_IMAGE' &&
          !exactDigest(component.imageDigest)
        ) {
          errors.push(`${name} verified imageEvidence requires a non-placeholder imageDigest`);
        } else if (
          component.imageEvidence === 'IMAGE_UNAVAILABLE_HELD' &&
          component.imageDigest !== null
        ) {
          errors.push(`${name} held imageEvidence requires imageDigest=null`);
        }
        if (environment !== 'local' && component.imageEvidence === 'IMAGE_UNAVAILABLE_HELD') {
          errors.push(`${name} ${environment ?? 'unknown'} image must be verified and immutable`);
        }
      }
    }
  }

  const capabilityKeys = [
    'financialProvider',
    'fakeFinancialEvents',
    'customerMoneyCreation',
    'hardAssignment',
    'realSettlement',
    'outboundCommunication',
    'dataClass',
  ] as const;
  if (checkObjectKeys(errors, value.capabilities, 'capabilities', capabilityKeys)) {
    const capabilities = value.capabilities;
    if (capabilities.customerMoneyCreation !== false) {
      errors.push('customerMoneyCreation must remain false');
    }
    if (capabilities.hardAssignment !== false) errors.push('hardAssignment must remain false');
    if (capabilities.realSettlement !== false) errors.push('realSettlement must remain false');
    if (environment === 'production') {
      if (capabilities.financialProvider !== 'disabled') {
        errors.push('production financialProvider must be disabled');
      }
      if (capabilities.fakeFinancialEvents !== false) {
        errors.push('production fakeFinancialEvents must be false');
      }
      if (!['sink', 'bounded_live'].includes(String(capabilities.outboundCommunication))) {
        errors.push('production outboundCommunication must be sink or bounded_live');
      }
      if (!['synthetic', 'approved_customer'].includes(String(capabilities.dataClass))) {
        errors.push('production dataClass must be synthetic or approved_customer');
      }
    } else if (environment) {
      if (capabilities.financialProvider !== 'fake') {
        errors.push('nonproduction financialProvider must be fake');
      }
      if (capabilities.fakeFinancialEvents !== true) {
        errors.push('nonproduction fakeFinancialEvents must be true');
      }
      if (capabilities.outboundCommunication !== 'sink') {
        errors.push('nonproduction outboundCommunication must be sink');
      }
      if (capabilities.dataClass !== 'synthetic') {
        errors.push('nonproduction dataClass must be synthetic');
      }
    }
  }

  if (checkObjectKeys(
    errors,
    value.promotion,
    'promotion',
    ['baseManifestDigest', 'changedComponents'],
  )) {
    const base = value.promotion.baseManifestDigest;
    if (base !== null && !exactDigest(base)) {
      errors.push('promotion.baseManifestDigest must be null or an exact sha256 digest');
    }
    const changed = value.promotion.changedComponents;
    if (!Array.isArray(changed) || changed.length === 0) {
      errors.push('promotion.changedComponents must name at least one component');
    } else {
      const unique = new Set(changed);
      if (unique.size !== changed.length) errors.push('promotion.changedComponents must be unique');
      for (const name of unique) {
        if (typeof name !== 'string' || !RELEASE_COMPONENTS.includes(name as ReleaseComponent)) {
          errors.push(`unknown changed component: ${String(name)}`);
        }
      }
      if (base === null && RELEASE_COMPONENTS.some((name) => !unique.has(name))) {
        errors.push('an initial manifest must declare every component changed');
      }
    }
  }

  if (checkObjectKeys(errors, value.health, 'health', ['backend', 'worker', 'web'])) {
    const expectedPaths = { backend: '/health', worker: '/health', web: '/version.json' } as const;
    for (const service of ['backend', 'worker', 'web'] as const) {
      const target = value.health[service];
      if (!checkObjectKeys(errors, target, `health.${service}`, ['component', 'path'])) continue;
      if (target.component !== service) errors.push(`health.${service}.component must be ${service}`);
      if (target.path !== expectedPaths[service]) {
        errors.push(`health.${service}.path must be ${expectedPaths[service]}`);
      }
    }
  }

  inspectSecretMaterial(errors, value);
  const uniqueErrors = [...new Set(errors)];
  return {
    manifest: uniqueErrors.length === 0 ? value as unknown as ReleaseManifest : null,
    errors: uniqueErrors,
  };
}

function evidenceFrom(
  raw: string,
  source: string,
  trust: ReleaseManifestTrustOptions,
): ReleaseManifestEvidence {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const { manifest, errors } = validateManifest(parsed);
    const digest = releaseManifestDigest(parsed);
    return {
      schema_version: 1,
      status: manifest ? 'valid' : 'invalid',
      digest,
      source,
      errors,
      manifest,
      authentication: authenticateManifestDigest(
        digest,
        trust.signatureRaw,
        trust.signatureSource ?? 'none',
        trust.trustedPublicKeys ?? PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS,
      ),
    };
  } catch {
    return {
      schema_version: 1,
      status: 'invalid',
      digest: `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}`,
      source,
      errors: ['manifest must be valid JSON'],
      manifest: null,
      authentication: unauthenticated('invalid', trust.signatureSource ?? 'none', [
        'a malformed manifest cannot be authenticated',
      ]),
    };
  }
}

export function readReleaseManifest(
  path?: string,
  options: ReleaseManifestTrustOptions = {},
): ReleaseManifestEvidence {
  const trustedPublicKeys = options.trustedPublicKeys ?? PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS;
  if (!path && process.env.HX_RELEASE_MANIFEST_JSON) {
    return evidenceFrom(process.env.HX_RELEASE_MANIFEST_JSON, 'HX_RELEASE_MANIFEST_JSON', {
      signatureRaw: options.signatureRaw ?? process.env.HX_RELEASE_MANIFEST_SIGNATURE_JSON,
      signatureSource: options.signatureSource
        ?? (process.env.HX_RELEASE_MANIFEST_SIGNATURE_JSON
          ? 'HX_RELEASE_MANIFEST_SIGNATURE_JSON'
          : 'none'),
      trustedPublicKeys,
    });
  }
  const resolvedPath = path
    || process.env.HX_RELEASE_MANIFEST_PATH
    || resolve(process.cwd(), 'dist/hx-release-manifest.json');
  try {
    let signatureRaw = options.signatureRaw ?? process.env.HX_RELEASE_MANIFEST_SIGNATURE_JSON;
    let signatureSource = options.signatureSource
      ?? (process.env.HX_RELEASE_MANIFEST_SIGNATURE_JSON
        ? 'HX_RELEASE_MANIFEST_SIGNATURE_JSON'
        : 'none');
    if (!signatureRaw) {
      const signaturePath = `${resolvedPath}.sig`;
      try {
        signatureRaw = readFileSync(signaturePath, 'utf8');
        signatureSource = signaturePath;
      } catch {
        // Missing detached evidence is represented explicitly below.
      }
    }
    return evidenceFrom(readFileSync(resolvedPath, 'utf8'), resolvedPath, {
      signatureRaw,
      signatureSource,
      trustedPublicKeys,
    });
  } catch {
    return {
      schema_version: 1,
      status: 'unattributed',
      digest: 'unattributed',
      source: 'none',
      errors: ['exact release manifest is unavailable'],
      manifest: null,
      authentication: unauthenticated('missing', 'none', [
        'exact release manifest is unavailable',
      ]),
    };
  }
}

export function isReleaseManifestCompatible(
  evidence: ReleaseManifestEvidence,
  runtime: RuntimeReleaseIdentity,
): boolean {
  const environment = normalizeEnvironment(runtime.environment);
  const manifest = evidence.manifest;
  if (evidence.status !== 'valid' || !manifest || !environment || !exactRevision(runtime.revision)) {
    return false;
  }
  const exactRequired = exactManifestRequired(environment);
  const artifactMatches = Boolean(
    runtime.artifactDigest
    && manifest.components[runtime.service].artifactDigest === runtime.artifactDigest,
  );
  return (
    manifest.environment === environment
    && manifest.components[runtime.service].revision === runtime.revision
    && (!exactRequired || artifactMatches)
    && (!exactRequired || isAuthenticatedReleaseManifest(evidence))
    && manifest.capabilities.customerMoneyCreation === false
    && manifest.capabilities.hardAssignment === false
    && manifest.capabilities.realSettlement === false
  );
}

export function releaseManifestForRuntime(
  evidence: ReleaseManifestEvidence,
  runtime: RuntimeReleaseIdentity,
): RuntimeReleaseManifestEvidence {
  if (evidence.status === 'unattributed') return { ...evidence, status: 'unattributed' };
  if (evidence.status === 'invalid') return { ...evidence, status: 'invalid' };
  if (isReleaseManifestCompatible(evidence, runtime)) {
    return { ...evidence, status: 'compatible', errors: [] };
  }
  return {
    ...evidence,
    status: 'invalid',
    errors: [
      ...evidence.errors,
      'manifest does not match the runtime service, revision, or environment',
    ],
  };
}

export function exactManifestRequired(environment: string): boolean {
  const normalized = normalizeEnvironment(environment);
  return normalized === 'preview' || normalized === 'staging' || normalized === 'production';
}

export const releaseManifestEvidence = readReleaseManifest();
