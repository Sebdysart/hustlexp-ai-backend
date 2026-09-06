import { createHash, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS } from '../../src/releaseAuthorityKeys.js';

const EXPECTED_KEY_ID = 'hustlexp-release-2026-v1';
const EXPECTED_SPKI_SHA256 =
  '1357325729c6439a494ede241b67bd550935ad9946e8bf11079bf41e83a6fa98';

describe('protected release-authority public keys', () => {
  it('pins only the reviewed public Ed25519 release key', () => {
    expect(Object.keys(PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS)).toEqual([EXPECTED_KEY_ID]);
    const pem = PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS[EXPECTED_KEY_ID];
    expect(pem).toContain('BEGIN PUBLIC KEY');
    expect(pem).not.toMatch(/PRIVATE KEY/u);

    const publicKey = createPublicKey(pem);
    expect(publicKey.asymmetricKeyType).toBe('ed25519');
    const fingerprint = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex');
    expect(fingerprint).toBe(EXPECTED_SPKI_SHA256);
  });

  it('keeps the protected key map immutable at runtime', () => {
    expect(Object.isFrozen(PINNED_RELEASE_AUTHORITY_PUBLIC_KEYS)).toBe(true);
  });
});
