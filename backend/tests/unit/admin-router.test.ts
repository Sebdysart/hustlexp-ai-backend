/**
 * Admin Router Unit Tests — offset-based pagination
 *
 * Tests all three admin list endpoints (listUsers, listTasks, listDisputes)
 * which use standard { limit, offset } pagination returning { collection, total }.
 *
 * Each list procedure makes 2 db.query calls:
 *   1. Data query (SELECT ... LIMIT $N OFFSET $M)
 *   2. Count query (SELECT COUNT(*) ... without limit/offset)
 *
 * Pattern: mock db at module level, use createCaller with a fake admin
 * context to bypass middleware, then call procedures directly.
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
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
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
 *   call 2: the actual data query → returns `dataRows`
 *   call 3: the count query → returns total count
 */
function setupAdminAndUsers(userRows: UserRow[], totalCount?: number) {
  const count = totalCount ?? userRows.length;
  // Admin role check
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  // Data query
  mockDb.query.mockResolvedValueOnce({ rows: userRows, rowCount: userRows.length } as any);
  // Count query
  mockDb.query.mockResolvedValueOnce({ rows: [{ count: String(count) }], rowCount: 1 } as any);
}

// ---------------------------------------------------------------------------
// Tests — admin.listUsers
// ---------------------------------------------------------------------------

describe('admin.listUsers — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Return shape — verifies the API contract { users, total }
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { users, total }', async () => {
      setupAdminAndUsers([makeUser({ id: 'aaa' })]);

      const caller = makeAdminCaller();
      const result = await caller.listUsers({ limit: 20, offset: 0 });

      expect(result).toHaveProperty('users');
      expect(result).toHaveProperty('total');
      expect(typeof result.total).toBe('number');
    });

    it('users is an array of user objects', async () => {
      const users = [makeUser({ id: 'aaa', email: 'a@test.com' })];
      setupAdminAndUsers(users);

      const result = await makeAdminCaller().listUsers({ limit: 20, offset: 0 });

      expect(Array.isArray(result.users)).toBe(true);
      expect(result.users).toHaveLength(1);
      expect(result.users[0].email).toBe('a@test.com');
    });

    it('total reflects the full count, not the page size', async () => {
      // Page has 2 users, but total is 50
      const users = [makeUser(), makeUser()];
      setupAdminAndUsers(users, 50);

      const result = await makeAdminCaller().listUsers({ limit: 2, offset: 0 });

      expect(result.users).toHaveLength(2);
      expect(result.total).toBe(50);
    });
  });

  // -------------------------------------------------------------------------
  // Pagination behaviour
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('passes limit and offset to db.query', async () => {
      setupAdminAndUsers([]);

      await makeAdminCaller().listUsers({ limit: 25, offset: 50 });

      const calls = (mockDb.query as any).mock.calls;
      // calls[0] = admin check, calls[1] = data query, calls[2] = count query
      const [sql, params] = calls[1];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(25);
      expect(params).toContain(50);
    });

    it('returns empty array when no users found', async () => {
      setupAdminAndUsers([], 0);

      const result = await makeAdminCaller().listUsers({ limit: 20, offset: 0 });

      expect(result.users).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('makes 3 db.query calls (admin check + data + count)', async () => {
      setupAdminAndUsers([makeUser()]);

      await makeAdminCaller().listUsers({ limit: 20, offset: 0 });

      expect(mockDb.query).toHaveBeenCalledTimes(3);
    });

    it('count query excludes limit/offset params', async () => {
      setupAdminAndUsers([]);

      await makeAdminCaller().listUsers({ limit: 20, offset: 10 });

      const calls = (mockDb.query as any).mock.calls;
      const countCall = calls[2]; // third call is count
      const [countSql] = countCall;
      expect(countSql).toContain('COUNT(*)');
      expect(countSql).not.toContain('LIMIT');
      expect(countSql).not.toContain('OFFSET');
    });
  });

  // -------------------------------------------------------------------------
  // Optional filters
  // -------------------------------------------------------------------------

  describe('optional filters', () => {
    it('passes search filter as ILIKE parameter on both full_name and email', async () => {
      setupAdminAndUsers([]);

      await makeAdminCaller().listUsers({ limit: 10, offset: 0, search: 'alice' });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('ILIKE');
      expect(params).toContain('%alice%');
      // Both OR branches must reference the same $N
      const ilikeParts = sql.match(/ILIKE \$(\d+)/g);
      expect(ilikeParts).toHaveLength(2);
      expect(ilikeParts![0]).toBe(ilikeParts![1]);
    });

    it('passes trustTier filter as a SQL parameter', async () => {
      setupAdminAndUsers([]);

      await makeAdminCaller().listUsers({ limit: 10, offset: 0, trustTier: '2' });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('trust_tier =');
      expect(params).toContain('2');
    });

    it('passes isBanned filter as a SQL parameter', async () => {
      setupAdminAndUsers([]);

      await makeAdminCaller().listUsers({ limit: 10, offset: 0, isBanned: true });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('is_banned =');
      expect(params).toContain(true);
    });

    it('accepts default limit of 20 when limit not provided', async () => {
      setupAdminAndUsers([]);

      await makeAdminCaller().listUsers({});

      const [, params] = (mockDb.query as any).mock.calls[1];
      // Default limit=20, default offset=0
      expect(params).toContain(20);
      expect(params).toContain(0);
    });
  });

  // -------------------------------------------------------------------------
  // Ordering
  // -------------------------------------------------------------------------

  describe('ordering', () => {
    it('orders results by created_at DESC', async () => {
      setupAdminAndUsers([]);

      await makeAdminCaller().listUsers({ limit: 10, offset: 0 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('ORDER BY u.created_at DESC');
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

function setupAdminAndTasks(taskRows: TaskRow[], totalCount?: number) {
  const count = totalCount ?? taskRows.length;
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  mockDb.query.mockResolvedValueOnce({ rows: taskRows, rowCount: taskRows.length } as any);
  mockDb.query.mockResolvedValueOnce({ rows: [{ count: String(count) }], rowCount: 1 } as any);
}

// =============================================================================
// admin.listTasks — offset-based pagination
// =============================================================================

describe('admin.listTasks — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns { tasks, total }', async () => {
      setupAdminAndTasks([makeTask({ id: 'aaa' })]);

      const result = await makeAdminCaller().listTasks({ limit: 20, offset: 0 });

      expect(result).toHaveProperty('tasks');
      expect(result).toHaveProperty('total');
      expect(typeof result.total).toBe('number');
    });

    it('tasks is an array of task objects', async () => {
      const tasks = [makeTask({ id: 'aaa', title: 'Fix the leak' })];
      setupAdminAndTasks(tasks);

      const result = await makeAdminCaller().listTasks({ limit: 20, offset: 0 });

      expect(Array.isArray(result.tasks)).toBe(true);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].title).toBe('Fix the leak');
    });

    it('total reflects the full count, not the page size', async () => {
      const tasks = [makeTask(), makeTask()];
      setupAdminAndTasks(tasks, 120);

      const result = await makeAdminCaller().listTasks({ limit: 2, offset: 0 });

      expect(result.tasks).toHaveLength(2);
      expect(result.total).toBe(120);
    });
  });

  describe('pagination', () => {
    it('passes limit and offset to db.query', async () => {
      setupAdminAndTasks([]);

      await makeAdminCaller().listTasks({ limit: 10, offset: 30 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(10);
      expect(params).toContain(30);
    });

    it('returns empty array when no tasks found', async () => {
      setupAdminAndTasks([], 0);

      const result = await makeAdminCaller().listTasks({ limit: 20, offset: 0 });

      expect(result.tasks).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('makes 3 db.query calls (admin check + data + count)', async () => {
      setupAdminAndTasks([makeTask()]);

      await makeAdminCaller().listTasks({ limit: 20, offset: 0 });

      expect(mockDb.query).toHaveBeenCalledTimes(3);
    });
  });

  describe('optional filters', () => {
    it('passes state filter as a SQL parameter', async () => {
      setupAdminAndTasks([]);

      await makeAdminCaller().listTasks({ limit: 10, offset: 0, state: 'OPEN' });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('t.state =');
      expect(params).toContain('OPEN');
    });
  });

  describe('ordering', () => {
    it('orders results by created_at DESC', async () => {
      setupAdminAndTasks([]);

      await makeAdminCaller().listTasks({ limit: 10, offset: 0 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('ORDER BY t.created_at DESC');
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

function setupAdminAndDisputes(disputeRows: DisputeRow[], totalCount?: number) {
  const count = totalCount ?? disputeRows.length;
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  mockDb.query.mockResolvedValueOnce({ rows: disputeRows, rowCount: disputeRows.length } as any);
  mockDb.query.mockResolvedValueOnce({ rows: [{ count: String(count) }], rowCount: 1 } as any);
}

// =============================================================================
// admin.listDisputes — offset-based pagination
// =============================================================================

describe('admin.listDisputes — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns { disputes, total }', async () => {
      setupAdminAndDisputes([makeDispute({ id: 'aaa' })]);

      const result = await makeAdminCaller().listDisputes({ limit: 20, offset: 0 });

      expect(result).toHaveProperty('disputes');
      expect(result).toHaveProperty('total');
      expect(typeof result.total).toBe('number');
    });

    it('disputes is an array of dispute objects', async () => {
      const disputes = [makeDispute({ id: 'aaa', reason: 'Work not done' })];
      setupAdminAndDisputes(disputes);

      const result = await makeAdminCaller().listDisputes({ limit: 20, offset: 0 });

      expect(Array.isArray(result.disputes)).toBe(true);
      expect(result.disputes).toHaveLength(1);
      expect(result.disputes[0].reason).toBe('Work not done');
    });

    it('total reflects the full count, not the page size', async () => {
      const disputes = [makeDispute()];
      setupAdminAndDisputes(disputes, 35);

      const result = await makeAdminCaller().listDisputes({ limit: 1, offset: 0 });

      expect(result.disputes).toHaveLength(1);
      expect(result.total).toBe(35);
    });
  });

  describe('pagination', () => {
    it('passes limit and offset to db.query', async () => {
      setupAdminAndDisputes([]);

      await makeAdminCaller().listDisputes({ limit: 15, offset: 45 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(15);
      expect(params).toContain(45);
    });

    it('returns empty array when no disputes found', async () => {
      setupAdminAndDisputes([], 0);

      const result = await makeAdminCaller().listDisputes({ limit: 20, offset: 0 });

      expect(result.disputes).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('makes 3 db.query calls (admin check + data + count)', async () => {
      setupAdminAndDisputes([makeDispute()]);

      await makeAdminCaller().listDisputes({ limit: 20, offset: 0 });

      expect(mockDb.query).toHaveBeenCalledTimes(3);
    });
  });

  describe('optional filters', () => {
    it('passes status filter as a SQL parameter', async () => {
      setupAdminAndDisputes([]);

      await makeAdminCaller().listDisputes({ limit: 10, offset: 0, status: 'OPEN' });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('d.state =');
      expect(params).toContain('OPEN');
    });
  });

  describe('ordering', () => {
    it('orders results by created_at DESC', async () => {
      setupAdminAndDisputes([]);

      await makeAdminCaller().listDisputes({ limit: 10, offset: 0 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('ORDER BY d.created_at DESC');
    });
  });
});
