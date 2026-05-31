/**
 * Geo Router Unit Tests — C5
 *
 * Covers backend/src/routers/geo.ts (geo.availability).
 *
 * Invariants under test:
 *   - Happy path returns exact truthful shape, no DB writes.
 *   - Empty marketplace returns zeros + emptyState: true.
 *   - k-anonymity guard: averageTimeToAcceptMinutes is null when N < 3.
 *   - Invalid / non-Eastside ZIP → BAD_REQUEST, no DB call.
 *   - Burst rate-limit fires → TOO_MANY_REQUESTS, no DB call.
 *   - Global kill-switch fires (or Redis throws) → SERVICE_UNAVAILABLE.
 *   - No PII columns ever selected; no INSERT/UPDATE/DELETE issued.
 *   - nearbyHustlerCount always 0 + hustlerSignalAvailable false in C5.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that transitively touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
  };
});

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
}));

vi.mock('../../src/cache/redis', () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 10 }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { checkRateLimit } from '../../src/cache/redis';
import { geoRouter } from '../../src/routers/geo';

const mockDb = vi.mocked(db);
const mockCheckRateLimit = vi.mocked(checkRateLimit);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_IP = '203.0.113.99';
const VALID_ZIP = '98004'; // Bellevue (Eastside allow-list)

function makePublicCaller(
  headers: Record<string, string> | null = { 'x-forwarded-for': TEST_IP }
) {
  return geoRouter.createCaller({
    user: null,
    firebaseUid: null,
    req: headers ? ({ headers: new Headers(headers) } as Request) : undefined,
  } as any);
}

/**
 * Wire `db.query` to return the three aggregate rowsets in order:
 *   1. posted last 7 days (per-category counts)
 *   2. completed last 30 days (per-category counts)
 *   3. avg time-to-accept (single row with avg_minutes + n)
 */
function mockAggregates(opts: {
  posted?: Array<{ category: string; n: string }>;
  completed?: Array<{ category: string; n: string }>;
  avg?: { avg_minutes: string | null; n: string };
}) {
  mockDb.query
    .mockResolvedValueOnce({ rows: opts.posted ?? [] } as any)
    .mockResolvedValueOnce({ rows: opts.completed ?? [] } as any)
    .mockResolvedValueOnce({
      rows: [opts.avg ?? { avg_minutes: null, n: '0' }],
    } as any);
}

// ===========================================================================
// geo.availability
// ===========================================================================

describe('geo.availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 10 });
  });

  it('happy path: returns full truthful shape, no DB writes, no PII columns selected', async () => {
    mockAggregates({
      posted: [
        { category: 'moving', n: '5' },
        { category: 'cleaning', n: '3' },
        { category: 'tech', n: '2' },
        { category: 'errands', n: '1' },
      ],
      completed: [
        { category: 'moving', n: '4' },
        { category: 'cleaning', n: '2' },
      ],
      avg: { avg_minutes: '47.6', n: '8' },
    });

    const caller = makePublicCaller();
    const result = await caller.availability({ zip: VALID_ZIP });

    expect(result).toMatchObject({
      zip: VALID_ZIP,
      nearbyHustlerCount: 0,
      hustlerSignalAvailable: false,
      tasksPostedLast7Days: 11,
      completedLast30Days: 6,
      completedByCategory: { moving: 4, cleaning: 2 },
      averageTimeToAcceptMinutes: 48,
      popularCategories: ['moving', 'cleaning', 'tech'],
      emptyState: false,
    });
    expect(result.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // Three SELECT queries, no writes.
    expect(mockDb.query).toHaveBeenCalledTimes(3);
    for (const call of mockDb.query.mock.calls) {
      const sql = String(call[0]);
      expect(sql).toMatch(/^\s*(SELECT|WITH)\b/i);
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
      // PII columns must never appear.
      expect(sql).not.toMatch(/\b(email|phone|address|user_id|created_by|assigned_to|firebase_uid|description|title)\b/i);
    }
  });

  it('empty marketplace: returns zeros + emptyState true, popularCategories empty, avg null', async () => {
    mockAggregates({ posted: [], completed: [], avg: { avg_minutes: null, n: '0' } });

    const caller = makePublicCaller();
    const result = await caller.availability({ zip: VALID_ZIP });

    expect(result).toMatchObject({
      zip: VALID_ZIP,
      nearbyHustlerCount: 0,
      hustlerSignalAvailable: false,
      tasksPostedLast7Days: 0,
      completedLast30Days: 0,
      completedByCategory: {},
      averageTimeToAcceptMinutes: null,
      popularCategories: [],
      emptyState: true,
    });
  });

  it('k-anonymity guard: averageTimeToAcceptMinutes is null when N < 3 even with raw avg present', async () => {
    mockAggregates({
      posted: [{ category: 'moving', n: '1' }],
      completed: [],
      avg: { avg_minutes: '12.0', n: '2' },
    });

    const caller = makePublicCaller();
    const result = await caller.availability({ zip: VALID_ZIP });

    expect(result.averageTimeToAcceptMinutes).toBeNull();
    expect(result.tasksPostedLast7Days).toBe(1);
  });

  it('returns avg when N exactly meets the k-anonymity threshold of 3', async () => {
    mockAggregates({
      posted: [],
      completed: [],
      avg: { avg_minutes: '30.4', n: '3' },
    });

    const caller = makePublicCaller();
    const result = await caller.availability({ zip: VALID_ZIP });

    expect(result.averageTimeToAcceptMinutes).toBe(30);
  });

  it('rejects malformed ZIP via zod (no DB call)', async () => {
    const caller = makePublicCaller();
    await expect(
      caller.availability({ zip: 'abcde' })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects valid-format but non-Eastside ZIP with BAD_REQUEST (no DB call, no rate-limit consumed downstream of the check)', async () => {
    const caller = makePublicCaller();
    await expect(
      caller.availability({ zip: '99999' })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('not yet available'),
    });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('burst rate limit: returns TOO_MANY_REQUESTS, no DB call', async () => {
    mockCheckRateLimit.mockImplementationOnce(async () => ({
      allowed: false,
      remaining: 0,
    }));

    const caller = makePublicCaller();
    await expect(
      caller.availability({ zip: VALID_ZIP })
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('global kill switch: returns SERVICE_UNAVAILABLE, no DB call', async () => {
    mockCheckRateLimit
      .mockResolvedValueOnce({ allowed: true, remaining: 4 })  // burst
      .mockResolvedValueOnce({ allowed: true, remaining: 29 }) // daily
      .mockResolvedValueOnce({ allowed: false, remaining: 0 }); // global

    const caller = makePublicCaller();
    await expect(
      caller.availability({ zip: VALID_ZIP })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('fails CLOSED on global kill switch when Redis throws on every layer', async () => {
    mockCheckRateLimit.mockRejectedValue(new Error('Redis ECONNREFUSED'));

    const caller = makePublicCaller();
    await expect(
      caller.availability({ zip: VALID_ZIP })
    ).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects in production when no IP key can be derived', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const caller = makePublicCaller(null);
      await expect(
        caller.availability({ zip: VALID_ZIP })
      ).rejects.toMatchObject({
        code: 'BAD_REQUEST',
        message: expect.stringContaining('Unable to identify client'),
      });
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(mockDb.query).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('falls back to dev-local key when no IP header is present in non-production', async () => {
    mockAggregates({ posted: [], completed: [], avg: { avg_minutes: null, n: '0' } });

    const caller = makePublicCaller(null);
    const result = await caller.availability({ zip: VALID_ZIP });

    expect(result.emptyState).toBe(true);
    // First (burst) rate-limit call should have used the shared dev sentinel.
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'dev-local',
      expect.stringContaining('geo:availability:burst'),
      expect.any(Number),
      expect.any(Number)
    );
  });

  it('queries the correct city for each Eastside ZIP (98075 → Sammamish)', async () => {
    mockAggregates({ posted: [], completed: [], avg: { avg_minutes: null, n: '0' } });

    const caller = makePublicCaller();
    await caller.availability({ zip: '98075' });

    // Every aggregate query receives the mapped city as its only parameter.
    for (const call of mockDb.query.mock.calls) {
      expect(call[1]).toEqual(['Sammamish']);
    }
  });
});
