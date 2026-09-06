import { describe, expect, it, vi } from 'vitest';

import {
  independentlyVerifyUniversalV1Bearer,
  UniversalV1BearerVerificationError,
} from '../../src/auth/universal-v1-bearer-verifier.js';

const now = new Date('2026-09-01T12:00:00.000Z');
const bearer = 'synthetic.firebase.bearer.for-attester-tests';

function firebaseClaims(overrides: Record<string, unknown> = {}) {
  return {
    uid: 'firebase_subject_00000001',
    sub: 'firebase_subject_00000001',
    iss: 'https://securetoken.google.com/hustlexp-test',
    aud: 'hustlexp-test',
    iat: Math.floor(now.getTime() / 1_000) - 20,
    auth_time: Math.floor(now.getTime() / 1_000) - 20,
    exp: Math.floor(now.getTime() / 1_000) + 120,
    amr: ['password'],
    firebase: { sign_in_provider: 'password' },
    ...overrides,
  };
}

const env = { FIREBASE_PROJECT_ID: 'hustlexp-test' };

describe('independentlyVerifyUniversalV1Bearer', () => {
  it('re-verifies issuer, audience, expiry and revocation without accepting API cache facts', async () => {
    const verifyFirebase = vi.fn().mockResolvedValue(firebaseClaims());
    const readRevocationMarker = vi.fn().mockResolvedValue(null);
    const verified = await independentlyVerifyUniversalV1Bearer(bearer, {
      env,
      now: () => now,
      verifyFirebase,
      readRevocationMarker,
    });

    expect(verifyFirebase).toHaveBeenCalledWith(bearer);
    expect(readRevocationMarker).toHaveBeenCalledWith('firebase_subject_00000001');
    expect(verified).toMatchObject({
      verifiedSubject: 'firebase_subject_00000001',
      issuer: 'https://securetoken.google.com/hustlexp-test',
      audience: 'hustlexp-test',
      authenticationMethods: ['password'],
      mfaVerified: false,
    });
  });

  it('rejects a current cryptographic bearer when the application revocation marker exists', async () => {
    await expect(
      independentlyVerifyUniversalV1Bearer(bearer, {
        env,
        now: () => now,
        verifyFirebase: vi.fn().mockResolvedValue(firebaseClaims()),
        readRevocationMarker: vi.fn().mockResolvedValue('revoked'),
      })
    ).rejects.toMatchObject<Partial<UniversalV1BearerVerificationError>>({
      code: 'BEARER_REVOKED',
    });
  });

  it('fails closed when revocation authority is unavailable', async () => {
    await expect(
      independentlyVerifyUniversalV1Bearer(bearer, {
        env,
        now: () => now,
        verifyFirebase: vi.fn().mockResolvedValue(firebaseClaims()),
        readRevocationMarker: vi.fn().mockRejectedValue(new Error('redis detail')),
      })
    ).rejects.toMatchObject({ code: 'REVOCATION_AUTHORITY_UNAVAILABLE' });
  });

  it.each([
    ['expired', { exp: Math.floor(now.getTime() / 1_000) }],
    ['wrong issuer', { iss: 'https://example.invalid' }],
    ['wrong audience', { aud: 'different-project' }],
    ['subject mismatch', { sub: 'different_subject' }],
  ])(
    'rejects %s bearer facts and never includes the bearer in the error',
    async (_name, overrides) => {
      let caught: unknown;
      try {
        await independentlyVerifyUniversalV1Bearer(bearer, {
          env,
          now: () => now,
          verifyFirebase: vi.fn().mockResolvedValue(firebaseClaims(overrides)),
          readRevocationMarker: vi.fn().mockResolvedValue(null),
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UniversalV1BearerVerificationError);
      expect(String(caught)).not.toContain(bearer);
    }
  );
});
