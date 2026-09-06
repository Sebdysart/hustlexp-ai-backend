import { firebaseAuth } from './firebase.js';
import {
  DEPLOYED_SYNTHETIC_OPERATOR_TOKEN_AUDIENCE,
  DEPLOYED_SYNTHETIC_OPERATOR_TOKEN_ISSUER,
  verifyDeployedSyntheticOperatorToken,
} from './deployed-synthetic-operator-token.js';
import {
  LOCAL_CERTIFICATION_TOKEN_AUDIENCE,
  LOCAL_CERTIFICATION_TOKEN_ISSUER,
  verifyLocalCertificationToken,
} from './local-certification-token.js';
import { identityAssuranceFromVerifiedToken } from './operator-identity-assurance.js';
import { redis } from '../cache/redis.js';

const MAX_BEARER_CHARACTERS = 5_000;
const SUBJECT = /^[A-Za-z0-9:_-]{1,128}$/u;
const AUTHENTICATION_METHOD = /^[a-z0-9:_-]{1,64}$/u;

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

export type UniversalV1BearerVerificationRefusalCode =
  | 'BEARER_MALFORMED'
  | 'BEARER_INVALID'
  | 'BEARER_EXPIRED'
  | 'BEARER_IDENTITY_INVALID'
  | 'BEARER_REVOKED'
  | 'REVOCATION_AUTHORITY_UNAVAILABLE';

export class UniversalV1BearerVerificationError extends Error {
  constructor(readonly code: UniversalV1BearerVerificationRefusalCode) {
    super(`UNIVERSAL_V1_BEARER_REFUSED:${code}`);
    this.name = 'UniversalV1BearerVerificationError';
  }
}

export interface IndependentlyVerifiedUniversalV1Bearer {
  readonly verifiedSubject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly authenticationTime: Date;
  readonly bearerExpiresAt: Date;
  readonly verifiedAt: Date;
  readonly revocationCheckedAt: Date;
  readonly authenticationMethods: readonly string[];
  readonly mfaVerified: boolean;
}

interface TokenClaims extends Record<string, unknown> {
  uid?: unknown;
  sub?: unknown;
  iss?: unknown;
  aud?: unknown;
  auth_time?: unknown;
  iat?: unknown;
  exp?: unknown;
  amr?: unknown;
  firebase?: unknown;
}

export interface UniversalV1BearerVerifierDependencies {
  readonly env?: Environment;
  readonly now?: () => Date;
  readonly verifyFirebase?: (bearer: string) => Promise<TokenClaims>;
  readonly readRevocationMarker?: (verifiedSubject: string) => Promise<string | null>;
}

function safeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function exactString(value: unknown): string | null {
  return typeof value === 'string' && value === value.trim() && value.length > 0 ? value : null;
}

function verifiedJwtPayload(bearer: string): TokenClaims | null {
  const encodedPayload = bearer.split('.')[1];
  if (!encodedPayload) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as TokenClaims)
      : null;
  } catch {
    return null;
  }
}

function firebaseAudience(env: Environment): string | null {
  const projectId = env.FIREBASE_PROJECT_ID?.trim() ?? '';
  return projectId.length > 0 ? projectId : null;
}

function normalizeAuthenticationMethods(claims: TokenClaims): readonly string[] {
  const assurance = identityAssuranceFromVerifiedToken(claims);
  const methods = new Set<string>();
  if (Array.isArray(claims.amr)) {
    for (const candidate of claims.amr) {
      if (typeof candidate !== 'string') continue;
      const normalized = candidate.trim().toLowerCase();
      if (AUTHENTICATION_METHOD.test(normalized)) methods.add(normalized);
    }
  }
  const provider = assurance.signInProvider
    ?.trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]/gu, '_');
  if (provider && AUTHENTICATION_METHOD.test(provider)) methods.add(provider);
  if (methods.size === 0) methods.add('firebase');
  if (assurance.mfaVerified) methods.add('mfa');
  return [...methods].sort().slice(0, 8);
}

function firebaseIdentity(claims: TokenClaims, env: Environment): TokenClaims | null {
  const expectedAudience = firebaseAudience(env);
  const subject = exactString(claims.uid);
  const claimSubject = exactString(claims.sub);
  const issuer = exactString(claims.iss);
  const audience = exactString(claims.aud);
  if (
    !expectedAudience ||
    !subject ||
    claimSubject !== subject ||
    issuer !== `https://securetoken.google.com/${expectedAudience}` ||
    audience !== expectedAudience
  ) {
    return null;
  }
  return claims;
}

/**
 * Re-verifies the original bearer in the isolated attester. No API cache fact
 * is accepted as identity authority. Revocation-marker reads fail closed and
 * Firebase verification always requests provider revocation checking.
 */
export async function independentlyVerifyUniversalV1Bearer(
  bearer: string,
  dependencies: UniversalV1BearerVerifierDependencies = {}
): Promise<IndependentlyVerifiedUniversalV1Bearer> {
  if (
    typeof bearer !== 'string' ||
    bearer.length < 10 ||
    bearer.length > MAX_BEARER_CHARACTERS ||
    bearer !== bearer.trim()
  ) {
    throw new UniversalV1BearerVerificationError('BEARER_MALFORMED');
  }

  const env = dependencies.env ?? process.env;
  const verifiedAt = (dependencies.now ?? (() => new Date()))();
  if (!Number.isFinite(verifiedAt.getTime())) {
    throw new UniversalV1BearerVerificationError('BEARER_INVALID');
  }
  const nowSeconds = Math.floor(verifiedAt.getTime() / 1_000);

  const deployed = verifyDeployedSyntheticOperatorToken(bearer, env, nowSeconds);
  const local = deployed ? null : verifyLocalCertificationToken(bearer, env, nowSeconds);
  let claims: TokenClaims;
  if (deployed) {
    claims = {
      uid: deployed.uid,
      sub: deployed.uid,
      auth_time: deployed.auth_time,
      exp: deployed.exp,
      amr: deployed.amr,
      firebase: deployed.firebase,
      iss: DEPLOYED_SYNTHETIC_OPERATOR_TOKEN_ISSUER,
      aud: DEPLOYED_SYNTHETIC_OPERATOR_TOKEN_AUDIENCE,
    };
  } else if (local) {
    const payload = verifiedJwtPayload(bearer);
    const issuedAt = safeInteger(payload?.iat);
    if (issuedAt === null) {
      throw new UniversalV1BearerVerificationError('BEARER_IDENTITY_INVALID');
    }
    claims = {
      uid: local.uid,
      sub: local.uid,
      iat: issuedAt,
      auth_time: issuedAt,
      exp: local.exp,
      amr: ['synthetic_hmac'],
      iss: LOCAL_CERTIFICATION_TOKEN_ISSUER,
      aud: LOCAL_CERTIFICATION_TOKEN_AUDIENCE,
    };
  } else {
    try {
      const verifyFirebase =
        dependencies.verifyFirebase ??
        ((candidate: string) =>
          firebaseAuth.verifyIdToken(candidate, true) as Promise<TokenClaims>);
      const verifiedFirebase = await verifyFirebase(bearer);
      const exactFirebase = firebaseIdentity(verifiedFirebase, env);
      if (!exactFirebase) {
        throw new UniversalV1BearerVerificationError('BEARER_IDENTITY_INVALID');
      }
      claims = exactFirebase;
    } catch (error) {
      if (error instanceof UniversalV1BearerVerificationError) throw error;
      throw new UniversalV1BearerVerificationError('BEARER_INVALID');
    }
  }

  const subject = exactString(claims.uid);
  const issuer = exactString(claims.iss);
  const audience = exactString(claims.aud);
  const authenticationTimeSeconds = safeInteger(claims.auth_time) ?? safeInteger(claims.iat);
  const expiresAtSeconds = safeInteger(claims.exp);
  if (
    !subject ||
    !SUBJECT.test(subject) ||
    !issuer ||
    issuer.length > 512 ||
    !audience ||
    audience.length > 512 ||
    authenticationTimeSeconds === null ||
    expiresAtSeconds === null ||
    authenticationTimeSeconds > nowSeconds
  ) {
    throw new UniversalV1BearerVerificationError('BEARER_IDENTITY_INVALID');
  }
  if (expiresAtSeconds <= nowSeconds) {
    throw new UniversalV1BearerVerificationError('BEARER_EXPIRED');
  }

  const readRevocationMarker =
    dependencies.readRevocationMarker ??
    ((verifiedSubject: string) =>
      redis.get<string>(`auth:revoked:${verifiedSubject}`, 'authority'));
  let revocationMarker: string | null;
  try {
    revocationMarker = await readRevocationMarker(subject);
  } catch {
    throw new UniversalV1BearerVerificationError('REVOCATION_AUTHORITY_UNAVAILABLE');
  }
  const revocationCheckedAt = (dependencies.now ?? (() => new Date()))();
  if (revocationMarker !== null) {
    throw new UniversalV1BearerVerificationError('BEARER_REVOKED');
  }

  const methods = normalizeAuthenticationMethods(claims);
  if (methods.length === 0 || methods.some((method) => !AUTHENTICATION_METHOD.test(method))) {
    throw new UniversalV1BearerVerificationError('BEARER_IDENTITY_INVALID');
  }
  return {
    verifiedSubject: subject,
    issuer,
    audience,
    authenticationTime: new Date(authenticationTimeSeconds * 1_000),
    bearerExpiresAt: new Date(expiresAtSeconds * 1_000),
    verifiedAt,
    revocationCheckedAt,
    authenticationMethods: methods,
    mfaVerified: methods.includes('mfa'),
  };
}
