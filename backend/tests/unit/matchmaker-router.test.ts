/**
 * Matchmaker Router Unit Tests
 *
 * Tests all procedures:
 * - rankCandidates (admin, mutation)
 * - explainMatch (protected, query)
 * - suggestPrice (protected, query)
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

vi.mock('../../src/services/MatchmakerAIService', () => ({
  MatchmakerAIService: {
    rankCandidates: vi.fn(),
    explainMatch: vi.fn(),
    suggestPrice: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { matchmakerRouter } from '../../src/routers/matchmaker';
import { MatchmakerAIService } from '../../src/services/MatchmakerAIService';

const mockDb = vi.mocked(db);
const mockMatchmaker = vi.mocked(MatchmakerAIService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';
const UUID3 = '00000000-0000-0000-0000-000000000003';

function makeProtectedCaller() {
  return matchmakerRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

function makeAdminCaller() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return matchmakerRouter.createCaller({
    user: { id: UUID1, email: 'admin@test.com', full_name: 'Admin', role: 'admin', firebase_uid: 'fb-admin' } as any,
    firebaseUid: 'fb-admin',
  });
}

const TASK_ROW = {
  id: UUID2,
  title: 'Fix plumbing',
  description: 'Leaky faucet',
  category: 'home_repair',
  location_text: 'Chicago',
  price: 5000,
  requirements: 'Experience needed',
  // T53-4: caller (UUID1) is the poster so ownership check passes
  poster_id: UUID1,
  worker_id: UUID3,
};

const CANDIDATE_ROW = {
  id: UUID3,
  trust_tier: 3,
  completed_tasks: 10,
  completion_rate: 0.95,
  average_rating: 4.5,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('matchmaker router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // rankCandidates (admin)
  // =========================================================================
  describe('rankCandidates', () => {
    it('fetches task and candidates from db, then ranks via service', async () => {
      const rankedData = [{ userId: UUID3, score: 0.92, rank: 1 }];
      mockMatchmaker.rankCandidates.mockResolvedValue({ success: true, data: rankedData } as any);

      const caller = makeAdminCaller();
      // Task query (after admin role check consumed by makeAdminCaller)
      mockDb.query.mockResolvedValueOnce({ rows: [TASK_ROW], rowCount: 1 } as any);
      // Candidates query
      mockDb.query.mockResolvedValueOnce({ rows: [CANDIDATE_ROW], rowCount: 1 } as any);
      const result = await caller.rankCandidates({ taskId: UUID2 });

      expect(result).toEqual(rankedData);
      expect(mockMatchmaker.rankCandidates).toHaveBeenCalledWith(
        expect.objectContaining({ id: UUID2, title: 'Fix plumbing', location: 'Chicago' }),
        expect.arrayContaining([expect.objectContaining({
          userId: UUID3,
          trustTier: 3,
          completedTasks: 10,
          completionRate: 0.95,
          averageRating: 4.5,
          isAvailable: true,
        })]),
      );
    });

    it('throws NOT_FOUND when task not found', async () => {
      const caller = makeAdminCaller();
      // Task query: empty (after admin role check)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(caller.rankCandidates({ taskId: UUID2 }))
        .rejects.toThrow('Task not found');
    });

    it('throws on service failure', async () => {
      mockMatchmaker.rankCandidates.mockResolvedValue({
        success: false,
        error: { code: 'AI_ERROR', message: 'AI service down' },
      } as any);

      const caller = makeAdminCaller();
      mockDb.query.mockResolvedValueOnce({ rows: [TASK_ROW], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(caller.rankCandidates({ taskId: UUID2 }))
        .rejects.toThrow('AI service down');
    });
  });

  // =========================================================================
  // explainMatch (protected)
  // =========================================================================
  describe('explainMatch', () => {
    it('returns match explanation on success', async () => {
      // Task query
      mockDb.query.mockResolvedValueOnce({ rows: [TASK_ROW], rowCount: 1 } as any);
      // Worker query
      mockDb.query.mockResolvedValueOnce({ rows: [CANDIDATE_ROW], rowCount: 1 } as any);

      const explanation = { explanation: 'Great match because of experience', confidence: 0.85 };
      mockMatchmaker.explainMatch.mockResolvedValue({ success: true, data: explanation } as any);

      const caller = makeProtectedCaller();
      const result = await caller.explainMatch({ taskId: UUID2, userId: UUID3 });

      expect(result).toEqual(explanation);
    });

    it('throws NOT_FOUND when task not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeProtectedCaller();
      await expect(caller.explainMatch({ taskId: UUID2, userId: UUID3 }))
        .rejects.toThrow('Task not found');
    });

    it('throws NOT_FOUND when worker not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [TASK_ROW], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeProtectedCaller();
      await expect(caller.explainMatch({ taskId: UUID2, userId: UUID3 }))
        .rejects.toThrow('Worker not found');
    });

    it('throws on service failure', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [TASK_ROW], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [CANDIDATE_ROW], rowCount: 1 } as any);
      mockMatchmaker.explainMatch.mockResolvedValue({
        success: false,
        error: { code: 'AI_ERROR', message: 'Explanation failed' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.explainMatch({ taskId: UUID2, userId: UUID3 }))
        .rejects.toThrow('Explanation failed');
    });
  });

  // =========================================================================
  // suggestPrice (protected)
  // =========================================================================
  describe('suggestPrice', () => {
    it('returns price suggestion on success', async () => {
      const data = { suggestedCents: 4500, confidence: 0.7 };
      mockMatchmaker.suggestPrice.mockResolvedValue({ success: true, data } as any);

      const caller = makeProtectedCaller();
      const result = await caller.suggestPrice({
        title: 'Fix plumbing',
        description: 'Leaky faucet in kitchen',
        category: 'home_repair',
      });

      expect(result).toEqual(data);
      expect(mockMatchmaker.suggestPrice).toHaveBeenCalledWith(
        'Fix plumbing - Leaky faucet in kitchen',
        'home_repair',
      );
    });

    it('works without optional category', async () => {
      mockMatchmaker.suggestPrice.mockResolvedValue({
        success: true,
        data: { suggestedCents: 3000 },
      } as any);

      const caller = makeProtectedCaller();
      await caller.suggestPrice({
        title: 'General task',
        description: 'No category',
      });

      expect(mockMatchmaker.suggestPrice).toHaveBeenCalledWith(
        'General task - No category',
        undefined,
      );
    });

    it('throws on service failure', async () => {
      mockMatchmaker.suggestPrice.mockResolvedValue({
        success: false,
        error: { code: 'AI_ERROR', message: 'Price suggestion failed' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.suggestPrice({
        title: 'Test',
        description: 'Test desc',
      })).rejects.toThrow('Price suggestion failed');
    });
  });
});
