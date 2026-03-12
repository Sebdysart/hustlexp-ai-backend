/**
 * Firebase auth branch coverage tests
 *
 * Targets the uncovered branches in src/auth/firebase.ts:
 * - verifyIdToken: auth is null (not configured)
 * - verifyIdToken: auth is configured (calls auth.verifyIdToken)
 * - Module init: credentials present vs missing
 * - messaging export
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase-admin/app
const mockGetApps = vi.fn(() => []);
const mockInitializeApp = vi.fn(() => 'mock-app');
const mockCert = vi.fn(() => ({}));

vi.mock('firebase-admin/app', () => ({
  getApps: mockGetApps,
  initializeApp: mockInitializeApp,
  cert: mockCert,
}));

// Mock firebase-admin/auth
const mockVerifyIdToken = vi.fn();
const mockGetAuth = vi.fn(() => ({
  verifyIdToken: mockVerifyIdToken,
}));

vi.mock('firebase-admin/auth', () => ({
  getAuth: mockGetAuth,
}));

// Mock firebase-admin/messaging
const mockGetMessaging = vi.fn(() => ({ send: vi.fn() }));

vi.mock('firebase-admin/messaging', () => ({
  getMessaging: mockGetMessaging,
}));

vi.mock('../../src/logger', () => ({
  authLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

describe('firebase auth — configured path', () => {
  it('verifyIdToken calls auth.verifyIdToken when configured', async () => {
    vi.mock('../../src/config', () => ({
      config: {
        firebase: {
          projectId: 'test-project',
          clientEmail: 'test@test.iam.gserviceaccount.com',
          privateKey: 'test-private-key',
        },
      },
    }));

    const decoded = { uid: 'fb-123', email: 'user@test.com' };
    mockVerifyIdToken.mockResolvedValueOnce(decoded);

    const { verifyIdToken } = await import('../../src/auth/firebase');
    const result = await verifyIdToken('valid-token');

    expect(result.uid).toBe('fb-123');
  });

  it('verifyIdToken passes checkRevoked param', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'fb-456' });

    const { verifyIdToken } = await import('../../src/auth/firebase');
    await verifyIdToken('token', false);

    expect(mockVerifyIdToken).toHaveBeenCalledWith('token', false);
  });

  it('exports firebaseAuth and adminAuth aliases', async () => {
    const mod = await import('../../src/auth/firebase');
    expect(mod.firebaseAuth).toBeDefined();
    expect(mod.adminAuth).toBeDefined();
    expect(mod.firebaseAuth.verifyIdToken).toBe(mod.adminAuth.verifyIdToken);
  });

  it('exports messaging', async () => {
    const mod = await import('../../src/auth/firebase');
    expect(mod.messaging).toBeDefined();
  });
});
