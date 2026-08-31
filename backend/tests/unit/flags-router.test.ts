/**
 * Flags Router Unit Tests
 *
 * Tests tRPC procedures:
 * - getFlags (protected, query)
 * - requestDisable (stepped-up, versioned, two-person mutation request)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/FlagsService', () => ({
  FlagsService: {
    getUserFlags: vi.fn(),
  },
}));

vi.mock('../../src/services/OperatorAuthorityService', () => ({
  OperatorAuthorityService: {
    request: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { flagsRouter } from '../../src/routers/flags';
import { FlagsService } from '../../src/services/FlagsService';
import { OperatorAuthorityService } from '../../src/services/OperatorAuthorityService';

const mockDb = vi.mocked(db);
const mockService = vi.mocked(FlagsService);
const mockOperatorAuthority = vi.mocked(OperatorAuthorityService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCaller(userId = 'test-uid') {
  return flagsRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-uid',
  });
}

function makeAdminCaller(userId = 'admin-uid') {
  return flagsRouter.createCaller({
    user: {
      id: userId,
      is_admin: true,
      is_banned: false,
      account_status: 'ACTIVE',
    } as any,
    firebaseUid: 'fb-admin',
    identityAssurance: {
      authenticatedAtSeconds: Math.floor(Date.now() / 1000),
      tokenExpiresAtSeconds: Math.floor(Date.now() / 1000) + 3_600,
      signInProvider: 'password',
      secondFactor: 'phone',
      mfaVerified: true,
    },
  } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('flags.getFlags', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns evaluated flags for user', async () => {
    const flags = { dark_mode: true, beta_features: false };
    mockService.getUserFlags.mockResolvedValueOnce(flags as any);

    const result = await makeCaller().getFlags();

    expect(result).toEqual(flags);
    expect(mockService.getUserFlags).toHaveBeenCalledWith('test-uid');
  });

  it('rejects unauthenticated users', async () => {
    const caller = flagsRouter.createCaller({ user: null, firebaseUid: null } as any);

    await expect(caller.getFlags()).rejects.toThrow();
  });
});

describe('flags.requestDisable', () => {
  beforeEach(() => vi.clearAllMocks());

  it('routes only an exact disable request into the two-person command rail', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ role: 'support', capability_granted: true }], rowCount: 1,
    } as any);
    mockOperatorAuthority.request.mockResolvedValueOnce({
      commandId: '22222222-2222-4222-8222-222222222222',
      status: 'PENDING',
      version: 1,
      idempotencyReplayed: false,
    } as any);
    const idempotencyKey = '11111111-1111-4111-8111-111111111111';

    await expect(makeAdminCaller().requestDisable({
      name: 'beta_feature',
      enabled: false,
      expectedVersion: 7,
      reason: 'Disable this feature while the incident is reviewed.',
      idempotencyKey,
    })).resolves.toMatchObject({ status: 'PENDING' });

    expect(mockOperatorAuthority.request).toHaveBeenCalledWith(expect.anything(), {
      operationType: 'DISABLE_FEATURE_FLAG',
      targetId: 'beta_feature',
      targetExpectedVersion: 7,
      reason: 'Disable this feature while the incident is reviewed.',
      idempotencyKey,
    });
  });

  it('rejects feature enablement at schema validation before authority execution', async () => {
    await expect(makeAdminCaller().requestDisable({
      name: 'beta_feature',
      enabled: true,
      expectedVersion: 7,
      reason: 'Attempt to enable a feature through a disable-only command.',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    } as any)).rejects.toThrow();
    expect(mockOperatorAuthority.request).not.toHaveBeenCalled();
    expect(mockDb.query.mock.calls.every(([sql]) =>
      !/\b(?:INSERT|UPDATE|DELETE)\b/iu.test(String(sql)),
    )).toBe(true);
  });

  it('rejects operators without current Operations capability', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    await expect(makeAdminCaller().requestDisable({
      name: 'beta_feature',
      enabled: false,
      expectedVersion: 7,
      reason: 'Disable this feature while the incident is reviewed.',
      idempotencyKey: '11111111-1111-4111-8111-111111111111',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockOperatorAuthority.request).not.toHaveBeenCalled();
  });

  it('does not expose the removed direct setFlag route', () => {
    expect((flagsRouter as any)._def.record.setFlag).toBeUndefined();
  });
});
