/**
 * Instant Router Unit Tests — cursor-based pagination for listAvailable
 *
 * Tests that instant.listAvailable returns { items, nextCursor } with correct
 * cursor-based pagination semantics.
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
  };
  return instantRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-user',
  });
}

// ===========================================================================
// instant.listAvailable — cursor-based pagination
// ===========================================================================

describe('instant.listAvailable — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeTask({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeCaller().listAvailable({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of task objects', async () => {
      const tasks = [makeTask({ id: 'aaa', title: 'Mow the lawn' })];
      mockDb.query.mockResolvedValueOnce({ rows: tasks, rowCount: 1 } as any);

      const result = await makeCaller().listAvailable({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Mow the lawn');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const rows = [makeTask(), makeTask(), makeTask()];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeCaller().listAvailable({ limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const rows = [makeTask({ id: 'aaa' }), makeTask({ id: 'bbb' })];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as any);

      const result = await makeCaller().listAvailable({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeCaller().listAvailable({ limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. nextCursor: non-null when more results exist (sentinel detected)
  // -------------------------------------------------------------------------

  describe('nextCursor — more pages exist', () => {
    it('is the id of the last visible item when there is a next page', async () => {
      const rows = [
        makeTask({ id: 'id-aaa' }),
        makeTask({ id: 'id-bbb' }),
        makeTask({ id: 'id-ccc' }), // sentinel row
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeCaller().listAvailable({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((t: any) => t.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listAvailable({
        cursor: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        limit: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('id >');
      expect(params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('does not add cursor clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listAvailable({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      // Should not have a WHERE id > clause
      expect(sql).not.toMatch(/AND\s+id\s*>/);
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listAvailable({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listAvailable({ limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(3);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Existing filters preserved
  // -------------------------------------------------------------------------

  describe('existing filters preserved', () => {
    it('still filters by mode=LIVE and state=OPEN and worker_id IS NULL', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listAvailable({ limit: 20 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain("mode = 'LIVE'");
      expect(sql).toContain("state = 'OPEN'");
      expect(sql).toContain('worker_id IS NULL');
    });
  });
});
