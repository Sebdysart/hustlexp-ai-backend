/**
 * Live Router Unit Tests — offset-based pagination for listBroadcasts
 *
 * Tests that live.listBroadcasts returns a plain mapped array with
 * offset-based pagination (LIMIT/OFFSET).
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
// live.listBroadcasts — offset-based pagination (returns array)
// ===========================================================================

describe('live.listBroadcasts — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape — plain array
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns an array (not { items, nextCursor })', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeBroadcast({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 20 });

      expect(Array.isArray(result)).toBe(true);
    });

    it('returns mapped broadcast objects with nested task property', async () => {
      const broadcasts = [makeBroadcast({ id: 'aaa', task_title: 'Fix my pipes', task_price: 7500 })];
      mockDb.query.mockResolvedValueOnce({ rows: broadcasts, rowCount: 1 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 20 });

      expect(result).toHaveLength(1);
      expect(result[0].task.title).toBe('Fix my pipes');
      expect(result[0].task.price).toBe(7500);
      expect(result[0].id).toBe('aaa');
      expect(result[0].startedAt).toBe('2025-01-01T00:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pagination — limit/offset passed to query
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('passes limit and offset to db.query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 25, offset: 10 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(25);
      expect(params).toContain(10);
    });

    it('uses default limit=50 and offset=0 when not provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({ ...BASE_INPUT });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(50);
      expect(params).toContain(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Empty result
  // -------------------------------------------------------------------------

  describe('empty result', () => {
    it('returns empty array when no results', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 20 });

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple items
  // -------------------------------------------------------------------------

  describe('multiple items', () => {
    it('returns multiple broadcasts in the array', async () => {
      const rows = [
        makeBroadcast({ id: 'aaa' }),
        makeBroadcast({ id: 'bbb' }),
        makeBroadcast({ id: 'ccc' }),
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 50 });

      expect(result).toHaveLength(3);
      expect(result.map((b: any) => b.id)).toEqual(['aaa', 'bbb', 'ccc']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Existing filters preserved
  // -------------------------------------------------------------------------

  describe('existing filters preserved', () => {
    it('filters by radiusMiles as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({ ...BASE_INPUT, radiusMiles: 10, limit: 20 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('final_radius_miles');
      expect(params).toContain(10);
    });

    it('filters by expired_at IS NULL and accepted_at IS NULL', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().listBroadcasts({ ...BASE_INPUT, limit: 20 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('expired_at IS NULL');
      expect(sql).toContain('accepted_at IS NULL');
    });
  });
});
