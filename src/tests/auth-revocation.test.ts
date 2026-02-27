/**
 * Auth Token Revocation Tests
 *
 * Verifies:
 *  1. TOKEN_CACHE_TTL is at most 5 minutes (300 seconds).
 *  2. verifyTokenWithRevocationCheck calls verifyIdToken with checkRevoked=true.
 */

import { describe, it, expect, vi } from 'vitest';
import { TOKEN_CACHE_TTL, verifyTokenWithRevocationCheck } from '../middleware/firebaseAuth.js';

describe('Auth token revocation', () => {
  it('TOKEN_CACHE_TTL is at most 5 minutes (300 seconds)', () => {
    expect(TOKEN_CACHE_TTL).toBeLessThanOrEqual(5 * 60);
    expect(TOKEN_CACHE_TTL).toBeGreaterThan(0);
  });

  it('verifyTokenWithRevocationCheck calls verifyIdToken with checkRevoked=true', async () => {
    const mockVerify = vi.fn().mockResolvedValue({ uid: 'user123' });
    const mockAdminSdk = { auth: () => ({ verifyIdToken: mockVerify }) };

    await verifyTokenWithRevocationCheck('test_token', mockAdminSdk, true);

    expect(mockVerify).toHaveBeenCalledWith('test_token', true); // true = checkRevoked
  });

  it('verifyTokenWithRevocationCheck passes checkRevoked=false when requested', async () => {
    const mockVerify = vi.fn().mockResolvedValue({ uid: 'user456' });
    const mockAdminSdk = { auth: () => ({ verifyIdToken: mockVerify }) };

    await verifyTokenWithRevocationCheck('test_token_2', mockAdminSdk, false);

    expect(mockVerify).toHaveBeenCalledWith('test_token_2', false);
  });

  it('verifyTokenWithRevocationCheck throws when Firebase Admin is not configured', async () => {
    const mockAdminSdk = { auth: () => null };

    await expect(
      verifyTokenWithRevocationCheck('test_token_3', mockAdminSdk, true),
    ).rejects.toThrow('Firebase Admin is not configured');
  });
});
