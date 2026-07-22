import { createHmac, timingSafeEqual } from 'node:crypto';

const ISSUER = 'hxos-local-certification';
const AUDIENCE = 'hustlexp-engine-test';
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const SUBJECT_RE = /^hxos-local-(poster|hustler)-[a-z0-9_-]{8,64}$/;
const MAX_TOKEN_CHARS = 5_000;
const MAX_LIFETIME_SECONDS = 10 * 60;
const CLOCK_SKEW_SECONDS = 30;

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

interface JwtHeader {
  alg?: unknown;
  typ?: unknown;
}

interface JwtPayload {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  iat?: unknown;
  exp?: unknown;
  hxos_test?: unknown;
}

export interface LocalCertificationIdentity {
  uid: string;
  exp: number;
}

function parseSegment<T>(segment: string): T | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value as T : null;
  } catch {
    return null;
  }
}

export function localCertificationAuthEnabled(env: Environment = process.env): boolean {
  const secret = env.HXOS_LOCAL_TEST_AUTH_SECRET?.trim() ?? '';
  return env.NODE_ENV !== 'production'
    && env.HXOS_ALLOW_LOCAL_TEST_AUTH === 'true'
    && env.ENGINE_API_MODE === 'test'
    && env.STRIPE_MODE === 'test'
    && secret.length >= 32;
}

export function verifyLocalCertificationToken(
  token: string,
  env: Environment = process.env,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): LocalCertificationIdentity | null {
  if (!localCertificationAuthEnabled(env)) return null;
  if (!TOKEN_RE.test(token) || token.length > MAX_TOKEN_CHARS) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) return null;
  const header = parseSegment<JwtHeader>(encodedHeader);
  const payload = parseSegment<JwtPayload>(encodedPayload);
  if (!header || !payload || header.alg !== 'HS256' || header.typ !== 'JWT') return null;

  const secret = env.HXOS_LOCAL_TEST_AUTH_SECRET!.trim();
  const signed = `${encodedHeader}.${encodedPayload}`;
  const expected = createHmac('sha256', secret).update(signed).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(encodedSignature, 'base64url');
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  if (payload.iss !== ISSUER || payload.aud !== AUDIENCE || payload.hxos_test !== true) return null;
  if (typeof payload.sub !== 'string' || !SUBJECT_RE.test(payload.sub)) return null;
  if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
  const issuedAt = payload.iat as number;
  const expiresAt = payload.exp as number;
  if (issuedAt > nowSeconds + CLOCK_SKEW_SECONDS) return null;
  if (expiresAt <= nowSeconds - CLOCK_SKEW_SECONDS) return null;
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LIFETIME_SECONDS) return null;

  return { uid: payload.sub, exp: expiresAt };
}
