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
const FORBIDDEN_VALUE =
  /(github_pat_|ghp_|sk_live_|rk_live_|whsec_|-----BEGIN [A-Z ]*PRIVATE KEY-----)/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;

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

export const RELEASE_DATABASE_TARGET_COMPONENTS = ['api', 'worker', 'attester'] as const;

export const RELEASE_ACCEPTANCE_LANES = [...RELEASE_COMPONENTS, 'infrastructure'] as const;
export const PROMOTABLE_RELEASE_MANIFEST_VERSION = 2 as const;

// Live staging predecessor/CAS authority has not yet been provisioned. This
// protected-source hold prevents a syntactically valid historical INITIAL or
// CHAINED pair from being treated as current deployment authority.
export const STAGING_PROMOTION_AUTHORITY_ENROLLED = false as boolean;

/** Runtime environments include production so an unenrolled production target fails closed. */
export type ReleaseEnvironment = 'local' | 'preview' | 'staging' | 'production';
export type ReleaseManifestEnvironment = Exclude<ReleaseEnvironment, 'production'>;
export type ReleaseService = 'backend' | 'worker' | 'web';
export type ReleaseComponent = (typeof RELEASE_COMPONENTS)[number];
export type ReleaseDatabaseTargetComponent =
  (typeof RELEASE_DATABASE_TARGET_COMPONENTS)[number];

interface RevisionComponent {
  revision: string;
  artifactDigest: string;
}

export type ReleaseImageEvidence = 'VERIFIED_IMMUTABLE_IMAGE' | 'IMAGE_UNAVAILABLE_HELD';

interface ImageComponent extends RevisionComponent {
  imageEvidence: ReleaseImageEvidence;
  imageDigest: string | null;
}

interface FixtureComposite extends RevisionComponent {
  providerImageEvidence: ReleaseImageEvidence;
  providerImageDigest: string | null;
  databaseImageEvidence: ReleaseImageEvidence;
  databaseImageDigest: string | null;
}

interface InfrastructureBinding extends RevisionComponent {
  desiredTopologyDigest: string;
}

interface ReleaseDatabaseTargetBinding<Component extends ReleaseDatabaseTargetComponent> {
  component: Component;
  environment: ReleaseManifestEnvironment;
  databaseTargetDigest: string;
}

interface LegacyHealthTarget<Service extends ReleaseService, Path extends string> {
  component: Service;
  path: Path;
}

interface HttpAcceptanceTarget<Service extends ReleaseService, Path extends string> {
  kind: 'http';
  component: Service;
  path: Path;
}

interface ReceiptAcceptanceTarget<
  Component extends 'migration' | 'policy' | 'fixtures',
  ReceiptType extends string,
> {
  kind: 'receipt';
  component: Component;
  receiptType: ReceiptType;
}

interface SharedReleaseManifest {
  $schema?: string;
  releaseId: string;
  createdAt: string;
  authority: {
    document: typeof RELEASE_CHARTER_AUTHORITY.document;
    charterVersion: typeof RELEASE_CHARTER_AUTHORITY.version;
    charterRevision: typeof RELEASE_CHARTER_AUTHORITY.revision;
    capabilityPolicyDigest: string;
  };
  capabilities: {
    financialProvider: 'fake';
    fakeFinancialEvents: true;
    customerMoneyCreation: false;
    hardAssignment: false;
    realSettlement: false;
    outboundCommunication: 'sink';
    dataClass: 'synthetic';
  };
}

/** Legacy v1 is parseable only as local diagnostic evidence and is never promotable. */
export interface LegacyLocalReleaseManifestV1 extends SharedReleaseManifest {
  version: 1;
  environment: 'local';
  components: {
    backend: ImageComponent;
    worker: ImageComponent;
    web: ImageComponent;
    migration: RevisionComponent;
    policy: RevisionComponent;
    fixtures: ImageComponent;
  };
  promotion: {
    baseManifestDigest: null;
    changedComponents: ReleaseComponent[];
  };
  health: {
    backend: LegacyHealthTarget<'backend', '/health'>;
    worker: LegacyHealthTarget<'worker', '/health'>;
    web: LegacyHealthTarget<'web', '/version.json'>;
  };
}

export interface ReleaseManifestV2 extends SharedReleaseManifest {
  version: typeof PROMOTABLE_RELEASE_MANIFEST_VERSION;
  environment: ReleaseManifestEnvironment;
  components: {
    backend: ImageComponent;
    worker: ImageComponent;
    web: ImageComponent;
    migration: RevisionComponent;
    policy: RevisionComponent;
    fixtures: FixtureComposite;
  };
  infrastructure: InfrastructureBinding;
  databaseTargets: {
    api: ReleaseDatabaseTargetBinding<'api'>;
    worker: ReleaseDatabaseTargetBinding<'worker'>;
    attester: ReleaseDatabaseTargetBinding<'attester'>;
  };
  promotion: {
    baseManifestDigest: string | null;
    changedComponents: ReleaseComponent[];
    infrastructureChanged: boolean;
  };
  acceptance: {
    backend: HttpAcceptanceTarget<'backend', '/health'>;
    worker: HttpAcceptanceTarget<'worker', '/health'>;
    web: HttpAcceptanceTarget<'web', '/version.json'>;
    migration: ReceiptAcceptanceTarget<'migration', 'migration-execution-v1'>;
    policy: ReceiptAcceptanceTarget<'policy', 'canonical-policy-digest-v1'>;
    fixtures: ReceiptAcceptanceTarget<'fixtures', 'fixture-seed-v1'>;
    infrastructure: {
      kind: 'readback';
      binding: 'infrastructure';
      receiptType: 'infrastructure-readback-v1';
    };
  };
}

export type ReleaseManifest = LegacyLocalReleaseManifestV1 | ReleaseManifestV2;

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
  signaturePath?: string;
  signatureSource?: string;
  /** Test-vector only. Runtime readers always use protected pinned keys. */
  trustedPublicKeys?: Readonly<Record<string, string>>;
}

interface AuthenticatedEvidenceBinding {
  digest: string;
  manifestVersion: 1 | 2;
  signatureRaw: string;
  signatureSource: string;
  trustedPublicKeys: Readonly<Record<string, string>>;
}

// Authentication is authority only for the exact evidence object produced by
// this module after detached-signature verification. A caller-created object
// that merely says `status: verified` must never acquire release authority.
const authenticatedEvidenceBindings = new WeakMap<object, AuthenticatedEvidenceBinding>();

export interface RuntimeReleaseManifestEvidence extends Omit<ReleaseManifestEvidence, 'status'> {
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

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(canonicalize(value));
}

export function releaseManifestDigest(manifest: unknown): string {
  const serialized = canonicalJson(manifest);
  if (serialized === undefined) throw new Error('release manifest value is not JSON serializable');
  return `sha256:${createHash('sha256').update(serialized, 'utf8').digest('hex')}`;
}

export function releaseManifestSignaturePayload(
  manifestDigest: string,
  manifestVersion: 1 | 2 = 1
): Buffer {
  if (!DIGEST.test(manifestDigest)) {
    throw new Error('release manifest signature payload requires an exact sha256 digest');
  }
  if (manifestVersion !== 1 && manifestVersion !== 2) {
    throw new Error('release manifest signature payload requires manifest version 1 or 2');
  }
  return Buffer.from(`HUSTLEXP_RELEASE_MANIFEST_V${manifestVersion}\n${manifestDigest}\n`, 'utf8');
}

function canonicalEd25519Signature(value: unknown): Buffer | null {
  if (typeof value !== 'string' || value.length === 0 || /\s/u.test(value)) return null;
  try {
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== value) return null;
    return bytes;
  } catch {
    return null;
  }
}

function pinnedPublicKeyEvidence(value: unknown) {
  if (typeof value !== 'string' || /PRIVATE KEY/u.test(value)) {
    throw new Error('pinned release trust anchor must contain only public key material');
  }
  const publicKey = createPublicKey(value);
  if (publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('pinned release trust anchor must be an Ed25519 public key');
  }
  const keyFingerprint = `sha256:${createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' }))
    .digest('hex')}`;
  return { publicKey, keyFingerprint };
}

function unauthenticated(
  status: ReleaseManifestAuthentication['status'],
  source: string,
  errors: string[],
  envelope?: Partial<ReleaseManifestSignatureEnvelope>
): ReleaseManifestAuthentication {
  return {
    status,
    algorithm: envelope?.algorithm === 'ed25519' ? 'ed25519' : null,
    keyId: typeof envelope?.keyId === 'string' ? envelope.keyId : null,
    keyFingerprint: null,
    signatureDigest: null,
    source,
    errors: [...new Set(errors)],
  };
}

function authenticateManifestDigest(
  manifestDigest: string,
  manifestVersion: 1 | 2,
  raw: unknown,
  source: string,
  trustedPublicKeys: Readonly<Record<string, string>>
): ReleaseManifestAuthentication {
  const trustedKeyEvidence = new Map<string, ReturnType<typeof pinnedPublicKeyEvidence>>();
  try {
    for (const [keyId, publicKey] of Object.entries(trustedPublicKeys)) {
      if (!KEY_ID.test(keyId)) throw new Error('pinned release key id is invalid');
      trustedKeyEvidence.set(keyId, pinnedPublicKeyEvidence(publicKey));
    }
  } catch {
    return unauthenticated('invalid', source, ['pinned release public key set is invalid']);
  }

  if (typeof raw !== 'string' || raw.trim() === '') {
    return unauthenticated('missing', source, ['detached release signature is unavailable']);
  }
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
  const allowed = ['version', 'algorithm', 'keyId', 'manifestDigest', 'signature'] as const;
  const errors: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!allowed.includes(key as (typeof allowed)[number])) {
      errors.push(`signature.${key} is not allowed`);
    }
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
  const signature = canonicalEd25519Signature(envelope.signature);
  if (!signature) {
    errors.push('signature.signature must be one canonical Ed25519 base64 signature');
  }
  if (errors.length > 0) return unauthenticated('invalid', source, errors, envelope);

  const selectedKey = trustedKeyEvidence.get(envelope.keyId!);
  if (!selectedKey) {
    return unauthenticated(
      'untrusted_key',
      source,
      [`release signing key is not pinned in protected source: ${envelope.keyId}`],
      envelope
    );
  }
  try {
    if (
      !verify(
        null,
        releaseManifestSignaturePayload(manifestDigest, manifestVersion),
        selectedKey.publicKey,
        signature!
      )
    ) {
      return unauthenticated(
        'invalid',
        source,
        ['detached release signature verification failed'],
        envelope
      );
    }
    return {
      status: 'verified',
      algorithm: 'ed25519',
      keyId: envelope.keyId!,
      keyFingerprint: selectedKey.keyFingerprint,
      signatureDigest: `sha256:${createHash('sha256').update(signature!).digest('hex')}`,
      source,
      errors: [],
    };
  } catch {
    return unauthenticated('invalid', source, ['pinned release public key is invalid'], envelope);
  }
}

export function isAuthenticatedReleaseManifest(
  evidence: ReleaseManifestEvidence,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): boolean {
  const binding = authenticatedEvidenceBindings.get(evidence);
  if (
    !binding ||
    evidence.status !== 'valid' ||
    evidence.manifest === null ||
    evidence.manifest.version !== binding.manifestVersion
  ) {
    return false;
  }
  const validated = validateManifest(evidence.manifest);
  if (!validated.manifest) return false;
  const digest = releaseManifestDigest(validated.manifest);
  if (digest !== evidence.digest || digest !== binding.digest) return false;
  const authentication = authenticateManifestDigest(
    digest,
    validated.manifest.version,
    binding.signatureRaw,
    binding.signatureSource,
    binding.trustedPublicKeys
  );
  if (validated.manifest.environment === 'staging' && !STAGING_PROMOTION_AUTHORITY_ENROLLED) {
    return false;
  }
  return (
    authentication.status === 'verified' &&
    canonicalJson(authentication) === canonicalJson(evidence.authentication) &&
    runtimePromotionErrors(validated.manifest, env).length === 0
  );
}

function exactRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION.test(value) && !ZERO_REVISION.test(value);
}

export function exactReleaseDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value) && !ZERO_DIGEST.test(value);
}

function normalizeRuntimeEnvironment(value: unknown): ReleaseEnvironment | null {
  if (typeof value !== 'string') return null;
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
  required: readonly string[] = allowed
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
    if (FORBIDDEN_VALUE.test(value)) {
      errors.push(`${path} contains forbidden live or secret material`);
    }
    return;
  }
  if (!isRecord(value) && !Array.isArray(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) errors.push(`${path}.${key} may not contain secret material`);
    inspectSecretMaterial(errors, child, `${path}.${key}`);
  }
}

function exactIsoTimestamp(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function verifyAuthority(errors: string[], authority: unknown): void {
  if (
    !checkObjectKeys(errors, authority, 'authority', [
      'document',
      'charterVersion',
      'charterRevision',
      'capabilityPolicyDigest',
    ])
  )
    return;
  if (authority.document !== RELEASE_CHARTER_AUTHORITY.document) {
    errors.push('authority.document must name the canonical Charter');
  }
  if (authority.charterVersion !== RELEASE_CHARTER_AUTHORITY.version) {
    errors.push('authority.charterVersion must be 1.1.0');
  }
  if (authority.charterRevision !== RELEASE_CHARTER_AUTHORITY.revision) {
    errors.push('authority.charterRevision must be the signed Charter authority SHA');
  }
  if (!exactReleaseDigest(authority.capabilityPolicyDigest)) {
    errors.push(
      'authority.capabilityPolicyDigest must be an immutable non-placeholder sha256 digest'
    );
  }
}

function verifyCapabilities(errors: string[], capabilities: unknown): void {
  const keys = [
    'financialProvider',
    'fakeFinancialEvents',
    'customerMoneyCreation',
    'hardAssignment',
    'realSettlement',
    'outboundCommunication',
    'dataClass',
  ];
  if (!checkObjectKeys(errors, capabilities, 'capabilities', keys)) return;
  if (capabilities.financialProvider !== 'fake') errors.push('financialProvider must be fake');
  if (capabilities.fakeFinancialEvents !== true) errors.push('fakeFinancialEvents must be true');
  if (capabilities.customerMoneyCreation !== false) {
    errors.push('customerMoneyCreation must be false');
  }
  if (capabilities.hardAssignment !== false) errors.push('hardAssignment must be false');
  if (capabilities.realSettlement !== false) errors.push('realSettlement must be false');
  if (capabilities.outboundCommunication !== 'sink') {
    errors.push('outboundCommunication must be sink');
  }
  if (capabilities.dataClass !== 'synthetic') errors.push('dataClass must be synthetic');
}

function verifyRevisionComponent(errors: string[], component: unknown, path: string): void {
  if (!checkObjectKeys(errors, component, path, ['revision', 'artifactDigest'])) return;
  if (!exactRevision(component.revision)) {
    errors.push(`${path}.revision must be an exact non-placeholder 40-character Git SHA`);
  }
  if (!exactReleaseDigest(component.artifactDigest)) {
    errors.push(`${path}.artifactDigest must be an immutable non-placeholder sha256 digest`);
  }
}

function verifyImagePair(
  errors: string[],
  evidence: unknown,
  digest: unknown,
  path: string,
  environment: unknown
): void {
  if (evidence !== 'VERIFIED_IMMUTABLE_IMAGE' && evidence !== 'IMAGE_UNAVAILABLE_HELD') {
    errors.push(`${path}Evidence must be VERIFIED_IMMUTABLE_IMAGE or IMAGE_UNAVAILABLE_HELD`);
    return;
  }
  if (evidence === 'VERIFIED_IMMUTABLE_IMAGE' && !exactReleaseDigest(digest)) {
    errors.push(`${path} verified evidence requires an immutable non-placeholder digest`);
  }
  if (evidence === 'IMAGE_UNAVAILABLE_HELD' && digest !== null) {
    errors.push(`${path} held evidence requires digest=null`);
  }
  if (environment !== 'local' && evidence === 'IMAGE_UNAVAILABLE_HELD') {
    errors.push(`${path} ${String(environment)} image must be verified and immutable`);
  }
}

function verifyImageComponent(
  errors: string[],
  component: unknown,
  path: string,
  environment: unknown
): void {
  if (
    !checkObjectKeys(errors, component, path, [
      'revision',
      'artifactDigest',
      'imageEvidence',
      'imageDigest',
    ])
  )
    return;
  if (!exactRevision(component.revision)) {
    errors.push(`${path}.revision must be an exact non-placeholder 40-character Git SHA`);
  }
  if (!exactReleaseDigest(component.artifactDigest)) {
    errors.push(`${path}.artifactDigest must be an immutable non-placeholder sha256 digest`);
  }
  verifyImagePair(
    errors,
    component.imageEvidence,
    component.imageDigest,
    `${path}.image`,
    environment
  );
}

function verifyLegacyComponents(errors: string[], components: unknown, environment: unknown): void {
  if (!checkObjectKeys(errors, components, 'components', RELEASE_COMPONENTS)) return;
  const imageComponents = new Set<ReleaseComponent>(['backend', 'worker', 'web', 'fixtures']);
  for (const name of RELEASE_COMPONENTS) {
    if (imageComponents.has(name)) {
      verifyImageComponent(errors, components[name], `components.${name}`, environment);
    } else {
      verifyRevisionComponent(errors, components[name], `components.${name}`);
    }
  }
}

function verifyV2Components(errors: string[], components: unknown, environment: unknown): void {
  if (!checkObjectKeys(errors, components, 'components', RELEASE_COMPONENTS)) return;
  const imageComponents = new Set<ReleaseComponent>(['backend', 'worker', 'web']);
  for (const name of RELEASE_COMPONENTS) {
    if (imageComponents.has(name)) {
      const component = components[name];
      verifyImageComponent(errors, component, `components.${name}`, environment);
      if (
        isRecord(component) &&
        exactReleaseDigest(component.imageDigest) &&
        component.artifactDigest === component.imageDigest
      ) {
        errors.push(`components.${name}.artifactDigest may not substitute for imageDigest`);
      }
    } else if (name !== 'fixtures') {
      verifyRevisionComponent(errors, components[name], `components.${name}`);
    }
  }

  const fixtures = components.fixtures;
  const fixtureKeys = [
    'revision',
    'artifactDigest',
    'providerImageEvidence',
    'providerImageDigest',
    'databaseImageEvidence',
    'databaseImageDigest',
  ];
  if (!checkObjectKeys(errors, fixtures, 'components.fixtures', fixtureKeys)) return;
  if (!exactRevision(fixtures.revision)) {
    errors.push(
      'components.fixtures.revision must be an exact non-placeholder 40-character Git SHA'
    );
  }
  if (!exactReleaseDigest(fixtures.artifactDigest)) {
    errors.push(
      'components.fixtures.artifactDigest must be an immutable non-placeholder sha256 digest'
    );
  }
  verifyImagePair(
    errors,
    fixtures.providerImageEvidence,
    fixtures.providerImageDigest,
    'components.fixtures.providerImage',
    environment
  );
  verifyImagePair(
    errors,
    fixtures.databaseImageEvidence,
    fixtures.databaseImageDigest,
    'components.fixtures.databaseImage',
    environment
  );
  if (
    exactReleaseDigest(fixtures.providerImageDigest) &&
    fixtures.providerImageDigest === fixtures.databaseImageDigest
  ) {
    errors.push('fixture providerImageDigest and databaseImageDigest must be distinct bindings');
  }
  for (const [label, digest] of [
    ['providerImageDigest', fixtures.providerImageDigest],
    ['databaseImageDigest', fixtures.databaseImageDigest],
  ] as const) {
    if (exactReleaseDigest(digest) && fixtures.artifactDigest === digest) {
      errors.push(`fixture artifactDigest may not substitute for ${label}`);
    }
  }
}

function verifyInfrastructure(
  errors: string[],
  infrastructure: unknown,
  components: unknown
): void {
  if (
    !checkObjectKeys(errors, infrastructure, 'infrastructure', [
      'revision',
      'artifactDigest',
      'desiredTopologyDigest',
    ])
  )
    return;
  if (!exactRevision(infrastructure.revision)) {
    errors.push('infrastructure.revision must be an exact non-placeholder 40-character Git SHA');
  }
  if (!exactReleaseDigest(infrastructure.artifactDigest)) {
    errors.push('infrastructure.artifactDigest must be an immutable non-placeholder sha256 digest');
  }
  if (!exactReleaseDigest(infrastructure.desiredTopologyDigest)) {
    errors.push(
      'infrastructure.desiredTopologyDigest must be an immutable non-placeholder sha256 digest'
    );
  }
  if (infrastructure.artifactDigest === infrastructure.desiredTopologyDigest) {
    errors.push('infrastructure artifactDigest may not substitute for desiredTopologyDigest');
  }
  if (
    isRecord(components) &&
    isRecord(components.policy) &&
    components.policy.artifactDigest === infrastructure.artifactDigest
  ) {
    errors.push('policy artifactDigest may not substitute for infrastructure artifactDigest');
  }
}

function verifyDatabaseTargets(
  errors: string[],
  databaseTargets: unknown,
  manifestEnvironment: unknown
): void {
  if (
    !checkObjectKeys(
      errors,
      databaseTargets,
      'databaseTargets',
      RELEASE_DATABASE_TARGET_COMPONENTS
    )
  )
    return;
  for (const component of RELEASE_DATABASE_TARGET_COMPONENTS) {
    const target = databaseTargets[component];
    const path = `databaseTargets.${component}`;
    if (
      !checkObjectKeys(errors, target, path, [
        'component',
        'environment',
        'databaseTargetDigest',
      ])
    )
      continue;
    if (target.component !== component) {
      errors.push(`${path}.component must be ${component}`);
    }
    if (target.environment !== manifestEnvironment) {
      errors.push(`${path}.environment must exactly match manifest.environment`);
    }
    if (!exactReleaseDigest(target.databaseTargetDigest)) {
      errors.push(
        `${path}.databaseTargetDigest must be an exact lowercase non-placeholder sha256 digest`
      );
    }
  }
}

function verifyLegacyPromotion(errors: string[], promotion: unknown): void {
  if (!checkObjectKeys(errors, promotion, 'promotion', ['baseManifestDigest', 'changedComponents']))
    return;
  if (promotion.baseManifestDigest !== null) {
    errors.push('legacy v1 local manifests are non-promotable and require baseManifestDigest=null');
  }
  if (!Array.isArray(promotion.changedComponents)) {
    errors.push('promotion.changedComponents must be an array');
    return;
  }
  const unique = new Set<unknown>(promotion.changedComponents);
  if (unique.size !== promotion.changedComponents.length) {
    errors.push('promotion.changedComponents must be unique');
  }
  for (const name of unique) {
    if (!RELEASE_COMPONENTS.includes(name as ReleaseComponent)) {
      errors.push(`unknown changed component: ${String(name)}`);
    }
  }
  if (RELEASE_COMPONENTS.some((name) => !unique.has(name))) {
    errors.push('legacy v1 local manifests must declare every component changed');
  }
}

function verifyV2Promotion(errors: string[], promotion: unknown): void {
  if (
    !checkObjectKeys(errors, promotion, 'promotion', [
      'baseManifestDigest',
      'changedComponents',
      'infrastructureChanged',
    ])
  )
    return;
  if (promotion.baseManifestDigest !== null && !exactReleaseDigest(promotion.baseManifestDigest)) {
    errors.push(
      'promotion.baseManifestDigest must be null or an exact non-placeholder sha256 digest'
    );
  }
  if (!Array.isArray(promotion.changedComponents)) {
    errors.push('promotion.changedComponents must be an array');
  } else {
    const unique = new Set<unknown>(promotion.changedComponents);
    if (unique.size !== promotion.changedComponents.length) {
      errors.push('promotion.changedComponents must be unique');
    }
    for (const name of unique) {
      if (!RELEASE_COMPONENTS.includes(name as ReleaseComponent)) {
        errors.push(`unknown changed component: ${String(name)}`);
      }
    }
    if (
      promotion.baseManifestDigest === null &&
      RELEASE_COMPONENTS.some((name) => !unique.has(name))
    ) {
      errors.push('an initial v2 manifest must declare every component changed');
    }
  }
  if (typeof promotion.infrastructureChanged !== 'boolean') {
    errors.push('promotion.infrastructureChanged must be a boolean');
  }
  if (promotion.baseManifestDigest === null && promotion.infrastructureChanged !== true) {
    errors.push('an initial v2 manifest must declare infrastructureChanged=true');
  }
  if (
    Array.isArray(promotion.changedComponents) &&
    promotion.changedComponents.length === 0 &&
    promotion.infrastructureChanged !== true
  ) {
    errors.push(
      'promotion may not be a no-op; declare at least one exact component or infrastructure change'
    );
  }
}

function verifyLegacyHealth(errors: string[], health: unknown): void {
  if (!checkObjectKeys(errors, health, 'health', ['backend', 'worker', 'web'])) return;
  const paths = { backend: '/health', worker: '/health', web: '/version.json' } as const;
  for (const service of ['backend', 'worker', 'web'] as const) {
    const target = health[service];
    if (!checkObjectKeys(errors, target, `health.${service}`, ['component', 'path'])) continue;
    if (target.component !== service) {
      errors.push(`health.${service}.component must be ${service}`);
    }
    if (target.path !== paths[service]) {
      errors.push(`health.${service}.path must be ${paths[service]}`);
    }
  }
}

function verifyV2Acceptance(errors: string[], acceptance: unknown): void {
  if (!checkObjectKeys(errors, acceptance, 'acceptance', RELEASE_ACCEPTANCE_LANES)) return;
  const http = { backend: '/health', worker: '/health', web: '/version.json' } as const;
  for (const service of ['backend', 'worker', 'web'] as const) {
    const target = acceptance[service];
    if (!checkObjectKeys(errors, target, `acceptance.${service}`, ['kind', 'component', 'path']))
      continue;
    if (target.kind !== 'http') errors.push(`acceptance.${service}.kind must be http`);
    if (target.component !== service) {
      errors.push(`acceptance.${service}.component must be ${service}`);
    }
    if (target.path !== http[service]) {
      errors.push(`acceptance.${service}.path must be ${http[service]}`);
    }
  }

  const receipts = {
    migration: 'migration-execution-v1',
    policy: 'canonical-policy-digest-v1',
    fixtures: 'fixture-seed-v1',
  } as const;
  for (const component of ['migration', 'policy', 'fixtures'] as const) {
    const target = acceptance[component];
    if (
      !checkObjectKeys(errors, target, `acceptance.${component}`, [
        'kind',
        'component',
        'receiptType',
      ])
    )
      continue;
    if (target.kind !== 'receipt') {
      errors.push(`acceptance.${component}.kind must be receipt`);
    }
    if (target.component !== component) {
      errors.push(`acceptance.${component}.component must be ${component}`);
    }
    if (target.receiptType !== receipts[component]) {
      errors.push(`acceptance.${component}.receiptType must be ${receipts[component]}`);
    }
  }

  const infrastructure = acceptance.infrastructure;
  if (
    checkObjectKeys(errors, infrastructure, 'acceptance.infrastructure', [
      'kind',
      'binding',
      'receiptType',
    ])
  ) {
    if (infrastructure.kind !== 'readback') {
      errors.push('acceptance.infrastructure.kind must be readback');
    }
    if (infrastructure.binding !== 'infrastructure') {
      errors.push('acceptance.infrastructure.binding must be infrastructure');
    }
    if (infrastructure.receiptType !== 'infrastructure-readback-v1') {
      errors.push('acceptance.infrastructure.receiptType must be infrastructure-readback-v1');
    }
  }
}

function verifySharedEnvelope(errors: string[], manifest: Record<string, unknown>): void {
  if ('$schema' in manifest && typeof manifest.$schema !== 'string') {
    errors.push('$schema must be a string when provided');
  }
  if (
    typeof manifest.environment !== 'string' ||
    !['local', 'preview', 'staging'].includes(manifest.environment)
  ) {
    errors.push('environment must be local, preview, or staging');
  }
  if (typeof manifest.releaseId !== 'string' || !RELEASE_ID.test(manifest.releaseId)) {
    errors.push('releaseId must be a stable lowercase identifier');
  }
  if (!exactIsoTimestamp(manifest.createdAt)) {
    errors.push('createdAt must be an exact UTC ISO timestamp');
  }
  verifyAuthority(errors, manifest.authority);
  verifyCapabilities(errors, manifest.capabilities);
}

function verifyLegacyV1(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const keys = [
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
  ];
  if (
    !checkObjectKeys(
      errors,
      manifest,
      'manifest',
      keys,
      keys.filter((key) => key !== '$schema')
    )
  )
    return errors;
  if (manifest.version !== 1) errors.push('legacy manifest version must be 1');
  if (manifest.environment !== 'local') {
    errors.push(
      'legacy manifest v1 is local-only and non-promotable; preview/staging require version 2'
    );
  }
  verifySharedEnvelope(errors, manifest);
  verifyLegacyComponents(errors, manifest.components, manifest.environment);
  verifyLegacyPromotion(errors, manifest.promotion);
  verifyLegacyHealth(errors, manifest.health);
  return errors;
}

function verifyV2(manifest: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const keys = [
    '$schema',
    'version',
    'environment',
    'releaseId',
    'createdAt',
    'authority',
    'components',
    'infrastructure',
    'databaseTargets',
    'capabilities',
    'promotion',
    'acceptance',
  ];
  if (
    !checkObjectKeys(
      errors,
      manifest,
      'manifest',
      keys,
      keys.filter((key) => key !== '$schema')
    )
  )
    return errors;
  if (manifest.version !== PROMOTABLE_RELEASE_MANIFEST_VERSION) {
    errors.push(`promotable manifest version must be ${PROMOTABLE_RELEASE_MANIFEST_VERSION}`);
  }
  verifySharedEnvelope(errors, manifest);
  verifyV2Components(errors, manifest.components, manifest.environment);
  verifyInfrastructure(errors, manifest.infrastructure, manifest.components);
  verifyDatabaseTargets(errors, manifest.databaseTargets, manifest.environment);
  verifyV2Promotion(errors, manifest.promotion);
  verifyV2Acceptance(errors, manifest.acceptance);
  return errors;
}

export function verifyReleaseManifest(value: unknown): string[] {
  if (!isRecord(value)) return ['manifest must be an object'];
  const errors = value.version === 1 ? verifyLegacyV1(value) : verifyV2(value);
  inspectSecretMaterial(errors, value);
  return [...new Set(errors)];
}

export function verifyReleasePromotion(candidate: unknown, previous: unknown): string[] {
  const errors = [
    ...verifyReleaseManifest(previous).map((error) => `previous: ${error}`),
    ...verifyReleaseManifest(candidate).map((error) => `candidate: ${error}`),
  ];
  if (errors.length > 0) return errors;

  const candidateManifest = candidate as ReleaseManifest;
  const previousManifest = previous as ReleaseManifest;
  if (
    candidateManifest.version !== PROMOTABLE_RELEASE_MANIFEST_VERSION ||
    previousManifest.version !== PROMOTABLE_RELEASE_MANIFEST_VERSION
  ) {
    return ['shared-staging promotion comparison requires two manifest v2 documents'];
  }
  if (candidateManifest.environment !== 'staging' || previousManifest.environment !== 'staging') {
    errors.push('shared-staging promotion comparison requires two staging manifests');
  }
  const previousDigest = releaseManifestDigest(previousManifest);
  if (candidateManifest.promotion.baseManifestDigest !== previousDigest) {
    errors.push('candidate baseManifestDigest does not match the exact previous manifest');
  }

  const actuallyChanged = RELEASE_COMPONENTS.filter(
    (name) =>
      canonicalJson(candidateManifest.components[name]) !==
      canonicalJson(previousManifest.components[name])
  );
  const declared = [...candidateManifest.promotion.changedComponents].sort();
  if (canonicalJson([...actuallyChanged].sort()) !== canonicalJson(declared)) {
    errors.push(
      `changedComponents must exactly equal changed component payloads (${actuallyChanged.join(', ') || 'none'})`
    );
  }
  const infrastructurePayloadChanged =
    canonicalJson(candidateManifest.infrastructure) !==
    canonicalJson(previousManifest.infrastructure);
  const databaseTargetsChanged =
    canonicalJson(candidateManifest.databaseTargets) !==
    canonicalJson(previousManifest.databaseTargets);
  const infrastructureChanged = infrastructurePayloadChanged || databaseTargetsChanged;
  if (candidateManifest.promotion.infrastructureChanged !== infrastructureChanged) {
    errors.push(
      `infrastructureChanged must exactly equal infrastructure or database-target payload change (${infrastructureChanged})`
    );
  }
  if (actuallyChanged.length === 0 && !infrastructureChanged) {
    errors.push('a staging promotion may not be a no-op manifest');
  }

  const candidateRecord = candidateManifest as unknown as Record<string, unknown>;
  const previousRecord = previousManifest as unknown as Record<string, unknown>;
  for (const field of [
    '$schema',
    'version',
    'environment',
    'authority',
    'capabilities',
    'acceptance',
  ]) {
    if (canonicalJson(candidateRecord[field]) !== canonicalJson(previousRecord[field])) {
      errors.push(`${field} may not change inside a component/infrastructure staging promotion`);
    }
  }
  if (candidateManifest.releaseId === previousManifest.releaseId) {
    errors.push('candidate releaseId must differ from previous releaseId');
  }
  if (Date.parse(candidateManifest.createdAt) <= Date.parse(previousManifest.createdAt)) {
    errors.push('candidate createdAt must be later than previous createdAt');
  }
  return [...new Set(errors)];
}

function validateManifest(value: unknown): { manifest: ReleaseManifest | null; errors: string[] } {
  const errors = verifyReleaseManifest(value);
  return {
    manifest: errors.length === 0 ? (value as ReleaseManifest) : null,
    errors,
  };
}

function evidenceFrom(
  raw: string,
  source: string,
  trust: ReleaseManifestTrustOptions
): ReleaseManifestEvidence {
  try {
    const parsed = JSON.parse(raw) as unknown;
    const { manifest, errors } = validateManifest(parsed);
    const digest = releaseManifestDigest(parsed);
    const signatureSource = trust.signatureSource ?? 'none';
    const trustedPublicKeys = Object.freeze({
      ...(trust.trustedPublicKeys ?? PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS),
    });
    const authentication = manifest
      ? authenticateManifestDigest(
          digest,
          manifest.version,
          trust.signatureRaw,
          signatureSource,
          trustedPublicKeys
        )
      : unauthenticated('invalid', signatureSource, [
          'an invalid release manifest cannot be authenticated',
        ]);
    const evidence = deepFreeze<ReleaseManifestEvidence>({
      schema_version: 1,
      status: manifest ? 'valid' : 'invalid',
      digest,
      source,
      errors,
      manifest,
      authentication,
    });
    if (
      manifest &&
      authentication.status === 'verified' &&
      typeof trust.signatureRaw === 'string'
    ) {
      authenticatedEvidenceBindings.set(evidence, {
        digest,
        manifestVersion: manifest.version,
        signatureRaw: trust.signatureRaw,
        signatureSource,
        trustedPublicKeys,
      });
    }
    return evidence;
  } catch {
    return deepFreeze<ReleaseManifestEvidence>({
      schema_version: 1,
      status: 'invalid',
      digest: `sha256:${createHash('sha256').update(raw, 'utf8').digest('hex')}`,
      source,
      errors: ['manifest must be valid JSON'],
      manifest: null,
      authentication: unauthenticated('invalid', trust.signatureSource ?? 'none', [
        'a malformed manifest cannot be authenticated',
      ]),
    });
  }
}

function signatureTrust(
  options: ReleaseManifestTrustOptions,
  adjacentManifestPath?: string
): ReleaseManifestTrustOptions {
  const trustedPublicKeys =
    process.env.VITEST === 'true' && options.trustedPublicKeys
      ? options.trustedPublicKeys
      : PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS;
  let signatureRaw = options.signatureRaw ?? process.env.HX_RELEASE_MANIFEST_SIGNATURE_JSON;
  let signatureSource =
    options.signatureSource ??
    (process.env.HX_RELEASE_MANIFEST_SIGNATURE_JSON
      ? 'HX_RELEASE_MANIFEST_SIGNATURE_JSON'
      : 'none');
  if (
    signatureRaw === undefined ||
    (typeof signatureRaw === 'string' && signatureRaw.trim() === '')
  ) {
    const configuredPath =
      options.signaturePath?.trim() || process.env.HX_RELEASE_MANIFEST_SIGNATURE_PATH?.trim();
    const signaturePath =
      configuredPath || (adjacentManifestPath ? `${adjacentManifestPath}.sig` : undefined);
    if (signaturePath) {
      signatureSource = options.signatureSource ?? signaturePath;
      try {
        signatureRaw = readFileSync(signaturePath, 'utf8');
      } catch {
        // Missing detached evidence is represented explicitly by authentication.
      }
    }
  }
  return { signatureRaw, signatureSource, trustedPublicKeys };
}

function runtimePromotionErrors(
  manifest: ReleaseManifest,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): string[] {
  const mode = env.HX_RELEASE_PROMOTION_MODE;
  if (manifest.environment !== 'staging') {
    if (mode !== undefined && mode !== '') {
      return ['HX_RELEASE_PROMOTION_MODE is reserved for staging release manifests'];
    }
    return [];
  }

  if (manifest.version !== PROMOTABLE_RELEASE_MANIFEST_VERSION) {
    return ['staging release promotion requires manifest version 2'];
  }
  if (manifest.promotion.baseManifestDigest === null) {
    const inlinePrevious = env.HX_PREVIOUS_RELEASE_MANIFEST_JSON?.trim();
    const pathPrevious = env.HX_PREVIOUS_RELEASE_MANIFEST_PATH?.trim();
    if (inlinePrevious || pathPrevious) {
      return [
        'initial staging manifest forbids HX_PREVIOUS_RELEASE_MANIFEST_JSON and HX_PREVIOUS_RELEASE_MANIFEST_PATH',
      ];
    }
    return mode === 'INITIAL'
      ? []
      : ['initial staging manifest requires HX_RELEASE_PROMOTION_MODE=INITIAL'];
  }
  if (mode !== 'CHAINED') {
    return ['chained staging manifest requires HX_RELEASE_PROMOTION_MODE=CHAINED'];
  }

  const inline = env.HX_PREVIOUS_RELEASE_MANIFEST_JSON?.trim();
  const configuredPath = env.HX_PREVIOUS_RELEASE_MANIFEST_PATH?.trim();
  if (!inline && !configuredPath) {
    return [
      'chained staging manifest requires HX_PREVIOUS_RELEASE_MANIFEST_JSON or HX_PREVIOUS_RELEASE_MANIFEST_PATH',
    ];
  }

  let raw: string;
  try {
    raw = inline || readFileSync(configuredPath!, 'utf8');
  } catch {
    return ['exact previous release manifest is unavailable'];
  }

  let previous: unknown;
  try {
    previous = JSON.parse(raw);
  } catch {
    return ['previous release manifest must be valid JSON'];
  }
  return verifyReleasePromotion(manifest, previous);
}

function enforceRuntimePromotion(evidence: ReleaseManifestEvidence): ReleaseManifestEvidence {
  if (evidence.status !== 'valid' || !evidence.manifest) return evidence;
  const errors = runtimePromotionErrors(evidence.manifest);
  if (errors.length === 0) return evidence;
  return {
    ...evidence,
    status: 'invalid',
    errors: [...new Set([...evidence.errors, ...errors])],
  };
}

export function readReleaseManifest(
  path?: string,
  options: ReleaseManifestTrustOptions = {}
): ReleaseManifestEvidence {
  if (!path && process.env.HX_RELEASE_MANIFEST_JSON) {
    return enforceRuntimePromotion(
      evidenceFrom(
        process.env.HX_RELEASE_MANIFEST_JSON,
        'HX_RELEASE_MANIFEST_JSON',
        signatureTrust(options)
      )
    );
  }
  const resolvedPath =
    path ||
    process.env.HX_RELEASE_MANIFEST_PATH ||
    resolve(process.cwd(), 'dist/hx-release-manifest.json');
  try {
    return enforceRuntimePromotion(
      evidenceFrom(
        readFileSync(resolvedPath, 'utf8'),
        resolvedPath,
        signatureTrust(options, resolvedPath)
      )
    );
  } catch {
    return {
      schema_version: 1,
      status: 'unattributed',
      digest: 'unattributed',
      source: 'none',
      errors: ['exact release manifest is unavailable'],
      manifest: null,
      authentication: unauthenticated('missing', 'none', ['exact release manifest is unavailable']),
    };
  }
}

export function isReleaseManifestCompatible(
  evidence: ReleaseManifestEvidence,
  runtime: RuntimeReleaseIdentity
): boolean {
  if (
    !isRecord(runtime) ||
    typeof runtime.service !== 'string' ||
    !['backend', 'worker', 'web'].includes(runtime.service)
  ) {
    return false;
  }
  const environment = normalizeRuntimeEnvironment(runtime.environment);
  const manifest = evidence.manifest;
  if (
    evidence.status !== 'valid' ||
    !manifest ||
    !environment ||
    !exactRevision(runtime.revision)
  ) {
    return false;
  }
  if (
    manifest.environment !== environment ||
    manifest.components[runtime.service].revision !== runtime.revision ||
    manifest.capabilities.customerMoneyCreation !== false ||
    manifest.capabilities.hardAssignment !== false ||
    manifest.capabilities.realSettlement !== false
  ) {
    return false;
  }

  if (runtimePromotionErrors(manifest).length > 0) return false;

  if (manifest.version === 1) {
    return environment === 'local';
  }

  if (
    !exactReleaseDigest(runtime.artifactDigest) ||
    manifest.components[runtime.service].artifactDigest !== runtime.artifactDigest
  ) {
    return false;
  }
  const nonlocal = environment !== 'local';
  return !nonlocal || isAuthenticatedReleaseManifest(evidence);
}

export function releaseManifestForRuntime(
  evidence: ReleaseManifestEvidence,
  runtime: RuntimeReleaseIdentity
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
      'manifest does not match the runtime service revision, artifact, version, or environment',
    ],
  };
}

export function exactManifestRequired(environment: string): boolean {
  const normalized = normalizeRuntimeEnvironment(environment);
  return normalized === 'preview' || normalized === 'staging' || normalized === 'production';
}

export const releaseManifestEvidence = readReleaseManifest();
