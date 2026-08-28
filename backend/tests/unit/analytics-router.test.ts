/**
 * Analytics Router Unit Tests
 *
 * Tests all procedures:
 * - trackEvent (public), trackBatch (public)
 * - getUserEvents (protected), getTaskEvents (protected)
 * - calculateFunnel (admin), calculateCohortRetention (admin)
 * - trackABTest (protected), getEventCounts (admin)
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

vi.mock('../../src/services/AnalyticsService', () => ({
  AnalyticsService: {
    trackEvent: vi.fn(),
    trackBatch: vi.fn(),
    getUserEvents: vi.fn(),
    getTaskEvents: vi.fn(),
    calculateFunnel: vi.fn(),
    calculateCohortRetention: vi.fn(),
    trackABTest: vi.fn(),
    getEventCounts: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { analyticsRouter } from '../../src/routers/analytics';
import { AnalyticsService } from '../../src/services/AnalyticsService';

const mockDb = vi.mocked(db);
const mockAnalytics = vi.mocked(AnalyticsService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';
const SESSION_ID = '00000000-0000-0000-0000-000000000010';
const DEVICE_ID = '00000000-0000-0000-0000-000000000020';

function makePublicCaller() {
  return analyticsRouter.createCaller({
    user: null as any,
    firebaseUid: undefined as any,
  });
}

function makeProtectedCaller() {
  return analyticsRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

function makeAdminCaller() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return analyticsRouter.createCaller({
    user: { id: UUID1, email: 'admin@test.com', full_name: 'Admin', role: 'admin', firebase_uid: 'fb-admin' } as any,
    firebaseUid: 'fb-admin',
  });
}

const BASE_EVENT = {
  eventType: 'page_view',
  eventCategory: 'user_action' as const,
  sessionId: SESSION_ID,
  deviceId: DEVICE_ID,
  platform: 'ios' as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('analytics router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // trackEvent
  // =========================================================================
  describe('trackEvent', () => {
    it('tracks event for authenticated user using ctx.user.id', async () => {
      mockAnalytics.trackEvent.mockResolvedValue({ success: true, data: { id: 'e-1' } } as any);

      const caller = makeProtectedCaller();
      const result = await caller.trackEvent(BASE_EVENT);

      expect(result).toEqual({ id: 'e-1' });
      expect(mockAnalytics.trackEvent).toHaveBeenCalledWith(
        expect.objectContaining({ userId: UUID1 }),
      );
    });

    it('requires authentication — rejects unauthenticated callers', async () => {
      const caller = makePublicCaller();
      await expect(caller.trackEvent(BASE_EVENT)).rejects.toThrow();
    });

    it('throws on service failure', async () => {
      mockAnalytics.trackEvent.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Insert failed' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.trackEvent(BASE_EVENT)).rejects.toThrow('Insert failed');
    });
  });

  // =========================================================================
  // trackBatch
  // =========================================================================
  describe('trackBatch', () => {
    it('tracks batch of events for authenticated user', async () => {
      mockAnalytics.trackBatch.mockResolvedValue({ success: true, data: { count: 2 } } as any);

      const caller = makeProtectedCaller();
      const result = await caller.trackBatch({
        events: [BASE_EVENT, { ...BASE_EVENT, eventType: 'button_click' }],
      });

      expect(result).toEqual({ count: 2 });
      expect(mockAnalytics.trackBatch).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ userId: UUID1 }),
        ]),
      );
    });

    it('requires authentication — rejects unauthenticated callers', async () => {
      const caller = makePublicCaller();
      await expect(caller.trackBatch({
        events: [BASE_EVENT],
      })).rejects.toThrow();
    });
  });

  // =========================================================================
  // getUserEvents
  // =========================================================================
  describe('getUserEvents', () => {
    it('returns user events on success', async () => {
      const data = [{ id: 'e-1', eventType: 'page_view' }];
      mockAnalytics.getUserEvents.mockResolvedValue({ success: true, data } as any);

      const caller = makeProtectedCaller();
      const result = await caller.getUserEvents({});

      expect(result).toEqual(data);
      expect(mockAnalytics.getUserEvents).toHaveBeenCalledWith(UUID1, undefined, 100, 0);
    });

    it('passes optional event type filters', async () => {
      mockAnalytics.getUserEvents.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeProtectedCaller();
      await caller.getUserEvents({ eventTypes: ['page_view', 'button_click'], limit: 50, offset: 10 });

      expect(mockAnalytics.getUserEvents).toHaveBeenCalledWith(
        UUID1, ['page_view', 'button_click'], 50, 10,
      );
    });
  });

  // =========================================================================
  // getTaskEvents
  // =========================================================================
  describe('getTaskEvents', () => {
    it('returns task events when user is poster', async () => {
      // Task ownership query
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: UUID1, worker_id: null }],
        rowCount: 1,
      } as any);
      mockAnalytics.getTaskEvents.mockResolvedValue({
        success: true,
        data: [{ id: 'e-1' }],
      } as any);

      const caller = makeProtectedCaller();
      const result = await caller.getTaskEvents({ taskId: UUID2 });

      expect(result).toEqual([{ id: 'e-1' }]);
    });

    it('returns task events when user is worker', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: UUID2, worker_id: UUID1 }],
        rowCount: 1,
      } as any);
      mockAnalytics.getTaskEvents.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeProtectedCaller();
      const result = await caller.getTaskEvents({ taskId: UUID2 });

      expect(result).toEqual([]);
    });

    it('returns task events when user is admin', async () => {
      // Task query: user is not poster or worker
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: UUID2, worker_id: UUID2 }],
        rowCount: 1,
      } as any);
      // Admin check
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 1 }], rowCount: 1 } as any);
      mockAnalytics.getTaskEvents.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeProtectedCaller();
      const result = await caller.getTaskEvents({ taskId: UUID2 });

      expect(result).toEqual([]);
    });

    it('throws NOT_FOUND when task not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeProtectedCaller();
      await expect(caller.getTaskEvents({ taskId: UUID2 }))
        .rejects.toThrow('Task not found');
    });

    it('throws FORBIDDEN when user is not participant or admin', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ poster_id: UUID2, worker_id: UUID2 }],
        rowCount: 1,
      } as any);
      // Admin check: not admin
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeProtectedCaller();
      await expect(caller.getTaskEvents({ taskId: UUID2 }))
        .rejects.toThrow('Access denied');
    });
  });

  // =========================================================================
  // calculateFunnel (admin)
  // =========================================================================
  describe('calculateFunnel', () => {
    it('returns funnel data on success', async () => {
      const data = { steps: [{ step: 'view', count: 100 }] };
      mockAnalytics.calculateFunnel.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.calculateFunnel({
        funnelName: 'onboarding',
        steps: ['sign_up', 'profile_complete'],
      });

      expect(result).toEqual(data);
    });
  });

  // =========================================================================
  // calculateCohortRetention (admin)
  // =========================================================================
  describe('calculateCohortRetention', () => {
    it('returns cohort data on success', async () => {
      const data = { cohort: '2025-01', retention: [100, 80, 60] };
      mockAnalytics.calculateCohortRetention.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.calculateCohortRetention({ cohortMonth: '2025-01' });

      expect(result).toEqual(data);
    });
  });

  // =========================================================================
  // trackABTest
  // =========================================================================
  describe('trackABTest', () => {
    it('tracks AB test on success', async () => {
      const data = { testId: 'ab-1', variant: 'A' };
      mockAnalytics.trackABTest.mockResolvedValue({ success: true, data } as any);

      const caller = makeProtectedCaller();
      const result = await caller.trackABTest({
        testName: 'homepage_v2',
        variant: 'A',
      });

      expect(result).toEqual(data);
      expect(mockAnalytics.trackABTest).toHaveBeenCalledWith(
        UUID1, 'homepage_v2', 'A', undefined, undefined, undefined, 'ios',
      );
    });

    it('passes optional parameters', async () => {
      mockAnalytics.trackABTest.mockResolvedValue({ success: true, data: {} } as any);

      const caller = makeProtectedCaller();
      await caller.trackABTest({
        testName: 'test',
        variant: 'B',
        conversionEvent: 'purchase',
        sessionId: SESSION_ID,
        deviceId: DEVICE_ID,
        platform: 'web',
      });

      expect(mockAnalytics.trackABTest).toHaveBeenCalledWith(
        UUID1, 'test', 'B', 'purchase', SESSION_ID, DEVICE_ID, 'web',
      );
    });
  });

  // =========================================================================
  // getEventCounts (admin)
  // =========================================================================
  describe('getEventCounts', () => {
    it('returns event counts on success', async () => {
      const data = [{ eventType: 'page_view', count: 500 }];
      mockAnalytics.getEventCounts.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.getEventCounts({
        eventTypes: ['page_view'],
      });

      expect(result).toEqual(data);
      expect(mockAnalytics.getEventCounts).toHaveBeenCalledWith(['page_view'], 30);
    });
  });
});
