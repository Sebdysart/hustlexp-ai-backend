import type { UniversalV1ActorEnvironment } from '../auth/universal-v1-actor-attestation-contracts.js';
import { buildIdentity, isTrustedBuildIdentity, type BuildIdentity } from '../buildIdentity.js';
import {
  isAuthenticatedReleaseManifest,
  readReleaseManifest,
  type ReleaseManifestEvidence,
} from '../releaseManifest.js';

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export class UniversalV1ActorReleaseAuthorityError extends Error {
  constructor(readonly code: string) {
    super(`UNIVERSAL_V1_ACTOR_ATTESTATION_REFUSED:${code}`);
    this.name = 'UniversalV1ActorReleaseAuthorityError';
  }
}

export interface UniversalV1ActorReleaseBinding {
  readonly environment: UniversalV1ActorEnvironment;
  readonly releaseManifestSha256: string;
  readonly backendRevision: string;
  readonly backendArtifactSha256: string;
}

function environmentValue(env: Environment): UniversalV1ActorEnvironment | null {
  const value = env.HX_ENVIRONMENT?.trim().toLowerCase();
  return value === 'local' || value === 'preview' || value === 'staging' ? value : null;
}

export function resolveUniversalV1ActorReleaseBinding(
  env: Environment = process.env,
  evidence: ReleaseManifestEvidence = readReleaseManifest(),
  identity: BuildIdentity = buildIdentity
): UniversalV1ActorReleaseBinding {
  const environment = environmentValue(env);
  if (!environment) {
    throw new UniversalV1ActorReleaseAuthorityError('ENVIRONMENT_NOT_ISOLATED_NONPRODUCTION');
  }
  if (
    env.HX_PAYMENT_CREATION_MODE !== 'frozen' ||
    env.STRIPE_MODE !== 'test' ||
    env.ENGINE_API_MODE !== 'test' ||
    env.HX_EXTERNAL_VALUE === 'true'
  ) {
    throw new UniversalV1ActorReleaseAuthorityError('NONPRODUCTION_FREEZE_NOT_PROVEN');
  }
  const manifest = evidence.manifest;
  const backend = manifest?.components.backend;
  if (
    evidence.status !== 'valid' ||
    !manifest ||
    !backend ||
    !/^sha256:[0-9a-f]{64}$/u.test(evidence.digest) ||
    manifest.environment !== environment ||
    manifest.capabilities.financialProvider !== 'fake' ||
    manifest.capabilities.customerMoneyCreation !== false ||
    manifest.capabilities.hardAssignment !== false ||
    manifest.capabilities.realSettlement !== false ||
    manifest.capabilities.dataClass !== 'synthetic' ||
    !isTrustedBuildIdentity(identity) ||
    identity.revision !== backend.revision ||
    identity.artifact_digest !== backend.artifactDigest
  ) {
    throw new UniversalV1ActorReleaseAuthorityError('EXACT_RELEASE_MANIFEST_REQUIRED');
  }
  if (environment !== 'local' && !isAuthenticatedReleaseManifest(evidence)) {
    throw new UniversalV1ActorReleaseAuthorityError('SIGNED_RELEASE_MANIFEST_REQUIRED');
  }
  return {
    environment,
    releaseManifestSha256: evidence.digest,
    backendRevision: backend.revision,
    backendArtifactSha256: backend.artifactDigest,
  };
}
