/**
 * Reputation Router Unit Tests
 *
 * Tests all procedures:
 * - calculateTrustScore (admin, query)
 * - detectAnomalies (admin, query)
 * - generateUserInsight (admin, query)
 * - checkTierEligibility (protected, query)
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

vi.mock('../../src/services/ReputationAIService', () => ({
  ReputationAIService: {
    calculateTrustScore: vi.fn(),
    detectAnomalies: vi.fn(),
    generateUserInsight: vi.fn(),
    shouldPromoteTier: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { reputationRouter } from '../../src/routers/reputation';
import { ReputationAIService } from '../../src/services/ReputationAIService';

const mockDb = vi.mocked(db);
const mockReputation = vi.mocked(ReputationAIService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';

function makeProtectedCaller() {
  return reputationRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

function makeAdminCaller() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return reputationRouter.createCaller({
    user: { id: UUID1, email: 'admin@test.com', full_name: 'Admin', role: 'admin', firebase_uid: 'fb-admin' } as any,
    firebaseUid: 'fb-admin',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reputation router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // calculateTrustScore (admin)
  // =========================================================================
  describe('calculateTrustScore', () => {
    it('returns trust score on success', async () => {
      const data = { userId: UUID2, trustScore: 85, tier: 3 };
      mockReputation.calculateTrustScore.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.calculateTrustScore({ userId: UUID2 });

      expect(result).toEqual(data);
      expect(mockReputation.calculateTrustScore).toHaveBeenCalledWith(UUID2);
    });

    it('throws on service failure', async () => {
      mockReputation.calculateTrustScore.mockResolvedValue({
        success: false,
        error: { code: 'AI_ERROR', message: 'Score calculation failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.calculateTrustScore({ userId: UUID2 }))
        .rejects.toThrow('Score calculation failed');
    });
  });

  // =========================================================================
  // detectAnomalies (admin)
  // =========================================================================
  describe('detectAnomalies', () => {
    it('returns anomaly data on success', async () => {
      const data = { anomalies: [{ type: 'rapid_completion', severity: 'high' }] };
      mockReputation.detectAnomalies.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.detectAnomalies({ userId: UUID2 });

      expect(result).toEqual(data);
      expect(mockReputation.detectAnomalies).toHaveBeenCalledWith(UUID2);
    });

    it('throws on service failure', async () => {
      mockReputation.detectAnomalies.mockResolvedValue({
        success: false,
        error: { code: 'AI_ERROR', message: 'Anomaly detection failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.detectAnomalies({ userId: UUID2 }))
        .rejects.toThrow('Anomaly detection failed');
    });
  });

  // =========================================================================
  // generateUserInsight (admin)
  // =========================================================================
  describe('generateUserInsight', () => {
    it('returns insight on success', async () => {
      const data = { summary: 'Reliable worker with high completion rate', riskFactors: [] };
      mockReputation.generateUserInsight.mockResolvedValue({ success: true, data } as any);

      const caller = makeAdminCaller();
      const result = await caller.generateUserInsight({ userId: UUID2 });

      expect(result).toEqual(data);
      expect(mockReputation.generateUserInsight).toHaveBeenCalledWith(UUID2);
    });

    it('throws on service failure', async () => {
      mockReputation.generateUserInsight.mockResolvedValue({
        success: false,
        error: { code: 'AI_ERROR', message: 'Insight generation failed' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.generateUserInsight({ userId: UUID2 }))
        .rejects.toThrow('Insight generation failed');
    });
  });

  // =========================================================================
  // checkTierEligibility (protected)
  // =========================================================================
  describe('checkTierEligibility', () => {
    it('returns tier eligibility on success', async () => {
      const data = { eligible: true, currentTier: 2, nextTier: 3, requirements: [] };
      mockReputation.shouldPromoteTier.mockResolvedValue({ success: true, data } as any);

      const caller = makeProtectedCaller();
      const result = await caller.checkTierEligibility();

      expect(result).toEqual(data);
      expect(mockReputation.shouldPromoteTier).toHaveBeenCalledWith(UUID1);
    });

    it('throws on service failure', async () => {
      mockReputation.shouldPromoteTier.mockResolvedValue({
        success: false,
        error: { code: 'AI_ERROR', message: 'Eligibility check failed' },
      } as any);

      const caller = makeProtectedCaller();
      await expect(caller.checkTierEligibility())
        .rejects.toThrow('Eligibility check failed');
    });
  });
});
