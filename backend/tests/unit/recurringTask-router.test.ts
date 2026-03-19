/**
 * RecurringTask Router Unit Tests — offset-based pagination
 *
 * Tests that recurringTask.listMine and recurringTask.listOccurrences
 * return plain arrays with offset-based pagination (LIMIT/OFFSET).
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
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
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
    default_mode: 'poster',
  };
  return recurringTaskRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-poster',
  });
}

// ===========================================================================
// recurringTask.listMine — offset-based pagination (returns array)
// ===========================================================================

describe('recurringTask.listMine — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape — plain array
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns an array (not { items, nextCursor })', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeSeries({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makePosterCaller().listMine({ limit: 20 });

      expect(Array.isArray(result)).toBe(true);
    });

    it('returns mapped series objects with camelCase fields', async () => {
      const series = [makeSeries({ id: 'aaa', title: 'Weekly Dog Walk', payment_cents: 3000 })];
      mockDb.query.mockResolvedValueOnce({ rows: series, rowCount: 1 } as any);

      const result = await makePosterCaller().listMine({ limit: 20 });

      expect(result).toHaveLength(1);
      expect(result[0].title).toBe('Weekly Dog Walk');
      expect(result[0].payment).toBe(30); // payment_cents / 100
      expect(result[0].id).toBe('aaa');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pagination — limit/offset passed to query
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('passes limit and offset to db.query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listMine({ limit: 25, offset: 10 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(25);
      expect(params).toContain(10);
    });

    it('uses default limit=50 and offset=0 when not provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listMine();

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

      const result = await makePosterCaller().listMine({ limit: 20 });

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple items
  // -------------------------------------------------------------------------

  describe('multiple items', () => {
    it('returns multiple series in the array', async () => {
      const series = [
        makeSeries({ id: 'aaa', title: 'Series A' }),
        makeSeries({ id: 'bbb', title: 'Series B' }),
        makeSeries({ id: 'ccc', title: 'Series C' }),
      ];
      mockDb.query.mockResolvedValueOnce({ rows: series, rowCount: 3 } as any);

      const result = await makePosterCaller().listMine({ limit: 50 });

      expect(result).toHaveLength(3);
      expect(result.map((s: any) => s.id)).toEqual(['aaa', 'bbb', 'ccc']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Filters the query by poster_id
  // -------------------------------------------------------------------------

  describe('ownership filter', () => {
    it('filters by poster_id from ctx.user.id', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller('poster-xyz').listMine({ limit: 10 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('poster_id');
      expect(params).toContain('poster-xyz');
    });
  });
});

// ===========================================================================
// recurringTask.listOccurrences — offset-based pagination (returns array)
// ===========================================================================

describe('recurringTask.listOccurrences — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SERIES_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

  /** For listOccurrences: ownership check fires first, then the main query. */
  function setupOwnerAndOccurrences(rows: OccurrenceRow[]) {
    // Ownership check -> passes
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any);
    // listOccurrences data query
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: rows.length } as any);
  }

  // -------------------------------------------------------------------------
  // 1. Return shape — plain array
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns an array (not { items, nextCursor })', async () => {
      setupOwnerAndOccurrences([makeOccurrence({ id: 'aaa' })]);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 20 });

      expect(Array.isArray(result)).toBe(true);
    });

    it('returns mapped occurrence objects with camelCase fields', async () => {
      const occs = [makeOccurrence({ id: 'aaa', occurrence_number: 7 })];
      setupOwnerAndOccurrences(occs);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 20 });

      expect(result).toHaveLength(1);
      expect(result[0].occurrenceNumber).toBe(7);
      expect(result[0].id).toBe('aaa');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pagination — limit/offset passed to query
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('passes limit and offset to the data query', async () => {
      // Ownership check
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 25, offset: 10 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(25);
      expect(params).toContain(10);
    });

    it('uses default limit=50 and offset=0 when not provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makePosterCaller().listOccurrences({ seriesId: SERIES_ID });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
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
      setupOwnerAndOccurrences([]);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 20 });

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple items
  // -------------------------------------------------------------------------

  describe('multiple items', () => {
    it('returns multiple occurrences in the array', async () => {
      const occs = [
        makeOccurrence({ id: 'aaa', occurrence_number: 1 }),
        makeOccurrence({ id: 'bbb', occurrence_number: 2 }),
      ];
      setupOwnerAndOccurrences(occs);

      const result = await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 50 });

      expect(result).toHaveLength(2);
      expect(result.map((o: any) => o.id)).toEqual(['aaa', 'bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Ownership check
  // -------------------------------------------------------------------------

  describe('ownership check', () => {
    it('verifies series ownership before querying occurrences', async () => {
      setupOwnerAndOccurrences([]);

      await makePosterCaller().listOccurrences({ seriesId: SERIES_ID, limit: 10 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('poster_id');
      expect(params).toContain(SERIES_ID);
      expect(params).toContain('poster-abc');
    });
  });
});
