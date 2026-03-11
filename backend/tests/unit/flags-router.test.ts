/**
 * Flags Router Unit Tests
 *
 * Tests tRPC procedures:
 * - getFlags (protected, query)
 * - setFlag (admin, mutation)
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
    setFlag: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { flagsRouter } from '../../src/routers/flags';
import { FlagsService } from '../../src/services/FlagsService';

const mockDb = vi.mocked(db);
const mockService = vi.mocked(FlagsService);

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
  // adminProcedure checks admin_roles table
  return flagsRouter.createCaller({
    user: { id: userId } as any,
    firebaseUid: 'fb-admin',
  });
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

describe('flags.setFlag', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets a feature flag (admin)', async () => {
    // Admin role check
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);

    const flagData = { name: 'beta_feature', enabled: true };
    mockService.setFlag.mockResolvedValueOnce(flagData as any);

    const result = await makeAdminCaller().setFlag({
      name: 'beta_feature',
      enabled: true,
    });

    expect(result).toEqual(flagData);
    expect(mockService.setFlag).toHaveBeenCalledWith({
      name: 'beta_feature',
      enabled: true,
      rolloutPercentage: 0,
      userAllowlist: [],
      userBlocklist: [],
      metadata: {},
    });
  });

  it('sets flag with all options', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
    mockService.setFlag.mockResolvedValueOnce({ name: 'rollout' } as any);

    const uuid1 = '11111111-1111-1111-1111-111111111111';

    await makeAdminCaller().setFlag({
      name: 'rollout_test',
      enabled: true,
      rolloutPercentage: 50,
      userAllowlist: [uuid1],
      userBlocklist: [],
      metadata: { version: '2.0' },
    });

    expect(mockService.setFlag).toHaveBeenCalledWith({
      name: 'rollout_test',
      enabled: true,
      rolloutPercentage: 50,
      userAllowlist: [uuid1],
      userBlocklist: [],
      metadata: { version: '2.0' },
    });
  });

  it('rejects non-admin users', async () => {
    // Admin role check returns empty
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeAdminCaller().setFlag({ name: 'test', enabled: true })
    ).rejects.toThrow('Admin access required');
  });

  it('rejects rollout percentage outside range', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);

    await expect(
      makeAdminCaller().setFlag({ name: 'test', enabled: true, rolloutPercentage: 101 })
    ).rejects.toThrow();
  });
});
