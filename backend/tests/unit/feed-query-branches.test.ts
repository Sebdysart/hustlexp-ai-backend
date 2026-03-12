/**
 * TaskDiscoveryService Branch Coverage Tests
 *
 * Targets backend/src/services/TaskDiscoveryService.ts branches NOT covered
 * by the existing task-discovery.test.ts:
 *
 * browsePublicFeed:
 *   - sort_by='price_low' branch (ORDER BY price ASC)
 *   - sort_by='deadline' branch (ORDER BY deadline ASC NULLS LAST)
 *   - sort_by='price_high' branch (ORDER BY price DESC)
 *   - default/unknown sort_by branch (falls back to newest)
 *   - min_price filter applied
 *   - max_price filter applied
 *   - category filter applied
 *   - DB error
 *
 * calculateMatchingScore (pure helper functions exercised via the service):
 *   - calculateDistanceScore: all 5 distance ranges (≤1, ≤3, ≤5, ≤10, >10)
 *   - calculateTimeMatch: null deadline, perfect timing, tight, very tight
 *   - calculateRelevanceScore: urgency factor (deadline within 24h)
 *   - calculateCategoryMatch: preferred vs not preferred
 *   - calculatePriceAttractiveness: both branches
 *
 * getFeed:
 *   - min_matching_score provided (explicit threshold branch)
 *   - min_matching_score absent (default 0.20 threshold branch)
 *   - sort_by='deadline' and sort_by='distance'
 *   - sort_by default (falls back to relevance)
 *
 * search:
 *   - query provided (full-text search path)
 *   - no query (delegates to getFeed path)
 *
 * saveSearch: invalid sortBy coercion to 'relevance'
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn(), serializableTransaction: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/logger', () => {
  const child = (): object => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() });
  return { logger: { child, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } };
});

vi.mock('../../src/services/GeocodingService', () => ({
  GeocodingService: {
    geocodeAddress:        vi.fn().mockResolvedValue({ lat: 47.6, lng: -122.3 }),
    calculateDistanceMiles: vi.fn().mockReturnValue(2.5),
  },
}));

vi.mock('../../src/lib/pii-scrubber', () => ({
  scrubPII: vi.fn((text: string) => text),
}));

vi.mock('../../src/services/AIClient', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(false),
    call:         vi.fn(),
    callJSON:     vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { TaskDiscoveryService } from '../../src/services/TaskDiscoveryService';
import { db } from '../../src/db';
import { GeocodingService } from '../../src/services/GeocodingService';

const mockQuery           = vi.mocked(db.query);
const mockGeocode         = vi.mocked(GeocodingService.geocodeAddress);
const mockCalcDistance    = vi.mocked(GeocodingService.calculateDistanceMiles);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePublicRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Fix faucet',
    description: 'Plumbing job',
    category: 'home_repair',
    price: 5000,
    location: 'Seattle, WA',
    deadline: null,
    created_at: new Date().toISOString(),
    state: 'OPEN',
    requires_proof: true,
    mode: 'STANDARD',
    poster_id: 'poster-1',
    ...overrides,
  };
}

function makeFeedRow(overrides: Record<string, unknown> = {}) {
  return {
    ...makePublicRow(),
    matching_score: 0.75,
    relevance_score: 0.80,
    distance_miles: 2.5,
    ...overrides,
  };
}

function makeTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    category: 'home_repair',
    price: 5000,
    deadline: null,
    location: 'Seattle, WA',
    created_at: new Date(),
    ...overrides,
  };
}

function makeHustlerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hustler-1',
    trust_tier: 3,
    zip_code: '98101',
    preferred_categories: ['home_repair'],
    preferred_min_price: 1000,
    ...overrides,
  };
}

function makeStatsRow(overrides: Record<string, unknown> = {}) {
  return { completion_rate: 80, approval_rate: 90, ...overrides };
}

// Setup calculateMatchingScore DB call chain
function setupMatchingScoreQueries({
  taskOverrides = {},
  hustlerOverrides = {},
  statsOverrides = {},
  distanceMiles = 2.5,
}: {
  taskOverrides?: Record<string, unknown>;
  hustlerOverrides?: Record<string, unknown>;
  statsOverrides?: Record<string, unknown>;
  distanceMiles?: number;
} = {}) {
  mockCalcDistance.mockReturnValue(distanceMiles);
  mockQuery
    .mockResolvedValueOnce({ rows: [makeTaskRow(taskOverrides)],    rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [makeHustlerRow(hustlerOverrides)], rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [makeStatsRow(statsOverrides)],  rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [],                              rowCount: 0 } as never); // category experience
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockGeocode.mockResolvedValue({ lat: 47.6, lng: -122.3 });
  mockCalcDistance.mockReturnValue(2.5);
});

// ===========================================================================
// browsePublicFeed — sort_by branches
// ===========================================================================

describe('TaskDiscoveryService.browsePublicFeed — sort_by branches', () => {
  it('sorts by price ASC for sort_by="price_low"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makePublicRow()], rowCount: 1 } as never);

    const result = await TaskDiscoveryService.browsePublicFeed({ sort_by: 'price_low' });

    expect(result.success).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY price ASC');
  });

  it('sorts by price DESC for sort_by="price_high"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makePublicRow()], rowCount: 1 } as never);

    await TaskDiscoveryService.browsePublicFeed({ sort_by: 'price_high' });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY price DESC');
  });

  it('sorts by deadline ASC NULLS LAST for sort_by="deadline"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makePublicRow()], rowCount: 1 } as never);

    await TaskDiscoveryService.browsePublicFeed({ sort_by: 'deadline' });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY deadline ASC NULLS LAST');
  });

  it('falls back to created_at DESC for default sort_by="newest"', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makePublicRow()], rowCount: 1 } as never);

    await TaskDiscoveryService.browsePublicFeed({ sort_by: 'newest' });

    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY created_at DESC');
  });

  it('falls back to created_at DESC when sort_by is omitted (default)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await TaskDiscoveryService.browsePublicFeed({});

    expect(result.success).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('ORDER BY created_at DESC');
  });

  it('applies min_price filter when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await TaskDiscoveryService.browsePublicFeed({ min_price: 1000 });

    const args = mockQuery.mock.calls[0][1] as unknown[];
    expect(args).toContain(1000);
  });

  it('applies max_price filter when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await TaskDiscoveryService.browsePublicFeed({ max_price: 9999 });

    const args = mockQuery.mock.calls[0][1] as unknown[];
    expect(args).toContain(9999);
  });

  it('applies category filter when provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await TaskDiscoveryService.browsePublicFeed({ category: 'cleaning' });

    const args = mockQuery.mock.calls[0][1] as unknown[];
    expect(args).toContain('cleaning');
  });

  it('returns DB_ERROR when query throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db error') as never);

    const result = await TaskDiscoveryService.browsePublicFeed({});

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ===========================================================================
// calculateMatchingScore — distance score branches
// ===========================================================================

describe('TaskDiscoveryService.calculateMatchingScore — distance score branches', () => {
  it('returns distance score=1.0 for distance ≤ 1 mile (excellent)', async () => {
    setupMatchingScoreQueries({ distanceMiles: 0.5 });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.components.distance_score).toBe(1.0);
  });

  it('returns distance score between 0.7 and 1.0 for distance between 1 and 3 miles', async () => {
    setupMatchingScoreQueries({ distanceMiles: 2.0 }); // midpoint of 1–3

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.components.distance_score).toBeGreaterThan(0.7);
    expect(result.data.components.distance_score).toBeLessThan(1.0);
  });

  it('returns distance score between 0.3 and 0.7 for distance between 3 and 5 miles', async () => {
    setupMatchingScoreQueries({ distanceMiles: 4.0 });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.components.distance_score).toBeGreaterThanOrEqual(0.3);
    expect(result.data.components.distance_score).toBeLessThan(0.7);
  });

  it('returns distance score between 0.1 and 0.3 for distance between 5 and 10 miles', async () => {
    setupMatchingScoreQueries({ distanceMiles: 7.5 });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.components.distance_score).toBeGreaterThan(0.1);
    expect(result.data.components.distance_score).toBeLessThan(0.3);
  });

  it('returns distance score=0.0 for distance > 10 miles (too far)', async () => {
    setupMatchingScoreQueries({ distanceMiles: 15.0 });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.components.distance_score).toBe(0.0);
  });
});

// ===========================================================================
// calculateMatchingScore — geocoding failure branch
// ===========================================================================

describe('TaskDiscoveryService.calculateMatchingScore — geocoding failure', () => {
  it('defaults distanceMiles to 0 when geocoding throws', async () => {
    mockGeocode.mockRejectedValue(new Error('geocode API down'));
    mockQuery
      .mockResolvedValueOnce({ rows: [makeTaskRow()],    rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeHustlerRow()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [makeStatsRow()],   rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [],                 rowCount: 0 } as never);

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.distanceMiles).toBe(0);
  });
});

// ===========================================================================
// calculateMatchingScore — time match branches
// ===========================================================================

describe('TaskDiscoveryService.calculateMatchingScore — time match', () => {
  it('returns time_match=0.5 when task has no deadline (neutral)', async () => {
    setupMatchingScoreQueries({ taskOverrides: { deadline: null } });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.components.time_match).toBe(0.5);
  });

  it('returns time_match=1.0 when deadline is well in the future (≥ availableWindow)', async () => {
    const futureDeadline = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48h from now
    setupMatchingScoreQueries({ taskOverrides: { deadline: futureDeadline } });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.components.time_match).toBe(1.0); // ≥ availableWindowHours (24h)
  });

  it('returns time_match=0.7 for tight but doable (deadline between 50% and 100% of window)', async () => {
    // availableWindowHours=24; 50% = 12h; deadline is 18h from now → tight but doable
    const tightDeadline = new Date(Date.now() + 18 * 60 * 60 * 1000);
    setupMatchingScoreQueries({ taskOverrides: { deadline: tightDeadline } });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.components.time_match).toBe(0.7);
  });

  it('returns time_match=0.3 when deadline is very tight (< 50% of window = < 12h)', async () => {
    const veryTightDeadline = new Date(Date.now() + 6 * 60 * 60 * 1000); // 6h from now
    setupMatchingScoreQueries({ taskOverrides: { deadline: veryTightDeadline } });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    expect(result.data.components.time_match).toBe(0.3);
  });
});

// ===========================================================================
// calculateMatchingScore — category match branches
// ===========================================================================

describe('TaskDiscoveryService.calculateMatchingScore — category match', () => {
  it('uses preferred category factor (1.0) when task category is in preferred list', async () => {
    setupMatchingScoreQueries({
      taskOverrides:    { category: 'home_repair' },
      hustlerOverrides: { preferred_categories: ['home_repair', 'cleaning'] },
    });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    // Preferred: isPreferred=1.0 → categoryMatch = 1.0*0.70 + experience*0.30 = exactly 0.70 (with 0 experience)
    expect(result.data.components.category_match).toBeGreaterThanOrEqual(0.7);
  });

  it('uses non-preferred category factor (0.6) when task category is NOT in preferred list', async () => {
    setupMatchingScoreQueries({
      taskOverrides:    { category: 'moving' },
      hustlerOverrides: { preferred_categories: ['home_repair'] },
    });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    // Non-preferred: isPreferred=0.6 → categoryMatch = 0.6*0.70 + 0*0.30 = 0.42
    expect(result.data.components.category_match).toBeLessThan(0.7);
  });
});

// ===========================================================================
// calculateMatchingScore — price attractiveness branches
// ===========================================================================

describe('TaskDiscoveryService.calculateMatchingScore — price attractiveness', () => {
  it('uses meetsMinimum=1.0 when task price >= preferred min', async () => {
    setupMatchingScoreQueries({
      taskOverrides:    { price: 5000 },
      hustlerOverrides: { preferred_min_price: 1000 }, // task price >= preferred min
    });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    // meetsMinimum=1.0, aboveMarket=1.0 (price=market) → attractiveness = 1.0*0.60 + 1.0*0.40 = 1.0
    expect(result.data.components.price_attractiveness).toBe(1.0);
  });

  it('uses meetsMinimum=0.5 when task price < preferred min', async () => {
    setupMatchingScoreQueries({
      taskOverrides:    { price: 500 },
      hustlerOverrides: { preferred_min_price: 2000 }, // task price < preferred min
    });

    const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

    expect(result.success).toBe(true);
    // meetsMinimum=0.5, aboveMarket=1.0 (price=market) → 0.5*0.60 + 1.0*0.40 = 0.70
    expect(result.data.components.price_attractiveness).toBe(0.70);
  });
});

// ===========================================================================
// getFeed — sort_by and min_matching_score branches
// ===========================================================================

describe('TaskDiscoveryService.getFeed — filter branches', () => {
  function setupFeedScoreQueries() {
    // calculateFeedScores calls: openTasks SELECT → empty (skip score calculation)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // getFeed main SELECT
    mockQuery.mockResolvedValueOnce({ rows: [makeFeedRow()], rowCount: 1 } as never);
  }

  it('applies explicit min_matching_score when provided', async () => {
    setupFeedScoreQueries();

    await TaskDiscoveryService.getFeed('hustler-1', { min_matching_score: 0.5 }, 50, 0);

    const feedSql = mockQuery.mock.calls[1][0] as string;
    expect(feedSql).toContain('tms.matching_score >=');
    const feedArgs = mockQuery.mock.calls[1][1] as unknown[];
    expect(feedArgs).toContain(0.5);
  });

  it('applies default 0.20 threshold when min_matching_score is absent', async () => {
    setupFeedScoreQueries();

    await TaskDiscoveryService.getFeed('hustler-1', {}, 50, 0);

    const feedSql = mockQuery.mock.calls[1][0] as string;
    expect(feedSql).toContain('tms.matching_score >= 0.20');
  });

  it('uses ORDER BY distance for sort_by="distance"', async () => {
    setupFeedScoreQueries();

    await TaskDiscoveryService.getFeed('hustler-1', { sort_by: 'distance' }, 50, 0);

    const feedSql = mockQuery.mock.calls[1][0] as string;
    expect(feedSql).toContain('ORDER BY tms.distance_miles ASC');
  });

  it('uses ORDER BY deadline for sort_by="deadline"', async () => {
    setupFeedScoreQueries();

    await TaskDiscoveryService.getFeed('hustler-1', { sort_by: 'deadline' }, 50, 0);

    const feedSql = mockQuery.mock.calls[1][0] as string;
    expect(feedSql).toContain('ORDER BY t.deadline ASC NULLS LAST');
  });

  it('uses ORDER BY relevance_score as default (no sort_by provided)', async () => {
    setupFeedScoreQueries();

    await TaskDiscoveryService.getFeed('hustler-1', {}, 50, 0);

    const feedSql = mockQuery.mock.calls[1][0] as string;
    expect(feedSql).toContain('ORDER BY tms.relevance_score DESC');
  });
});

// ===========================================================================
// search — query vs no-query branches
// ===========================================================================

describe('TaskDiscoveryService.search — query branch', () => {
  it('uses full-text search SQL when query is provided', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [makeFeedRow()], rowCount: 1 } as never);

    const result = await TaskDiscoveryService.search(
      'hustler-1',
      { query: 'plumbing' },
      20, 0
    );

    expect(result.success).toBe(true);
    const sql = mockQuery.mock.calls[0][0] as string;
    expect(sql).toContain('plainto_tsquery');
    expect(sql).toContain('ts_rank');
  });

  it('delegates to getFeed when no query provided', async () => {
    // calculateFeedScores: open tasks SELECT → empty
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    // getFeed main SELECT
    mockQuery.mockResolvedValueOnce({ rows: [makeFeedRow()], rowCount: 1 } as never);

    const result = await TaskDiscoveryService.search(
      'hustler-1',
      { category: 'home_repair' }, // no query field
      20, 0
    );

    expect(result.success).toBe(true);
    // getFeed path uses tms.matching_score threshold
    const feedSql = mockQuery.mock.calls[1][0] as string;
    expect(feedSql).toContain('task_matching_scores');
  });
});

// ===========================================================================
// saveSearch — invalid sortBy coercion
// ===========================================================================

describe('TaskDiscoveryService.saveSearch — sortBy coercion', () => {
  it('coerces unknown sort_by to "relevance"', async () => {
    const savedRow = {
      id: 'ss-1', user_id: 'user-1', name: 'My Search', query: null,
      filters: JSON.stringify({}), sort_by: 'relevance', created_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [savedRow], rowCount: 1 } as never);

    const result = await TaskDiscoveryService.saveSearch(
      'user-1', 'My Search', undefined, {},
      'invalid_sort' // not in ['relevance','price','distance','deadline']
    );

    expect(result.success).toBe(true);
    // The SQL should have been called with 'relevance' (coerced)
    const insertArgs = mockQuery.mock.calls[0][1] as unknown[];
    expect(insertArgs).toContain('relevance');
  });

  it('preserves valid sortBy when provided', async () => {
    const savedRow = {
      id: 'ss-2', user_id: 'user-1', name: 'Price Sort', query: 'repair',
      filters: JSON.stringify({}), sort_by: 'price', created_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [savedRow], rowCount: 1 } as never);

    await TaskDiscoveryService.saveSearch('user-1', 'Price Sort', 'repair', {}, 'price');

    const insertArgs = mockQuery.mock.calls[0][1] as unknown[];
    expect(insertArgs).toContain('price');
  });
});
