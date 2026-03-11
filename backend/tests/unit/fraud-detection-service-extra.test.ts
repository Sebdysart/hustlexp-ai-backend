/**
 * FraudDetectionService Extra Tests
 *
 * Covers uncovered paths from fraud-detection-service.test.ts:
 * - getRiskAssessment (all risk level recommendation paths)
 * - getHighRiskScores
 * - getUserPatterns (with and without status filter)
 * - getDetectedPatterns
 * - detectPattern: MEDIUM/LOW risk paths, multiple users, DB errors
 * - calculateRiskScore: DB error path, invariant violation
 * - storeRiskScoreFromExistingService
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn(() => 'invariant error message'),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: {
    createNotification: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('../../src/services/AdminNotificationHelper', () => ({
  notifyAdmins: vi.fn().mockResolvedValue(undefined),
}));

import { db, isInvariantViolation } from '../../src/db';
import { FraudDetectionService } from '../../src/services/FraudDetectionService';

const mockDb = vi.mocked(db);
const mockIsInvariantViolation = vi.mocked(isInvariantViolation);

beforeEach(() => {
  vi.clearAllMocks();
  mockIsInvariantViolation.mockReturnValue(false);
});

describe('FraudDetectionService (extra coverage)', () => {
  // -------------------------------------------------------------------------
  // calculateRiskScore — DB error path
  // -------------------------------------------------------------------------
  describe('calculateRiskScore — error paths', () => {
    it('returns DB_ERROR when query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection lost'));

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'user',
        entityId: 'u-1',
        riskScore: 0.5,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
        expect(result.error.message).toBe('connection lost');
      }
    });

    it('returns INVARIANT_VIOLATION when isInvariantViolation is true', async () => {
      mockIsInvariantViolation.mockReturnValueOnce(true);
      mockDb.query.mockRejectedValueOnce({ code: 'HX100', message: 'Invariant' });

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'task',
        entityId: 't-1',
        riskScore: 0.4,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        // code comes from error.code or 'INVARIANT_VIOLATION'
        expect(['HX100', 'INVARIANT_VIOLATION']).toContain(result.error.code);
      }
    });

    it('handles non-Error thrown value gracefully', async () => {
      mockDb.query.mockRejectedValueOnce('string error');

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'user',
        entityId: 'u-1',
        riskScore: 0.5,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
        expect(result.error.message).toBe('Unknown error');
      }
    });

    it('passes componentScores and flags to INSERT query', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', risk_score: 0.5 }],
        rowCount: 1,
      } as never);

      await FraudDetectionService.calculateRiskScore({
        entityType: 'user',
        entityId: 'u-1',
        riskScore: 0.5,
        componentScores: { velocity: 0.6, device: 0.4 },
        flags: ['suspicious_login', 'vpn_detected'],
      });

      const queryArgs = mockDb.query.mock.calls[0][1] as unknown[];
      // componentScores serialized as JSON string
      expect(queryArgs[4]).toContain('velocity');
      // flags array
      expect(queryArgs[5]).toContain('suspicious_login');
    });
  });

  // -------------------------------------------------------------------------
  // getLatestRiskScore — DB error
  // -------------------------------------------------------------------------
  describe('getLatestRiskScore — error path', () => {
    it('returns DB_ERROR when query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('timeout'));

      const result = await FraudDetectionService.getLatestRiskScore('user', 'u-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getRiskAssessment — all recommendation branches
  // -------------------------------------------------------------------------
  describe('getRiskAssessment', () => {
    function mockRiskScore(riskLevel: string) {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'rs-1',
          entity_type: 'user',
          entity_id: 'u-1',
          risk_score: 0.5,
          risk_level: riskLevel,
          component_scores: {},
          flags: [],
          status: 'active',
        }],
        rowCount: 1,
      } as never);
    }

    it('recommends auto_approve for LOW risk', async () => {
      mockRiskScore('LOW');
      const result = await FraudDetectionService.getRiskAssessment('user', 'u-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.recommendation).toBe('auto_approve');
        expect(result.data.riskLevel).toBe('LOW');
      }
    });

    it('recommends review for MEDIUM risk', async () => {
      mockRiskScore('MEDIUM');
      const result = await FraudDetectionService.getRiskAssessment('user', 'u-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.recommendation).toBe('review');
      }
    });

    it('recommends manual_review for HIGH risk', async () => {
      mockRiskScore('HIGH');
      const result = await FraudDetectionService.getRiskAssessment('user', 'u-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.recommendation).toBe('manual_review');
      }
    });

    it('recommends auto_reject for CRITICAL risk', async () => {
      mockRiskScore('CRITICAL');
      const result = await FraudDetectionService.getRiskAssessment('user', 'u-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.recommendation).toBe('auto_reject');
      }
    });

    it('returns NOT_FOUND when no score exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await FraudDetectionService.getRiskAssessment('user', 'u-missing');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });

    it('returns NOT_FOUND when getLatestRiskScore fails', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB error'));

      const result = await FraudDetectionService.getRiskAssessment('user', 'u-1');

      // scoreResult.success = false triggers not-found return
      expect(result.success).toBe(false);
    });

    it('maps entity fields from raw score row', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'rs-9',
          entity_type: 'transaction',
          entity_id: 'txn-42',
          risk_score: 0.3,
          risk_level: 'LOW',
          component_scores: { velocity: 0.2 },
          flags: ['flag1'],
          status: 'active',
        }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.getRiskAssessment('transaction', 'txn-42');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.entityType).toBe('transaction');
        expect(result.data.entityId).toBe('txn-42');
        expect(result.data.flags).toContain('flag1');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getHighRiskScores
  // -------------------------------------------------------------------------
  describe('getHighRiskScores', () => {
    it('returns scores above threshold', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { id: 'rs-1', risk_score: 0.9, risk_level: 'CRITICAL' },
          { id: 'rs-2', risk_score: 0.7, risk_level: 'HIGH' },
        ],
        rowCount: 2,
      } as never);

      const result = await FraudDetectionService.getHighRiskScores();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
        expect(result.data[0].risk_level).toBe('CRITICAL');
      }
    });

    it('accepts custom threshold and limit', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await FraudDetectionService.getHighRiskScores(0.8, 10);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
      // Verify threshold was passed
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[0]).toBe(0.8);
      expect(args[1]).toBe(10);
    });

    it('returns DB_ERROR when query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('query error'));

      const result = await FraudDetectionService.getHighRiskScores();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getUserPatterns
  // -------------------------------------------------------------------------
  describe('getUserPatterns', () => {
    it('returns patterns for a user without status filter', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { id: 'fp-1', pattern_type: 'self_matching', status: 'detected' },
          { id: 'fp-2', pattern_type: 'multiple_accounts', status: 'reviewed' },
        ],
        rowCount: 2,
      } as never);

      const result = await FraudDetectionService.getUserPatterns('user-1');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(2);
      }

      // Verify no status filter in SQL
      const sql = mockDb.query.mock.calls[0][0] as string;
      expect(sql).not.toContain('status =');
    });

    it('applies status filter when provided', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-1', pattern_type: 'self_matching', status: 'confirmed' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.getUserPatterns('user-1', 'confirmed');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }

      // Verify status filter appears in SQL
      const sql = mockDb.query.mock.calls[0][0] as string;
      expect(sql).toContain('status');
    });

    it('returns empty array when user has no patterns', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await FraudDetectionService.getUserPatterns('user-clean');

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(0);
      }
    });

    it('returns DB_ERROR when query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('timeout'));

      const result = await FraudDetectionService.getUserPatterns('user-1');

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // getDetectedPatterns
  // -------------------------------------------------------------------------
  describe('getDetectedPatterns', () => {
    it('returns detected patterns with default limit', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-1', status: 'detected', pattern_type: 'self_matching' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.getDetectedPatterns();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toHaveLength(1);
      }

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[0]).toBe(100); // default limit
    });

    it('accepts custom limit', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await FraudDetectionService.getDetectedPatterns(50);

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[0]).toBe(50);
    });

    it('returns DB_ERROR when query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB failure'));

      const result = await FraudDetectionService.getDetectedPatterns();

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // detectPattern — MEDIUM/LOW risk paths and multiple users
  // -------------------------------------------------------------------------
  describe('detectPattern — MEDIUM risk path', () => {
    it('scores medium risk for rapid_account_creation pattern', async () => {
      // INSERT fraud_patterns
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-med', pattern_type: 'rapid_account_creation', status: 'detected' }],
        rowCount: 1,
      } as never);
      // calculateRiskScore INSERT (MEDIUM = 0.5 score)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-med', risk_score: 0.5 }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.detectPattern({
        patternType: 'rapid_account_creation',
        patternDescription: 'Many accounts from same IP',
        userIds: ['user-a'],
      });

      expect(result.success).toBe(true);

      // Verify risk score was created with 0.5 score (MEDIUM)
      const riskScoreCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO fraud_risk_scores')
      );
      expect(riskScoreCall).toBeDefined();
      const scoreArg = riskScoreCall![1] as unknown[];
      expect(scoreArg[2]).toBe(0.5); // riskScore for MEDIUM
    });

    it('scores LOW risk for unknown pattern type', async () => {
      // INSERT fraud_patterns
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-low', pattern_type: 'unknown_pattern', status: 'detected' }],
        rowCount: 1,
      } as never);
      // calculateRiskScore INSERT (LOW = 0.3 score)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-low', risk_score: 0.3 }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.detectPattern({
        patternType: 'unknown_pattern_xyz',
        patternDescription: 'Some unknown pattern',
        userIds: ['user-b'],
      });

      expect(result.success).toBe(true);

      const riskScoreCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('INSERT INTO fraud_risk_scores')
      );
      expect(riskScoreCall).toBeDefined();
      const scoreArg = riskScoreCall![1] as unknown[];
      expect(scoreArg[2]).toBe(0.3); // LOW risk score
    });

    it('handles multiple users for CRITICAL pattern', async () => {
      // INSERT fraud_patterns
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-crit', pattern_type: 'money_laundering', status: 'detected' }],
        rowCount: 1,
      } as never);

      // For each of the 2 users: UPDATE SUSPENDED + calculateRiskScore
      // user-1 suspend
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // user-1 risk score
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', risk_score: 0.95 }],
        rowCount: 1,
      } as never);
      // user-2 suspend
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // user-2 risk score
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-2', risk_score: 0.95 }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.detectPattern({
        patternType: 'money_laundering',
        patternDescription: 'Coordinated laundering',
        userIds: ['user-1', 'user-2'],
        taskIds: ['task-a', 'task-b'],
        transactionIds: ['txn-1'],
        evidence: { amount: 50000, accounts: 2 },
      });

      expect(result.success).toBe(true);

      // Verify both users were suspended
      const suspendCalls = mockDb.query.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes("account_status = 'SUSPENDED'")
      );
      expect(suspendCalls.length).toBe(2);
    });

    it('handles multiple users for HIGH risk pattern', async () => {
      // INSERT fraud_patterns
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-high', pattern_type: 'multiple_accounts', status: 'detected' }],
        rowCount: 1,
      } as never);

      // user-1: flag + risk score
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'rs-1' }], rowCount: 1 } as never);
      // user-2: flag + risk score
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'rs-2' }], rowCount: 1 } as never);

      const result = await FraudDetectionService.detectPattern({
        patternType: 'multiple_accounts',
        patternDescription: 'Same person, multiple accounts',
        userIds: ['user-1', 'user-2'],
      });

      expect(result.success).toBe(true);

      const flagCalls = mockDb.query.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('inconsistency_flags')
      );
      expect(flagCalls.length).toBe(2);
    });

    it('returns DB_ERROR when pattern INSERT fails', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB write error'));

      const result = await FraudDetectionService.detectPattern({
        patternType: 'self_matching',
        patternDescription: 'Test',
        userIds: ['user-1'],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // updateRiskScoreStatus — no review notes
  // -------------------------------------------------------------------------
  describe('updateRiskScoreStatus — without notes', () => {
    it('updates without review notes (null passed)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', status: 'dismissed', reviewed_by: 'admin-1' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.updateRiskScoreStatus(
        'rs-1', 'dismissed', 'admin-1'
        // no reviewNotes arg
      );

      expect(result.success).toBe(true);
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[2]).toBeNull(); // reviewNotes defaults to null
    });

    it('returns DB_ERROR when query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('DB fail'));

      const result = await FraudDetectionService.updateRiskScoreStatus(
        'rs-1', 'reviewed', 'admin-1'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });
  });

  // -------------------------------------------------------------------------
  // updatePatternStatus — DB error
  // -------------------------------------------------------------------------
  describe('updatePatternStatus — error path', () => {
    it('returns DB_ERROR when query throws', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection reset'));

      const result = await FraudDetectionService.updatePatternStatus(
        'fp-1', 'reviewed', 'admin-1'
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('DB_ERROR');
      }
    });

    it('passes all optional fields to UPDATE query', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-1', status: 'dismissed' }],
        rowCount: 1,
      } as never);

      await FraudDetectionService.updatePatternStatus(
        'fp-1', 'dismissed', 'admin-1', 'no_fraud', 'Investigated — false positive'
      );

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[2]).toBe('no_fraud');     // reviewDecision
      expect(args[3]).toBe('Investigated — false positive'); // reviewNotes
    });
  });

  // -------------------------------------------------------------------------
  // storeRiskScoreFromExistingService
  // -------------------------------------------------------------------------
  describe('storeRiskScoreFromExistingService', () => {
    it('converts 0-100 score to 0.0-1.0 before storing', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', risk_score: 0.75, risk_level: 'HIGH' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.storeRiskScoreFromExistingService(
        'user',
        'u-1',
        75, // 0-100 scale from existing service
        { velocity: 0.8 },
        ['flagged']
      );

      expect(result.success).toBe(true);
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[2]).toBeCloseTo(0.75); // 75 / 100 = 0.75
    });

    it('clamps score to max 1.0', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', risk_score: 1.0 }],
        rowCount: 1,
      } as never);

      await FraudDetectionService.storeRiskScoreFromExistingService(
        'user', 'u-1',
        150, // over 100 -> should clamp to 1.0
        {},
        []
      );

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[2]).toBe(1.0);
    });

    it('clamps score to min 0.0', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', risk_score: 0.0 }],
        rowCount: 1,
      } as never);

      await FraudDetectionService.storeRiskScoreFromExistingService(
        'user', 'u-1',
        -10, // negative -> should clamp to 0.0
        {},
        []
      );

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[2]).toBe(0.0);
    });

    it('passes entity type and id correctly', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', risk_score: 0.3 }],
        rowCount: 1,
      } as never);

      await FraudDetectionService.storeRiskScoreFromExistingService(
        'transaction', 'txn-999', 30, {}, []
      );

      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[0]).toBe('transaction');
      expect(args[1]).toBe('txn-999');
    });
  });
});
