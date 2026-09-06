import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';

import {
  actorAttesterRequestSignaturePayload,
  actorAttesterResponseSignaturePayload,
  equalLowerHex,
  hmacSha256LowerHex,
  sha256LowerHex,
  UNIVERSAL_V1_ACTOR_ATTESTATION_BODY_LIMIT_BYTES,
  UNIVERSAL_V1_ACTOR_ATTESTATION_MAX_CLOCK_SKEW_MS,
  UNIVERSAL_V1_ACTOR_ATTESTATION_PATH,
  UniversalV1ActorAttestationTransportBodySchema,
  type UniversalV1ActorEnvironment,
} from '../auth/universal-v1-actor-attestation-contracts.js';
import {
  independentlyVerifyUniversalV1Bearer,
  type IndependentlyVerifiedUniversalV1Bearer,
} from '../auth/universal-v1-bearer-verifier.js';
import {
  resolveUniversalV1ActorReleaseBinding,
  type UniversalV1ActorReleaseBinding,
} from './UniversalV1ActorAttestationReleaseAuthority.js';
import {
  PostgresUniversalV1ActorAssertionIssuer,
  UniversalV1ActorAssertionIssuerError,
  type UniversalV1ActorAssertionIssuerPort,
  type UniversalV1VerifiedAuthenticationFacts,
} from './UniversalV1ActorAssertionIssuer.js';

const NONCE = /^[0-9a-f]{32}$/u;
const SIGNATURE = /^[0-9a-f]{64}$/u;
const TRANSPORT_SECRET_MIN_CHARACTERS = 32;
const MAX_NONCES = 10_000;
const NONCE_LIFETIME_MS = 60_000;
const MIN_BEARER_REMAINING_MS = 2_000;
const REQUESTED_ASSERTION_LIFETIME_MS = 55_000;

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export interface UniversalV1ActorAttesterServiceDependencies {
  readonly env?: Environment;
  readonly releaseBinding?: () => UniversalV1ActorReleaseBinding;
  readonly verifyBearer?: (bearer: string) => Promise<IndependentlyVerifiedUniversalV1Bearer>;
  readonly issuer?: UniversalV1ActorAssertionIssuerPort;
  readonly randomBytes?: (size: number) => Buffer;
  readonly now?: () => Date;
  readonly nonceGuard?: UniversalV1ActorAttesterNonceGuard;
}

export class UniversalV1ActorAttesterNonceGuard {
  private readonly nonces = new Map<string, number>();

  claim(nonce: string, nowMs: number): boolean {
    for (const [candidate, expiresAt] of this.nonces) {
      if (expiresAt <= nowMs) this.nonces.delete(candidate);
    }
    if (this.nonces.has(nonce) || this.nonces.size >= MAX_NONCES) return false;
    this.nonces.set(nonce, nowMs + NONCE_LIFETIME_MS);
    return true;
  }
}

function runtimeEnvironment(env: Environment): UniversalV1ActorEnvironment {
  const environment = env.HX_ENVIRONMENT?.trim().toLowerCase();
  if (environment !== 'local' && environment !== 'preview' && environment !== 'staging') {
    throw new Error('UNIVERSAL_V1_ACTOR_ATTESTER_REFUSED:PRODUCTION_OR_UNKNOWN_DENIED');
  }
  if (env.SERVICE_ROLE?.trim().toLowerCase() !== 'attester') {
    throw new Error('UNIVERSAL_V1_ACTOR_ATTESTER_REFUSED:SERVICE_ROLE_MUST_BE_ATTESTER');
  }
  return environment;
}

function transportSecret(env: Environment): string {
  const secret = env.HX_ACTOR_ATTESTER_TRANSPORT_SECRET?.trim() ?? '';
  if (secret.length < TRANSPORT_SECRET_MIN_CHARACTERS) {
    throw new Error('UNIVERSAL_V1_ACTOR_ATTESTER_REFUSED:TRANSPORT_SECRET_REQUIRED');
  }
  return secret;
}

async function readBoundedBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get('content-length');
  if (
    declaredLength &&
    (!/^\d+$/u.test(declaredLength) ||
      Number(declaredLength) > UNIVERSAL_V1_ACTOR_ATTESTATION_BODY_LIMIT_BYTES)
  ) {
    throw new Error('BODY_TOO_LARGE');
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > UNIVERSAL_V1_ACTOR_ATTESTATION_BODY_LIMIT_BYTES) {
        throw new Error('BODY_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

function originalBearer(request: Request): string {
  const authorization = request.headers.get('authorization') ?? '';
  if (!authorization.startsWith('Bearer ') || authorization.length <= 17) {
    throw new Error('BEARER_REQUIRED');
  }
  return authorization.slice(7);
}

function exactRequestTimestamp(request: Request, nowMs: number): number {
  const raw = request.headers.get('x-hx-attester-timestamp-ms') ?? '';
  if (!/^\d{13}$/u.test(raw)) throw new Error('REQUEST_TIMESTAMP_INVALID');
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    Math.abs(nowMs - value) > UNIVERSAL_V1_ACTOR_ATTESTATION_MAX_CLOCK_SKEW_MS
  ) {
    throw new Error('REQUEST_TIMESTAMP_INVALID');
  }
  return value;
}

function exactNonce(request: Request): string {
  const nonce = request.headers.get('x-hx-attester-nonce') ?? '';
  if (!NONCE.test(nonce)) throw new Error('REQUEST_NONCE_INVALID');
  return nonce;
}

function authorizeTransport(input: {
  readonly request: Request;
  readonly body: string;
  readonly bearer: string;
  readonly secret: string;
  readonly timestampMs: number;
  readonly nonce: string;
}): void {
  const provided = input.request.headers.get('x-hx-attester-signature') ?? '';
  if (!SIGNATURE.test(provided)) throw new Error('TRANSPORT_AUTHENTICATION_FAILED');
  const expected = hmacSha256LowerHex(
    input.secret,
    actorAttesterRequestSignaturePayload({
      timestampMs: input.timestampMs,
      nonce: input.nonce,
      bodySha256: sha256LowerHex(input.body),
      bearerSha256: sha256LowerHex(input.bearer),
    })
  );
  if (!equalLowerHex(provided, expected)) {
    throw new Error('TRANSPORT_AUTHENTICATION_FAILED');
  }
}

function authenticationFacts(
  verified: IndependentlyVerifiedUniversalV1Bearer,
  releaseManifestSha256: string
): UniversalV1VerifiedAuthenticationFacts {
  return {
    schema_version: 1,
    verified_subject: verified.verifiedSubject,
    issuer: verified.issuer,
    audience: verified.audience,
    release_manifest_sha256: releaseManifestSha256,
    verified_at: verified.verifiedAt.toISOString(),
    bearer_expires_at: verified.bearerExpiresAt.toISOString(),
    auth_time: verified.authenticationTime.toISOString(),
    revocation_checked_at: verified.revocationCheckedAt.toISOString(),
    amr: verified.authenticationMethods,
    mfa_verified: verified.mfaVerified,
    step_up: {
      satisfied: false,
      method: null,
      verified_at: null,
    },
  };
}

function signedJsonResponse(
  body: Record<string, unknown>,
  status: number,
  requestNonce: string,
  secret: string
): Response {
  const serialized = JSON.stringify(body);
  const signature = hmacSha256LowerHex(
    secret,
    actorAttesterResponseSignaturePayload({
      requestNonce,
      status,
      bodySha256: sha256LowerHex(serialized),
    })
  );
  return new Response(serialized, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'x-hx-attester-response-signature': signature,
    },
  });
}

export function createUniversalV1ActorAttesterApp(
  dependencies: UniversalV1ActorAttesterServiceDependencies = {}
): Hono {
  const env = dependencies.env ?? process.env;
  const environment = runtimeEnvironment(env);
  const secret = transportSecret(env);
  const releaseBinding =
    dependencies.releaseBinding ?? (() => resolveUniversalV1ActorReleaseBinding(env));
  const verifyBearer =
    dependencies.verifyBearer ??
    ((bearer: string) => independentlyVerifyUniversalV1Bearer(bearer, { env }));
  const issuer = dependencies.issuer ?? new PostgresUniversalV1ActorAssertionIssuer({ env });
  const random = dependencies.randomBytes ?? randomBytes;
  const now = dependencies.now ?? (() => new Date());
  const nonceGuard = dependencies.nonceGuard ?? new UniversalV1ActorAttesterNonceGuard();
  const app = new Hono();

  app.get('/health', async (context) => {
    try {
      const release = releaseBinding();
      if (release.environment !== environment) throw new Error('ENVIRONMENT_MISMATCH');
      const database = await issuer.readiness();
      return context.json(
        {
          schema_version: 1,
          service: 'universal-v1-actor-attester',
          status: 'ready',
          environment,
          release_manifest_sha256: release.releaseManifestSha256,
          backend_revision: release.backendRevision,
          backend_artifact_sha256: release.backendArtifactSha256,
          database_role: database.databaseRole,
          database_name: database.databaseName,
          issuer_identity: database.issuerIdentity,
          production_effects: 'NONE',
        },
        200,
        { 'cache-control': 'no-store' }
      );
    } catch {
      return context.json(
        {
          schema_version: 1,
          service: 'universal-v1-actor-attester',
          status: 'held',
          environment,
          production_effects: 'NONE',
        },
        503,
        { 'cache-control': 'no-store' }
      );
    }
  });

  app.post(UNIVERSAL_V1_ACTOR_ATTESTATION_PATH, async (context) => {
    let nonce = '0'.repeat(32);
    try {
      const request = context.req.raw;
      if (
        request.headers.get('origin') ||
        request.headers.get('referer') ||
        !request.headers.get('content-type')?.toLowerCase().startsWith('application/json')
      ) {
        throw new Error('INTERNAL_TRANSPORT_REQUIRED');
      }
      const clock = now();
      const nowMs = clock.getTime();
      if (!Number.isSafeInteger(nowMs)) throw new Error('CLOCK_INVALID');
      const timestampMs = exactRequestTimestamp(request, nowMs);
      nonce = exactNonce(request);
      const bearer = originalBearer(request);
      const body = await readBoundedBody(request);
      authorizeTransport({ request, body, bearer, secret, timestampMs, nonce });
      if (!nonceGuard.claim(nonce, nowMs)) throw new Error('REQUEST_REPLAYED');

      let decoded: unknown;
      try {
        decoded = JSON.parse(body);
      } catch {
        throw new Error('REQUEST_BODY_MALFORMED');
      }
      const parsed = UniversalV1ActorAttestationTransportBodySchema.safeParse(decoded);
      if (!parsed.success) throw new Error('REQUEST_BODY_MALFORMED');
      const release = releaseBinding();
      if (
        release.environment !== environment ||
        parsed.data.environment !== environment ||
        parsed.data.canonical_request.command_kind !== parsed.data.command_kind ||
        parsed.data.canonical_request.target_authority.environment !== environment ||
        parsed.data.canonical_request.release_manifest_sha256 !== release.releaseManifestSha256 ||
        parsed.data.canonical_request.target_authority.release !== release.releaseManifestSha256
      ) {
        throw new Error('RELEASE_OR_ENVIRONMENT_BINDING_MISMATCH');
      }

      const verified = await verifyBearer(bearer);
      if (
        nowMs - verified.authenticationTime.getTime() >
          parsed.data.canonical_request.authentication_requirements.max_auth_age_seconds * 1_000 ||
        verified.bearerExpiresAt.getTime() - nowMs < MIN_BEARER_REMAINING_MS
      ) {
        throw new Error('BEARER_NOT_CURRENT_FOR_COMMAND');
      }
      const tokenBytes = random(32);
      const opaqueToken = tokenBytes.toString('hex');
      if (
        tokenBytes.byteLength !== 32 ||
        !SIGNATURE.test(opaqueToken) ||
        opaqueToken === '0'.repeat(64)
      ) {
        throw new Error('TOKEN_ENTROPY_UNAVAILABLE');
      }
      const requestedExpiresAt = new Date(
        Math.min(nowMs + REQUESTED_ASSERTION_LIFETIME_MS, verified.bearerExpiresAt.getTime())
      );
      const issued = await issuer.issue({
        opaqueToken,
        environment,
        commandKind: parsed.data.command_kind,
        canonicalRequest: parsed.data.canonical_request,
        canonicalRequestSha256: parsed.data.canonical_request_sha256,
        authenticationFacts: authenticationFacts(verified, release.releaseManifestSha256),
        requestedExpiresAt,
      });
      if (!equalLowerHex(issued.canonicalRequestSha256, parsed.data.canonical_request_sha256)) {
        throw new UniversalV1ActorAssertionIssuerError('CANONICAL_REQUEST_SHA256_MISMATCH');
      }
      return signedJsonResponse(
        {
          schema_version: 1,
          command_kind: parsed.data.command_kind,
          canonical_request_sha256: issued.canonicalRequestSha256,
          actor_assertion_token: opaqueToken,
          assertion_expires_at: issued.expiresAt.toISOString(),
        },
        200,
        nonce,
        secret
      );
    } catch {
      // The endpoint never reflects bearer, assertion-token, database, or
      // verification details. Authentication failures and internal failures
      // are intentionally indistinguishable to the caller.
      return signedJsonResponse(
        { schema_version: 1, error: 'ACTOR_ATTESTATION_REFUSED' },
        401,
        nonce,
        secret
      );
    }
  });

  return app;
}
