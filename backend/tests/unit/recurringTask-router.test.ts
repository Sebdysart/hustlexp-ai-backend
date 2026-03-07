/**
 * RecurringTask Router Unit Tests — cursor-based pagination
 *
 * Tests that recurringTask.listMine and recurringTask.listOccurrences
 * return { items, nextCursor } with correct cursor-based pagination semantics.
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
import { recurringTaskRouter } from '../../src/routers/recurringTask';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SeriesRow = {
  id: string;
  poster_id: string;
  template_task_id: string | null;
  pattern: string;
  day_of_week: number | null;
  day_of_month: number | null;
  time_of_day: string | null;
  start_date: string;
  end_date: string | null;
  title: string;
  description: string;
  payment_cents: number;
  location: string;
  category: string | null;
  estimated_duration: string;
  required_tier: number;
  status: string;
  occurrence_count: number;
  completed_count: number;
  preferred_worker_id: string | null;
  next_occurrence_at: string | null;
  created_at: string;
  updated_at: string;
  worker_name: string | null;
};

type OccurrenceRow = {
  id: string;
  series_id: string;
  task_id: string | null;
  occurrence_number: number;
  scheduled_date: string;
  status: string;
  worker_id: string | null;
  worker_name: string | null;
  completed_at: string | null;
  rating: number | null;
};

function makeSeries(overrides: Partial<SeriesRow & { id: string }> = {}): SeriesRow {
  const id = overrides.id ?? `series-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    poster_id: 'poster-abc',
    template_task_id: null,
    pattern: 'weekly',
    day_of_week: 1,
    day_of_month: null,
    time_of_day: '09:00',
    start_date: '2025-01-06',
    end_date: null,
    title: 'Weekly Cleaning',
    description: 'Clean the house every week',
    payment_cents: 5000,
    location: '123 Main St',
    category: 'cleaning',
    estimated_duration: '2 hours',
    required_tier: 1,
    status: 'active',
    occurrence_count: 0,
    completed_count: 0,
    preferred_worker_id: null,
    next_occurrence_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    updated_at: '2025-01-01T00:00:00.000Z',
    worker_name: null,
    ...overrides,
  };
}

function makeOccurrence(overrides: Partial<OccurrenceRow & { id: string }> = {}): OccurrenceRow {
  const id = overrides.id ?? `occ-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    series_id: 'series-abc',
    task_id: null,
    occurrence_number: 1,
    scheduled_date: '2025-01-06',
    status: 'scheduled',
    worker_id: null,
    worker_name: null,
    completed_at: null,
    rating: null,
    ...overrides,
  };
}

/** Create a caller for a poster user (trust_tier=3+). */
function makePosterCaller(userId = 'poster-abc') {
  const fakeUser = {
    id: userId,
    email: 'poster@hustlexp.com',
    full_name: 'Test Poster',
    role: 'poster',
    trust_tier: 3,
    plan: 'premium',
    firebase_uid: 'fb-poster',
  };
  return recurringTaskRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-poster',
  });
}

// ===========================================================================
// recurringTask.listMine — cursor-based pagination
// ===========================================================================

describe('recurringTask.listMine — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeSeries({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makePosterCaller().listMine({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of series objects', async () => {
      const series = [makeSeries({ id: 'aaa', title: 'Weekly Dog Walk' })];
      mockDb.query.mockResolvedValueOnce({ rows: series, rowCount: 1 } as any);

      const result = await makePosterCaller().listMine({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].title).toBe('Weekly Dog Walk');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const series = [makeSeries(), makeSeries(), makeSeries()];
      mockDb.query.mockResolvedValueOnce({ rows: series, rowCount: 3 } as any);

      const result = await makePosterCaller().listMine({ limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const series = [makeSeries({ id: 'aaa' }), makeSeries({ id: 'bbb' })];
      mockDb.query.mockResolvedValueOnce({ rows: series, rowCount: 2 } as any);

      const result = await makePosterCaller().listMine({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makePosterCaller().listMine({ limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. nextCursor: non-null when more results exist (sentinel detected)
  // -------------------------------------------------------------------------

  describe('nextCursor — more pages exist', () => {
    it('is the id of the last visible item when there is a next page', async () => {
      const series = [
        makeSeries({ id: 'id-aaa' }),
        makeSeries({ id: 'id-bbb' }),
        makeSeries({ id: 'id-ccc' }), // sentinel row
      ];
      mockDb.query.mockResolvedValueOnce({ rows: series, rowCount: 3 } as any);

      const result = await makePosterCaller().listMine({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((s: any) => s.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition present in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listMine({
        cursor: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        limit: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('rts.id >');
      expect(params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('does not add rts.id > clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listMine({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).not.toContain('rts.id >');
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listMine({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listMine({ limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(3);
    });
  });
});

// ===========================================================================
// recurringTask.listOccurrences — cursor-based pagination
// ===========================================================================

describe('recurringTask.listOccurrences — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SERIES_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  /** For listOccurrences: ownership check fires first, then the main query. */
  function setupOwnerAndOccurrences(rows: OccurrenceRow[]) {
    // Ownership check → passes
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any);
    // listOccurrences data query
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: rows.length } as any);
  }

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      setupOwnerAndOccurrences([makeOccurrence({ id: 'aaa' })]);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of occurrence objects', async () => {
      const occs = [makeOccurrence({ id: 'aaa', occurrence_number: 7 })];
      setupOwnerAndOccurrences(occs);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].occurrenceNumber).toBe(7);
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const occs = [makeOccurrence(), makeOccurrence()];
      setupOwnerAndOccurrences(occs);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const occs = [makeOccurrence({ id: 'aaa' }), makeOccurrence({ id: 'bbb' })];
      setupOwnerAndOccurrences(occs);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      setupOwnerAndOccurrences([]);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. nextCursor: non-null when more results exist
  // -------------------------------------------------------------------------

  describe('nextCursor — more pages exist', () => {
    it('is the id of the last visible item when there is a next page', async () => {
      const occs = [
        makeOccurrence({ id: 'id-aaa' }),
        makeOccurrence({ id: 'id-bbb' }),
        makeOccurrence({ id: 'id-ccc' }), // sentinel row
      ];
      setupOwnerAndOccurrences(occs);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((o: any) => o.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition present in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      // Ownership check
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any);
      // listOccurrences query
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listOccurrences({
        seriesId: SERIES_ID,
        cursor: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        limit: 5,
      });

      const calls = (mockDb.query as any).mock.calls;
      const [sql, params] = calls[1]; // calls[0] is ownership check
      expect(sql).toContain('rto.id >');
      expect(params).toContain('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee');
    });

    it('does not add rto.id > clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).not.toContain('rto.id >');
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      expect(params).toContain(3);
    });
  });
});
