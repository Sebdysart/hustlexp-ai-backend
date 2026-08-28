/**
 * Instant Router Unit Tests — offset-based pagination for listAvailable
 *
 * Tests that instant.listAvailable returns a plain mapped array with
 * limit-only pagination (no offset — just LIMIT $1).
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

vi.mock('../../src/services/TaskService', () => ({
  TaskService: { accept: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { instantRouter } from '../../src/routers/instant';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TaskRow = {
  id: string;
  title: string;
  description: string;
  price: number;
  location: string | null;
  created_at: Date;
};

function makeTask(overrides: Partial<TaskRow & { id: string }> = {}): TaskRow {
  const id = overrides.id ?? `task-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    title: 'Test Task',
    description: 'Do the thing',
    price: 5000,
    location: null,
    created_at: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeCaller(userId = 'user-abc') {
  const fakeUser = {
    id: userId,
    email: 'user@hustlexp.com',
    full_name: 'Test User',
    role: 'hustler',
    trust_tier: 4,
    firebase_uid: 'fb-user',
    default_mode: 'worker',
  };
  return instantRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-user',
  });
}

// ===========================================================================
// instant.listAvailable — limit-only pagination (returns array)
// ===========================================================================

describe('instant.listAvailable — limit-only pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape — plain array
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns an array (not { items, nextCursor })', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeTask({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeCaller().listAvailable({ limit: 20 });

      expect(Array.isArray(result)).toBe(true);
    });

    it('returns mapped task objects with camelCase fields and waitingSeconds', async () => {
      const tasks = [makeTask({ id: 'aaa', title: 'Mow the lawn' })];
      mockDb.query.mockResolvedValueOnce({ rows: tasks, rowCount: 1 } as any);

      const result = await makeCaller().listAvailable({ limit: 20 });

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Mow the lawn');
      expect(result[0].id).toBe('aaa');
      expect(typeof result[0].waitingSeconds).toBe('number');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pagination — limit passed to query (no offset)
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('passes limit to db.query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listAvailable({ limit: 15 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('LIMIT');
      expect(params).toContain(15);
    });

    it('uses default limit=20 when not provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listAvailable();

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('LIMIT');
      expect(params).toContain(20);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Empty result
  // -------------------------------------------------------------------------

  describe('empty result', () => {
    it('returns empty array when no results', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeCaller().listAvailable({ limit: 20 });

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple items
  // -------------------------------------------------------------------------

  describe('multiple items', () => {
    it('returns multiple tasks in the array', async () => {
      const rows = [
        makeTask({ id: 'aaa' }),
        makeTask({ id: 'bbb' }),
        makeTask({ id: 'ccc' }),
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeCaller().listAvailable({ limit: 50 });

      expect(result).toHaveLength(3);
      expect(result.map((t: any) => t.id)).toEqual(['aaa', 'bbb', 'ccc']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Existing filters preserved
  // -------------------------------------------------------------------------

  describe('existing filters preserved', () => {
    it('filters by mode=LIVE and state=OPEN and worker_id IS NULL', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listAvailable({ limit: 20 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain("mode = 'LIVE'");
      expect(sql).toContain("state = 'OPEN'");
      expect(sql).toContain('worker_id IS NULL');
    });
  });
});
