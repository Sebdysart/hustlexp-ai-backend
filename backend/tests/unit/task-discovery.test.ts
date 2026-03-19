/**
 * TaskDiscoveryService Unit Tests
 *
 * Tests all exported methods of TaskDiscoveryService:
 * browsePublicFeed, calculateMatchingScore, calculateFeedScores,
 * getFeed, search, getExplanation, saveSearch, getSavedSearches,
 * deleteSavedSearch, executeSavedSearch
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that use them
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn(), serializableTransaction: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/logger', () => {
  const childFn = () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: childFn });
  return { logger: { child: childFn, info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn() } };
});

vi.mock('../../src/services/GeocodingService', () => ({
  GeocodingService: {
    geocodeAddress: vi.fn().mockResolvedValue({ lat: 47.6, lng: -122.3 }),
    calculateDistanceMiles: vi.fn().mockReturnValue(2.5),
  },
}));

vi.mock('../../src/lib/pii-scrubber', () => ({
  scrubPII: vi.fn((text: string) => text), // pass-through
}));

vi.mock('../../src/services/AIClient', () => ({
  AIClient: {
    isConfigured: vi.fn().mockReturnValue(false),
    call: vi.fn(),
    callJSON: vi.fn(),
  },
}));

import { TaskDiscoveryService } from '../../src/services/TaskDiscoveryService';
import { db } from '../../src/db';
import { AIClient } from '../../src/services/AIClient';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePublicTaskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Fix leaky faucet',
    description: 'Need plumber',
    category: 'home_repair',
    price: 5000,
    location: 'Seattle, WA',
    deadline: null,
    created_at: new Date().toISOString(),
    state: 'OPEN',
    requires_proof: false,
    mode: 'STANDARD',
    poster_id: 'user-poster-1',
    ...overrides,
  };
}

function makeTaskFeedRow(overrides: Record<string, unknown> = {}) {
  return {
    ...makePublicTaskRow(),
    matching_score: 0.75,
    relevance_score: 0.80,
    distance_miles: 2.5,
    search_rank: 0.9,
    ...overrides,
  };
}

function makeSavedSearch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'search-1',
    user_id: 'user-1',
    name: 'My Search',
    query: 'plumber',
    filters: JSON.stringify({ category: 'home_repair' }),
    sort_by: 'relevance',
    created_at: new Date(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('TaskDiscoveryService', () => {

  // -------------------------------------------------------------------------
  // browsePublicFeed
  // -------------------------------------------------------------------------
  describe('browsePublicFeed', () => {
    it('returns rows on success', async () => {
      const row = makePublicTaskRow();
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      const result = await TaskDiscoveryService.browsePublicFeed({});

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].id).toBe('task-1');
      }
    });

    it('returns rows with category filter', async () => {
      const row = makePublicTaskRow({ category: 'cleaning' });
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      const result = await TaskDiscoveryService.browsePublicFeed({ category: 'cleaning' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].category).toBe('cleaning');
      }
    });

    it('returns rows with price filters', async () => {
      const row = makePublicTaskRow({ price: 7500 });
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      const result = await TaskDiscoveryService.browsePublicFeed({ min_price: 5000, max_price: 10000 });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].price).toBe(7500);
      }
    });

    it('returns empty array when no tasks found', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.browsePublicFeed({ sort_by: 'price_high' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it('returns error on DB failure', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.browsePublicFeed({});

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
        expect(result.error.message).toBe('Database error');
      }
    });
  });

  // -------------------------------------------------------------------------
  // calculateMatchingScore
  // -------------------------------------------------------------------------
  describe('calculateMatchingScore', () => {
    it('returns matching score on success', async () => {
      // Query 1: task details
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          category: 'home_repair',
          price: 5000,
          deadline: null,
          location: 'Seattle, WA',
          created_at: new Date(),
        }],
        rowCount: 1,
      });
      // Query 2: hustler details
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{
          id: 'hustler-1',
          trust_tier: 3,
          zip_code: '98101',
          preferred_categories: ['home_repair'],
          preferred_min_price: 2000,
        }],
        rowCount: 1,
      });
      // Query 3: hustler stats
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ completion_rate: 80, approval_rate: 90, category_experience: {} }],
        rowCount: 1,
      });
      // Query 4: category experience
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ category: 'home_repair', count: 5 }],
        rowCount: 1,
      });

      const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.matchingScore).toBeGreaterThanOrEqual(0);
        expect(result.data.matchingScore).toBeLessThanOrEqual(1);
        expect(result.data.components).toBeDefined();
        expect(result.data.distanceMiles).toBeGreaterThanOrEqual(0);
      }
    });

    it('returns NOT_FOUND when task does not exist', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.calculateMatchingScore('nonexistent-task', 'hustler-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
        expect(result.error.message).toContain('nonexistent-task');
      }
    });

    it('returns NOT_FOUND when hustler does not exist', async () => {
      // Query 1: task found
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          category: 'home_repair',
          price: 5000,
          deadline: null,
          location: 'Seattle, WA',
          created_at: new Date(),
        }],
        rowCount: 1,
      });
      // Query 2: hustler not found
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'nonexistent-hustler');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
        expect(result.error.message).toContain('nonexistent-hustler');
      }
    });

    it('returns error on DB failure', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.calculateMatchingScore('task-1', 'hustler-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // calculateFeedScores
  // -------------------------------------------------------------------------
  describe('calculateFeedScores', () => {
    it('calculates scores for open tasks', async () => {
      // Query 1: open tasks list
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ id: 'task-1' }],
        rowCount: 1,
      });
      // calculateMatchingScore sub-calls:
      // Q2: task details
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          category: 'home_repair',
          price: 5000,
          deadline: null,
          location: 'Seattle, WA',
          created_at: new Date(),
        }],
        rowCount: 1,
      });
      // Q3: hustler details
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{
          id: 'hustler-1',
          trust_tier: 2,
          zip_code: '98101',
          preferred_categories: ['home_repair'],
          preferred_min_price: 1000,
        }],
        rowCount: 1,
      });
      // Q4: hustler stats
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ completion_rate: 75, approval_rate: 85 }],
        rowCount: 1,
      });
      // Q5: category experience
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [],
        rowCount: 0,
      });
      // Q6: task details for relevance score
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ created_at: new Date(), deadline: null }],
        rowCount: 1,
      });
      // Q7: INSERT into task_matching_scores
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await TaskDiscoveryService.calculateFeedScores('hustler-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data.calculated).toBe('number');
        expect(typeof result.data.cached).toBe('number');
      }
    });

    it('returns zeros when no open tasks exist', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.calculateFeedScores('hustler-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.calculated).toBe(0);
        expect(result.data.cached).toBe(0);
      }
    });

    it('returns error on DB failure', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.calculateFeedScores('hustler-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getFeed
  // -------------------------------------------------------------------------
  describe('getFeed', () => {
    /**
     * getFeed internally calls calculateFeedScores which calls calculateMatchingScore.
     * We need to mock many sequential queries. The simplest approach is to make
     * the open-tasks query return [] so calculateFeedScores finishes quickly,
     * then mock the final SELECT for the feed itself.
     */
    function stubCalculateFeedScoresNoTasks() {
      // open tasks for calculateFeedScores -> empty
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    }

    it('returns feed items on success', async () => {
      stubCalculateFeedScoresNoTasks();
      // Feed SELECT
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [makeTaskFeedRow()],
        rowCount: 1,
      });

      const result = await TaskDiscoveryService.getFeed('hustler-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].task.id).toBe('task-1');
        expect(result.data[0].matching_score).toBe(0.75);
        expect(typeof result.data[0].explanation).toBe('string');
      }
    });

    it('returns empty array when no matching tasks', async () => {
      stubCalculateFeedScoresNoTasks();
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.getFeed('hustler-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it('returns error on DB failure during feed SELECT', async () => {
      stubCalculateFeedScoresNoTasks();
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.getFeed('hustler-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------
  describe('search', () => {
    it('returns results with full-text query', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [makeTaskFeedRow({ search_rank: 0.95 })],
        rowCount: 1,
      });

      const result = await TaskDiscoveryService.search('hustler-1', { query: 'plumber' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].task.id).toBe('task-1');
      }
    });

    it('returns empty array when no search results', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.search('hustler-1', { query: 'no match query' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it('applies category filter in full-text search', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [makeTaskFeedRow({ category: 'cleaning' })],
        rowCount: 1,
      });

      const result = await TaskDiscoveryService.search('hustler-1', {
        query: 'cleaning',
        category: 'cleaning',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data[0].task.category).toBe('cleaning');
      }
    });

    it('falls back to getFeed when no query provided', async () => {
      // No query -> calls getFeed -> calculateFeedScores (empty tasks) + feed SELECT
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 }); // calculateFeedScores open tasks
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [makeTaskFeedRow()],
        rowCount: 1,
      });

      const result = await TaskDiscoveryService.search('hustler-1', { category: 'home_repair' });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }
    });

    it('returns error on DB failure', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.search('hustler-1', { query: 'plumber' });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getExplanation
  // -------------------------------------------------------------------------
  describe('getExplanation', () => {
    function stubCalculateMatchingScoreSuccess() {
      // Q1: task details (for calculateMatchingScore)
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{
          id: 'task-1',
          category: 'home_repair',
          price: 5000,
          deadline: null,
          location: 'Seattle, WA',
          created_at: new Date(),
        }],
        rowCount: 1,
      });
      // Q2: hustler details
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{
          id: 'hustler-1',
          trust_tier: 3,
          zip_code: '98101',
          preferred_categories: ['home_repair'],
          preferred_min_price: 2000,
        }],
        rowCount: 1,
      });
      // Q3: hustler stats
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ completion_rate: 80, approval_rate: 90 }],
        rowCount: 1,
      });
      // Q4: category experience
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    }

    it('returns explanation when task and hustler exist', async () => {
      stubCalculateMatchingScoreSuccess();
      // Q5: task details for explanation
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ title: 'Fix faucet', category: 'home_repair', price: 5000, description: 'Leaky faucet' }],
        rowCount: 1,
      });
      // Q6: user expertise
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.getExplanation('task-1', 'hustler-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(typeof result.data).toBe('string');
        expect(result.data.length).toBeGreaterThan(0);
      }
    });

    it('returns error when task not found', async () => {
      // calculateMatchingScore returns NOT_FOUND for task
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.getExplanation('nonexistent-task', 'hustler-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns error on DB failure', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.getExplanation('task-1', 'hustler-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });

    // -----------------------------------------------------------------------
    // TDD: Fix #1 — route getExplanation through AIClient.call (not raw fetch)
    // -----------------------------------------------------------------------
    it('uses AIClient.call when AI is configured and returns AI-generated explanation', async () => {
      // Before fix: AIClient.call is never invoked (raw fetch used instead).
      // After fix:  AIClient.call is the AI path; its response is used directly.
      (AIClient.isConfigured as any).mockReturnValue(true);
      (AIClient.call as any).mockResolvedValue({
        content: 'This task perfectly matches your home repair expertise and location.',
        provider: 'anthropic',
        latencyMs: 80,
        cached: false,
      });

      stubCalculateMatchingScoreSuccess();
      // Q5: task details for explanation
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ title: 'Fix faucet', category: 'home_repair', price: 5000, description: 'Leaky faucet' }],
        rowCount: 1,
      });
      // Q6: user expertise
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.getExplanation('task-1', 'hustler-1');

      expect(result.success).toBe(true);
      expect(AIClient.call).toHaveBeenCalled();   // ← FAILS before fix
      if (result.success) {
        expect(result.data).toBe(
          'This task perfectly matches your home repair expertise and location.'
        );
      }
    });

    it('falls back to template explanation when AIClient.call throws', async () => {
      // Before fix: AIClient.call is not called; no regression possible.
      // After fix:  AIClient.call throws — must degrade to generateExplanation() template.
      (AIClient.isConfigured as any).mockReturnValue(true);
      (AIClient.call as any).mockRejectedValue(new Error('circuit open'));

      stubCalculateMatchingScoreSuccess();
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [{ title: 'Fix faucet', category: 'home_repair', price: 5000, description: 'Leaky faucet' }],
        rowCount: 1,
      });
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.getExplanation('task-1', 'hustler-1');

      expect(result.success).toBe(true);
      expect(AIClient.call).toHaveBeenCalled();   // ← FAILS before fix
      if (result.success) {
        expect(typeof result.data).toBe('string');
        expect(result.data.length).toBeGreaterThan(0);
      }
    });
  });

  // -------------------------------------------------------------------------
  // saveSearch
  // -------------------------------------------------------------------------
  describe('saveSearch', () => {
    it('saves search and returns saved search object', async () => {
      const savedSearch = makeSavedSearch();
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [savedSearch], rowCount: 1 });

      const result = await TaskDiscoveryService.saveSearch(
        'user-1',
        'My Search',
        'plumber',
        { category: 'home_repair' },
        'relevance'
      );

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.id).toBe('search-1');
        expect(result.data.name).toBe('My Search');
        expect(result.data.user_id).toBe('user-1');
        // filters should be parsed object, not a string
        expect(typeof result.data.filters).not.toBe('string');
      }
    });

    it('returns error on DB failure', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.saveSearch(
        'user-1',
        'My Search',
        undefined,
        {},
        'price'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getSavedSearches
  // -------------------------------------------------------------------------
  describe('getSavedSearches', () => {
    it('returns saved searches for a user', async () => {
      const rows = [makeSavedSearch(), makeSavedSearch({ id: 'search-2', name: 'Second Search' })];
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows, rowCount: 2 });

      const result = await TaskDiscoveryService.getSavedSearches('user-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        // filters should be parsed
        result.data.forEach(s => {
          expect(typeof s.filters).not.toBe('string');
        });
      }
    });

    it('returns empty array when user has no saved searches', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.getSavedSearches('user-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it('returns error on DB failure', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.getSavedSearches('user-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // deleteSavedSearch
  // -------------------------------------------------------------------------
  describe('deleteSavedSearch', () => {
    it('deletes saved search successfully', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 1 });

      const result = await TaskDiscoveryService.deleteSavedSearch('search-1', 'user-1');

      expect(result.success).toBe(true);
    });

    it('returns NOT_FOUND when search does not exist or belongs to another user', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.deleteSavedSearch('nonexistent-search', 'user-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns error on DB failure', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.deleteSavedSearch('search-1', 'user-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // executeSavedSearch
  // -------------------------------------------------------------------------
  describe('executeSavedSearch', () => {
    it('executes saved search with stored filters', async () => {
      // Q1: fetch saved search
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [makeSavedSearch({ query: 'plumber' })],
        rowCount: 1,
      });
      // search() with query -> single db.query call
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        rows: [makeTaskFeedRow()],
        rowCount: 1,
      });

      const result = await TaskDiscoveryService.executeSavedSearch('search-1', 'user-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
        expect(result.data[0].task.id).toBe('task-1');
      }
    });

    it('returns NOT_FOUND when saved search does not exist', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const result = await TaskDiscoveryService.executeSavedSearch('nonexistent-search', 'user-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
        expect(result.error.message).toContain('Saved search not found');
      }
    });

    it('returns error on DB failure', async () => {
      (db.query as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('DB error'));

      const result = await TaskDiscoveryService.executeSavedSearch('search-1', 'user-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });
});
