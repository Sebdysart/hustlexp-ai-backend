/**
 * RatingService Unit Tests
 *
 * Tests getRatingById, getRatingsForTask, getRatingsForUser, getRatingSummary,
 * hasRated, submitRating, processAutoRatings, and getRatingStats.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      // transaction passes the same queryFn so mockResolvedValueOnce sequences
      // flow through seamlessly for tests that use db.transaction internally.
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

import { RatingService } from '../../src/services/RatingService';
import { db, isUniqueViolation, isInvariantViolation } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetAllMocks();
});

// ============================================================================
// getRatingById
// ============================================================================
describe('RatingService.getRatingById', () => {
  it('returns rating when found', async () => {
    const rating = { id: 'r1', stars: 5, task_id: 't1' };
    mockQuery.mockResolvedValueOnce({ rows: [rating] });

    const result = await RatingService.getRatingById('r1');
    expect(result.success).toBe(true);
    expect(result.data).toEqual(rating);
  });

  it('returns NOT_FOUND for missing rating', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await RatingService.getRatingById('r_missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db fail'));

    const result = await RatingService.getRatingById('r1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ============================================================================
// getRatingsForTask
// ============================================================================
describe('RatingService.getRatingsForTask', () => {
  it('returns ratings for a task', async () => {
    const ratings = [{ id: 'r1', task_id: 't1' }, { id: 'r2', task_id: 't1' }];
    mockQuery.mockResolvedValueOnce({ rows: ratings });

    const result = await RatingService.getRatingsForTask('t1');
    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('returns empty array when no ratings', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await RatingService.getRatingsForTask('t1');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });
});

// ============================================================================
// getRatingsForUser
// ============================================================================
describe('RatingService.getRatingsForUser', () => {
  it('returns public ratings for a user with pagination', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'r1' }] });

    const result = await RatingService.getRatingsForUser('u1', 10, 5);
    expect(result.success).toBe(true);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('is_public = true'),
      ['u1', 10, 5],
    );
  });
});

// ============================================================================
// getRatingSummary
// ============================================================================
describe('RatingService.getRatingSummary', () => {
  it('returns summary from view', async () => {
    const summary = { user_id: 'u1', total_ratings: 10, avg_rating: 4.5 };
    mockQuery.mockResolvedValueOnce({ rows: [summary] });

    const result = await RatingService.getRatingSummary('u1');
    expect(result.success).toBe(true);
    expect(result.data?.avg_rating).toBe(4.5);
  });

  it('returns default summary when no ratings exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await RatingService.getRatingSummary('u1');
    expect(result.success).toBe(true);
    expect(result.data?.total_ratings).toBe(0);
    expect(result.data?.avg_rating).toBe(0);
  });
});

// ============================================================================
// hasRated
// ============================================================================
describe('RatingService.hasRated', () => {
  it('returns true when rating exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });

    const result = await RatingService.hasRated('t1', 'u1', 'u2');
    expect(result.success).toBe(true);
    expect(result.data).toBe(true);
  });

  it('returns false when no rating exists', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const result = await RatingService.hasRated('t1', 'u1', 'u2');
    expect(result.success).toBe(true);
    expect(result.data).toBe(false);
  });
});

// ============================================================================
// submitRating
// ============================================================================
describe('RatingService.submitRating', () => {
  const completedAt = new Date(Date.now() - 1000 * 60 * 60); // 1 hour ago

  it('rejects invalid star rating (0)', async () => {
    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u1', stars: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects invalid star rating (6)', async () => {
    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u1', stars: 6,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects non-integer star rating (3.5)', async () => {
    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u1', stars: 3.5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects comment over 500 chars', async () => {
    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u1', stars: 5, comment: 'x'.repeat(501),
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_INPUT');
  });

  it('rejects rating for non-COMPLETED task', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 't1', poster_id: 'u1', worker_id: 'u2', state: 'ACCEPTED', completed_at: null }],
    });

    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u1', stars: 5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_STATE');
  });

  it('rejects rating outside 7-day window', async () => {
    const oldCompleted = new Date(Date.now() - 1000 * 60 * 60 * 24 * 8); // 8 days ago
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 't1', poster_id: 'u1', worker_id: 'u2', state: 'COMPLETED', completed_at: oldCompleted }],
    });

    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u1', stars: 5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('expired');
  });

  it('rejects non-participant rater', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 't1', poster_id: 'u1', worker_id: 'u2', state: 'COMPLETED', completed_at: completedAt }],
    });

    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u3', stars: 5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('FORBIDDEN');
  });

  it('rejects duplicate rating', async () => {
    // 1. Task fetch (outside transaction)
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 't1', poster_id: 'u1', worker_id: 'u2', state: 'COMPLETED', completed_at: completedAt }],
    });
    // 2. Advisory lock (first call inside transaction — result is discarded)
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    // 3. Duplicate check inside transaction — existing rating found
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'r_existing' }] });

    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u1', stars: 5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('already rated');
  });

  it('successfully submits first rating (blind)', async () => {
    // 1. Task fetch (outside transaction)
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 't1', poster_id: 'u1', worker_id: 'u2', state: 'COMPLETED', completed_at: completedAt }],
    });
    // 2. Advisory lock (first call inside transaction — result is discarded)
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    // 3. Duplicate check inside transaction — no existing rating
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. Existing ratings count (inside transaction) — 0 existing
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    // 5. INSERT rating (inside transaction)
    const newRating = { id: 'r1', task_id: 't1', rater_id: 'u1', ratee_id: 'u2', stars: 5, is_blind: true };
    mockQuery.mockResolvedValueOnce({ rows: [newRating] });

    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u1', stars: 5,
    });
    expect(result.success).toBe(true);
    expect(result.data?.stars).toBe(5);
  });

  it('makes all ratings public when both parties rate', async () => {
    // 1. Task fetch (outside transaction)
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 't1', poster_id: 'u1', worker_id: 'u2', state: 'COMPLETED', completed_at: completedAt }],
    });
    // 2. Advisory lock (first call inside transaction — result is discarded)
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    // 3. Duplicate check inside transaction — no existing rating
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. Existing ratings count (inside transaction) — 1 existing (first party already rated)
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '1' }] });
    // 5. INSERT rating (inside transaction)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'r2', is_blind: false, is_public: true }] });
    // 6. UPDATE all to public (outside transaction, updatedRatingsCount === 2)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 7. Re-fetch updated rating (outside transaction)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'r2', is_public: true, is_blind: false }] });

    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u2', stars: 4,
    });
    expect(result.success).toBe(true);
  });

  it('returns NOT_FOUND for missing task', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await RatingService.submitRating({
      taskId: 't_missing', raterId: 'u1', stars: 5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('handles unique violation (RATE-5)', async () => {
    // 1. Task fetch (outside transaction)
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 't1', poster_id: 'u1', worker_id: 'u2', state: 'COMPLETED', completed_at: completedAt }],
    });
    // 2. Advisory lock (first call inside transaction — result is discarded)
    mockQuery.mockResolvedValueOnce({ rows: [{}], rowCount: 1 });
    // 3. Duplicate check inside transaction — no existing rating
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // 4. Existing ratings count (inside transaction)
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });
    // 5. INSERT rating — DB unique violation
    const uniqueErr = Object.assign(new Error('duplicate key'), { code: '23505' });
    mockQuery.mockRejectedValueOnce(uniqueErr);
    (isUniqueViolation as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const result = await RatingService.submitRating({
      taskId: 't1', raterId: 'u1', stars: 5,
    });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVARIANT_VIOLATION');
  });
});

// ============================================================================
// processAutoRatings
// ============================================================================
describe('RatingService.processAutoRatings', () => {
  it('returns 0 when no tasks need auto-rating', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await RatingService.processAutoRatings();
    expect(result.success).toBe(true);
    expect(result.data?.autoRated).toBe(0);
  });

  it('batch-inserts auto-ratings for expired tasks', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { id: 't1', poster_id: 'u1', worker_id: 'u2', completed_at: new Date() },
      ],
    });
    // batch insert
    mockQuery.mockResolvedValueOnce({ rowCount: 2 });

    const result = await RatingService.processAutoRatings();
    expect(result.success).toBe(true);
    expect(result.data?.autoRated).toBe(2);
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const result = await RatingService.processAutoRatings();
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ============================================================================
// getRatingStats
// ============================================================================
describe('RatingService.getRatingStats', () => {
  it('returns combined stats and recent ratings', async () => {
    // getRatingSummary query
    mockQuery.mockResolvedValueOnce({
      rows: [{
        user_id: 'u1', total_ratings: 10, avg_rating: 4.5,
        five_star_count: 5, four_star_count: 3, three_star_count: 1,
        two_star_count: 1, one_star_count: 0, commented_count: 6,
        last_rating_at: new Date(),
      }],
    });
    // getRatingsForUser query
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'r1', stars: 5 }] });

    const result = await RatingService.getRatingStats('u1');
    expect(result.success).toBe(true);
    expect(result.data?.totalRatings).toBe(10);
    expect(result.data?.averageRating).toBe(4.5);
    expect(result.data?.ratingDistribution.five).toBe(5);
    expect(result.data?.recentRatings).toHaveLength(1);
  });
});
