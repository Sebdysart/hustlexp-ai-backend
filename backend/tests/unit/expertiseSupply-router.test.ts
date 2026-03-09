/**
 * ExpertiseSupply Router Unit Tests — offset-based pagination
 *
 * Tests that expertiseSupply.listExpertise returns a plain array with
 * offset-based pagination. The router calls ExpertiseSupplyService.listExpertise()
 * (which returns ALL active rows), then slices with offset/limit.
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
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/ExpertiseSupplyService', () => ({
  ExpertiseSupplyService: {
    listExpertise: vi.fn(),
    getUserExpertise: vi.fn(),
    addUserExpertise: vi.fn(),
    removeUserExpertise: vi.fn(),
    promoteExpertise: vi.fn(),
    checkCapacity: vi.fn(),
    getUserWaitlist: vi.fn(),
    acceptWaitlistInvite: vi.fn(),
    getSupplyDashboard: vi.fn(),
    adminUpdateCapacity: vi.fn(),
    recalculateAllCapacity: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { ExpertiseSupplyService } from '../../src/services/ExpertiseSupplyService';
import { expertiseSupplyRouter } from '../../src/routers/expertiseSupply';

const mockExpertiseService = vi.mocked(ExpertiseSupplyService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExpertiseInfo = {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  riskTier: string;
  active: boolean;
};

function makeExpertise(overrides: Partial<ExpertiseInfo & { id: string }> = {}): ExpertiseInfo {
  const id = overrides.id ?? `exp-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    slug: 'plumbing',
    displayName: 'Plumbing',
    description: null,
    riskTier: 'low',
    active: true,
    ...overrides,
  };
}

function makeUserCaller(userId = 'user-abc') {
  const fakeUser = {
    id: userId,
    email: 'user@hustlexp.com',
    full_name: 'Test User',
    role: 'hustler',
    trust_tier: 4,
    firebase_uid: 'fb-user',
  };
  return expertiseSupplyRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-user',
  });
}

// ===========================================================================
// expertiseSupply.listExpertise — offset-based pagination (returns array)
// ===========================================================================

describe('expertiseSupply.listExpertise — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape — plain array
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns an array (not { items, nextCursor })', async () => {
      mockExpertiseService.listExpertise.mockResolvedValueOnce({
        success: true,
        data: [makeExpertise({ id: 'aaa' })],
      } as any);

      const result = await makeUserCaller().listExpertise({ limit: 20 });

      expect(Array.isArray(result)).toBe(true);
    });

    it('returns expertise objects with camelCase fields from the service', async () => {
      mockExpertiseService.listExpertise.mockResolvedValueOnce({
        success: true,
        data: [makeExpertise({ id: 'aaa', displayName: 'Electrical' })],
      } as any);

      const result = await makeUserCaller().listExpertise({ limit: 20 });

      expect(result).toHaveLength(1);
      expect(result[0].displayName).toBe('Electrical');
      expect(result[0].id).toBe('aaa');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pagination — router slices with offset/limit
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('slices the service result with offset and limit', async () => {
      const allItems = [
        makeExpertise({ id: 'aaa' }),
        makeExpertise({ id: 'bbb' }),
        makeExpertise({ id: 'ccc' }),
        makeExpertise({ id: 'ddd' }),
        makeExpertise({ id: 'eee' }),
      ];
      mockExpertiseService.listExpertise.mockResolvedValueOnce({
        success: true,
        data: allItems,
      } as any);

      const result = await makeUserCaller().listExpertise({ limit: 2, offset: 1 });

      expect(result).toHaveLength(2);
      expect(result.map((e: any) => e.id)).toEqual(['bbb', 'ccc']);
    });

    it('uses default limit=50 and offset=0 when not provided', async () => {
      const items = [makeExpertise({ id: 'aaa' })];
      mockExpertiseService.listExpertise.mockResolvedValueOnce({
        success: true,
        data: items,
      } as any);

      const result = await makeUserCaller().listExpertise();

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('aaa');
    });
  });

  // -------------------------------------------------------------------------
  // 3. Empty result
  // -------------------------------------------------------------------------

  describe('empty result', () => {
    it('returns empty array when service returns no data', async () => {
      mockExpertiseService.listExpertise.mockResolvedValueOnce({
        success: true,
        data: [],
      } as any);

      const result = await makeUserCaller().listExpertise({ limit: 20 });

      expect(result).toEqual([]);
    });

    it('returns empty array when offset is beyond data length', async () => {
      mockExpertiseService.listExpertise.mockResolvedValueOnce({
        success: true,
        data: [makeExpertise({ id: 'aaa' })],
      } as any);

      const result = await makeUserCaller().listExpertise({ limit: 20, offset: 100 });

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple items
  // -------------------------------------------------------------------------

  describe('multiple items', () => {
    it('returns multiple expertise items in the array', async () => {
      const items = [
        makeExpertise({ id: 'aaa', displayName: 'Plumbing' }),
        makeExpertise({ id: 'bbb', displayName: 'Electrical' }),
        makeExpertise({ id: 'ccc', displayName: 'Cleaning' }),
      ];
      mockExpertiseService.listExpertise.mockResolvedValueOnce({
        success: true,
        data: items,
      } as any);

      const result = await makeUserCaller().listExpertise({ limit: 50 });

      expect(result).toHaveLength(3);
      expect(result.map((e: any) => e.displayName)).toEqual(['Plumbing', 'Electrical', 'Cleaning']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Service error propagation
  // -------------------------------------------------------------------------

  describe('service error', () => {
    it('throws INTERNAL_SERVER_ERROR when service returns failure', async () => {
      mockExpertiseService.listExpertise.mockResolvedValueOnce({
        success: false,
        error: { message: 'Database unavailable' },
      } as any);

      await expect(
        makeUserCaller().listExpertise({ limit: 20 })
      ).rejects.toThrow('Database unavailable');
    });
  });
});
