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
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1', default_mode: 'worker' } as any,
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
      // Challenge lookup — use complete_task so server-side verification runs
      mockDb.query.mockResolvedValueOnce({
        rows: [{ target_value: 3, xp_reward: 20, challenge_type: 'complete_task' }],
        rowCount: 1,
      } as any);
      // Server verification: 3 actual completed tasks today
      mockDb.query.mockResolvedValueOnce({
        rows: [{ completed_tasks: '3' }],
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

    it('throws NOT_FOUND when challenge does not exist or is not active today', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      await expect(caller.updateProgress({
        challengeId: CHALLENGE_ID,
        progress: 1,
      })).rejects.toThrow("Challenge not found or is not today's active challenge");
    });

    it('caps progress at actual completed tasks for complete_task type', async () => {
      // Challenge lookup returns complete_task type
      mockDb.query.mockResolvedValueOnce({
        rows: [{ target_value: 3, xp_reward: 20, challenge_type: 'complete_task' }],
        rowCount: 1,
      } as any);
      // Server verification: only 1 actual completed task today
      mockDb.query.mockResolvedValueOnce({
        rows: [{ completed_tasks: '1' }],
        rowCount: 1,
      } as any);
      // Upsert
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.updateProgress({
        challengeId: CHALLENGE_ID,
        progress: 3, // client claims 3 but only 1 verified
      });

      expect(result.completed).toBe(false);
      expect(result.xpReward).toBe(0);
    });

    it('caps fast_completion progress using duration filter', async () => {
      // Challenge lookup returns fast_completion type
      mockDb.query.mockResolvedValueOnce({
        rows: [{ target_value: 1, xp_reward: 15, challenge_type: 'fast_completion' }],
        rowCount: 1,
      } as any);
      // Server verification: 1 task completed within 30 minutes today
      mockDb.query.mockResolvedValueOnce({
        rows: [{ completed_tasks: '1' }],
        rowCount: 1,
      } as any);
      // Upsert
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.updateProgress({
        challengeId: CHALLENGE_ID,
        progress: 1,
      });

      expect(result.completed).toBe(true);
      expect(result.xpReward).toBe(15);

      // Verify the fast_completion query included the duration filter
      const fastCompletionCall = (mockDb.query as any).mock.calls[1];
      expect(fastCompletionCall[0]).toContain('accepted_at');
      expect(fastCompletionCall[0]).toContain('30 minutes');
    });
  });
});
