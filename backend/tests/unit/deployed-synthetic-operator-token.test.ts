import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  deployedSyntheticOperatorAuthEnabled,
  verifyDeployedSyntheticOperatorToken,
} from '../../src/auth/deployed-synthetic-operator-token.js';

const SECRET = 'synthetic-operator-auth-secret-v1';
const NOW = 2_000_000_000;

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    HX_ENVIRONMENT: 'staging',
    ENGINE_API_MODE: 'test',
    STRIPE_MODE: 'test',
    HX_PAYMENT_CREATION_MODE: 'frozen',
    HX_SYNTHETIC_OPERATOR_AUTH_MODE: 'signed_hmac',
    HX_SYNTHETIC_OPERATOR_AUTH_SECRET: SECRET,
    ...overrides,
  };
}

function token(overrides: Record<string, unknown> = {}, secret = SECRET): string {
  const header = Buffer.from(JSON.stringify({
    alg: 'HS256', typ: 'JWT', kid: 'hxos-nonprod-operator-v1',
  })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: 'hxos-deployed-synthetic-operator',
    aud: 'hustlexp-nonprod-operations',
    sub: 'hxos-staging-operator-alice000',
    iat: NOW - 30,
    auth_time: NOW - 30,
    exp: NOW + 300,
    environment: 'staging',
    operator_name: 'Alice Staging Operator',
    mfa_method: 'webauthn',
    hxos_synthetic_operator: true,
    ...overrides,
  })).toString('base64url');
  const signed = `${header}.${payload}`;
  return `${signed}.${createHmac('sha256', secret).update(signed, 'utf8').digest('base64url')}`;
}

describe('deployed synthetic named-operator token', () => {
  it('activates only inside an exact production-optimized preview or staging boundary', () => {
    expect(deployedSyntheticOperatorAuthEnabled(environment())).toBe(true);
    expect(deployedSyntheticOperatorAuthEnabled(environment({ HX_ENVIRONMENT: 'preview' }))).toBe(true);
    expect(deployedSyntheticOperatorAuthEnabled(environment({ HX_ENVIRONMENT: 'production' }))).toBe(false);
    expect(deployedSyntheticOperatorAuthEnabled(environment({ NODE_ENV: 'development' }))).toBe(false);
    expect(deployedSyntheticOperatorAuthEnabled(environment({ STRIPE_MODE: 'live' }))).toBe(false);
    expect(deployedSyntheticOperatorAuthEnabled(environment({ HX_PAYMENT_CREATION_MODE: 'enabled' }))).toBe(false);
  });

  it('returns only server-verified named identity and fresh MFA claims', () => {
    expect(verifyDeployedSyntheticOperatorToken(token(), environment(), NOW)).toEqual({
      uid: 'hxos-staging-operator-alice000',
      exp: NOW + 300,
      auth_time: NOW - 30,
      amr: ['synthetic_hmac', 'mfa'],
      firebase: {
        sign_in_provider: 'synthetic_nonprod_hmac',
        sign_in_second_factor: 'webauthn',
      },
      operatorName: 'Alice Staging Operator',
    });
  });

  it('rejects tampering, stale step-up, environment substitution, and production activation', () => {
    expect(verifyDeployedSyntheticOperatorToken(token({}, 'wrong-secret-that-is-long-enough-v1'), environment(), NOW)).toBeNull();
    expect(verifyDeployedSyntheticOperatorToken(
      token({ iat: NOW - 700, auth_time: NOW - 700, exp: NOW + 100 }),
      environment(),
      NOW,
    )).toBeNull();
    expect(verifyDeployedSyntheticOperatorToken(
      token({ environment: 'preview', sub: 'hxos-preview-operator-alice000' }),
      environment(),
      NOW,
    )).toBeNull();
    expect(verifyDeployedSyntheticOperatorToken(
      token(),
      environment({ HX_ENVIRONMENT: 'production' }),
      NOW,
    )).toBeNull();
  });
});
