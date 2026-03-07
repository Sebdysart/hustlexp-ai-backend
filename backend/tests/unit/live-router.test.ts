/**
 * Live Router Unit Tests — cursor-based pagination for listBroadcasts
 *
 * Tests that live.listBroadcasts returns { items, nextCursor } with correct
 * cursor-based pagination semantics.
 *
 * Pattern: mock db at module level, use createCaller with a fake protected
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
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { liveRouter } from '../../src/routers/live';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type BroadcastRow = {
  id: string;
  task_id: string;
  started_at: Date;
  expired_at: Date | null;
  initial_radius_miles: number;
  final_radius_miles: number | null;
  hustlers_notified: number;
  hustlers_viewed: number;
  task_title: string;
  task_price: number;
  task_location: string | null;
  task_category: string | null;
  task_deadline: Date | null;
};

function makeBroadcast(overrides: Partial<BroadcastRow & { id: string }> = {}): BroadcastRow {
  const id = overrides.id ?? `bc-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    task_id: 'task-abc',
    started_at: new Date('2025-01-01T00:00:00Z'),
    expired_at: null,
    initial_radius_miles: 5,
    final_radius_miles: null,
    hustlers_notified: 0,
    hustlers_viewed: 0,
    task_title: 'Test Task',
    task_price: 5000,
    task_location: null,
    task_category: null,
    task_deadline: null,
    ...overrides,
  };
}

/** Create a caller for a regular user. */
function makeCaller(userId = 'user-abc') {
  const fakeUser = {
    id: userId,
    email: 'user@hustlexp.com',
    full_name: 'Test User',
    role: 'hustler',
    trust_tier: 4,
    firebase_uid: 'fb-user',
    live_mode_banned_until: null,
    live_mode_state: 'ACTIVE',
    live_mode_session_started_at: null,
    live_mode_total_tasks: 0,
    live_mode_completion_rate: 0,
  };
  return liveRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-user',
  });
}

const BASE_INPUT = { latitude: 47.6062, longitude: -122.3321, radiusMiles: 5 };

// ===========================================================================
// live.listBroadcasts — cursor-based pagination
// ===========================================================================

describe('live.listBroadcasts — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeBroadcast({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of broadcast objects with task property', async () => {
      const broadcasts = [makeBroadcast({ id: 'aaa', task_title: 'Fix my pipes' })];
      mockDb.query.mockResolvedValueOnce({ rows: broadcasts, rowCount: 1 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].task.title).toBe('Fix my pipes');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const rows = [makeBroadcast(), makeBroadcast(), makeBroadcast()];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const rows = [makeBroadcast({ id: 'aaa' }), makeBroadcast({ id: 'bbb' })];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 20 });

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
        makeBroadcast({ id: 'id-aaa' }),
        makeBroadcast({ id: 'id-bbb' }),
        makeBroadcast({ id: 'id-ccc' }), // sentinel row
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((b: any) => b.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({
        ...BASE_INPUT,
        cursor: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        limit: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('lb.started_at <');
      expect(params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('does not add cursor clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).not.toContain('lb.started_at <');
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(3);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Existing filters preserved
  // -------------------------------------------------------------------------

  describe('existing filters preserved', () => {
    it('still filters by radiusMiles as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({ ...BASE_INPUT, radiusMiles: 10, limit: 20 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('final_radius_miles');
      expect(params).toContain(10);
    });

    it('still filters by expired_at IS NULL and accepted_at IS NULL', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 20 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('expired_at IS NULL');
      expect(sql).toContain('accepted_at IS NULL');
    });
  });
});
