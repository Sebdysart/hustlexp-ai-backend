/**
 * Analytics, Feed, and Batch Service Unit Tests
 *
 * Services covered:
 *  1. AnalyticsService          (0%  coverage)
 *  2. TaskBatchingService       (0%  coverage)
 *  3. FeedQueryService          (0%  coverage)
 *  4. AnomalyDetectionService   (38% coverage — class methods not yet tested)
 *  5. XPTaxService              (3%  coverage)
 *  6. InstantRateLimiter        (0%  coverage)
 *  7. InstantModeKillSwitch     (0%  coverage)
 *  8. TaskRiskClassifier        (38% coverage — toLegacyRiskLevel not yet tested)
 *  9. KnowledgeGraphService     (0%  coverage)
 * 10. InstantObservability      (0%  coverage)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// ALL vi.mock CALLS MUST BE BEFORE ANY IMPORTS
// ============================================================================

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      readQuery: vi.fn(),
      // serializableTransaction calls the callback with the same query spy so
      // mockResolvedValueOnce sequences set on mockDb.query work seamlessly
      // inside transaction callbacks (mirrors EscrowService.test.ts pattern).
      serializableTransaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  logger: {
    child: vi.fn(() => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  },
  aiLogger: {
    child: vi.fn(() => ({
      warn: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock('../../src/services/GDPRService', () => ({
  GDPRService: {
    getConsentStatus: vi.fn(),
  },
}));

vi.mock('../../src/services/EligibilityResolverService', () => ({
  isEligible: vi.fn(() => ({
    eligible: true,
    code: 'HX200',
    reasons: [],
  })),
}));

vi.mock('../../src/services/AIClient', () => ({
  AIClient: {
    isConfigured: vi.fn(() => false),
    callJSON: vi.fn(),
  },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    isConfigured: vi.fn(() => true),
    verifyPaymentIntent: vi.fn(),
  },
}));

vi.mock('openai', () => {
  const mockCreate = vi.fn();
  function MockOpenAI() {
    this.embeddings = { create: mockCreate };
  }
  return {
    default: MockOpenAI,
    __mockEmbeddingsCreate: mockCreate,
  };
});

// ============================================================================
// IMPORTS — after all mocks
// ============================================================================

import { db, isInvariantViolation } from '../../src/db';
import { GDPRService } from '../../src/services/GDPRService';
import { isEligible } from '../../src/services/EligibilityResolverService';
import { AIClient } from '../../src/services/AIClient';
import { StripeService } from '../../src/services/StripeService';

import { AnalyticsService } from '../../src/services/AnalyticsService';
import { TaskBatchingService } from '../../src/services/TaskBatchingService';
import { queryFeed, getNearbyTasks, getTasksByTrade } from '../../src/services/FeedQueryService';
import { AnomalyDetectionService } from '../../src/services/AnomalyDetectionService';
import { XPTaxService } from '../../src/services/XPTaxService';
import { InstantRateLimiter } from '../../src/services/InstantRateLimiter';
import { InstantModeKillSwitch } from '../../src/services/InstantModeKillSwitch';
import { TaskRiskClassifier, TaskRisk } from '../../src/services/TaskRiskClassifier';
import { KnowledgeGraphService } from '../../src/services/KnowledgeGraphService';
import { InstantObservability } from '../../src/services/InstantObservability';

const mockDb = vi.mocked(db);
const mockGDPR = vi.mocked(GDPRService);
const mockIsEligible = vi.mocked(isEligible);
const mockAIClient = vi.mocked(AIClient);
const mockStripe = vi.mocked(StripeService);
const mockIsInvariantViolation = vi.mocked(isInvariantViolation);

beforeEach(() => {
  // resetAllMocks clears both call history AND once-queues, preventing mock
  // bleed across tests when a previous test fails before consuming all its
  // queued mockResolvedValueOnce / mockRejectedValueOnce responses.
  vi.resetAllMocks();
  // Re-apply default implementations that were wiped by resetAllMocks.
  vi.mocked(isInvariantViolation).mockReturnValue(false);
  // isEligible is the default for feed tests — all tasks eligible unless overridden.
  mockIsEligible.mockReturnValue({ eligible: true, code: 'HX200', reasons: [] });
  // Stripe configured by default so payTax tests hit the verification path.
  mockStripe.isConfigured.mockReturnValue(true);
  // AIClient not configured by default (avoids real AI calls).
  mockAIClient.isConfigured.mockReturnValue(false);
});

// ============================================================================
// FACTORY HELPERS
// ============================================================================

function makeAnalyticsEvent(overrides = {}) {
  return {
    id: 'evt-1',
    event_type: 'task_created',
    event_category: 'user_action' as const,
    user_id: 'user-1',
    session_id: 'sess-1',
    device_id: 'dev-1',
    task_id: null,
    task_category: null,
    trust_tier: null,
    properties: {},
    platform: 'ios' as const,
    app_version: null,
    ab_test_id: null,
    ab_variant: null,
    event_timestamp: new Date('2026-03-01T00:00:00Z'),
    ingested_at: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

function makeTrackEventParams(overrides = {}) {
  return {
    eventType: 'task_created' as const,
    eventCategory: 'user_action' as const,
    userId: 'user-1',
    sessionId: 'sess-1',
    deviceId: 'dev-1',
    platform: 'ios' as const,
    ...overrides,
  };
}

function makeTask(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Test task',
    price: 5000, // cents
    location: '123 Main St',
    latitude: 37.7749,
    longitude: -122.4194,
    estimatedDuration: 60,
    ...overrides,
  };
}

function makeFeedRow(overrides = {}) {
  return {
    id: 'task-1',
    title: 'Fix sink',
    description: 'Plumbing work needed',
    trade: 'plumbing',
    location_address: '123 Main St',
    location_city: 'San Francisco',
    location_state: 'CA',
    location_lat: 37.7749,
    location_lng: -122.4194,
    payout_cents: 10000,
    currency: 'USD',
    risk_level: 'low' as const,
    estimated_duration_minutes: 60,
    insurance_required: false,
    background_check_required: false,
    created_at: '2026-03-01T00:00:00Z',
    poster_id: 'poster-1',
    poster_rating: 4.8,
    poster_completed_tasks: 10,
    ...overrides,
  };
}

function makeCapabilityProfile(overrides = {}) {
  return {
    userId: 'user-1',
    verifiedTrades: [{ trade: 'plumbing', level: 'basic' }],
    riskClearance: ['low', 'medium'],
    insuranceStatus: 'none',
    backgroundCheckStatus: 'none',
    ...overrides,
  };
}

// ============================================================================
// 1. AnalyticsService
// ============================================================================

describe('AnalyticsService.trackEvent', () => {
  it('tracks event successfully when no consent record exists', async () => {
    mockGDPR.getConsentStatus.mockResolvedValueOnce({ success: true, data: [] });
    const event = makeAnalyticsEvent();
    mockDb.query.mockResolvedValueOnce({ rows: [event], rowCount: 1 });

    const result = await AnalyticsService.trackEvent(makeTrackEventParams());

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_type).toBe('task_created');
    }
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO analytics_events'),
      expect.any(Array)
    );
  });

  it('returns CONSENT_REQUIRED when user has explicitly revoked analytics consent', async () => {
    mockGDPR.getConsentStatus.mockResolvedValueOnce({
      success: true,
      data: [{ consent_type: 'analytics', granted: false }],
    });

    const result = await AnalyticsService.trackEvent(makeTrackEventParams());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CONSENT_REQUIRED');
    }
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('tracks event when user has granted analytics consent', async () => {
    mockGDPR.getConsentStatus.mockResolvedValueOnce({
      success: true,
      data: [{ consent_type: 'analytics', granted: true }],
    });
    const event = makeAnalyticsEvent();
    mockDb.query.mockResolvedValueOnce({ rows: [event], rowCount: 1 });

    const result = await AnalyticsService.trackEvent(makeTrackEventParams());

    expect(result.success).toBe(true);
  });

  it('tracks anonymous event without GDPR check (no userId)', async () => {
    const event = makeAnalyticsEvent({ user_id: null });
    mockDb.query.mockResolvedValueOnce({ rows: [event], rowCount: 1 });

    const result = await AnalyticsService.trackEvent(
      makeTrackEventParams({ userId: undefined })
    );

    expect(result.success).toBe(true);
    expect(mockGDPR.getConsentStatus).not.toHaveBeenCalled();
  });

  it('returns DB_ERROR when db.query throws', async () => {
    mockGDPR.getConsentStatus.mockResolvedValueOnce({ success: true, data: [] });
    mockDb.query.mockRejectedValueOnce(new Error('Connection reset'));

    const result = await AnalyticsService.trackEvent(makeTrackEventParams());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
      expect(result.error.message).toBe('Connection reset');
    }
  });

  it('returns invariant violation error when db raises constraint', async () => {
    mockGDPR.getConsentStatus.mockResolvedValueOnce({ success: true, data: [] });
    const dbErr = Object.assign(new Error('invariant'), { code: 'HX201' });
    mockDb.query.mockRejectedValueOnce(dbErr);
    mockIsInvariantViolation.mockReturnValueOnce(true);

    const result = await AnalyticsService.trackEvent(makeTrackEventParams());

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HX201');
    }
  });

  it('uses provided eventTimestamp when passed', async () => {
    mockGDPR.getConsentStatus.mockResolvedValueOnce({ success: true, data: [] });
    const event = makeAnalyticsEvent();
    mockDb.query.mockResolvedValueOnce({ rows: [event], rowCount: 1 });
    const ts = new Date('2026-01-01T00:00:00Z');

    await AnalyticsService.trackEvent(makeTrackEventParams({ eventTimestamp: ts }));

    const callArgs = mockDb.query.mock.calls[0][1] as unknown[];
    expect(callArgs).toContain(ts);
  });
});

describe('AnalyticsService.trackBatch', () => {
  it('tracks all events in batch and returns counts', async () => {
    // Each trackEvent call needs a GDPR check + db.query
    const event = makeAnalyticsEvent();
    mockGDPR.getConsentStatus
      .mockResolvedValue({ success: true, data: [] });
    mockDb.query
      .mockResolvedValue({ rows: [event], rowCount: 1 });

    const result = await AnalyticsService.trackBatch([
      makeTrackEventParams({ eventType: 'task_created' }),
      makeTrackEventParams({ eventType: 'task_accepted' }),
      makeTrackEventParams({ eventType: 'task_completed' }),
    ]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tracked).toBe(3);
      expect(result.data.failed).toBe(0);
    }
  });

  it('counts failed events separately when some trackEvent calls fail', async () => {
    mockGDPR.getConsentStatus.mockResolvedValue({ success: true, data: [] });
    const event = makeAnalyticsEvent();
    mockDb.query
      .mockResolvedValueOnce({ rows: [event], rowCount: 1 }) // first succeeds
      .mockRejectedValueOnce(new Error('DB timeout'));          // second fails

    const result = await AnalyticsService.trackBatch([
      makeTrackEventParams({ eventType: 'task_created' }),
      makeTrackEventParams({ eventType: 'task_accepted' }),
    ]);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tracked).toBe(1);
      expect(result.data.failed).toBe(1);
    }
  });
});

describe('AnalyticsService.getUserEvents', () => {
  it('returns events for a user', async () => {
    const events = [makeAnalyticsEvent(), makeAnalyticsEvent({ id: 'evt-2' })];
    mockDb.query.mockResolvedValueOnce({ rows: events, rowCount: 2 });

    const result = await AnalyticsService.getUserEvents('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
    }
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE user_id = $1'),
      expect.arrayContaining(['user-1'])
    );
  });

  it('filters by event types when provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await AnalyticsService.getUserEvents('user-1', ['task_created', 'task_completed']);

    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('ANY($'),
      expect.arrayContaining([['task_created', 'task_completed']])
    );
  });

  it('returns empty array when no events found', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await AnalyticsService.getUserEvents('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB down'));

    const result = await AnalyticsService.getUserEvents('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});

describe('AnalyticsService.getTaskEvents', () => {
  it('returns events for a task', async () => {
    const events = [makeAnalyticsEvent({ task_id: 'task-1' })];
    mockDb.query.mockResolvedValueOnce({ rows: events, rowCount: 1 });

    const result = await AnalyticsService.getTaskEvents('task-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
    }
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE task_id = $1'),
      ['task-1', 100]
    );
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('fail'));

    const result = await AnalyticsService.getTaskEvents('task-1');

    expect(result.success).toBe(false);
  });
});

describe('AnalyticsService.calculateFunnel', () => {
  it('calculates overall conversion rate correctly', async () => {
    // Each step calls db.query once
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ count: '100' }], rowCount: 1 }) // task_created
      .mockResolvedValueOnce({ rows: [{ count: '80' }], rowCount: 1 })  // task_accepted
      .mockResolvedValueOnce({ rows: [{ count: '60' }], rowCount: 1 }); // task_completed

    const result = await AnalyticsService.calculateFunnel(
      'task_lifecycle',
      ['task_created', 'task_accepted', 'task_completed'],
      30
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.conversionRate).toBeCloseTo(60); // 60/100 = 60%
      expect(result.data.name).toBe('task_lifecycle');
      expect(Object.keys(result.data.dropoffRates)).toHaveLength(2);
    }
  });

  it('returns 0% conversion rate when first step has 0 users', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

    const result = await AnalyticsService.calculateFunnel(
      'empty_funnel',
      ['task_created', 'task_completed'],
      7
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.conversionRate).toBe(0);
    }
  });

  it('returns DB_ERROR on db failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('query fail'));

    const result = await AnalyticsService.calculateFunnel(
      'funnel',
      ['task_created', 'task_completed'],
      30
    );

    expect(result.success).toBe(false);
  });
});

describe('AnalyticsService.getEventCounts', () => {
  it('returns counts for multiple event types', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ count: '42' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ count: '17' }], rowCount: 1 });

    const result = await AnalyticsService.getEventCounts(
      ['task_created', 'task_completed'],
      30
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data['task_created']).toBe(42);
      expect(result.data['task_completed']).toBe(17);
    }
  });

  it('returns DB_ERROR on failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('fail'));

    const result = await AnalyticsService.getEventCounts(['task_created'], 30);

    expect(result.success).toBe(false);
  });
});

describe('AnalyticsService.trackABTest', () => {
  it('tracks AB test assignment successfully', async () => {
    mockGDPR.getConsentStatus.mockResolvedValue({ success: true, data: [] });
    const event = makeAnalyticsEvent();
    mockDb.query.mockResolvedValue({ rows: [event], rowCount: 1 });

    const result = await AnalyticsService.trackABTest(
      'user-1',
      'onboarding_v2',
      'A',
      undefined,
      'sess-1',
      'dev-1',
      'ios'
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.assigned).toBe(true);
    }
  });

  it('tracks AB test assignment with conversion event', async () => {
    mockGDPR.getConsentStatus.mockResolvedValue({ success: true, data: [] });
    const event = makeAnalyticsEvent();
    mockDb.query.mockResolvedValue({ rows: [event], rowCount: 1 });

    const result = await AnalyticsService.trackABTest(
      'user-1',
      'onboarding_v2',
      'B',
      'user_onboarded',
      'sess-1',
      'dev-1'
    );

    expect(result.success).toBe(true);
    // Two trackEvent calls: one for assignment, one for conversion
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// 2. TaskBatchingService
// ============================================================================

describe('TaskBatchingService.calculateSavings', () => {
  it('calculates savings for a batch of tasks', () => {
    const tasks = [
      makeTask({ price: 3000, estimatedDuration: 45 }),
      makeTask({ id: 'task-2', price: 2000, estimatedDuration: 30 }),
    ];

    const savings = TaskBatchingService.calculateSavings(tasks);

    expect(savings.totalEarnings).toBe(5000);
    // individualDuration: (45+15) + (30+15) = 105
    expect(savings.individualDuration).toBe(105);
    // combinedDuration: (45+30) + 20 = 95
    expect(savings.combinedDuration).toBe(95);
    expect(savings.timeSaved).toBe(10);
    expect(savings.earningsBoost).toBeGreaterThan(0);
  });

  it('uses default 60 minutes when estimatedDuration not set', () => {
    const tasks = [
      makeTask({ price: 1000, estimatedDuration: undefined }),
      makeTask({ id: 'task-2', price: 1000, estimatedDuration: undefined }),
    ];

    const savings = TaskBatchingService.calculateSavings(tasks);

    // individualDuration: (60+15) + (60+15) = 150; combinedDuration: (60+60) + 20 = 140
    expect(savings.individualDuration).toBe(150);
    expect(savings.combinedDuration).toBe(140);
  });
});

describe('TaskBatchingService._validateRecommendation', () => {
  const baseRec = {
    primaryTask: makeTask(),
    additionalTasks: [makeTask({ id: 'task-2' })],
    totalEarnings: 10000,
    totalDuration: 90,
    earningsPerHour: 25, // > $20/hr minimum
    routeDistance: 1000, // < 5000m max
    estimatedTravelTime: 20,
    savingsVsIndividual: 500,
    confidence: 0.80, // > 0.65 threshold
    reasoning: 'Geographic clustering near downtown with 1 nearby task.',
  };

  it('passes valid recommendation', () => {
    const result = TaskBatchingService._validateRecommendation(baseRec);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails when earningsPerHour is below $20/hr', () => {
    const result = TaskBatchingService._validateRecommendation({
      ...baseRec,
      earningsPerHour: 15,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('BATCH-ERR-001'))).toBe(true);
  });

  it('fails when batch size exceeds 5 tasks', () => {
    const result = TaskBatchingService._validateRecommendation({
      ...baseRec,
      additionalTasks: [
        makeTask({ id: 't2' }),
        makeTask({ id: 't3' }),
        makeTask({ id: 't4' }),
        makeTask({ id: 't5' }),
        makeTask({ id: 't6' }),
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('BATCH-ERR-002'))).toBe(true);
  });

  it('fails when route distance exceeds 5km', () => {
    const result = TaskBatchingService._validateRecommendation({
      ...baseRec,
      routeDistance: 6000,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('BATCH-ERR-003'))).toBe(true);
  });

  it('fails when confidence is below 0.65', () => {
    const result = TaskBatchingService._validateRecommendation({
      ...baseRec,
      confidence: 0.50,
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('BATCH-ERR-004'))).toBe(true);
  });

  it('fails when reasoning is too short (< 30 chars)', () => {
    const result = TaskBatchingService._validateRecommendation({
      ...baseRec,
      reasoning: 'Too short',
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('BATCH-ERR-005'))).toBe(true);
  });
});

describe('TaskBatchingService._calculateDistance', () => {
  it('returns ~0 for identical coordinates', () => {
    const dist = TaskBatchingService._calculateDistance(37.7749, -122.4194, 37.7749, -122.4194);
    expect(dist).toBeCloseTo(0, 1);
  });

  it('returns a positive distance for different coordinates', () => {
    // SF to LA is roughly 559km
    const dist = TaskBatchingService._calculateDistance(37.7749, -122.4194, 34.0522, -118.2437);
    expect(dist).toBeGreaterThan(500000); // > 500km in meters
    expect(dist).toBeLessThan(700000);    // < 700km in meters
  });
});

describe('TaskBatchingService._generateHeuristicRecommendation', () => {
  it('returns null when fewer than 2 tasks have coordinates', () => {
    const tasks = [makeTask({ latitude: undefined, longitude: undefined })];
    const result = TaskBatchingService._generateHeuristicRecommendation(tasks);
    expect(result).toBeNull();
  });

  it('returns null when no tasks are within 2km of primary', () => {
    // SF and NY are >4000km apart
    const tasks = [
      makeTask({ id: 'sf', price: 5000, latitude: 37.7749, longitude: -122.4194 }),
      makeTask({ id: 'ny', price: 4000, latitude: 40.7128, longitude: -74.0060 }),
    ];
    const result = TaskBatchingService._generateHeuristicRecommendation(tasks);
    expect(result).toBeNull();
  });

  it('returns a recommendation for nearby tasks', () => {
    // Two tasks within a few hundred meters of each other
    const tasks = [
      makeTask({ id: 'anchor', price: 5000, latitude: 37.7749, longitude: -122.4194 }),
      makeTask({ id: 'nearby', price: 3000, latitude: 37.7755, longitude: -122.4200 }),
    ];
    const result = TaskBatchingService._generateHeuristicRecommendation(tasks);
    expect(result).not.toBeNull();
    if (result) {
      expect(result.primaryTask.id).toBe('anchor');
      expect(result.additionalTasks).toHaveLength(1);
      expect(result.confidence).toBe(0.75);
    }
  });
});

describe('TaskBatchingService.generateRecommendation', () => {
  it('returns null when fewer than 2 tasks available', async () => {
    const result = await TaskBatchingService.generateRecommendation(
      'worker-1',
      [makeTask()]
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
    }
  });

  it('uses heuristic fallback when AI is not configured', async () => {
    mockAIClient.isConfigured.mockReturnValue(false);

    // Tasks not within 2km — heuristic returns null → valid null result
    const tasks = [
      makeTask({ id: 'sf', latitude: 37.7749, longitude: -122.4194 }),
      makeTask({ id: 'ny', latitude: 40.7128, longitude: -74.0060 }),
    ];

    const result = await TaskBatchingService.generateRecommendation('worker-1', tasks);

    expect(result.success).toBe(true);
    expect(mockAIClient.callJSON).not.toHaveBeenCalled();
  });

  it('returns recommendation with valid nearby tasks via heuristic', async () => {
    mockAIClient.isConfigured.mockReturnValue(false);

    const tasks = [
      makeTask({ id: 'anchor', price: 8000, estimatedDuration: 45, latitude: 37.7749, longitude: -122.4194 }),
      makeTask({ id: 'nearby', price: 5000, estimatedDuration: 30, latitude: 37.7755, longitude: -122.4200 }),
    ];

    const result = await TaskBatchingService.generateRecommendation('worker-1', tasks);

    expect(result.success).toBe(true);
    if (result.success && result.data) {
      expect(result.data.primaryTask.id).toBe('anchor');
      expect(result.data.confidence).toBeGreaterThanOrEqual(0.65);
    }
  });
});

// ============================================================================
// 3. FeedQueryService
// ============================================================================

describe('queryFeed', () => {
  const baseQuery = {
    userId: 'user-1',
    capabilityProfile: makeCapabilityProfile() as any,
    pagination: { limit: 10 },
  };

  it('returns eligible tasks from db results', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [makeFeedRow()],
      rowCount: 1,
    });
    mockIsEligible.mockReturnValue({ eligible: true, code: 'HX200', reasons: [] });

    const result = await queryFeed(baseQuery);

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].id).toBe('task-1');
    expect(result.filters.applied).toContain('risk_clearance');
    expect(result.filters.excluded).toBe(0);
  });

  it('excludes ineligible tasks from feed', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [makeFeedRow(), makeFeedRow({ id: 'task-2' })],
      rowCount: 2,
    });
    mockIsEligible
      .mockReturnValueOnce({ eligible: true, code: 'HX200', reasons: [] })
      .mockReturnValueOnce({ eligible: false, code: 'HX403', reasons: ['no_license'] });

    const result = await queryFeed(baseQuery);

    expect(result.tasks).toHaveLength(1);
    expect(result.filters.excluded).toBe(1);
  });

  it('returns empty feed when db has no results', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await queryFeed(baseQuery);

    expect(result.tasks).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('applies trade filter when specified in query', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await queryFeed({ ...baseQuery, filters: { trades: ['plumbing'] } });

    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain('trade_type = ANY($');
    expect(params).toContainEqual(["plumbing"]);
  });

  it('applies location filter when lat/lng and radius provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await queryFeed({
      ...baseQuery,
      location: { lat: 37.77, lng: -122.42 },
      radiusMiles: 10,
    });

    const [sql] = mockDb.query.mock.calls[0];
    expect(sql).toContain('acos(');
  });

  it('applies payout filters when specified', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await queryFeed({
      ...baseQuery,
      filters: { minPayout: 50, maxPayout: 200 },
    });

    const [sql] = mockDb.query.mock.calls[0];
    expect(sql).toContain('payout_cents >=');
    expect(sql).toContain('payout_cents <=');
  });

  it('sets nextCursor from last task postedAt', async () => {
    const rows = [
      makeFeedRow({ id: 'a', created_at: '2026-03-01T10:00:00Z' }),
      makeFeedRow({ id: 'b', created_at: '2026-03-01T09:00:00Z' }),
    ];
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 });
    mockIsEligible.mockReturnValue({ eligible: true, code: 'HX200', reasons: [] });

    const result = await queryFeed(baseQuery);

    expect(result.nextCursor).toBe('2026-03-01T09:00:00Z');
  });

  it('applies cursor when provided in pagination', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await queryFeed({
      ...baseQuery,
      pagination: { cursor: '2026-03-01T00:00:00Z', limit: 10 },
    });

    const [sql] = mockDb.query.mock.calls[0];
    expect(sql).toContain('created_at < $');
  });

  it('calculates distance when location provided', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [makeFeedRow()],
      rowCount: 1,
    });
    mockIsEligible.mockReturnValue({ eligible: true, code: 'HX200', reasons: [] });

    const result = await queryFeed({
      ...baseQuery,
      location: { lat: 37.7749, lng: -122.4194 },
    });

    // Distance should be a number (close to 0 for same coords)
    expect(result.tasks[0].distance).toBeDefined();
    expect(typeof result.tasks[0].distance).toBe('number');
  });
});

describe('getNearbyTasks', () => {
  it('returns nearby tasks from db', async () => {
    const rows = [
      { id: 'task-1', title: 'Fix pipe', lat: 37.775, lng: -122.419, payoutCents: 8000 },
    ];
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 });

    const result = await getNearbyTasks(37.7749, -122.4194, 5, 10);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('task-1');
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('3959 * acos('),
      [37.7749, -122.4194, 5, 10]
    );
  });

  it('returns empty array when no nearby tasks', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await getNearbyTasks(37.7749, -122.4194, 5);

    expect(result).toHaveLength(0);
  });
});

describe('getTasksByTrade', () => {
  it('returns tasks for a given trade and state', async () => {
    const row = {
      id: 'task-1',
      title: 'Plumbing job',
      description: 'Fix the sink',
      trade_type: 'plumbing',
      location_address: '123 Main',
      location_city: 'SF',
      location_state: 'CA',
      location_lat: 37.77,
      location_lng: -122.41,
      payout_cents: 10000,
      currency: 'USD',
      risk_level: 'low',
      estimated_duration_minutes: 60,
      insurance_required: false,
      background_check_required: false,
      created_at: '2026-03-01T00:00:00Z',
      poster_id: 'poster-1',
      poster_rating: 4.5,
      completed_tasks_count: 8,
    };
    mockDb.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

    const result = await getTasksByTrade('plumbing', 'CA', 10);

    expect(result).toHaveLength(1);
    expect(result[0].trade).toBe('plumbing');
    expect(result[0].payout.cents).toBe(10000);
    expect(result[0].poster.rating).toBe(4.5);
  });

  it('returns empty array when no tasks match', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await getTasksByTrade('welding', 'TX');

    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// 4. AnomalyDetectionService (class methods — extending existing coverage)
// ============================================================================

describe('AnomalyDetectionService.createIncidentEvent', () => {
  it('creates an incident event and returns it', async () => {
    const incidentRow = {
      id: 'inc-1',
      eventType: 'error_spike',
      severity: 'critical',
      service: 'api',
      details: {},
    };
    mockDb.query.mockResolvedValueOnce({ rows: [incidentRow], rowCount: 1 });

    const result = await AnomalyDetectionService.createIncidentEvent({
      eventType: 'error_spike',
      severity: 'critical',
      service: 'api',
      details: { rate: 5 },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe('inc-1');
    }
  });

  it('returns error when rowCount is 0', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await AnomalyDetectionService.createIncidentEvent({
      eventType: 'budget_threshold',
      severity: 'warning',
      service: 'ai',
      details: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HX600');
    }
  });

  it('returns error when db throws', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('PG error'));

    const result = await AnomalyDetectionService.createIncidentEvent({
      eventType: 'latency_spike',
      severity: 'warning',
      service: 'api',
      details: {},
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('HX600');
    }
  });
});

describe('AnomalyDetectionService.detectBudgetExhaustion', () => {
  it('returns empty array when usage is below threshold', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_cost: '5.00', daily_budget: 10.0, usage_pct: 50.0 }],
      rowCount: 1,
    });

    const result = await AnomalyDetectionService.detectBudgetExhaustion();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });

  it('creates incident event when usage exceeds threshold', async () => {
    // First query: budget check; second query: insert incident
    mockDb.query
      .mockResolvedValueOnce({
        rows: [{ total_cost: '8.50', daily_budget: 10.0, usage_pct: 85.0 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({
        rows: [{ id: 'inc-1', eventType: 'budget_threshold', severity: 'warning', service: 'ai', details: {} }],
        rowCount: 1,
      });

    const result = await AnomalyDetectionService.detectBudgetExhaustion({
      errorRateThreshold: 2.0,
      latencyThreshold: 2.0,
      budgetThreshold: 80,
      checkIntervalMs: 60000,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].eventType).toBe('budget_threshold');
    }
  });
});

describe('AnomalyDetectionService.runDetectors', () => {
  it('aggregates results from all detectors', async () => {
    // detectBudgetExhaustion makes a db.query; detectErrorRateSpike and detectLatencySpike
    // use random Math.random() internally (not controllable), but we can verify success shape.
    mockDb.query.mockResolvedValue({
      rows: [{ total_cost: '2.00', daily_budget: 10.0, usage_pct: 20.0 }],
      rowCount: 1,
    });

    const result = await AnomalyDetectionService.runDetectors();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(Array.isArray(result.data)).toBe(true);
    }
  });
});

// ============================================================================
// 5. XPTaxService
// ============================================================================

describe('XPTaxService.calculateTax', () => {
  it('returns 0 for escrow payments', () => {
    expect(XPTaxService.calculateTax(10000, 'escrow')).toBe(0);
  });

  it('returns 10% for offline_cash payments', () => {
    expect(XPTaxService.calculateTax(10000, 'offline_cash')).toBe(1000);
  });

  it('returns 10% for offline_venmo payments', () => {
    expect(XPTaxService.calculateTax(5000, 'offline_venmo')).toBe(500);
  });

  it('returns 10% for offline_cashapp payments', () => {
    expect(XPTaxService.calculateTax(7500, 'offline_cashapp')).toBe(750);
  });

  it('rounds to nearest cent', () => {
    // 10% of 33 = 3.3 → rounds to 3
    expect(XPTaxService.calculateTax(33, 'offline_cash')).toBe(3);
  });
});

describe('XPTaxService.recordOfflinePayment', () => {
  it('inserts tax ledger entry and updates status', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT xp_tax_ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT/UPDATE user_xp_tax_status

    const result = await XPTaxService.recordOfflinePayment(
      'user-1',
      'task-1',
      'offline_cash',
      10000
    );

    expect(result.success).toBe(true);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO xp_tax_ledger'),
      expect.arrayContaining(['user-1', 'task-1', 10000, 10.0])
    );
  });

  it('returns error when db throws on first query', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('insert fail'));

    const result = await XPTaxService.recordOfflinePayment(
      'user-1',
      'task-1',
      'offline_cash',
      10000
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RECORD_OFFLINE_PAYMENT_FAILED');
    }
  });
});

describe('XPTaxService.checkTaxStatus', () => {
  it('returns zero status when no record exists', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await XPTaxService.checkTaxStatus('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unpaid_tax_cents).toBe(0);
      expect(result.data.blocked).toBe(false);
    }
  });

  it('returns blocked when unpaid tax exists', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_unpaid_tax_cents: 500, total_xp_held_back: 50 }],
      rowCount: 1,
    });

    const result = await XPTaxService.checkTaxStatus('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.unpaid_tax_cents).toBe(500);
      expect(result.data.blocked).toBe(true);
    }
  });

  it('returns error on db failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('db fail'));

    const result = await XPTaxService.checkTaxStatus('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CHECK_TAX_STATUS_FAILED');
    }
  });
});

describe('XPTaxService.getTaxHistory', () => {
  it('returns tax history for a user', async () => {
    const rows = [
      {
        id: 'ledger-1',
        user_id: 'user-1',
        task_id: 'task-1',
        gross_payout_cents: 10000,
        tax_percentage: 10,
        tax_amount_cents: 1000,
        net_payout_cents: 10000,
        payment_method: 'offline_cash',
        tax_paid: false,
        tax_paid_at: null,
        xp_held_back: true,
        xp_released: false,
        xp_released_at: null,
        created_at: new Date(),
      },
    ];
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 });

    const result = await XPTaxService.getTaxHistory('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('ledger-1');
    }
  });

  it('returns error on db failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('fail'));

    const result = await XPTaxService.getTaxHistory('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('GET_TAX_HISTORY_FAILED');
    }
  });
});

describe('XPTaxService.payTax', () => {
  it('returns XP_TAX_PAYMENT_UNAVAILABLE when Stripe is not configured (FIX 4)', async () => {
    // FIX 4: payTax hard-blocks when Stripe is not configured (no dev-mode bypass)
    vi.mocked(mockStripe.isConfigured).mockReturnValueOnce(false);

    const result = await XPTaxService.payTax('user-1', 'pi_test_123');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('XP_TAX_PAYMENT_UNAVAILABLE');
    }
  });

  it('returns PAYMENT_NOT_SUCCEEDED when Stripe PI status is not succeeded', async () => {
    // Idempotency check: no existing payment with this intent ID
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'requires_payment_method',
        amountCents: 1000,
        metadata: { type: 'xp_tax' },
      },
    });

    const result = await XPTaxService.payTax('user-1', 'pi_test_123');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PAYMENT_NOT_SUCCEEDED');
    }
  });

  it('returns INVALID_PAYMENT_TYPE when PI metadata type is wrong', async () => {
    // Idempotency check: no existing payment with this intent ID
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    mockStripe.verifyPaymentIntent.mockResolvedValueOnce({
      success: true,
      data: {
        status: 'succeeded',
        amountCents: 1000,
        metadata: { type: 'task_payment' },
      },
    });

    const result = await XPTaxService.payTax('user-1', 'pi_test_123');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('INVALID_PAYMENT_TYPE');
    }
  });

  it('returns error on db failure', async () => {
    // Idempotency check: no existing payment with this intent ID
    mockDb.query.mockResolvedValueOnce({ rows: [] });
    mockStripe.verifyPaymentIntent.mockRejectedValueOnce(new Error('Stripe crash'));

    const result = await XPTaxService.payTax('user-1', 'pi_test_123');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('PAY_TAX_FAILED');
    }
  });
});

describe('XPTaxService.adminForgiveTax', () => {
  it('forgives unpaid taxes and logs admin action', async () => {
    // F58-2 FIX: adminForgiveTax now first SELECTs the XP sum, then (if > 0)
    // credits users.xp_total, then marks ledger rows paid, then resets summary.
    // Updated mock sequence (all inside serializableTransaction + admin_actions outside):
    // 1. SELECT SUM(gross_payout_cents/10) → total_xp to credit
    // 2. UPDATE users SET xp_total = xp_total + N  (skipped when total_xp = 0)
    // 3. UPDATE xp_tax_ledger SET tax_paid = TRUE
    // 4. UPDATE user_xp_tax_status SET total_unpaid_tax_cents = 0
    // 5. INSERT admin_actions (fire-and-forget, outside transaction)
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ total_xp: 0 }], rowCount: 1 })  // SELECT SUM (F58-2) — 0 so no UPDATE users
      .mockResolvedValueOnce({ rows: [], rowCount: 5 })                   // UPDATE xp_tax_ledger
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })                   // UPDATE user_xp_tax_status
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });                  // INSERT admin_actions

    const result = await XPTaxService.adminForgiveTax(
      'user-1',
      'admin-1',
      'User hardship waiver'
    );

    expect(result.success).toBe(true);
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE xp_tax_ledger'),
      ['user-1']
    );
  });

  it('returns error when db throws on first query', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('update fail'));

    const result = await XPTaxService.adminForgiveTax('user-1', 'admin-1', 'test');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('ADMIN_FORGIVE_FAILED');
    }
  });
});

// ============================================================================
// 6. InstantRateLimiter
// ============================================================================

describe('InstantRateLimiter.checkAcceptLimit', () => {
  it('allows when count is below limit', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '3', latest_accept: null }],
      rowCount: 1,
    });

    const result = await InstantRateLimiter.checkAcceptLimit('hustler-1');

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('denies when count equals the limit (5)', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '5', latest_accept: new Date() }],
      rowCount: 1,
    });

    const result = await InstantRateLimiter.checkAcceptLimit('hustler-1');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Rate limit exceeded');
    expect(result.reason).toContain('5');
  });

  it('includes retryAfter when latest_accept is set', async () => {
    const recentAccept = new Date(Date.now() - 5 * 60 * 1000); // 5 minutes ago
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '5', latest_accept: recentAccept }],
      rowCount: 1,
    });

    const result = await InstantRateLimiter.checkAcceptLimit('hustler-1');

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBeTypeOf('number');
    expect(result.retryAfter!).toBeGreaterThan(0);
  });

  it('allows when count is 0', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '0', latest_accept: null }],
      rowCount: 1,
    });

    const result = await InstantRateLimiter.checkAcceptLimit('hustler-1');

    expect(result.allowed).toBe(true);
  });
});

describe('InstantRateLimiter.checkPostLimit', () => {
  it('allows when count is below limit', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '4', latest_post: null }],
      rowCount: 1,
    });

    const result = await InstantRateLimiter.checkPostLimit('poster-1');

    expect(result.allowed).toBe(true);
  });

  it('denies when count equals the limit (10)', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '10', latest_post: new Date() }],
      rowCount: 1,
    });

    const result = await InstantRateLimiter.checkPostLimit('poster-1');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('10');
  });

  it('includes retryAfter when latest_post is recent', async () => {
    const recentPost = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '10', latest_post: recentPost }],
      rowCount: 1,
    });

    const result = await InstantRateLimiter.checkPostLimit('poster-1');

    expect(result.retryAfter).toBeTypeOf('number');
    expect(result.retryAfter!).toBeGreaterThan(0);
  });
});

// ============================================================================
// 7. InstantModeKillSwitch
// ============================================================================

describe('InstantModeKillSwitch', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it('isInstantModeEnabled returns false when env var not set', () => {
    delete process.env.INSTANT_MODE_ENABLED;
    expect(InstantModeKillSwitch.isInstantModeEnabled()).toBe(false);
  });

  it('isInstantModeEnabled returns true when env var is "true"', () => {
    process.env.INSTANT_MODE_ENABLED = 'true';
    expect(InstantModeKillSwitch.isInstantModeEnabled()).toBe(true);
  });

  it('isInstantModeEnabled returns true when env var is "1"', () => {
    process.env.INSTANT_MODE_ENABLED = '1';
    expect(InstantModeKillSwitch.isInstantModeEnabled()).toBe(true);
  });

  it('isInstantModeEnabled returns false when env var is "false"', () => {
    process.env.INSTANT_MODE_ENABLED = 'false';
    expect(InstantModeKillSwitch.isInstantModeEnabled()).toBe(false);
  });

  it('isSurgeEnabled returns false when env var not set', () => {
    delete process.env.INSTANT_SURGE_ENABLED;
    expect(InstantModeKillSwitch.isSurgeEnabled()).toBe(false);
  });

  it('isSurgeEnabled returns true when env var is "true"', () => {
    process.env.INSTANT_SURGE_ENABLED = 'true';
    expect(InstantModeKillSwitch.isSurgeEnabled()).toBe(true);
  });

  it('areInterruptsEnabled returns false when env var not set', () => {
    delete process.env.INSTANT_INTERRUPTS_ENABLED;
    expect(InstantModeKillSwitch.areInterruptsEnabled()).toBe(false);
  });

  it('areInterruptsEnabled returns true when env var is "true"', () => {
    process.env.INSTANT_INTERRUPTS_ENABLED = 'true';
    expect(InstantModeKillSwitch.areInterruptsEnabled()).toBe(true);
  });

  it('checkFlags returns allEnabled=false when any flag is disabled', () => {
    process.env.INSTANT_MODE_ENABLED = 'true';
    process.env.INSTANT_SURGE_ENABLED = 'false';
    process.env.INSTANT_INTERRUPTS_ENABLED = 'true';

    const flags = InstantModeKillSwitch.checkFlags({ operation: 'accept_task', taskId: 't-1' });

    expect(flags.instantModeEnabled).toBe(true);
    expect(flags.surgeEnabled).toBe(false);
    expect(flags.interruptsEnabled).toBe(true);
    expect(flags.allEnabled).toBe(false);
  });

  it('checkFlags returns allEnabled=true when all flags enabled', () => {
    process.env.INSTANT_MODE_ENABLED = 'true';
    process.env.INSTANT_SURGE_ENABLED = 'true';
    process.env.INSTANT_INTERRUPTS_ENABLED = 'true';

    const flags = InstantModeKillSwitch.checkFlags({ operation: 'post_task' });

    expect(flags.allEnabled).toBe(true);
  });

  it('checkFlags works without taskId context', () => {
    delete process.env.INSTANT_MODE_ENABLED;

    const flags = InstantModeKillSwitch.checkFlags({ operation: 'health_check' });

    expect(flags.allEnabled).toBe(false);
  });
});

// ============================================================================
// 8. TaskRiskClassifier
// ============================================================================

describe('TaskRiskClassifier.classifyTaskRisk', () => {
  it('returns TIER_3 when people are present', () => {
    const risk = TaskRiskClassifier.classifyTaskRisk({
      insideHome: false,
      peoplePresent: true,
      petsPresent: false,
      caregiving: false,
    });
    expect(risk).toBe(TaskRisk.TIER_3);
  });

  it('returns TIER_3 when pets are present', () => {
    const risk = TaskRiskClassifier.classifyTaskRisk({
      insideHome: false,
      peoplePresent: false,
      petsPresent: true,
      caregiving: false,
    });
    expect(risk).toBe(TaskRisk.TIER_3);
  });

  it('returns TIER_3 when caregiving is required', () => {
    const risk = TaskRiskClassifier.classifyTaskRisk({
      insideHome: false,
      peoplePresent: false,
      petsPresent: false,
      caregiving: true,
    });
    expect(risk).toBe(TaskRisk.TIER_3);
  });

  it('returns TIER_2 when inside home but no people/pets/care', () => {
    const risk = TaskRiskClassifier.classifyTaskRisk({
      insideHome: true,
      peoplePresent: false,
      petsPresent: false,
      caregiving: false,
    });
    expect(risk).toBe(TaskRisk.TIER_2);
  });

  it('returns TIER_0 for fully outdoor no-contact task', () => {
    const risk = TaskRiskClassifier.classifyTaskRisk({
      insideHome: false,
      peoplePresent: false,
      petsPresent: false,
      caregiving: false,
    });
    expect(risk).toBe(TaskRisk.TIER_0);
  });

  it('TIER_3 takes priority over insideHome=true', () => {
    const risk = TaskRiskClassifier.classifyTaskRisk({
      insideHome: true,
      peoplePresent: true,
      petsPresent: true,
      caregiving: true,
    });
    expect(risk).toBe(TaskRisk.TIER_3);
  });
});

describe('TaskRiskClassifier.toLegacyRiskLevel', () => {
  it('maps TIER_0 to LOW', () => {
    expect(TaskRiskClassifier.toLegacyRiskLevel(TaskRisk.TIER_0)).toBe('LOW');
  });

  it('maps TIER_1 to LOW', () => {
    expect(TaskRiskClassifier.toLegacyRiskLevel(TaskRisk.TIER_1)).toBe('LOW');
  });

  it('maps TIER_2 to HIGH', () => {
    expect(TaskRiskClassifier.toLegacyRiskLevel(TaskRisk.TIER_2)).toBe('HIGH');
  });

  it('maps TIER_3 to IN_HOME', () => {
    expect(TaskRiskClassifier.toLegacyRiskLevel(TaskRisk.TIER_3)).toBe('IN_HOME');
  });
});

// ============================================================================
// 9. KnowledgeGraphService
// ============================================================================

describe('KnowledgeGraphService.queryDocs', () => {
  it('returns doc sections mapped from db rows', async () => {
    // We need to set up OpenAI mock via dynamic import since it was mocked at top
    const openaiModule = await import('openai');
    const mockEmbeddingsCreate = (openaiModule as any).__mockEmbeddingsCreate;
    if (mockEmbeddingsCreate) {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.1) }],
      });
    }

    const rows = [
      {
        file_path: 'docs/API_CONTRACT.md',
        section_header: '## escrow',
        content: 'Escrow release policy...',
        is_locked: true,
        similarity: 0.92,
      },
    ];
    mockDb.readQuery.mockResolvedValueOnce({ rows, rowCount: 1 });

    const result = await KnowledgeGraphService.queryDocs('escrow release', 5);

    expect(result).toHaveLength(1);
    expect(result[0].filePath).toBe('docs/API_CONTRACT.md');
    expect(result[0].similarity).toBeCloseTo(0.92);
    expect(result[0].isLocked).toBe(true);
  });

  it('returns empty array when no docs match', async () => {
    const openaiModule = await import('openai');
    const mockEmbeddingsCreate = (openaiModule as any).__mockEmbeddingsCreate;
    if (mockEmbeddingsCreate) {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0) }],
      });
    }

    mockDb.readQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await KnowledgeGraphService.queryDocs('nonexistent topic', 5);

    expect(result).toHaveLength(0);
  });
});

describe('KnowledgeGraphService.getRelatedInvariants', () => {
  it('returns invariant docs for a router', async () => {
    const openaiModule = await import('openai');
    const mockEmbeddingsCreate = (openaiModule as any).__mockEmbeddingsCreate;
    if (mockEmbeddingsCreate) {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.2) }],
      });
    }

    const rows = [
      {
        file_path: 'docs/INVARIANTS.md',
        section_header: '## INV-1',
        content: 'Escrow must be positive...',
        is_locked: true,
        similarity: 0.88,
      },
    ];
    mockDb.readQuery.mockResolvedValueOnce({ rows, rowCount: 1 });

    const result = await KnowledgeGraphService.getRelatedInvariants('escrow');

    expect(result).toHaveLength(1);
    expect(result[0].sectionHeader).toBe('## INV-1');
  });
});

describe('KnowledgeGraphService.getContractForProcedure', () => {
  it('returns contract docs for a procedure', async () => {
    const openaiModule = await import('openai');
    const mockEmbeddingsCreate = (openaiModule as any).__mockEmbeddingsCreate;
    if (mockEmbeddingsCreate) {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.3) }],
      });
    }

    const rows = [
      {
        file_path: 'docs/API_CONTRACT.md',
        section_header: '### escrow.release',
        content: 'Release escrow to worker...',
        is_locked: false,
        similarity: 0.95,
      },
    ];
    mockDb.readQuery.mockResolvedValueOnce({ rows, rowCount: 1 });

    const result = await KnowledgeGraphService.getContractForProcedure('escrow', 'release');

    expect(result).toHaveLength(1);
    expect(result[0].sectionHeader).toBe('### escrow.release');
    expect(result[0].isLocked).toBe(false);
  });
});

// ============================================================================
// 10. InstantObservability
// ============================================================================

describe('InstantObservability.logTaskEvent', () => {
  it('does not throw when called with minimal args', () => {
    expect(() =>
      InstantObservability.logTaskEvent({
        taskId: 'task-1',
        event: 'task_matched',
      })
    ).not.toThrow();
  });

  it('does not throw when called with full args', () => {
    expect(() =>
      InstantObservability.logTaskEvent({
        taskId: 'task-1',
        event: 'task_accepted',
        state: 'ACCEPTED',
        surgeLevel: 2,
        trustTier: 3,
        latency: 145,
        error: undefined,
        metadata: { workerId: 'w-1' },
      })
    ).not.toThrow();
  });
});

describe('InstantObservability.checkStuckTasks', () => {
  it('returns empty result when no stuck tasks', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await InstantObservability.checkStuckTasks();

    expect(result.stuckCount).toBe(0);
    expect(result.stuckTasks).toHaveLength(0);
  });

  it('returns stuck tasks when tasks exceed 180s', async () => {
    const rows = [
      { id: 'task-stuck-1', matched_at: new Date(), surge_level: 1, elapsed_seconds: 200 },
      { id: 'task-stuck-2', matched_at: new Date(), surge_level: 2, elapsed_seconds: 350 },
    ];
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 });

    const result = await InstantObservability.checkStuckTasks();

    expect(result.stuckCount).toBe(2);
    expect(result.stuckTasks[0].taskId).toBe('task-stuck-1');
    expect(result.stuckTasks[0].elapsedSeconds).toBe(200);
    expect(result.stuckTasks[1].surgeLevel).toBe(2);
  });
});

describe('InstantObservability.logAcceptRace', () => {
  it('does not throw when logging race condition', () => {
    expect(() =>
      InstantObservability.logAcceptRace('task-1', 'worker-1', 'already_accepted')
    ).not.toThrow();
  });
});

describe('InstantObservability.logSurgeFallback', () => {
  it('does not throw when logging surge fallback', () => {
    expect(() =>
      InstantObservability.logSurgeFallback('task-1', 185)
    ).not.toThrow();
  });
});

describe('InstantObservability.logXPFailure', () => {
  it('does not throw when logging XP award failure', () => {
    expect(() =>
      InstantObservability.logXPFailure('task-1', 'hustler-1', 'invariant_violation')
    ).not.toThrow();
  });
});
