/**
 * Rating Router Unit Tests
 *
 * Tests all procedures in the rating router:
 * - submitRating (mutation, protected)
 * - getTaskRatings (query, protected)
 * - getUserRatingSummary (query, protected)
 * - getMyRatings (query, protected, uses db directly)
 * - getRatingsReceived (query, protected)
 * - processAutoRatings (mutation, admin)
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

vi.mock('../../src/services/RatingService', () => ({
  RatingService: {
    submitRating: vi.fn(),
    getRatingsForTask: vi.fn(),
    getRatingSummary: vi.fn(),
    getRatingsForUser: vi.fn(),
    processAutoRatings: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { ratingRouter } from '../../src/routers/rating';
import { RatingService } from '../../src/services/RatingService';

const mockDb = vi.mocked(db);
const mockRatingService = vi.mocked(RatingService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_UUID = '00000000-0000-0000-0000-000000000001';
const TEST_UUID_2 = '00000000-0000-0000-0000-000000000002';

function makeProtectedCaller() {
  return ratingRouter.createCaller({
    user: { id: TEST_UUID, email: 'user@test.com', full_name: 'Test User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

function makeAdminCaller() {
  return ratingRouter.createCaller({
    user: { id: TEST_UUID, email: 'admin@test.com', full_name: 'Admin', role: 'admin', firebase_uid: 'fb-admin' } as any,
    firebaseUid: 'fb-admin',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('rating router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // submitRating
  // =========================================================================
  describe('submitRating', () => {
    it('calls RatingService.submitRating and returns data on success', async () => {
      const mockData = { id: 'rating-1', stars: 5 };
      mockRatingService.submitRating.mockResolvedValue({ success: true, data: mockData } as any);

      const caller = makeProtectedCaller();
      const result = await caller.submitRating({
        taskId: TEST_UUID_2,
        stars: 5,
        comment: 'Great work!',
      });

      expect(result).toEqual(mockData);
      expect(mockRatingService.submitRating).toHaveBeenCalledWith({
        taskId: TEST_UUID_2,
        raterId: TEST_UUID,
        stars: 5,
        comment: 'Great work!',
        tags: undefined,
      });
    });

    it('throws NOT_FOUND when service returns NOT_FOUND error', async () => {
      mockRatingService.submitRating.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.submitRating({ taskId: TEST_UUID_2, stars: 3 }))
        .rejects.toThrow('Task not found');
    });

    it('throws FORBIDDEN when service returns FORBIDDEN error', async () => {
      mockRatingService.submitRating.mockResolvedValue({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Not authorized' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.submitRating({ taskId: TEST_UUID_2, stars: 3 }))
        .rejects.toThrow('Not authorized');
    });

    it('throws PRECONDITION_FAILED when service returns INVALID_STATE', async () => {
      mockRatingService.submitRating.mockResolvedValue({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Task not completed' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.submitRating({ taskId: TEST_UUID_2, stars: 3 }))
        .rejects.toThrow('Task not completed');
    });

    it('accepts optional tags', async () => {
      mockRatingService.submitRating.mockResolvedValue({ success: true, data: { id: 'r1' } } as any);

      const caller = makeProtectedCaller();
      await caller.submitRating({
        taskId: TEST_UUID_2,
        stars: 4,
        tags: ['On Time', 'Professional'],
      });

      expect(mockRatingService.submitRating).toHaveBeenCalledWith(
        expect.objectContaining({ tags: ['On Time', 'Professional'] }),
      );
    });
  });

  // =========================================================================
  // getTaskRatings
  // =========================================================================
  describe('getTaskRatings', () => {
    it('returns only public ratings', async () => {
      const allRatings = [
        { id: 'r1', is_public: true, stars: 5 },
        { id: 'r2', is_public: false, stars: 3 },
      ];
      mockRatingService.getRatingsForTask.mockResolvedValue({ success: true, data: allRatings } as any);

      const caller = makeProtectedCaller();
      const result = await caller.getTaskRatings({ taskId: TEST_UUID_2 });

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('r1');
    });

    it('throws NOT_FOUND when service returns NOT_FOUND error', async () => {
      mockRatingService.getRatingsForTask.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Task not found' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.getTaskRatings({ taskId: TEST_UUID_2 }))
        .rejects.toThrow('Task not found');
    });

    it('throws INTERNAL_SERVER_ERROR on unknown service error', async () => {
      mockRatingService.getRatingsForTask.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'connection lost' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.getTaskRatings({ taskId: TEST_UUID_2 }))
        .rejects.toThrow('connection lost');
    });
  });

  // =========================================================================
  // getUserRatingSummary
  // =========================================================================
  describe('getUserRatingSummary', () => {
    it('returns summary data on success', async () => {
      const summary = { averageStars: 4.5, totalRatings: 10 };
      mockRatingService.getRatingSummary.mockResolvedValue({ success: true, data: summary } as any);

      const caller = makeProtectedCaller();
      const result = await caller.getUserRatingSummary({ userId: TEST_UUID_2 });

      expect(result).toEqual(summary);
    });

    it('throws on service failure', async () => {
      mockRatingService.getRatingSummary.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'User not found' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.getUserRatingSummary({ userId: TEST_UUID_2 }))
        .rejects.toThrow('User not found');
    });
  });

  // =========================================================================
  // getMyRatings
  // =========================================================================
  describe('getMyRatings', () => {
    it('queries db for ratings by the authenticated user', async () => {
      const rows = [{ id: 'r1', stars: 5 }];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 } as any);

      const caller = makeProtectedCaller();
      const result = await caller.getMyRatings({ limit: 10, offset: 0 });

      expect(result).toEqual(rows);
      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('rater_id'),
        [TEST_UUID, 10, 0],
      );
    });

    it('uses default limit and offset', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeProtectedCaller();
      await caller.getMyRatings({});

      expect(mockDb.query).toHaveBeenCalledWith(
        expect.stringContaining('LIMIT'),
        [TEST_UUID, 50, 0],
      );
    });
  });

  // =========================================================================
  // getRatingsReceived
  // =========================================================================
  describe('getRatingsReceived', () => {
    it('returns data from RatingService.getRatingsForUser', async () => {
      const data = [{ id: 'r1', stars: 4 }];
      mockRatingService.getRatingsForUser.mockResolvedValue({ success: true, data } as any);

      const caller = makeProtectedCaller();
      const result = await caller.getRatingsReceived({ limit: 20, offset: 0 });

      expect(result).toEqual(data);
      expect(mockRatingService.getRatingsForUser).toHaveBeenCalledWith(TEST_UUID, 20, 0);
    });

    it('throws on service failure', async () => {
      mockRatingService.getRatingsForUser.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'query failed' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.getRatingsReceived({ limit: 10, offset: 0 }))
        .rejects.toThrow('query failed');
    });
  });

  // =========================================================================
  // processAutoRatings (admin)
  // =========================================================================
  describe('processAutoRatings', () => {
    it('calls service and returns data on success', async () => {
      // Admin check
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockRatingService.processAutoRatings.mockResolvedValue({ success: true, data: { processed: 5 } } as any);

      const caller = makeAdminCaller();
      const result = await caller.processAutoRatings();

      expect(result).toEqual({ processed: 5 });
    });

    it('throws on service failure', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
      mockRatingService.processAutoRatings.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'Failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.processAutoRatings()).rejects.toThrow('Failed');
    });
  });
});
