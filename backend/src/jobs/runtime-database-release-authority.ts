import { createHash, createPublicKey } from 'node:crypto';

import { buildIdentity, isTrustedBuildIdentity, type BuildIdentity } from '../buildIdentity.js';
import { PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS } from '../releaseAuthorityKeys.js';
import {
  exactReleaseDigest,
  isAuthenticatedReleaseManifest,
  releaseManifestDigest,
  type ReleaseManifestEvidence,
  type ReleaseManifestV2,
} from '../releaseManifest.js';
import {
  RUNTIME_DATABASE_AUTHORITY_COMPONENTS,
  runtimeDatabaseBuildProofDigest,
  type RuntimeDatabaseAuthorityComponent,
  type RuntimeDatabaseAuthorityEnvironment,
  type RuntimeDatabaseCanonicalReleaseProof,
  type RuntimeDatabaseReleaseAuthorityVerifier,
  type RuntimeDatabaseReleasePins,
  type RuntimeDatabaseReleaseVerificationRequest,
} from './runtime-database-authority.js';

const REVISION = /^[0-9a-f]{40}$/u;
const ZERO_REVISION = /^0{40}$/u;
const KEY_ID = /^[a-z0-9][a-z0-9._-]{2,127}$/u;
const BUILD_IDENTITY_KEYS = [
  'schema_version',
  'service',
  'revision',
  'built_at',
  'environment',
  'clean_source',
  'source',
  'artifact_digest',
  'artifact_verified',
] as const satisfies readonly (keyof BuildIdentity)[];
const VERIFICATION_REQUEST_KEYS = [
  'component',
  'releaseComponent',
  'environment',
  'databaseTargetDigest',
  'pins',
] as const satisfies readonly (keyof RuntimeDatabaseReleaseVerificationRequest)[];
const RELEASE_PIN_KEYS = [
  'manifestDigest',
  'signerKeyId',
  'signerKeyFingerprint',
  'revision',
  'artifactDigest',
] as const satisfies readonly (keyof RuntimeDatabaseReleasePins)[];

type RuntimeDatabaseReleaseComponent = RuntimeDatabaseCanonicalReleaseProof['component'];

const RELEASE_COMPONENT_BY_DATABASE_COMPONENT: Readonly<
  Record<RuntimeDatabaseAuthorityComponent, RuntimeDatabaseReleaseComponent>
> = Object.freeze({ api: 'backend', worker: 'worker', attester: 'backend' });

export type RuntimeDatabaseReleaseAuthorityFailureCode =
  | 'AUTHENTICATED_V2_RELEASE_MANIFEST_REQUIRED'
  | 'BUILD_IDENTITY_INVALID'
  | 'BUILD_IDENTITY_MISMATCH'
  | 'COMPONENT_INVALID'
  | 'DATABASE_TARGET_BINDING_INVALID'
  | 'EVIDENCE_DRIFT'
  | 'SIGNING_AUTHORITY_INVALID'
  | 'TEST_VECTOR_DEPENDENCY_FORBIDDEN'
  | 'VERIFICATION_REQUEST_INVALID'
  | 'VERIFICATION_REQUEST_MISMATCH';

export class RuntimeDatabaseReleaseAuthorityError extends Error {
  constructor(readonly code: RuntimeDatabaseReleaseAuthorityFailureCode) {
    super(`RUNTIME_DATABASE_RELEASE_AUTHORITY_REFUSED:${code}`);
    this.name = 'RuntimeDatabaseReleaseAuthorityError';
  }
}

declare const RUNTIME_DATABASE_RELEASE_AUTHORITY_BRAND: unique symbol;

/**
 * One inseparable, authenticated release-authority composition. Production
 * integration obtains release pins and its verifier from this same object; it
 * never accepts either as an independent caller-authored authority claim.
 */
export interface RuntimeDatabaseReleaseAuthorityComposition {
  readonly [RUNTIME_DATABASE_RELEASE_AUTHORITY_BRAND]: true;
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly releaseComponent: RuntimeDatabaseReleaseComponent;
  readonly environment: RuntimeDatabaseAuthorityEnvironment;
  readonly databaseTargetDigest: string;
  readonly releasePins: Readonly<RuntimeDatabaseReleasePins>;
  readonly verifier: Readonly<RuntimeDatabaseReleaseAuthorityVerifier>;
}

interface ReleaseAuthorityBinding {
  readonly evidence: ReleaseManifestEvidence;
  readonly manifest: ReleaseManifestV2;
  readonly identity: Readonly<BuildIdentity>;
  readonly processOwnedIdentity: boolean;
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly releaseComponent: RuntimeDatabaseReleaseComponent;
  readonly environment: RuntimeDatabaseAuthorityEnvironment;
  readonly databaseTargetDigest: string;
  readonly manifestDigest: string;
  readonly signerKeyId: string;
  readonly signerKeyFingerprint: string;
  readonly signatureDigest: string;
  readonly revision: string;
  readonly artifactDigest: string;
  readonly releasePins: Readonly<RuntimeDatabaseReleasePins>;
}

function refuse(code: RuntimeDatabaseReleaseAuthorityFailureCode): never {
  throw new RuntimeDatabaseReleaseAuthorityError(code);
}

function exactOwnKeys(value: unknown, expected: readonly string[]): value is object {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  let keys: readonly PropertyKey[];
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    return false;
  }
  if (keys.length !== expected.length || keys.some((key) => typeof key !== 'string')) return false;
  const strings = keys as readonly string[];
  return expected.every((key) => strings.includes(key));
}

function exactRevision(value: unknown): value is string {
  return typeof value === 'string' && REVISION.test(value) && !ZERO_REVISION.test(value);
}

function exactComponent(value: unknown): value is RuntimeDatabaseAuthorityComponent {
  return (
    typeof value === 'string' &&
    RUNTIME_DATABASE_AUTHORITY_COMPONENTS.includes(value as RuntimeDatabaseAuthorityComponent)
  );
}

function protectedSigningKeyFingerprint(keyId: string): string | null {
  const publicKeyPem = PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS[keyId];
  if (typeof publicKeyPem !== 'string' || /PRIVATE KEY/u.test(publicKeyPem)) return null;
  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== 'ed25519') return null;
    return `sha256:${createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')}`;
  } catch {
    return null;
  }
}

function assertBuildIdentity(
  identity: Readonly<BuildIdentity>,
  environment: RuntimeDatabaseAuthorityEnvironment,
  revision: string,
  artifactDigest: string
): void {
  if (
    !exactOwnKeys(identity, BUILD_IDENTITY_KEYS) ||
    identity.schema_version !== 1 ||
    identity.service !== 'hustlexp-engine' ||
    !exactRevision(identity.revision) ||
    typeof identity.built_at !== 'string' ||
    Number.isNaN(Date.parse(identity.built_at)) ||
    typeof identity.environment !== 'string' ||
    typeof identity.clean_source !== 'boolean' ||
    typeof identity.source !== 'string' ||
    identity.source.length === 0 ||
    typeof identity.artifact_digest !== 'string' ||
    typeof identity.artifact_verified !== 'boolean' ||
    !isTrustedBuildIdentity(identity as BuildIdentity)
  ) {
    return refuse('BUILD_IDENTITY_INVALID');
  }
  if (
    identity.environment !== environment ||
    identity.revision !== revision ||
    identity.artifact_digest !== artifactDigest
  ) {
    return refuse('BUILD_IDENTITY_MISMATCH');
  }
}

function assertEvidenceStillBound(binding: ReleaseAuthorityBinding): void {
  let authenticated = false;
  try {
    authenticated = isAuthenticatedReleaseManifest(binding.evidence);
  } catch {
    return refuse('EVIDENCE_DRIFT');
  }
  if (
    !authenticated ||
    binding.evidence.manifest !== binding.manifest ||
    binding.evidence.digest !== binding.manifestDigest ||
    releaseManifestDigest(binding.manifest) !== binding.manifestDigest
  ) {
    return refuse('EVIDENCE_DRIFT');
  }
  const authentication = binding.evidence.authentication;
  if (
    authentication.status !== 'verified' ||
    authentication.algorithm !== 'ed25519' ||
    authentication.keyId !== binding.signerKeyId ||
    authentication.keyFingerprint !== binding.signerKeyFingerprint ||
    authentication.signatureDigest !== binding.signatureDigest
  ) {
    return refuse('EVIDENCE_DRIFT');
  }
  if (binding.processOwnedIdentity && binding.identity !== buildIdentity) {
    return refuse('BUILD_IDENTITY_INVALID');
  }
  assertBuildIdentity(
    binding.identity,
    binding.environment,
    binding.revision,
    binding.artifactDigest
  );
  const executable = binding.manifest.components[binding.releaseComponent];
  const target = binding.manifest.databaseTargets[binding.component];
  if (
    binding.manifest.environment !== binding.environment ||
    executable.revision !== binding.revision ||
    executable.artifactDigest !== binding.artifactDigest ||
    target.component !== binding.component ||
    target.environment !== binding.environment ||
    target.databaseTargetDigest !== binding.databaseTargetDigest
  ) {
    return refuse('EVIDENCE_DRIFT');
  }
}

function copyVerificationRequest(request: RuntimeDatabaseReleaseVerificationRequest): {
  readonly component: RuntimeDatabaseAuthorityComponent;
  readonly releaseComponent: RuntimeDatabaseReleaseComponent;
  readonly environment: RuntimeDatabaseAuthorityEnvironment;
  readonly databaseTargetDigest: string;
  readonly pins: Readonly<RuntimeDatabaseReleasePins>;
} {
  if (!exactOwnKeys(request, VERIFICATION_REQUEST_KEYS)) {
    return refuse('VERIFICATION_REQUEST_INVALID');
  }
  const component = request.component;
  const releaseComponent = request.releaseComponent;
  const environment = request.environment;
  const databaseTargetDigest = request.databaseTargetDigest;
  const pinsInput = request.pins;
  if (!exactOwnKeys(pinsInput, RELEASE_PIN_KEYS)) {
    return refuse('VERIFICATION_REQUEST_INVALID');
  }
  const pins = Object.freeze({
    manifestDigest: pinsInput.manifestDigest,
    signerKeyId: pinsInput.signerKeyId,
    signerKeyFingerprint: pinsInput.signerKeyFingerprint,
    revision: pinsInput.revision,
    artifactDigest: pinsInput.artifactDigest,
  });
  if (
    !exactComponent(component) ||
    (releaseComponent !== 'backend' && releaseComponent !== 'worker') ||
    (environment !== 'local' &&
      environment !== 'preview' &&
      environment !== 'staging' &&
      environment !== 'production') ||
    !exactReleaseDigest(databaseTargetDigest) ||
    !exactReleaseDigest(pins.manifestDigest) ||
    typeof pins.signerKeyId !== 'string' ||
    !KEY_ID.test(pins.signerKeyId) ||
    !exactReleaseDigest(pins.signerKeyFingerprint) ||
    !exactRevision(pins.revision) ||
    !exactReleaseDigest(pins.artifactDigest)
  ) {
    return refuse('VERIFICATION_REQUEST_INVALID');
  }
  return { component, releaseComponent, environment, databaseTargetDigest, pins };
}

function canonicalProof(binding: ReleaseAuthorityBinding): RuntimeDatabaseCanonicalReleaseProof {
  assertEvidenceStillBound(binding);
  const buildFields = Object.freeze({
    releaseManifestDigest: binding.manifestDigest,
    environment: binding.environment,
    component: binding.releaseComponent,
    revision: binding.revision,
    artifactDigest: binding.artifactDigest,
    databaseTargetDigest: binding.databaseTargetDigest,
  });
  const build = Object.freeze({
    identityDigest: runtimeDatabaseBuildProofDigest(buildFields),
    ...buildFields,
  });
  return Object.freeze({
    schemaVersion: 1,
    signatureAlgorithm: 'ed25519',
    canonicalManifestDigest: releaseManifestDigest(binding.manifest),
    manifestDigest: binding.manifestDigest,
    signerKeyId: binding.signerKeyId,
    signerKeyFingerprint: binding.signerKeyFingerprint,
    environment: binding.environment,
    component: binding.releaseComponent,
    revision: binding.revision,
    artifactDigest: binding.artifactDigest,
    databaseTargetDigest: binding.databaseTargetDigest,
    build,
  });
}

function samePins(
  left: Readonly<RuntimeDatabaseReleasePins>,
  right: Readonly<RuntimeDatabaseReleasePins>
): boolean {
  return RELEASE_PIN_KEYS.every((key) => left[key] === right[key]);
}

function composeKernel(
  evidence: ReleaseManifestEvidence,
  componentInput: RuntimeDatabaseAuthorityComponent,
  identity: Readonly<BuildIdentity>,
  processOwnedIdentity: boolean
): RuntimeDatabaseReleaseAuthorityComposition {
  const component = componentInput;
  if (!exactComponent(component)) return refuse('COMPONENT_INVALID');
  let authenticated = false;
  try {
    authenticated = isAuthenticatedReleaseManifest(evidence);
  } catch {
    return refuse('AUTHENTICATED_V2_RELEASE_MANIFEST_REQUIRED');
  }
  const manifest = evidence?.manifest;
  if (!authenticated || !manifest || manifest.version !== 2) {
    return refuse('AUTHENTICATED_V2_RELEASE_MANIFEST_REQUIRED');
  }
  if (
    !Object.isFrozen(evidence) ||
    !Object.isFrozen(manifest) ||
    evidence.status !== 'valid' ||
    !exactReleaseDigest(evidence.digest)
  ) {
    return refuse('AUTHENTICATED_V2_RELEASE_MANIFEST_REQUIRED');
  }
  const releaseComponent = RELEASE_COMPONENT_BY_DATABASE_COMPONENT[component];
  const environment = manifest.environment;
  const executable = manifest.components[releaseComponent];
  const target = manifest.databaseTargets[component];
  if (
    target.component !== component ||
    target.environment !== environment ||
    !exactReleaseDigest(target.databaseTargetDigest)
  ) {
    return refuse('DATABASE_TARGET_BINDING_INVALID');
  }
  const authentication = evidence.authentication;
  if (
    authentication.status !== 'verified' ||
    authentication.algorithm !== 'ed25519' ||
    typeof authentication.keyId !== 'string' ||
    !KEY_ID.test(authentication.keyId) ||
    !exactReleaseDigest(authentication.keyFingerprint) ||
    !exactReleaseDigest(authentication.signatureDigest)
  ) {
    return refuse('SIGNING_AUTHORITY_INVALID');
  }
  if (
    processOwnedIdentity &&
    protectedSigningKeyFingerprint(authentication.keyId) !== authentication.keyFingerprint
  ) {
    return refuse('SIGNING_AUTHORITY_INVALID');
  }
  if (processOwnedIdentity && identity !== buildIdentity) {
    return refuse('BUILD_IDENTITY_INVALID');
  }
  assertBuildIdentity(identity, environment, executable.revision, executable.artifactDigest);
  const manifestDigest = releaseManifestDigest(manifest);
  if (manifestDigest !== evidence.digest) {
    return refuse('EVIDENCE_DRIFT');
  }
  const releasePins = Object.freeze({
    manifestDigest,
    signerKeyId: authentication.keyId,
    signerKeyFingerprint: authentication.keyFingerprint,
    revision: executable.revision,
    artifactDigest: executable.artifactDigest,
  });
  const binding: ReleaseAuthorityBinding = Object.freeze({
    evidence,
    manifest,
    identity,
    processOwnedIdentity,
    component,
    releaseComponent,
    environment,
    databaseTargetDigest: target.databaseTargetDigest,
    manifestDigest,
    signerKeyId: authentication.keyId,
    signerKeyFingerprint: authentication.keyFingerprint,
    signatureDigest: authentication.signatureDigest,
    revision: executable.revision,
    artifactDigest: executable.artifactDigest,
    releasePins,
  });
  const verifyReleaseAuthority = Object.freeze(
    async (
      request: Readonly<RuntimeDatabaseReleaseVerificationRequest>
    ): Promise<RuntimeDatabaseCanonicalReleaseProof> => {
      const supplied = copyVerificationRequest(request);
      assertEvidenceStillBound(binding);
      if (
        supplied.component !== binding.component ||
        supplied.releaseComponent !== binding.releaseComponent ||
        supplied.environment !== binding.environment ||
        supplied.databaseTargetDigest !== binding.databaseTargetDigest ||
        !samePins(supplied.pins, binding.releasePins)
      ) {
        return refuse('VERIFICATION_REQUEST_MISMATCH');
      }
      return canonicalProof(binding);
    }
  );
  const verifier = Object.freeze({ verifyReleaseAuthority });
  return Object.freeze({
    component,
    releaseComponent,
    environment,
    databaseTargetDigest: binding.databaseTargetDigest,
    releasePins,
    verifier,
  }) as RuntimeDatabaseReleaseAuthorityComposition;
}

/** Canonical production-quality composition using only process-owned evidence. */
export function composeRuntimeDatabaseReleaseAuthority(
  evidence: ReleaseManifestEvidence,
  component: RuntimeDatabaseAuthorityComponent
): RuntimeDatabaseReleaseAuthorityComposition {
  return composeKernel(evidence, component, buildIdentity, true);
}

/**
 * Focused test-vector seam. It is unavailable to normal application/runtime
 * processes and still requires an authenticated module-issued manifest.
 */
export function composeRuntimeDatabaseReleaseAuthorityKernelForTest(
  evidence: ReleaseManifestEvidence,
  component: RuntimeDatabaseAuthorityComponent,
  identity: Readonly<BuildIdentity>
): RuntimeDatabaseReleaseAuthorityComposition {
  if (
    process.env.NODE_ENV !== 'test' ||
    process.env.VITEST !== 'true' ||
    !Object.isFrozen(identity)
  ) {
    return refuse('TEST_VECTOR_DEPENDENCY_FORBIDDEN');
  }
  return composeKernel(evidence, component, identity, false);
}
