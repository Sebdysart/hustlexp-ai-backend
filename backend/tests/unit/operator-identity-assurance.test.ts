import { describe, expect, it } from 'vitest';
import {
  hasFreshOperatorStepUp,
  identityAssuranceFromVerifiedToken,
  OPERATOR_STEP_UP_MAX_AGE_SECONDS,
} from '../../src/auth/operator-identity-assurance';

describe('named operator identity assurance', () => {
  const now = 2_000_000_000;

  it('derives MFA only from verified token claims and accepts a recent assertion', () => {
    const assurance = identityAssuranceFromVerifiedToken({
      auth_time: now - 30,
      exp: now + 3_000,
      firebase: {
        sign_in_provider: 'password',
        sign_in_second_factor: 'phone',
      },
    });
    expect(assurance).toEqual({
      authenticatedAtSeconds: now - 30,
      tokenExpiresAtSeconds: now + 3_000,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    });
    expect(hasFreshOperatorStepUp(assurance, now)).toBe(true);
  });

  it('recognizes a verified amr MFA assertion without trusting browser headers', () => {
    const assurance = identityAssuranceFromVerifiedToken({
      auth_time: now,
      exp: now + 600,
      amr: ['pwd', 'mfa'],
      firebase: { sign_in_provider: 'password' },
    });
    expect(assurance.mfaVerified).toBe(true);
    expect(hasFreshOperatorStepUp(assurance, now)).toBe(true);
  });

  it.each([
    ['no MFA', { authenticatedAtSeconds: now, tokenExpiresAtSeconds: now + 600, mfaVerified: false }],
    ['stale step-up', { authenticatedAtSeconds: now - OPERATOR_STEP_UP_MAX_AGE_SECONDS - 1, tokenExpiresAtSeconds: now + 600, mfaVerified: true }],
    ['expired token', { authenticatedAtSeconds: now - 10, tokenExpiresAtSeconds: now, mfaVerified: true }],
    ['missing auth time', { authenticatedAtSeconds: null, tokenExpiresAtSeconds: now + 600, mfaVerified: true }],
  ])('fails closed for %s', (_label, partial) => {
    expect(hasFreshOperatorStepUp({
      signInProvider: null,
      secondFactor: null,
      ...partial,
    }, now)).toBe(false);
  });
});
