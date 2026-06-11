// backend/tests/unit/recurring-task-service.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// AUDIT FIX M7: generateOccurrencesForSeries now wraps generation in
// db.transaction with a FOR UPDATE lock on the series row. The tx executor
// delegates to the same `query` spy so sequences keep driving both paths —
// each generating test gains ONE leading mock for the lock SELECT.
const dbMocks = vi.hoisted(() => {
  const query = vi.fn();
  const txQuery = vi.fn((sql: string, params?: unknown[]) => query(sql, params));
  const transaction = vi.fn(async (fn: (q: typeof txQuery) => Promise<unknown>) => fn(txQuery));
  return { query, txQuery, transaction };
});

vi.mock('../../src/db.js', () => ({
  db: { query: dbMocks.query, transaction: dbMocks.transaction },
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }),
    info: vi.fn(),
    error: vi.fn(),
  },
}));

import { db } from '../../src/db.js';
import {
  getNextOccurrenceDates,
  generateOccurrencesForSeries,
} from '../../src/services/RecurringTaskService.js';

const mockDb = vi.mocked(db);

const SERIES_ID = 'series-aaa-001';

// ============================================================================
// getNextOccurrenceDates (pure function — no DB)
// ============================================================================

describe('getNextOccurrenceDates', () => {
  it('generates daily dates starting from startDate', () => {
    const dates = getNextOccurrenceDates('daily', '2026-03-10', null, null, null, 5);
    expect(dates).toHaveLength(5);
    expect(dates[0]).toBe('2026-03-10');
    expect(dates[1]).toBe('2026-03-11');
    expect(dates[4]).toBe('2026-03-14');
  });

  it('stops daily generation before endDate', () => {
    const dates = getNextOccurrenceDates('daily', '2026-03-10', '2026-03-12', null, null, 30);
    expect(dates).toHaveLength(3);
    expect(dates[dates.length - 1]).toBe('2026-03-12');
  });

  it('generates weekly occurrences on correct day of week', () => {
    // dayOfWeek=1 (Monday). 2026-03-09 is a Monday.
    const dates = getNextOccurrenceDates('weekly', '2026-03-09', null, 1, null, 3);
    expect(dates).toHaveLength(3);
    // Each should be a Monday
    dates.forEach(d => {
      const day = new Date(d + 'T12:00:00.000Z').getUTCDay();
      expect(day).toBe(1); // Monday
    });
    // They should be 7 days apart
    expect(dates[1]).toBe('2026-03-16');
    expect(dates[2]).toBe('2026-03-23');
  });

  it('generates weekly occurrences with Sunday (dayOfWeek=7)', () => {
    // dayOfWeek=7 → JS day 0 (Sunday). 2026-03-08 is Sunday.
    const dates = getNextOccurrenceDates('weekly', '2026-03-08', null, 7, null, 3);
    expect(dates).toHaveLength(3);
    dates.forEach(d => {
      const day = new Date(d + 'T12:00:00.000Z').getUTCDay();
      expect(day).toBe(0); // Sunday
    });
  });

  it('generates biweekly occurrences 14 days apart', () => {
    // dayOfWeek=3 (Wednesday). 2026-03-11 is a Wednesday.
    const dates = getNextOccurrenceDates('biweekly', '2026-03-11', null, 3, null, 3);
    expect(dates).toHaveLength(3);
    // Should be 14 days apart
    const d0 = new Date(dates[0] + 'T12:00:00.000Z').getTime();
    const d1 = new Date(dates[1] + 'T12:00:00.000Z').getTime();
    expect(d1 - d0).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('generates monthly occurrences on given day of month', () => {
    // dayOfMonth=15, starting 2026-03-15
    const dates = getNextOccurrenceDates('monthly', '2026-03-15', null, null, 15, 3);
    expect(dates).toHaveLength(3);
    expect(dates[0]).toBe('2026-03-15');
    expect(dates[1]).toBe('2026-04-15');
    expect(dates[2]).toBe('2026-05-15');
  });

  it('clips monthly dayOfMonth to 28 to avoid month overflow', () => {
    // dayOfMonth=31 should be clipped to 28
    const dates = getNextOccurrenceDates('monthly', '2026-01-28', null, null, 31, 2);
    dates.forEach(d => {
      const day = parseInt(d.slice(8, 10), 10);
      expect(day).toBeLessThanOrEqual(28);
    });
  });

  it('returns empty array for weekly with no dayOfWeek', () => {
    const dates = getNextOccurrenceDates('weekly', '2026-03-10', null, null, null, 5);
    expect(dates).toHaveLength(0);
  });

  it('returns empty array for monthly with no dayOfMonth', () => {
    const dates = getNextOccurrenceDates('monthly', '2026-03-10', null, null, null, 5);
    expect(dates).toHaveLength(0);
  });

  it('returns empty array for unknown pattern', () => {
    const dates = getNextOccurrenceDates('unknown_pattern' as any, '2026-03-10', null, null, null, 5);
    expect(dates).toHaveLength(0);
  });

  it('returns empty array when endDate is before startDate', () => {
    const dates = getNextOccurrenceDates('daily', '2026-03-15', '2026-03-10', null, null, 5);
    expect(dates).toHaveLength(0);
  });

  it('respects maxCount limit for daily', () => {
    const dates = getNextOccurrenceDates('daily', '2026-01-01', null, null, null, 7);
    expect(dates).toHaveLength(7);
  });
});

// ============================================================================
// generateOccurrencesForSeries (DB-backed)
// ============================================================================

describe('generateOccurrencesForSeries', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  const makeSeries = (overrides = {}) => ({
    id: SERIES_ID,
    poster_id: 'poster-001',
    pattern: 'weekly',
    day_of_week: 1, // Monday
    day_of_month: null,
    start_date: '2026-03-09',
    end_date: null,
    status: 'active',
    occurrence_count: 0,
    ...overrides,
  });

  it('generates occurrences for an active weekly series', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeSeries()], rowCount: 1 } as any) // SELECT series
      .mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any) // FOR UPDATE lock (M7)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any) // SELECT existing occurrences
      .mockResolvedValueOnce({ rows: [], rowCount: 5 } as any) // INSERT occurrences
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // UPDATE series

    const result = await generateOccurrencesForSeries(SERIES_ID);

    expect(result.success).toBe(true);
    expect(result.data!.generated).toBeGreaterThan(0);
    // M7: generation runs inside one transaction with the series locked
    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);
    expect(String(dbMocks.txQuery.mock.calls[0][0])).toContain('FOR UPDATE');
  });

  it('returns NOT_FOUND when series does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await generateOccurrencesForSeries('nonexistent-series');

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('NOT_FOUND');
  });

  it('returns 0 generated for cancelled series', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [makeSeries({ status: 'cancelled' })],
      rowCount: 1,
    } as any);

    const result = await generateOccurrencesForSeries(SERIES_ID);

    expect(result.success).toBe(true);
    expect(result.data!.generated).toBe(0);
  });

  it('returns 0 generated when all dates already have occurrences', async () => {
    // The service generates maxOccurrences+50 candidate dates (default: 30+50=80 weeks).
    // We need existing dates to cover ALL 80 candidates to get generated=0.
    const existingDates = Array.from({ length: 80 }, (_, i) => {
      const d = new Date('2026-03-09T12:00:00.000Z');
      d.setUTCDate(d.getUTCDate() + i * 7);
      return {
        scheduled_date: d.toISOString().slice(0, 10),
        occurrence_number: i + 1,
      };
    });

    mockDb.query
      .mockResolvedValueOnce({ rows: [makeSeries()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any) // FOR UPDATE lock (M7)
      .mockResolvedValueOnce({ rows: existingDates, rowCount: existingDates.length } as any);

    const result = await generateOccurrencesForSeries(SERIES_ID);

    expect(result.success).toBe(true);
    expect(result.data!.generated).toBe(0);
  });

  it('skips already-existing dates and only inserts new ones', async () => {
    // First occurrence (2026-03-09) exists; only subsequent ones should be inserted
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeSeries()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any) // FOR UPDATE lock (M7)
      .mockResolvedValueOnce({
        rows: [{ scheduled_date: '2026-03-09', occurrence_number: 1 }],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 5 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await generateOccurrencesForSeries(SERIES_ID, { maxOccurrences: 5 });

    expect(result.success).toBe(true);
    expect(result.data!.generated).toBe(5);
  });

  it('accepts paused series and generates occurrences', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeSeries({ status: 'paused' })], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any) // FOR UPDATE lock (M7)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 5 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await generateOccurrencesForSeries(SERIES_ID);

    expect(result.success).toBe(true);
    expect(result.data!.generated).toBeGreaterThan(0);
  });

  it('respects the maxOccurrences option', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeSeries()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ id: SERIES_ID }], rowCount: 1 } as any) // FOR UPDATE lock (M7)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 3 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await generateOccurrencesForSeries(SERIES_ID, { maxOccurrences: 3 });

    expect(result.success).toBe(true);
    expect(result.data!.generated).toBe(3);
  });

  it('uses fromDate option when provided', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeSeries()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 5 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await generateOccurrencesForSeries(SERIES_ID, {
      fromDate: '2026-04-01',
      maxOccurrences: 5,
    });

    expect(result.success).toBe(true);
  });

  it('returns DB_ERROR on db exception', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB connection error'));

    const result = await generateOccurrencesForSeries(SERIES_ID);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('DB_ERROR');
    expect(result.error!.message).toContain('DB connection error');
  });

  it('generates occurrences for a daily series', async () => {
    mockDb.query
      .mockResolvedValueOnce({
        rows: [makeSeries({ pattern: 'daily', day_of_week: null })],
        rowCount: 1,
      } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 10 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    const result = await generateOccurrencesForSeries(SERIES_ID, { maxOccurrences: 10 });

    expect(result.success).toBe(true);
    expect(result.data!.generated).toBe(10);
  });

  it('caps maxOccurrences at MAX_OCCURRENCES_PER_CALL (100)', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [makeSeries()], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 30 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    // Request 200 but only 30 weekly dates exist in the date range
    const result = await generateOccurrencesForSeries(SERIES_ID, { maxOccurrences: 200 });

    expect(result.success).toBe(true);
  });
});
