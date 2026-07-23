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
  aiLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
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

vi.mock('../../src/services/TaskSuggestionAIService', () => ({
  TaskSuggestionAIService: { getSuggestions: vi.fn() },
}));

vi.mock('../../src/services/RecommendationService', () => ({
  RecommendationService: {
    recordUserEvent: vi.fn(),
    listCurrent: vi.fn(),
  },
}));

vi.mock('../../src/services/ControlledTestOfferReviewService', () => ({
  ControlledTestOfferReviewService: {
    review: vi.fn(),
    accept: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { taskDiscoveryRouter } from '../../src/routers/taskDiscovery';
import { TaskDiscoveryService } from '../../src/services/TaskDiscoveryService';
import { TaskSuggestionAIService } from '../../src/services/TaskSuggestionAIService';
import { RecommendationService } from '../../src/services/RecommendationService';
import { ControlledTestOfferReviewService } from '../../src/services/ControlledTestOfferReviewService';

const mockService = vi.mocked(TaskDiscoveryService);
const mockSuggestionService = vi.mocked(TaskSuggestionAIService);
const mockRecommendations = vi.mocked(RecommendationService);
const mockControlledOffer = vi.mocked(ControlledTestOfferReviewService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '11111111-1111-1111-1111-111111111111';

function makeCaller(userId = 'test-uid', trustTier = 2) {
  return taskDiscoveryRouter.createCaller({
    user: { id: userId, trust_tier: trustTier, default_mode: 'worker' } as any,
    firebaseUid: 'fb-uid',
  });
}

function makePublicCaller() {
  return taskDiscoveryRouter.createCaller({
    user: null,
    firebaseUid: null,
  });
}

describe('taskDiscovery controlled TEST worker offer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds offer review to the authenticated hustler', async () => {
    mockControlledOffer.review.mockResolvedValueOnce({
      success: true,
      data: { taskId: TEST_UUID, workerId: TEST_UUID, eventType: 'VIEWED' },
    } as any);

    await makeCaller(TEST_UUID).reviewControlledTestOffer({
      taskId: TEST_UUID,
      idempotencyKey: 'offer-review-router-0001',
    });

    expect(mockControlledOffer.review).toHaveBeenCalledWith({
      taskId: TEST_UUID,
      workerId: TEST_UUID,
      idempotencyKey: 'offer-review-router-0001',
    });
  });

  it('binds explicit acceptance to the authenticated hustler and reviewed decision', async () => {
    mockControlledOffer.accept.mockResolvedValueOnce({
      success: true,
      data: { taskId: TEST_UUID, workerId: TEST_UUID, eventType: 'ACCEPTED' },
    } as any);

    await makeCaller(TEST_UUID).acceptControlledTestOffer({
      taskId: TEST_UUID,
      offerDecisionId: TEST_UUID,
      idempotencyKey: 'offer-accept-router-0001',
    });

    expect(mockControlledOffer.accept).toHaveBeenCalledWith({
      taskId: TEST_UUID,
      offerDecisionId: TEST_UUID,
      workerId: TEST_UUID,
      idempotencyKey: 'offer-accept-router-0001',
    });
  });

  it('fails closed with a precondition error for stale evidence', async () => {
    mockControlledOffer.accept.mockResolvedValueOnce({
      success: false,
      error: { code: 'LOCAL_TEST_OFFER_ACCEPT_NOT_READY', message: 'Offer stale' },
    } as any);

    await expect(makeCaller(TEST_UUID).acceptControlledTestOffer({
      taskId: TEST_UUID,
      offerDecisionId: TEST_UUID,
      idempotencyKey: 'offer-accept-router-stale',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
  });
});

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
    expect(result.tasks[0].canAccept).toBe(false); // public browse is read-only and has no personalized distance
    expect(result.tasks[0].requiredTrustTier).toBe(0);
    expect(result.userTrustTier).toBe(0);
    expect(result.isReadOnly).toBe(true);
  });

  it('never exposes an exact address through anonymous discovery', async () => {
    mockService.browsePublicFeed.mockResolvedValueOnce({
      success: true,
      data: [{
        id: 'task-1', title: 'Fix sink', price: 1500,
        location: '123 Main St, Bellevue, WA 98004',
        rough_location: 'Bellevue area',
      }],
    } as any);

    const result = await makePublicCaller().browseTasks({});

    expect(result.tasks[0].location).toBe('Bellevue area');
    expect(JSON.stringify(result.tasks[0])).not.toContain('123 Main St');
  });

  it('annotates expensive tasks as requiring higher tier', async () => {
    const tasks = [{ id: 'task-1', title: 'Major renovation', price: 15000 }];
    mockService.browsePublicFeed.mockResolvedValueOnce({ success: true, data: tasks } as any);

    const result = await makeCaller('user-1', 1).browseTasks({});

    expect(result.tasks[0].canAccept).toBe(false); // tier 1 limit is 5000
    expect(result.tasks[0].requiredTrustTier).toBe(2);
    expect(result.tasks[0].verificationCTA).toContain('Level 2');
  });

  it('requires a personalized decision-ready offer even for a high-trust user', async () => {
    const tasks = [{ id: 'task-1', title: 'Big job', price: 15000 }];
    mockService.browsePublicFeed.mockResolvedValueOnce({ success: true, data: tasks } as any);

    const result = await makeCaller('user-1', 3).browseTasks({});

    expect(result.tasks[0].canAccept).toBe(false);
    expect(result.tasks[0].verificationCTA).toBeNull();
    expect(result.tasks[0].decisionCTA).toMatch(/personalized offer/i);
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
      { task: { id: 'task-1', price: 3000 }, matchingScore: 0.85, offer_decision: { decisionReady: true } },
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

  // T53-6: Matchmaker must not leak poster identity to unassigned hustlers.
  // poster_id should be stripped from tasks where worker_id !== callerUserId.
  it('T53-6: strips poster_id from unassigned task feed items', async () => {
    const CALLER_ID = 'hustler-user-1';
    const feedItems = [
      {
        task: {
          id: 'task-unassigned',
          price: 3000,
          poster_id: 'poster-secret-id',
          worker_id: null, // not yet assigned
        },
        matching_score: 0.8,
        relevance_score: 0.85,
        distance_miles: 1.5,
        offer_decision: { decisionReady: true },
      },
    ];
    mockService.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);

    const result = await makeCaller(CALLER_ID, 2).getFeed({});

    expect(result).toHaveLength(1);
    // poster_id must NOT appear in the response for an unassigned task
    expect((result[0].task as any).poster_id).toBeUndefined();
  });

  it('T53-6: includes poster_id for tasks where the caller is the assigned worker', async () => {
    const CALLER_ID = 'hustler-user-1';
    const feedItems = [
      {
        task: {
          id: 'task-assigned',
          price: 3000,
          poster_id: 'poster-secret-id',
          worker_id: CALLER_ID, // this hustler is the assigned worker
        },
        matching_score: 0.9,
        relevance_score: 0.9,
        distance_miles: 0.5,
        offer_decision: { decisionReady: true },
      },
    ];
    mockService.getFeed.mockResolvedValueOnce({ success: true, data: feedItems } as any);

    const result = await makeCaller(CALLER_ID, 2).getFeed({});

    expect(result).toHaveLength(1);
    // For an assigned task, poster_id is allowed (participant has context)
    expect((result[0].task as any).poster_id).toBe('poster-secret-id');
  });

  it('T53-6: browseTasks also strips poster_id from public task listings', async () => {
    const tasks = [
      {
        id: 'task-1',
        price: 1500,
        poster_id: 'poster-secret-id',
        title: 'Fix sink',
      },
    ];
    mockService.browsePublicFeed.mockResolvedValueOnce({ success: true, data: tasks } as any);

    const result = await makePublicCaller().browseTasks({});

    expect(result.tasks).toHaveLength(1);
    // poster_id must not be in the public browseTasks response
    expect((result.tasks[0] as any).poster_id).toBeUndefined();
  });

  it.each([
    ['unassigned', null],
    ['assigned', 'test-uid'],
  ])('strips exact location and coordinates from the %s personalized feed', async (_state, workerId) => {
    mockService.getFeed.mockResolvedValueOnce({ success: true, data: [{
      task: {
        id: TEST_UUID, title: 'Private-address task', price: 5000,
        worker_id: workerId, poster_id: 'poster-secret-id',
        location: '123 Main St, Bellevue, WA 98004', rough_location: 'Bellevue area',
        location_lat: 47.6101, location_lng: -122.2015, location_geo: 'private-geo',
      },
      matching_score: 0.8, relevance_score: 0.8, distance_miles: 2,
      explanation: 'Nearby', offer_decision: { decisionReady: false },
    }] } as any);

    const result = await makeCaller('test-uid', 2).getFeed({});
    const task = result[0].task as Record<string, unknown>;

    expect(task.location).toBe('Bellevue area');
    expect(task).not.toHaveProperty('location_lat');
    expect(task).not.toHaveProperty('location_lng');
    expect(task).not.toHaveProperty('location_geo');
    expect(JSON.stringify(task)).not.toContain('123 Main St');
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

describe('taskDiscovery.recordRecommendationAction', () => {
  beforeEach(() => vi.clearAllMocks());

  it('binds neutral recommendation feedback to the authenticated Hustler', async () => {
    mockRecommendations.recordUserEvent.mockResolvedValueOnce({
      success: true,
      data: { eventId: 'event-1', rankingPenalty: 0 },
    } as any);

    const result = await makeCaller(TEST_UUID).recordRecommendationAction({
      recommendationId: '22222222-2222-4222-8222-222222222222',
      action: 'DISMISSED',
      idempotencyKey: 'dismiss:recommendation:1',
    });

    expect(result).toEqual({ eventId: 'event-1', rankingPenalty: 0 });
    expect(mockRecommendations.recordUserEvent).toHaveBeenCalledWith({
      actorId: TEST_UUID,
      recommendationId: '22222222-2222-4222-8222-222222222222',
      eventType: 'DISMISSED',
      idempotencyKey: 'dismiss:recommendation:1',
      publicNote: null,
    });
  });

  it('does not convert an unavailable recommendation into a successful action', async () => {
    mockRecommendations.recordUserEvent.mockResolvedValueOnce({
      success: false,
      error: { code: 'RECOMMENDATION_NOT_FOUND', message: 'Unavailable' },
    } as any);

    await expect(makeCaller(TEST_UUID).recordRecommendationAction({
      recommendationId: '22222222-2222-4222-8222-222222222222',
      action: 'SNOOZED',
      idempotencyKey: 'snooze:recommendation:1',
    })).rejects.toThrow('Unavailable');
  });
});

describe('taskDiscovery.listRecommendations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retrieves Recommendation evidence for the authenticated Hustler only', async () => {
    mockRecommendations.listCurrent.mockResolvedValueOnce({
      success: true,
      data: [{ id: '22222222-2222-4222-8222-222222222222', subjectType: 'TASK' }],
    } as any);

    const result = await makeCaller(TEST_UUID).listRecommendations({ limit: 10, offset: 0 });

    expect(result).toHaveLength(1);
    expect(mockRecommendations.listCurrent).toHaveBeenCalledWith(TEST_UUID, { limit: 10, offset: 0 });
  });
});

describe('taskDiscovery.getAISuggestions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the server-authoritative offer decision with every Recommendation', async () => {
    mockSuggestionService.getSuggestions.mockResolvedValueOnce({ success: true, data: [{
      recommendationId: '22222222-2222-4222-8222-222222222222',
      task: {
        id: TEST_UUID, title: 'Repair fence', description: 'Replace two damaged boards.',
        price: 14_000, hustler_payout_cents: 10_500, distance_miles: 2.3,
        estimated_duration_minutes: 120, rough_location: 'North Bellevue', risk_level: 'LOW',
        required_tools: ['drill'], scope_hash: 'a'.repeat(64),
        cancellation_policy_version: 'cancel-v1', late_cancel_pct: 0.5,
        cancellation_window_hours: 24,
      },
      matching_score: 0.91, distance_miles: 2.3,
      offerDecision: {
        decisionReady: true,
        economics: { customerTotalCents: 14_000, payoutCents: 10_500 },
        logistics: { distanceMiles: 2.3, estimatedDurationMinutes: 120 },
        scope: { risk: 'LOW', requiredTools: ['drill'] },
        rights: { passingHasRankPenalty: false },
      },
    }] } as any);

    const result = await makeCaller(TEST_UUID).getAISuggestions({ limit: 1 });

    expect(result.suggestions[0].offerDecision).toMatchObject({
      decisionReady: true,
      economics: { customerTotalCents: 14_000, payoutCents: 10_500 },
      logistics: { distanceMiles: 2.3, estimatedDurationMinutes: 120 },
      scope: { risk: 'LOW', requiredTools: ['drill'] },
      rights: { passingHasRankPenalty: false },
    });
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
