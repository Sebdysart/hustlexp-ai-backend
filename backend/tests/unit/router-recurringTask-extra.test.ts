/**
 * RecurringTask Router Extra Unit Tests
 *
 * Covers branches NOT tested by recurringTask-router.test.ts:
 * - create (success, FORBIDDEN tier < 3, BAD_REQUEST limit reached)
 * - getById (success, NOT_FOUND)
 * - pause (success, NOT_FOUND)
 * - resume (success, NOT_FOUND)
 * - cancel (success, NOT_FOUND)
 * - skipOccurrence (success, NOT_FOUND)
 * - setPreferredWorker (success, NOT_FOUND worker, NOT_FOUND series)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
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

const SERIES_UUID  = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKER_UUID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const OCC_UUID     = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const POSTER_UUID  = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

function makeCaller(plan = 'premium', trustTier = 3) {
  return recurringTaskRouter.createCaller({
    user: {
      id: POSTER_UUID,
      email: 'poster@hustlexp.com',
      full_name: 'Poster User',
      role: 'poster',
      trust_tier: trustTier,
      plan,
      firebase_uid: 'fb-poster',
      default_mode: 'poster',
    } as any,
    firebaseUid: 'fb-poster',
  });
}

function makeSeriesRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SERIES_UUID,
    poster_id: POSTER_UUID,
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

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('recurringTask.create', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws FORBIDDEN when trust_tier < 3', async () => {
    const caller = makeCaller('premium', 2);
    await expect(
      caller.create({
        title: 'Weekly Cleaning',
        description: 'Clean the house every week thoroughly',
        payment: 50,
        location: '123 Main St',
        estimatedDuration: '2 hours',
        pattern: 'weekly',
        startDate: '2025-01-06',
      })
    ).rejects.toThrow('Recurring tasks require Trusted tier');
  });

  it('throws BAD_REQUEST when subscription limit is reached', async () => {
    // Active series count = limit (5 for premium)
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '5' }], rowCount: 1 } as any);

    await expect(
      makeCaller('premium').create({
        title: 'Weekly Cleaning',
        description: 'Clean the house every week thoroughly',
        payment: 50,
        location: '123 Main St',
        estimatedDuration: '2 hours',
        pattern: 'weekly',
        startDate: '2025-01-06',
      })
    ).rejects.toThrow('Recurring task limit reached');
  });

  it('throws BAD_REQUEST for free plan (limit 0)', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);

    await expect(
      makeCaller('free').create({
        title: 'Weekly Cleaning',
        description: 'Clean the house every week thoroughly',
        payment: 50,
        location: '123 Main St',
        estimatedDuration: '2 hours',
        pattern: 'weekly',
        startDate: '2025-01-06',
      })
    ).rejects.toThrow('Recurring task limit reached');
  });

  it('inserts series and returns mapped response on success', async () => {
    // Count check: 2 active, limit is 5 (premium)
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 } as any);
    // INSERT
    mockDb.query.mockResolvedValueOnce({ rows: [makeSeriesRow({ title: 'Weekly Cleaning' })], rowCount: 1 } as any);

    const result = await makeCaller('premium').create({
      title: 'Weekly Cleaning',
      description: 'Clean the house every week thoroughly',
      payment: 50,
      location: '123 Main St',
      estimatedDuration: '2 hours',
      pattern: 'weekly',
      startDate: '2025-01-06',
    });

    expect(result.id).toBe(SERIES_UUID);
    expect(result.title).toBe('Weekly Cleaning');
    expect(result.payment).toBe(50); // 5000/100
    expect(result.pattern).toBe('weekly');
    expect(result.posterId).toBe(POSTER_UUID);
  });

  it('converts payment from dollars to cents', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [makeSeriesRow()], rowCount: 1 } as any);

    await makeCaller('pro').create({
      title: 'Weekly Cleaning',
      description: 'Clean the house every week thoroughly',
      payment: 75.5,
      location: '123 Main St',
      estimatedDuration: '2 hours',
      pattern: 'weekly',
      startDate: '2025-01-06',
    });

    const insertParams = (mockDb.query as any).mock.calls[1][1];
    expect(insertParams[3]).toBe(7550); // 75.5 * 100 rounded
  });
});

// ---------------------------------------------------------------------------
// getById
// ---------------------------------------------------------------------------

describe('recurringTask.getById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NOT_FOUND when series not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().getById({ id: SERIES_UUID })
    ).rejects.toThrow('Series not found');
  });

  it('returns series with preferred worker name', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [makeSeriesRow({ preferred_worker_id: WORKER_UUID, worker_name: 'Jane Doe' })],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getById({ id: SERIES_UUID });
    expect(result.id).toBe(SERIES_UUID);
    expect(result.preferredWorkerName).toBe('Jane Doe');
  });

  it('returns null for preferred worker when none set', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [makeSeriesRow({ preferred_worker_id: null, worker_name: null })],
      rowCount: 1,
    } as any);

    const result = await makeCaller().getById({ id: SERIES_UUID });
    expect(result.preferredWorkerName).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// pause
// ---------------------------------------------------------------------------

describe('recurringTask.pause', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NOT_FOUND when active series not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().pause({ id: SERIES_UUID })
    ).rejects.toThrow('Active series not found');
  });

  it('returns success when paused', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_UUID }], rowCount: 1 } as any);

    const result = await makeCaller().pause({ id: SERIES_UUID });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

describe('recurringTask.resume', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NOT_FOUND when paused series not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().resume({ id: SERIES_UUID })
    ).rejects.toThrow('Paused series not found');
  });

  it('returns success when resumed', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_UUID }], rowCount: 1 } as any);

    const result = await makeCaller().resume({ id: SERIES_UUID });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe('recurringTask.cancel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NOT_FOUND when series not found or not cancellable', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const txQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
      return fn(txQuery);
    });

    await expect(
      makeCaller().cancel({ id: SERIES_UUID })
    ).rejects.toThrow('Series not found');
  });

  it('cancels series and all scheduled occurrences', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ id: SERIES_UUID }], rowCount: 1 }) // UPDATE series
        .mockResolvedValueOnce({ rows: [], rowCount: 3 })                    // UPDATE scheduled occurrences
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });                   // SELECT active/in_progress occurrences (none)
      return fn(txQuery);
    });

    const result = await makeCaller().cancel({ id: SERIES_UUID });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// skipOccurrence
// ---------------------------------------------------------------------------

describe('recurringTask.skipOccurrence', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NOT_FOUND when scheduled occurrence not found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().skipOccurrence({ occurrenceId: OCC_UUID })
    ).rejects.toThrow('Scheduled occurrence not found');
  });

  it('returns success when occurrence skipped', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: OCC_UUID }], rowCount: 1 } as any);

    const result = await makeCaller().skipOccurrence({ occurrenceId: OCC_UUID });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setPreferredWorker
// ---------------------------------------------------------------------------

describe('recurringTask.setPreferredWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NOT_FOUND when worker does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().setPreferredWorker({ seriesId: SERIES_UUID, workerId: WORKER_UUID })
    ).rejects.toThrow('Worker not found');
  });

  it('throws NOT_FOUND when series not found or not owned by poster', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: WORKER_UUID, account_status: 'ACTIVE' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeCaller().setPreferredWorker({ seriesId: SERIES_UUID, workerId: WORKER_UUID })
    ).rejects.toThrow('Series not found');
  });

  it('returns success when preferred worker set', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: WORKER_UUID, account_status: 'ACTIVE' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_UUID }], rowCount: 1 } as any);

    const result = await makeCaller().setPreferredWorker({ seriesId: SERIES_UUID, workerId: WORKER_UUID });
    expect(result.success).toBe(true);
  });

  it('passes correct params to update query', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: WORKER_UUID, account_status: 'ACTIVE' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: SERIES_UUID }], rowCount: 1 } as any);

    await makeCaller().setPreferredWorker({ seriesId: SERIES_UUID, workerId: WORKER_UUID });

    const updateCall = (mockDb.query as any).mock.calls[1];
    expect(updateCall[1]).toContain(WORKER_UUID);
    expect(updateCall[1]).toContain(SERIES_UUID);
    expect(updateCall[1]).toContain(POSTER_UUID);
  });
});
