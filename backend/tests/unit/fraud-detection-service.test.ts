/**
 * FraudDetectionService Unit Tests
 *
 * Tests risk score calculation, threshold classification, pattern detection,
 * automated actions (CRITICAL suspension, HIGH flagging), and admin review.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn(() => ''),
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

import { db } from '../../src/db';
import { FraudDetectionService } from '../../src/services/FraudDetectionService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FraudDetectionService', () => {
  // -------------------------------------------------------------------------
  // calculateRiskScore
  // -------------------------------------------------------------------------
  describe('calculateRiskScore', () => {
    it('stores risk score with correct risk level — LOW (<0.3)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', risk_score: 0.2, risk_level: 'LOW', entity_type: 'user', entity_id: 'u-1' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'user', entityId: 'u-1', riskScore: 0.2,
      });

      expect(result.success).toBe(true);
      // Verify query was called with risk_level 'LOW'
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[3]).toBe('LOW');
    });

    it('classifies MEDIUM risk (0.3 - 0.6)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-2', risk_score: 0.45, risk_level: 'MEDIUM' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'user', entityId: 'u-1', riskScore: 0.45,
      });

      expect(result.success).toBe(true);
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[3]).toBe('MEDIUM');
    });

    it('classifies HIGH risk (0.6 - 0.8)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-3', risk_score: 0.7, risk_level: 'HIGH' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'transaction', entityId: 't-1', riskScore: 0.7,
      });

      expect(result.success).toBe(true);
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[3]).toBe('HIGH');
    });

    it('classifies CRITICAL risk (≥0.8)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-4', risk_score: 0.9, risk_level: 'CRITICAL' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'user', entityId: 'u-1', riskScore: 0.9,
      });

      expect(result.success).toBe(true);
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[3]).toBe('CRITICAL');
    });

    it('rejects score below 0', async () => {
      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'user', entityId: 'u-1', riskScore: -0.1,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('rejects score above 1.0', async () => {
      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'user', entityId: 'u-1', riskScore: 1.5,
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('accepts boundary score 0.0 (LOW)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-5', risk_score: 0.0, risk_level: 'LOW' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'user', entityId: 'u-1', riskScore: 0.0,
      });

      expect(result.success).toBe(true);
      const args = mockDb.query.mock.calls[0][1] as unknown[];
      expect(args[3]).toBe('LOW');
    });

    it('accepts boundary score 1.0 (CRITICAL)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-6', risk_score: 1.0, risk_level: 'CRITICAL' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.calculateRiskScore({
        entityType: 'user', entityId: 'u-1', riskScore: 1.0,
      });

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getLatestRiskScore
  // -------------------------------------------------------------------------
  describe('getLatestRiskScore', () => {
    it('returns latest risk score for entity', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', risk_score: 0.75, risk_level: 'HIGH' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.getLatestRiskScore('user', 'u-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data?.risk_level).toBe('HIGH');
    });

    it('returns null when no score exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await FraudDetectionService.getLatestRiskScore('user', 'u-missing');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // detectPattern
  // -------------------------------------------------------------------------
  describe('detectPattern', () => {
    it('rejects pattern with empty userIds', async () => {
      const result = await FraudDetectionService.detectPattern({
        patternType: 'self_matching',
        patternDescription: 'test',
        userIds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INVALID_INPUT');
    });

    it('creates pattern and triggers CRITICAL auto-suspend for payment_fraud', async () => {
      // INSERT fraud_patterns
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-1', pattern_type: 'payment_fraud', status: 'detected' }],
        rowCount: 1,
      } as never);
      // UPDATE users SET SUSPENDED (for user-1)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // calculateRiskScore INSERT (for user-1)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-auto', risk_score: 0.95 }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.detectPattern({
        patternType: 'payment_fraud',
        patternDescription: 'Fraudulent payment detected',
        userIds: ['user-1'],
      });

      expect(result.success).toBe(true);

      // Verify SUSPEND query was called
      const suspendCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes("account_status = 'SUSPENDED'")
      );
      expect(suspendCall).toBeDefined();
    });

    it('flags users for HIGH risk patterns like self_matching', async () => {
      // INSERT fraud_patterns
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-2', pattern_type: 'self_matching', status: 'detected' }],
        rowCount: 1,
      } as never);
      // UPDATE users SET inconsistency_flags
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
      // calculateRiskScore INSERT
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-flag', risk_score: 0.75 }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.detectPattern({
        patternType: 'self_matching',
        patternDescription: 'User matched own task',
        userIds: ['user-1'],
      });

      expect(result.success).toBe(true);

      // Should flag, not suspend
      const flagCall = mockDb.query.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('inconsistency_flags')
      );
      expect(flagCall).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // updateRiskScoreStatus
  // -------------------------------------------------------------------------
  describe('updateRiskScoreStatus', () => {
    it('updates status with reviewer info', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'rs-1', status: 'reviewed', reviewed_by: 'admin-1' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.updateRiskScoreStatus(
        'rs-1', 'reviewed', 'admin-1', 'Looks legit'
      );

      expect(result.success).toBe(true);
    });

    it('returns NOT_FOUND for missing score', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await FraudDetectionService.updateRiskScoreStatus(
        'rs-missing', 'reviewed', 'admin-1'
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // updatePatternStatus
  // -------------------------------------------------------------------------
  describe('updatePatternStatus', () => {
    it('updates pattern with review decision', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'fp-1', status: 'confirmed' }],
        rowCount: 1,
      } as never);

      const result = await FraudDetectionService.updatePatternStatus(
        'fp-1', 'confirmed', 'admin-1', 'confirmed', 'Verified fraud ring'
      );

      expect(result.success).toBe(true);
    });

    it('returns NOT_FOUND for missing pattern', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await FraudDetectionService.updatePatternStatus(
        'fp-missing', 'dismissed', 'admin-1'
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });
});
