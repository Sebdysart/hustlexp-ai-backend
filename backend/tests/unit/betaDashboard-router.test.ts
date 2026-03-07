/**
 * BetaDashboard Router Unit Tests — listUsers cursor-based pagination
 *
 * Tests that betaDashboard.listUsers returns { items, nextCursor } with correct
 * cursor-based pagination semantics.
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
  },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: {
    getLedgerIntegrity: vi.fn(),
  },
}));

vi.mock('../../src/services/ChargebackService', () => ({
  ChargebackService: {
    getChargebackRisk: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    beta: {
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
 *   call 1: admin_roles check → returns 1 row (grants access)
 *   call 2: the actual listUsers query → returns `userRows`
 */
function setupAdminAndUsers(userRows: UserRow[]) {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  mockDb.query.mockResolvedValueOnce({ rows: userRows, rowCount: userRows.length } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('betaDashboard.listUsers — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } instead of a plain array', async () => {
      setupAdminAndUsers([makeUserRow({ id: 'aaa' })]);

      const result = await makeAdminCaller().listUsers({});

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
      expect(Array.isArray(result)).toBe(false);
    });

    it('items contains mapped user objects with camelCase fields', async () => {
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

      expect(result.items).toHaveLength(1);
      const item = result.items[0];
      expect(item.email).toBe('jane@test.com');
      expect(item.fullName).toBe('Jane Doe');
      expect(item.tasksPosted).toBe(3);
      expect(item.tasksCompleted).toBe(1);
      expect(item.totalEarnedCents).toBe(500);
      expect(item.totalSpentCents).toBe(1000);
    });
  });

  // -------------------------------------------------------------------------
  // nextCursor behaviour
  // -------------------------------------------------------------------------

  describe('nextCursor', () => {
    it('is null when results < limit (last page)', async () => {
      const users = [makeUserRow(), makeUserRow(), makeUserRow()];
      setupAdminAndUsers(users);

      const result = await makeAdminCaller().listUsers({ limit: 100 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const users = [makeUserRow({ id: 'aaa' }), makeUserRow({ id: 'bbb' })];
      setupAdminAndUsers(users);

      const result = await makeAdminCaller().listUsers({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is the id of the last visible item when there is a next page', async () => {
      const users = [
        makeUserRow({ id: 'id-aaa' }),
        makeUserRow({ id: 'id-bbb' }),
        makeUserRow({ id: 'id-ccc' }), // sentinel
      ];
      setupAdminAndUsers(users);

      const result = await makeAdminCaller().listUsers({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((u: { id: string }) => u.id)).toEqual(['id-aaa', 'id-bbb']);
    });

    it('nextCursor is null for empty result set', async () => {
      setupAdminAndUsers([]);

      const result = await makeAdminCaller().listUsers({ limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Cursor forwarding
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({
        cursor: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        limit: 5,
      });

      const calls = (mockDb.query as any).mock.calls;
      const [sql, params] = calls[1];

      expect(sql).toContain('u.id >');
      expect(params).toContain('cccccccc-cccc-cccc-cccc-cccccccccccc');
    });

    it('does not add u.id > clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).not.toContain('u.id >');
    });

    it('simulates two-page traversal', async () => {
      const id001 = '00000000-0000-0000-0000-000000000001';
      const id002 = '00000000-0000-0000-0000-000000000002';
      const id003 = '00000000-0000-0000-0000-000000000003';

      // ── Page 1 ──
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [
          makeUserRow({ id: id001 }),
          makeUserRow({ id: id002 }),
          makeUserRow({ id: id003 }), // sentinel
        ],
        rowCount: 3,
      } as any);

      const page1 = await makeAdminCaller().listUsers({ limit: 2 });
      expect(page1.nextCursor).toBe(id002);
      expect(page1.items).toHaveLength(2);

      vi.clearAllMocks();

      // ── Page 2 (cursor=id002) ──
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [makeUserRow({ id: id003 })],
        rowCount: 1,
      } as any);

      const page2 = await makeAdminCaller().listUsers({ cursor: id002, limit: 2 });
      expect(page2.nextCursor).toBeNull();
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).toBe(id003);
    });
  });

  // -------------------------------------------------------------------------
  // Limit parameter plumbing
  // -------------------------------------------------------------------------

  describe('limit parameter', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      // $1 = limit+1 = 21
      expect(params[0]).toBe(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({ limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      expect(params[0]).toBe(3);
    });

    it('uses default limit of 20 when no input provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // Input is optional on betaDashboard.listUsers
      await makeAdminCaller().listUsers(undefined);

      const [, params] = (mockDb.query as any).mock.calls[1];
      // default limit=20, so $1 = 21
      expect(params[0]).toBe(21);
    });
  });
});
