/**
 * Fraud Router Unit Tests
 *
 * Tests all admin-only procedures in the fraud router:
 * - calculateRiskScore, getLatestRiskScore, getRiskAssessment,
 *   getHighRiskScores, updateRiskScoreStatus
 * - detectPattern, getUserPatterns, getDetectedPatterns, updatePatternStatus
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

vi.mock('../../src/services/FraudDetectionService', () => ({
  FraudDetectionService: {
    calculateRiskScore: vi.fn(),
    getLatestRiskScore: vi.fn(),
    getRiskAssessment: vi.fn(),
    getHighRiskScores: vi.fn(),
    updateRiskScoreStatus: vi.fn(),
    detectPattern: vi.fn(),
    getUserPatterns: vi.fn(),
    getDetectedPatterns: vi.fn(),
    updatePatternStatus: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { fraudRouter } from '../../src/routers/fraud';
import { FraudDetectionService } from '../../src/services/FraudDetectionService';

const mockDb = vi.mocked(db);
const mockFraud = vi.mocked(FraudDetectionService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';

function makeAdminCaller() {
  // Pre-set admin role check
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return fraudRouter.createCaller({
    user: { id: UUID1, email: 'admin@test.com', full_name: 'Admin', role: 'admin', firebase_uid: 'fb-admin' } as any,
    firebaseUid: 'fb-admin',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fraud router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // calculateRiskScore
  // =========================================================================
  describe('calculateRiskScore', () => {
    it('returns risk score data on success', async () => {
      const data = { id: 'rs-1', riskScore: 0.8 };
      mockFraud.calculateRiskScore.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.calculateRiskScore({
        entityType: 'user',
        entityId: UUID2,
        riskScore: 0.8,
      });

      expect(result).toEqual(data);
      expect(mockFraud.calculateRiskScore).toHaveBeenCalledWith({
        entityType: 'user',
        entityId: UUID2,
        riskScore: 0.8,
        componentScores: undefined,
        flags: [],
      });
    });

    it('throws BAD_REQUEST on INVALID_INPUT error', async () => {
      mockFraud.calculateRiskScore.mockResolvedValue({
        success: false,
        error: { code: 'INVALID_INPUT', message: 'bad data' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.calculateRiskScore({
        entityType: 'task',
        entityId: UUID2,
        riskScore: 0.5,
      })).rejects.toThrow('bad data');
    });

    it('throws INTERNAL_SERVER_ERROR on unknown error', async () => {
      mockFraud.calculateRiskScore.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'connection lost' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.calculateRiskScore({
        entityType: 'transaction',
        entityId: UUID2,
        riskScore: 0.3,
      })).rejects.toThrow('connection lost');
    });
  });

  // =========================================================================
  // getLatestRiskScore
  // =========================================================================
  describe('getLatestRiskScore', () => {
    it('returns latest risk score on success', async () => {
      const data = { riskScore: 0.6, entityType: 'user' };
      mockFraud.getLatestRiskScore.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.getLatestRiskScore({ entityType: 'user', entityId: UUID2 });

      expect(result).toEqual(data);
    });

    it('throws on failure', async () => {
      mockFraud.getLatestRiskScore.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.getLatestRiskScore({ entityType: 'user', entityId: UUID2 }))
        .rejects.toThrow('failed');
    });
  });

  // =========================================================================
  // getRiskAssessment
  // =========================================================================
  describe('getRiskAssessment', () => {
    it('returns assessment on success', async () => {
      const data = { recommendation: 'block', riskLevel: 'high' };
      mockFraud.getRiskAssessment.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.getRiskAssessment({ entityType: 'user', entityId: UUID2 });

      expect(result).toEqual(data);
    });

    it('throws NOT_FOUND when entity not found', async () => {
      mockFraud.getRiskAssessment.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'No risk score found' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.getRiskAssessment({ entityType: 'user', entityId: UUID2 }))
        .rejects.toThrow('No risk score found');
    });
  });

  // =========================================================================
  // getHighRiskScores
  // =========================================================================
  describe('getHighRiskScores', () => {
    it('returns high risk scores with defaults', async () => {
      const data = [{ id: 'rs-1', riskScore: 0.9 }];
      mockFraud.getHighRiskScores.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.getHighRiskScores({});

      expect(result).toEqual(data);
      expect(mockFraud.getHighRiskScores).toHaveBeenCalledWith(0.6, 100);
    });

    it('passes custom minRiskScore and limit', async () => {
      mockFraud.getHighRiskScores.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeAdminCaller();
      await caller.getHighRiskScores({ minRiskScore: 0.8, limit: 50 });

      expect(mockFraud.getHighRiskScores).toHaveBeenCalledWith(0.8, 50);
    });
  });

  // =========================================================================
  // updateRiskScoreStatus
  // =========================================================================
  describe('updateRiskScoreStatus', () => {
    it('updates status and returns data on success', async () => {
      const data = { id: 'rs-1', status: 'reviewed' };
      mockFraud.updateRiskScoreStatus.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.updateRiskScoreStatus({
        riskScoreId: UUID2,
        status: 'reviewed',
        reviewNotes: 'looks ok',
      });

      expect(result).toEqual(data);
      expect(mockFraud.updateRiskScoreStatus).toHaveBeenCalledWith(
        UUID2, 'reviewed', UUID1, 'looks ok',
      );
    });

    it('throws NOT_FOUND when risk score not found', async () => {
      mockFraud.updateRiskScoreStatus.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Risk score not found' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.updateRiskScoreStatus({
        riskScoreId: UUID2,
        status: 'dismissed',
      })).rejects.toThrow('Risk score not found');
    });
  });

  // =========================================================================
  // detectPattern
  // =========================================================================
  describe('detectPattern', () => {
    it('detects and returns pattern on success', async () => {
      const data = { id: 'p-1', patternType: 'self_matching' };
      mockFraud.detectPattern.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.detectPattern({
        patternType: 'self_matching',
        patternDescription: 'User matched own task',
        userIds: [UUID2],
      });

      expect(result).toEqual(data);
    });

    it('throws BAD_REQUEST on invalid patternType (Zod enum)', async () => {
      // A-3 FIX: patternType is now a Zod .enum([...]) — 'x' is rejected by Zod
      // input validation before the service is ever called. The Zod error message
      // describes which enum values are valid rather than 'Invalid pattern'.
      const caller = makeAdminCaller();
      await expect(caller.detectPattern({
        patternType: 'x' as any,
        patternDescription: 'test',
        userIds: [UUID2],
      })).rejects.toThrow('Invalid enum value');
    });
  });

  // =========================================================================
  // getUserPatterns
  // =========================================================================
  describe('getUserPatterns', () => {
    it('returns patterns for user', async () => {
      const data = [{ id: 'p-1' }];
      mockFraud.getUserPatterns.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.getUserPatterns({ userId: UUID2 });

      expect(result).toEqual(data);
    });

    it('passes optional status filter', async () => {
      mockFraud.getUserPatterns.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeAdminCaller();
      await caller.getUserPatterns({ userId: UUID2, status: 'confirmed' });

      expect(mockFraud.getUserPatterns).toHaveBeenCalledWith(UUID2, 'confirmed');
    });
  });

  // =========================================================================
  // getDetectedPatterns
  // =========================================================================
  describe('getDetectedPatterns', () => {
    it('returns detected patterns with default limit', async () => {
      mockFraud.getDetectedPatterns.mockResolvedValue({ success: true, data: [] } as any);

      const caller = makeAdminCaller();
      await caller.getDetectedPatterns({});

      expect(mockFraud.getDetectedPatterns).toHaveBeenCalledWith(100);
    });
  });

  // =========================================================================
  // updatePatternStatus
  // =========================================================================
  describe('updatePatternStatus', () => {
    it('updates pattern status on success', async () => {
      const data = { id: 'p-1', status: 'confirmed' };
      mockFraud.updatePatternStatus.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.updatePatternStatus({
        patternId: UUID2,
        status: 'confirmed',
        reviewDecision: 'confirmed',
        reviewNotes: 'Confirmed fraud',
      });

      expect(result).toEqual(data);
    });

    it('throws NOT_FOUND when pattern not found', async () => {
      mockFraud.updatePatternStatus.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Pattern not found' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.updatePatternStatus({
        patternId: UUID2,
        status: 'dismissed',
      })).rejects.toThrow('Pattern not found');
    });
  });
});
