import { createHmac, timingSafeEqual } from 'node:crypto';

const ISSUER = 'hxos-deployed-synthetic-operator';
const AUDIENCE = 'hustlexp-nonprod-operations';
const KEY_ID = 'hxos-nonprod-operator-v1';
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const SUBJECT_RE = /^hxos-(staging|preview)-operator-[a-z0-9][a-z0-9_-]{7,63}$/u;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._'-]{2,79}$/u;
const MAX_TOKEN_CHARS = 5_000;
const MAX_LIFETIME_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 30;

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface JwtHeader {
  alg?: unknown;
  typ?: unknown;
  kid?: unknown;
}

interface JwtPayload {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  iat?: unknown;
  auth_time?: unknown;
  exp?: unknown;
  environment?: unknown;
  operator_name?: unknown;
  mfa_method?: unknown;
  hxos_synthetic_operator?: unknown;
}

export interface DeployedSyntheticOperatorIdentity {
  uid: string;
  exp: number;
  auth_time: number;
  amr: readonly ['synthetic_hmac', 'mfa'];
  firebase: {
    sign_in_provider: 'synthetic_nonprod_hmac';
    sign_in_second_factor: 'totp' | 'webauthn';
  };
  operatorName: string;
}

function parseSegment<T>(segment: string): T | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as T : null;
  } catch {
    return null;
  }
}

function deployedEnvironment(env: Environment): 'staging' | 'preview' | null {
  return env.HX_ENVIRONMENT === 'staging' || env.HX_ENVIRONMENT === 'preview'
    ? env.HX_ENVIRONMENT
    : null;
}

export function deployedSyntheticOperatorAuthEnabled(
  env: Environment = process.env,
): boolean {
  const secret = env.HX_SYNTHETIC_OPERATOR_AUTH_SECRET?.trim() ?? '';
  return env.NODE_ENV === 'production'
    && deployedEnvironment(env) !== null
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && env.HX_PAYMENT_CREATION_MODE === 'frozen'
    && env.HX_SYNTHETIC_OPERATOR_AUTH_MODE === 'signed_hmac'
    && secret.length >= 32;
}

/**
 * Verify a short-lived named operator token minted by the isolated nonprod
 * identity sink. This path cannot activate in the production environment and
 * does not accept request headers as MFA evidence. Current database RBAC still
 * decides what the seeded operator may do.
 */
export function verifyDeployedSyntheticOperatorToken(
  token: string,
  env: Environment = process.env,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): DeployedSyntheticOperatorIdentity | null {
  const environment = deployedEnvironment(env);
  if (!environment || !deployedSyntheticOperatorAuthEnabled(env)) return null;
  if (!TOKEN_RE.test(token) || token.length > MAX_TOKEN_CHARS) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
  const header = parseSegment<JwtHeader>(encodedHeader);
  const payload = parseSegment<JwtPayload>(encodedPayload);
  if (
    !header
    || !payload
    || header.alg !== 'HS256'
    || header.typ !== 'JWT'
    || header.kid !== KEY_ID
  ) return null;

  const signed = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac('sha256', env.HX_SYNTHETIC_OPERATOR_AUTH_SECRET!.trim())
    .update(signed, 'utf8')
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  if (
    payload.iss !== ISSUER
    || payload.aud !== AUDIENCE
    || payload.environment !== environment
    || payload.hxos_synthetic_operator !== true
    || typeof payload.sub !== 'string'
    || typeof payload.operator_name !== 'string'
    || !SUBJECT_RE.test(payload.sub)
    || !payload.sub.startsWith(`hxos-${environment}-operator-`)
    || !NAME_RE.test(payload.operator_name)
    || (payload.mfa_method !== 'totp' && payload.mfa_method !== 'webauthn')
    || !Number.isSafeInteger(payload.iat)
    || !Number.isSafeInteger(payload.auth_time)
    || !Number.isSafeInteger(payload.exp)
  ) return null;

  const issuedAt = payload.iat as number;
  const authenticatedAt = payload.auth_time as number;
  const expiresAt = payload.exp as number;
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (authenticatedAt > issuedAt || nowSeconds - authenticatedAt > MAX_LIFETIME_SECONDS) return null;
  if (expiresAt <= nowSeconds - CLOCK_SKEW_SECONDS) return null;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LIFETIME_SECONDS) return null;

  return {
    uid: payload.sub,
    exp: expiresAt,
    auth_time: authenticatedAt,
    amr: ['synthetic_hmac', 'mfa'],
    firebase: {
      sign_in_provider: 'synthetic_nonprod_hmac',
      sign_in_second_factor: payload.mfa_method,
    },
    operatorName: payload.operator_name,
  };
}
