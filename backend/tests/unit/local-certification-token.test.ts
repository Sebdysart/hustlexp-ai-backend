import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  localCertificationAuthEnabled,
  verifyLocalCertificationToken,
} from '../../src/auth/local-certification-token.js';

const NOW = 2_000_000_000;
const SECRET = 'hxos-local-auth-secret-is-at-least-thirty-two-chars';
const enabled = {
  NODE_ENV: 'test',
  HXOS_ALLOW_LOCAL_TEST_AUTH: 'true',
  ENGINE_API_MODE: 'test',
  STRIPE_MODE: 'test',
  HXOS_LOCAL_TEST_AUTH_SECRET: SECRET,
};

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(payload: Record<string, unknown>, secret = SECRET, header: Record<string, unknown> = {
  alg: 'HS256', typ: 'JWT',
}): string {
  const input = `${encode(header)}.${encode(payload)}`;
  const signature = createHmac('sha256', secret).update(input).digest('base64url');
  return `${input}.${signature}`;
}

const claims = {
  iss: 'hxos-local-certification',
  aud: 'hustlexp-engine-test',
  sub: 'hxos-local-poster-certification01',
  iat: NOW,
  exp: NOW + 300,
  hxos_test: true,
};

describe('local certification identity token', () => {
  it('accepts a signed, short-lived TEST token', () => {
    expect(verifyLocalCertificationToken(token(claims), enabled, NOW)).toEqual({
      uid: claims.sub,
      exp: claims.exp,
    });
  });

  it('requires every non-production enablement guard and a strong secret', () => {
    expect(localCertificationAuthEnabled(enabled)).toBe(true);
    for (const override of [
      { NODE_ENV: 'production' },
      { HXOS_ALLOW_LOCAL_TEST_AUTH: 'false' },
      { ENGINE_API_MODE: 'live' },
      { STRIPE_MODE: 'live' },
      { HXOS_LOCAL_TEST_AUTH_SECRET: 'weak' },
    ]) {
      expect(localCertificationAuthEnabled({ ...enabled, ...override })).toBe(false);
      expect(verifyLocalCertificationToken(token(claims), { ...enabled, ...override }, NOW)).toBeNull();
    }
  });

  it('rejects wrong signatures and unsupported algorithms', () => {
    expect(verifyLocalCertificationToken(token(claims, `${SECRET}-wrong`), enabled, NOW)).toBeNull();
    expect(verifyLocalCertificationToken(token(claims, SECRET, { alg: 'none', typ: 'JWT' }), enabled, NOW)).toBeNull();
  });

  it('rejects expired, future-issued, and excessive-lifetime tokens', () => {
    expect(verifyLocalCertificationToken(token({ ...claims, exp: NOW - 31 }), enabled, NOW)).toBeNull();
    expect(verifyLocalCertificationToken(token({ ...claims, iat: NOW + 31, exp: NOW + 60 }), enabled, NOW)).toBeNull();
    expect(verifyLocalCertificationToken(token({ ...claims, exp: NOW + 601 }), enabled, NOW)).toBeNull();
  });

  it('rejects wrong issuer, audience, provenance, and subject class', () => {
    for (const override of [
      { iss: 'attacker' },
      { aud: 'other-service' },
      { hxos_test: false },
      { sub: 'ordinary-firebase-user' },
    ]) {
      expect(verifyLocalCertificationToken(token({ ...claims, ...override }), enabled, NOW)).toBeNull();
    }
  });
});
