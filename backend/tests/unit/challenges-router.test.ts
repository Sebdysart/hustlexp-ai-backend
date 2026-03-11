/**
 * Challenges Router Unit Tests
 *
 * Tests all protected procedures:
 * - getTodaysChallenges (query)
 * - updateProgress (mutation)
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

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { challengesRouter } from '../../src/routers/challenges';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const CHALLENGE_ID = '00000000-0000-0000-0000-000000000099';

function makeCaller() {
  return challengesRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('challenges router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // getTodaysChallenges
  // =========================================================================
  describe('getTodaysChallenges', () => {
    it('returns existing challenges with user progress', async () => {
      const challengeRows = [
        { id: CHALLENGE_ID, title: 'Complete a Task', description: 'Finish any task', challenge_type: 'complete_task', target_value: 1, xp_reward: 10 },
      ];
      const progressRows = [
        { challenge_id: CHALLENGE_ID, progress: 1, completed: true },
      ];

      // Challenges query
      mockDb.query.mockResolvedValueOnce({ rows: challengeRows, rowCount: 1 } as any);
      // Progress query
      mockDb.query.mockResolvedValueOnce({ rows: progressRows, rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.getTodaysChallenges();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        id: CHALLENGE_ID,
        title: 'Complete a Task',
        description: 'Finish any task',
        challengeType: 'complete_task',
        targetValue: 1,
        xpReward: 10,
        progress: 1,
        completed: true,
      });
    });

    it('auto-creates default challenges when none exist', async () => {
      // First query: no challenges
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Insert default challenges
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 3 } as any);
      // Re-fetch challenges after insert
      const defaultRows = [
        { id: 'c1', title: 'Complete a Task', description: 'Finish any task today', challenge_type: 'complete_task', target_value: 1, xp_reward: 10 },
        { id: 'c2', title: 'Speed Run', description: 'Complete a task in under 30 minutes', challenge_type: 'fast_completion', target_value: 1, xp_reward: 15 },
        { id: 'c3', title: 'Keep the Streak', description: 'Maintain your daily streak', challenge_type: 'streak_maintain', target_value: 1, xp_reward: 5 },
      ];
      mockDb.query.mockResolvedValueOnce({ rows: defaultRows, rowCount: 3 } as any);
      // Progress query
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      const result = await caller.getTodaysChallenges();

      expect(result).toHaveLength(3);
      // Verify insert was called
      expect(mockDb.query).toHaveBeenCalledTimes(4);
      const insertCall = (mockDb.query as any).mock.calls[1];
      expect(insertCall[0]).toContain('INSERT INTO daily_challenges');
    });

    it('returns zero progress for challenges without completions', async () => {
      const challengeRows = [
        { id: CHALLENGE_ID, title: 'Test', description: 'desc', challenge_type: 'test', target_value: 3, xp_reward: 20 },
      ];
      mockDb.query.mockResolvedValueOnce({ rows: challengeRows, rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      const result = await caller.getTodaysChallenges();

      expect(result[0].progress).toBe(0);
      expect(result[0].completed).toBe(false);
    });
  });

  // =========================================================================
  // updateProgress
  // =========================================================================
  describe('updateProgress', () => {
    it('updates progress and returns completed=true when target reached', async () => {
      // Challenge lookup
      mockDb.query.mockResolvedValueOnce({
        rows: [{ target_value: 3, xp_reward: 20 }],
        rowCount: 1,
      } as any);
      // Upsert progress
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.updateProgress({
        challengeId: CHALLENGE_ID,
        progress: 3,
      });

      expect(result.success).toBe(true);
      expect(result.completed).toBe(true);
      expect(result.xpReward).toBe(20);
    });

    it('returns completed=false when target not reached', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ target_value: 3, xp_reward: 20 }],
        rowCount: 1,
      } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.updateProgress({
        challengeId: CHALLENGE_ID,
        progress: 1,
      });

      expect(result.completed).toBe(false);
      expect(result.xpReward).toBe(0);
    });

    it('throws NOT_FOUND when challenge does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      await expect(caller.updateProgress({
        challengeId: CHALLENGE_ID,
        progress: 1,
      })).rejects.toThrow('Challenge not found');
    });
  });
});
