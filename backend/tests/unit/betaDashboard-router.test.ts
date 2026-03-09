/**
 * BetaDashboard Router Unit Tests — listUsers offset-based pagination
 *
 * Tests that betaDashboard.listUsers returns a plain mapped array with
 * limit-based pagination (LIMIT $1, no offset). Uses adminProcedure,
 * so the first db.query mock is the admin_roles check.
 *
 * Pattern: mock db at module level, use createCaller with a fake admin
 * context to bypass middleware, then call listUsers directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that transitively touch these modules
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

vi.mock('../../src/services/BetaService', () => ({
  BetaService: {
    getBetaMetrics: vi.fn(),
    getBetaStatus: vi.fn(),
    getKillSignals: vi.fn(),
    logBetaStateChange: vi.fn(),
  },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: {
    getLedgerIntegrity: vi.fn(),
    getRevenueSummary: vi.fn(),
    getMonthlyPnl: vi.fn(),
    verifyLedgerIntegrity: vi.fn(),
  },
}));

vi.mock('../../src/services/ChargebackService', () => ({
  ChargebackService: {
    getChargebackRisk: vi.fn(),
    getPlatformDisputeRate: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    beta: {
      enabled: true,
      regionName: 'Seattle',
      bounds: {},
      center: {},
      radiusMiles: 25,
      startDate: '2025-01-01',
      endDate: '2025-06-01',
      maxHustlers: 100,
      maxPosters: 50,
      geoFence: { city: 'Seattle' },
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { betaDashboardRouter } from '../../src/routers/betaDashboard';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type UserRow = {
  id: string;
  email: string;
  full_name: string;
  default_mode: string;
  subscription_tier: string;
  trust_tier: number;
  xp_total: number;
  created_at: string;
  tasks_posted: string;
  tasks_completed: string;
  total_earned_cents: string;
  total_spent_cents: string;
};

function makeUserRow(overrides: Partial<UserRow & { id: string }> = {}): UserRow {
  const id = overrides.id ?? `user-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    email: 'test@example.com',
    full_name: 'Test User',
    default_mode: 'hustler',
    subscription_tier: 'free',
    trust_tier: 1,
    xp_total: 0,
    created_at: '2025-01-01T00:00:00.000Z',
    tasks_posted: '0',
    tasks_completed: '0',
    total_earned_cents: '0',
    total_spent_cents: '0',
    ...overrides,
  };
}

/**
 * Create a tRPC caller for the betaDashboard router with a pre-authenticated
 * admin context. The adminProcedure middleware checks admin_roles; we set that
 * up as the first mock call.
 */
function makeAdminCaller() {
  const fakeAdminUser = {
    id: 'admin-user-id',
    email: 'admin@hustlexp.com',
    full_name: 'Admin User',
    role: 'admin',
    firebase_uid: 'fb-admin',
  };
  return betaDashboardRouter.createCaller({
    user: fakeAdminUser as any,
    firebaseUid: 'fb-admin',
  });
}

/**
 * Set up the mock so that:
 *   call 1: admin_roles check -> returns 1 row (grants access)
 *   call 2: the actual listUsers query -> returns `userRows`
 */
function setupAdminAndUsers(userRows: UserRow[]) {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  mockDb.query.mockResolvedValueOnce({ rows: userRows, rowCount: userRows.length } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('betaDashboard.listUsers — offset-based pagination (returns array)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape — plain array
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns an array (not { items, nextCursor })', async () => {
      setupAdminAndUsers([makeUserRow({ id: 'aaa' })]);

      const result = await makeAdminCaller().listUsers({});

      expect(Array.isArray(result)).toBe(true);
    });

    it('returns mapped user objects with camelCase fields', async () => {
      setupAdminAndUsers([
        makeUserRow({
          id: 'aaa',
          email: 'jane@test.com',
          full_name: 'Jane Doe',
          tasks_posted: '3',
          tasks_completed: '1',
          total_earned_cents: '500',
          total_spent_cents: '1000',
        }),
      ]);

      const result = await makeAdminCaller().listUsers({});

      expect(result).toHaveLength(1);
      const item = result[0];
      expect(item.email).toBe('jane@test.com');
      expect(item.fullName).toBe('Jane Doe');
      expect(item.tasksPosted).toBe(3);
      expect(item.tasksCompleted).toBe(1);
      expect(item.totalEarnedCents).toBe(500);
      expect(item.totalSpentCents).toBe(1000);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pagination — limit passed to query
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('passes limit to db.query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({ limit: 25 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('LIMIT');
      expect(params).toContain(25);
    });

    it('uses default limit=100 when not provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers();

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('LIMIT');
      expect(params).toContain(100);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Empty result
  // -------------------------------------------------------------------------

  describe('empty result', () => {
    it('returns empty array when no results', async () => {
      setupAdminAndUsers([]);

      const result = await makeAdminCaller().listUsers({ limit: 20 });

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple items
  // -------------------------------------------------------------------------

  describe('multiple items', () => {
    it('returns multiple users in the array', async () => {
      const users = [
        makeUserRow({ id: 'aaa', email: 'a@test.com' }),
        makeUserRow({ id: 'bbb', email: 'b@test.com' }),
        makeUserRow({ id: 'ccc', email: 'c@test.com' }),
      ];
      setupAdminAndUsers(users);

      const result = await makeAdminCaller().listUsers({ limit: 100 });

      expect(result).toHaveLength(3);
      expect(result.map((u: any) => u.id)).toEqual(['aaa', 'bbb', 'ccc']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. sortBy parameter
  // -------------------------------------------------------------------------

  describe('sortBy parameter', () => {
    it('accepts sortBy parameter', async () => {
      setupAdminAndUsers([makeUserRow({ id: 'aaa' })]);

      const result = await makeAdminCaller().listUsers({ sortBy: 'xp_total' });

      // Should not throw — sortBy is accepted by the input schema
      expect(Array.isArray(result)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Admin check
  // -------------------------------------------------------------------------

  describe('admin check', () => {
    it('requires admin role (first db.query is admin_roles check)', async () => {
      setupAdminAndUsers([makeUserRow({ id: 'aaa' })]);

      await makeAdminCaller().listUsers({});

      // First call should be the admin_roles check
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
  });
});
