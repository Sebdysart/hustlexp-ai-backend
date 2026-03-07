/**
 * Admin Router Unit Tests — listUsers cursor-based pagination
 *
 * Tests that admin.listUsers returns { items, nextCursor } with correct
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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { adminRouter } from '../../src/routers/admin';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type UserRow = {
  id: string;
  full_name: string;
  email: string;
  trust_tier: string;
  xp_total: number;
  is_verified: boolean;
  is_banned: boolean;
  default_mode: string;
  created_at: Date;
  stripe_connect_id: string | null;
};

function makeUser(overrides: Partial<UserRow & { id: string }> = {}): UserRow {
  const id = overrides.id ?? `user-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    full_name: 'Test User',
    email: 'test@example.com',
    trust_tier: 'ROOKIE',
    xp_total: 0,
    is_verified: false,
    is_banned: false,
    default_mode: 'hustler',
    created_at: new Date('2025-01-01T00:00:00Z'),
    stripe_connect_id: null,
    ...overrides,
  };
}

/**
 * Create a tRPC caller for the admin router with a pre-authenticated admin
 * context. The adminProcedure middleware calls db.query to check admin_roles;
 * we set that up as the first mock call so we can control subsequent ones.
 */
function makeAdminCaller() {
  const fakeAdminUser = {
    id: 'admin-user-id',
    email: 'admin@hustlexp.com',
    full_name: 'Admin User',
    role: 'admin',
    firebase_uid: 'fb-admin',
  };
  return adminRouter.createCaller({
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
  // Admin role check
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  // listUsers data query
  mockDb.query.mockResolvedValueOnce({ rows: userRows, rowCount: userRows.length } as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('admin.listUsers — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Return shape — verifies the new API contract { items, nextCursor }
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } instead of { users, total }', async () => {
      setupAdminAndUsers([makeUser({ id: 'aaa' })]);

      const caller = makeAdminCaller();
      const result = await caller.listUsers({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
      // Old shape should NOT be present
      expect(result).not.toHaveProperty('users');
      expect(result).not.toHaveProperty('total');
    });

    it('items is an array of user objects', async () => {
      const users = [makeUser({ id: 'aaa', email: 'a@test.com' })];
      setupAdminAndUsers(users);

      const result = await makeAdminCaller().listUsers({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].email).toBe('a@test.com');
    });
  });

  // -------------------------------------------------------------------------
  // nextCursor behaviour
  // -------------------------------------------------------------------------

  describe('nextCursor', () => {
    it('is null when results < limit (last page)', async () => {
      // limit=100 but only 3 rows → DB returned fewer than limit+1 → no next page
      const users = [makeUser(), makeUser(), makeUser()];
      setupAdminAndUsers(users);

      const result = await makeAdminCaller().listUsers({ limit: 100 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      // limit=2, DB returned exactly 2 rows (limit+1=3 was requested but only 2 exist)
      const users = [makeUser({ id: 'aaa' }), makeUser({ id: 'bbb' })];
      setupAdminAndUsers(users);

      const result = await makeAdminCaller().listUsers({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is the id of the last visible item when there is a next page', async () => {
      // limit=2, DB returns 3 rows (limit+1) → sentinel detected → next page exists
      const users = [
        makeUser({ id: 'id-aaa' }),
        makeUser({ id: 'id-bbb' }),
        makeUser({ id: 'id-ccc' }), // sentinel row
      ];
      setupAdminAndUsers(users);

      const result = await makeAdminCaller().listUsers({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');   // last of the visible items
      expect(result.items).toHaveLength(2);         // sentinel excluded from items
      expect(result.items.map((u: UserRow) => u.id)).toEqual(['id-aaa', 'id-bbb']);
    });

    it('nextCursor is null for empty result set', async () => {
      setupAdminAndUsers([]);

      const result = await makeAdminCaller().listUsers({ limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Cursor forwarding — the cursor must appear in the SQL query params
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      // Admin check + listUsers query
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({
        cursor: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        limit: 5,
      });

      // The second db.query call is listUsers
      const calls = (mockDb.query as any).mock.calls;
      const listUsersCall = calls[1]; // calls[0] is the admin_roles check
      const [sql, params] = listUsersCall;

      expect(sql).toContain('u.id >');
      expect(params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('does not add u.id > clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({ limit: 10 });

      const calls = (mockDb.query as any).mock.calls;
      const [sql] = calls[1];
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
          makeUser({ id: id001 }),
          makeUser({ id: id002 }),
          makeUser({ id: id003 }), // sentinel
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
        rows: [makeUser({ id: id003 })],
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

      const calls = (mockDb.query as any).mock.calls;
      const [, params] = calls[1];
      // First SQL param ($1) must be limit+1 = 21
      expect(params[0]).toBe(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({ limit: 2 });

      const calls = (mockDb.query as any).mock.calls;
      const [, params] = calls[1];
      expect(params[0]).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Optional filters
  // -------------------------------------------------------------------------

  describe('optional filters', () => {
    it('passes role filter as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({ limit: 10, role: 'hustler' });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('u.role =');
      expect(params).toContain('hustler');
    });

    it('passes search filter as an ILIKE parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listUsers({ limit: 10, search: 'alice' });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('ILIKE');
      expect(params).toContain('%alice%');
      // Both OR branches must reference the same $N — guards against the fragile
      // double-push pattern where params.push() and params.length could diverge.
      const ilikeParts = sql.match(/ILIKE \$(\d+)/g);
      expect(ilikeParts).toHaveLength(2);
      expect(ilikeParts![0]).toBe(ilikeParts![1]); // both reference same $N
    });

    it('accepts default limit of 20 when limit not provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      // Zod default(20) — calling without limit
      await makeAdminCaller().listUsers({});

      const [, params] = (mockDb.query as any).mock.calls[1];
      // $1 = limit+1 = 21
      expect(params[0]).toBe(21);
    });
  });
});

// =============================================================================
// Task row type and helpers
// =============================================================================

type TaskRow = {
  id: string;
  title: string;
  state: string;
  price: number;
  poster_id: string;
  worker_id: string | null;
  created_at: Date;
  poster_name: string;
  worker_name: string | null;
};

function makeTask(overrides: Partial<TaskRow & { id: string }> = {}): TaskRow {
  const id = overrides.id ?? `task-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    title: 'Test Task',
    state: 'open',
    price: 5000,
    poster_id: 'poster-id',
    worker_id: null,
    created_at: new Date('2025-01-01T00:00:00Z'),
    poster_name: 'Test Poster',
    worker_name: null,
    ...overrides,
  };
}

/**
 * Set up the mock so that:
 *   call 1: admin_roles check → returns 1 row (grants access)
 *   call 2: the actual listTasks query → returns `taskRows`
 */
function setupAdminAndTasks(taskRows: TaskRow[]) {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  mockDb.query.mockResolvedValueOnce({ rows: taskRows, rowCount: taskRows.length } as any);
}

// =============================================================================
// admin.listTasks — cursor-based pagination
// =============================================================================

describe('admin.listTasks — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } instead of { tasks, total }', async () => {
      setupAdminAndTasks([makeTask({ id: 'aaa' })]);

      const result = await makeAdminCaller().listTasks({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
      expect(result).not.toHaveProperty('tasks');
      expect(result).not.toHaveProperty('total');
    });

    it('items is an array of task objects', async () => {
      const tasks = [makeTask({ id: 'aaa', title: 'Fix the leak' })];
      setupAdminAndTasks(tasks);

      const result = await makeAdminCaller().listTasks({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Fix the leak');
    });
  });

  // -------------------------------------------------------------------------
  // nextCursor behaviour
  // -------------------------------------------------------------------------

  describe('nextCursor', () => {
    it('is null when results < limit (last page)', async () => {
      const tasks = [makeTask(), makeTask(), makeTask()];
      setupAdminAndTasks(tasks);

      const result = await makeAdminCaller().listTasks({ limit: 100 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const tasks = [makeTask({ id: 'aaa' }), makeTask({ id: 'bbb' })];
      setupAdminAndTasks(tasks);

      const result = await makeAdminCaller().listTasks({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is the id of the last visible item when there is a next page', async () => {
      const tasks = [
        makeTask({ id: 'id-aaa' }),
        makeTask({ id: 'id-bbb' }),
        makeTask({ id: 'id-ccc' }), // sentinel
      ];
      setupAdminAndTasks(tasks);

      const result = await makeAdminCaller().listTasks({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((t: TaskRow) => t.id)).toEqual(['id-aaa', 'id-bbb']);
    });

    it('nextCursor is null for empty result set', async () => {
      setupAdminAndTasks([]);

      const result = await makeAdminCaller().listTasks({ limit: 20 });

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

      await makeAdminCaller().listTasks({
        cursor: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        limit: 5,
      });

      const calls = (mockDb.query as any).mock.calls;
      const [sql, params] = calls[1];

      expect(sql).toContain('t.id >');
      expect(params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('does not add t.id > clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listTasks({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).not.toContain('t.id >');
    });
  });

  // -------------------------------------------------------------------------
  // Limit parameter plumbing
  // -------------------------------------------------------------------------

  describe('limit parameter', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listTasks({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      expect(params[0]).toBe(21);
    });
  });

  // -------------------------------------------------------------------------
  // Optional filters
  // -------------------------------------------------------------------------

  describe('optional filters', () => {
    it('passes state filter as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listTasks({ limit: 10, state: 'open' });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('t.state =');
      expect(params).toContain('open');
    });
  });
});

// =============================================================================
// Dispute row type and helpers
// =============================================================================

type DisputeRow = {
  id: string;
  task_id: string;
  status: string;
  reason: string;
  created_at: Date;
  task_title: string;
};

function makeDispute(overrides: Partial<DisputeRow & { id: string }> = {}): DisputeRow {
  const id = overrides.id ?? `dispute-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    task_id: 'task-id',
    status: 'open',
    reason: 'Test dispute reason',
    created_at: new Date('2025-01-01T00:00:00Z'),
    task_title: 'Test Task',
    ...overrides,
  };
}

/**
 * Set up the mock so that:
 *   call 1: admin_roles check → returns 1 row (grants access)
 *   call 2: the actual listDisputes query → returns `disputeRows`
 */
function setupAdminAndDisputes(disputeRows: DisputeRow[]) {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  mockDb.query.mockResolvedValueOnce({ rows: disputeRows, rowCount: disputeRows.length } as any);
}

// =============================================================================
// admin.listDisputes — cursor-based pagination
// =============================================================================

describe('admin.listDisputes — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } instead of { disputes, total }', async () => {
      setupAdminAndDisputes([makeDispute({ id: 'aaa' })]);

      const result = await makeAdminCaller().listDisputes({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
      expect(result).not.toHaveProperty('disputes');
      expect(result).not.toHaveProperty('total');
    });

    it('items is an array of dispute objects', async () => {
      const disputes = [makeDispute({ id: 'aaa', reason: 'Work not done' })];
      setupAdminAndDisputes(disputes);

      const result = await makeAdminCaller().listDisputes({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].reason).toBe('Work not done');
    });
  });

  // -------------------------------------------------------------------------
  // nextCursor behaviour
  // -------------------------------------------------------------------------

  describe('nextCursor', () => {
    it('is null when results < limit (last page)', async () => {
      const disputes = [makeDispute(), makeDispute()];
      setupAdminAndDisputes(disputes);

      const result = await makeAdminCaller().listDisputes({ limit: 100 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const disputes = [makeDispute({ id: 'aaa' }), makeDispute({ id: 'bbb' })];
      setupAdminAndDisputes(disputes);

      const result = await makeAdminCaller().listDisputes({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is the id of the last visible item when there is a next page', async () => {
      const disputes = [
        makeDispute({ id: 'id-aaa' }),
        makeDispute({ id: 'id-bbb' }),
        makeDispute({ id: 'id-ccc' }), // sentinel
      ];
      setupAdminAndDisputes(disputes);

      const result = await makeAdminCaller().listDisputes({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((d: DisputeRow) => d.id)).toEqual(['id-aaa', 'id-bbb']);
    });

    it('nextCursor is null for empty result set', async () => {
      setupAdminAndDisputes([]);

      const result = await makeAdminCaller().listDisputes({ limit: 20 });

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

      await makeAdminCaller().listDisputes({
        cursor: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        limit: 5,
      });

      const calls = (mockDb.query as any).mock.calls;
      const [sql, params] = calls[1];

      expect(sql).toContain('d.id >');
      expect(params).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    });

    it('does not add d.id > clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listDisputes({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).not.toContain('d.id >');
    });
  });

  // -------------------------------------------------------------------------
  // Limit parameter plumbing
  // -------------------------------------------------------------------------

  describe('limit parameter', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listDisputes({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      expect(params[0]).toBe(21);
    });
  });

  // -------------------------------------------------------------------------
  // Optional filters
  // -------------------------------------------------------------------------

  describe('optional filters', () => {
    it('passes status filter as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeAdminCaller().listDisputes({ limit: 10, status: 'open' });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('d.status =');
      expect(params).toContain('open');
    });
  });
});
