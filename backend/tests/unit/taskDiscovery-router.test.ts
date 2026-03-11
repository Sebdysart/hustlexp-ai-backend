/**
 * TaskDiscovery Router Unit Tests
 *
 * Tests tRPC procedures:
 * - browseTasks (public, query)
 * - getFeed (protected, query)
 * - calculateFeedScores (protected, mutation)
 * - calculateMatchingScore (protected, query)
 * - getExplanation (protected, query)
 * - search (protected, query)
 * - saveSearch (protected, mutation)
 * - getSavedSearches (protected, query)
 * - deleteSavedSearch (protected, mutation)
 * - executeSavedSearch (protected, query)
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
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/TaskDiscoveryService', () => ({
  TaskDiscoveryService: {
    browsePublicFeed: vi.fn(),
    getFeed: vi.fn(),
    calculateFeedScores: vi.fn(),
    calculateMatchingScore: vi.fn(),
    getExplanation: vi.fn(),
    search: vi.fn(),
    saveSearch: vi.fn(),
    getSavedSearches: vi.fn(),
    deleteSavedSearch: vi.fn(),
    executeSavedSearch: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { taskDiscoveryRouter } from '../../src/routers/taskDiscovery';
import { TaskDiscoveryService } from '../../src/services/TaskDiscoveryService';

const mockService = vi.mocked(TaskDiscoveryService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '11111111-1111-1111-1111-111111111111';

function makeCaller(userId = 'test-uid', trustTier = 2) {
  return taskDiscoveryRouter.createCaller({
    user: { id: userId, trust_tier: trustTier } as any,
    firebaseUid: 'fb-uid',
  });
}

function makePublicCaller() {
  return taskDiscoveryRouter.createCaller({
    user: null,
    firebaseUid: null,
  });
}

// ---------------------------------------------------------------------------
// Tests — browseTasks (public)
// ---------------------------------------------------------------------------

describe('taskDiscovery.browseTasks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns annotated tasks for unauthenticated user', async () => {
    const tasks = [{ id: 'task-1', title: 'Fix sink', price: 1500 }];
    mockService.browsePublicFeed.mockResolvedValueOnce({ success: true, data: tasks } as any);

    const result = await makePublicCaller().browseTasks({});

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].canAccept).toBe(true); // 1500 < 2000 (tier 0 limit)
    expect(result.tasks[0].requiredTrustTier).toBe(0);
    expect(result.userTrustTier).toBe(0);
    expect(result.isReadOnly).toBe(true);
  });

  it('annotates expensive tasks as requiring higher tier', async () => {
    const tasks = [{ id: 'task-1', title: 'Major renovation', price: 15000 }];
    mockService.browsePublicFeed.mockResolvedValueOnce({ success: true, data: tasks } as any);

    const result = await makeCaller('user-1', 1).browseTasks({});

    expect(result.tasks[0].canAccept).toBe(false); // tier 1 limit is 5000
    expect(result.tasks[0].requiredTrustTier).toBe(2);
    expect(result.tasks[0].verificationCTA).toContain('Level 2');
  });

  it('authenticated user with high tier can accept expensive tasks', async () => {
    const tasks = [{ id: 'task-1', title: 'Big job', price: 15000 }];
    mockService.browsePublicFeed.mockResolvedValueOnce({ success: true, data: tasks } as any);

    const result = await makeCaller('user-1', 3).browseTasks({});

    expect(result.tasks[0].canAccept).toBe(true);
    expect(result.tasks[0].verificationCTA).toBeNull();
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockService.browsePublicFeed.mockResolvedValueOnce({
      success: false,
      error: { message: 'DB error' },
    } as any);

    await expect(makePublicCaller().browseTasks({})).rejects.toThrow('DB error');
  });
});

// ---------------------------------------------------------------------------
// Tests — getFeed (protected)
// ---------------------------------------------------------------------------

describe('taskDiscovery.getFeed', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns annotated feed items', async () => {
    const feedItems = [
      { task: { id: 'task-1', price: 3000 }, matchingScore: 0.85 },
    ];
    mockService.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);

    const result = await makeCaller('user-1', 2).getFeed({});

    expect(result).toHaveLength(1);
    expect(result[0].canAccept).toBe(true);
    expect(result[0].matchingScore).toBe(0.85);
  });

  it('merges iOS flat params into filters', async () => {
    mockService.getFeed.mockResolvedValueOnce({ success: true, data: [] } as any);

    await makeCaller().getFeed({
      radiusMeters: 16093,
      skills: ['plumbing'],
    });

    const callArgs = mockService.getFeed.mock.calls[0];
    expect(callArgs[1]).toHaveProperty('max_distance_miles');
    expect(callArgs[1]).toHaveProperty('skills');
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockService.getFeed.mockResolvedValueOnce({
      success: false,
      error: { message: 'Feed error' },
    } as any);

    await expect(makeCaller().getFeed({})).rejects.toThrow('Feed error');
  });
});

// ---------------------------------------------------------------------------
// Tests — calculateFeedScores
// ---------------------------------------------------------------------------

describe('taskDiscovery.calculateFeedScores', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calculates feed scores', async () => {
    const scoreData = { scoresComputed: 15 };
    mockService.calculateFeedScores.mockResolvedValueOnce({ success: true, data: scoreData } as any);

    const result = await makeCaller().calculateFeedScores({});

    expect(result).toEqual(scoreData);
  });

  it('throws when service fails', async () => {
    mockService.calculateFeedScores.mockResolvedValueOnce({
      success: false,
      error: { message: 'Computation error' },
    } as any);

    await expect(makeCaller().calculateFeedScores({})).rejects.toThrow('Computation error');
  });
});

// ---------------------------------------------------------------------------
// Tests — calculateMatchingScore
// ---------------------------------------------------------------------------

describe('taskDiscovery.calculateMatchingScore', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns matching score for a task', async () => {
    const score = { score: 0.92, factors: {} };
    mockService.calculateMatchingScore.mockResolvedValueOnce({ success: true, data: score } as any);

    const result = await makeCaller().calculateMatchingScore({ taskId: TEST_UUID });

    expect(result).toEqual(score);
  });

  it('throws NOT_FOUND when task not found', async () => {
    mockService.calculateMatchingScore.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Task not found' },
    } as any);

    await expect(
      makeCaller().calculateMatchingScore({ taskId: TEST_UUID })
    ).rejects.toThrow('Task not found');
  });
});

// ---------------------------------------------------------------------------
// Tests — getExplanation
// ---------------------------------------------------------------------------

describe('taskDiscovery.getExplanation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns task explanation', async () => {
    const explanation = 'This task matches your plumbing skills';
    mockService.getExplanation.mockResolvedValueOnce({ success: true, data: explanation } as any);

    const result = await makeCaller().getExplanation({ taskId: TEST_UUID });

    expect(result.explanation).toBe(explanation);
  });
});

// ---------------------------------------------------------------------------
// Tests — search
// ---------------------------------------------------------------------------

describe('taskDiscovery.search', () => {
  beforeEach(() => vi.clearAllMocks());

  it('searches tasks with query', async () => {
    const searchResults = [{ id: 'task-1', title: 'Fix sink' }];
    mockService.search.mockResolvedValueOnce({ success: true, data: searchResults } as any);

    const result = await makeCaller().search({ query: 'sink' });

    expect(result).toEqual(searchResults);
    expect(mockService.search).toHaveBeenCalled();
  });

  it('merges flat iOS params into search filters', async () => {
    mockService.search.mockResolvedValueOnce({ success: true, data: [] } as any);

    await makeCaller().search({
      query: 'test',
      category: 'cleaning',
      minPaymentCents: 1000,
      maxPaymentCents: 5000,
    });

    const callArgs = mockService.search.mock.calls[0];
    expect(callArgs[1]).toHaveProperty('category', 'cleaning');
    expect(callArgs[1]).toHaveProperty('min_price', 1000);
    expect(callArgs[1]).toHaveProperty('max_price', 5000);
  });
});

// ---------------------------------------------------------------------------
// Tests — Saved Searches
// ---------------------------------------------------------------------------

describe('taskDiscovery.saveSearch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('saves a search', async () => {
    const saved = { id: 'search-1', name: 'My Search' };
    mockService.saveSearch.mockResolvedValueOnce({ success: true, data: saved } as any);

    const result = await makeCaller().saveSearch({ name: 'My Search' });

    expect(result).toEqual(saved);
  });
});

describe('taskDiscovery.getSavedSearches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns saved searches', async () => {
    const searches = [{ id: 'search-1', name: 'My Search' }];
    mockService.getSavedSearches.mockResolvedValueOnce({ success: true, data: searches } as any);

    const result = await makeCaller().getSavedSearches();

    expect(result).toEqual(searches);
  });
});

describe('taskDiscovery.deleteSavedSearch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('deletes a saved search', async () => {
    mockService.deleteSavedSearch.mockResolvedValueOnce({ success: true, data: null } as any);

    const result = await makeCaller().deleteSavedSearch({ searchId: TEST_UUID });

    expect(result.success).toBe(true);
  });
});

describe('taskDiscovery.executeSavedSearch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('executes a saved search', async () => {
    const results = [{ id: 'task-1' }];
    mockService.executeSavedSearch.mockResolvedValueOnce({ success: true, data: results } as any);

    const result = await makeCaller().executeSavedSearch({ searchId: TEST_UUID });

    expect(result).toEqual(results);
  });
});
