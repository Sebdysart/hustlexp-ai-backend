/**
 * GDPRService Unit Tests
 *
 * Tests GDPR request lifecycle: creation (with export format validation),
 * duplicate prevention, cancellation (with grace period), consent management,
 * and deadline calculations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
    serializableTransaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn(() => ''),
}));

vi.mock('../../src/logger', () => {
  const base = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => base };
  return {
    logger: base,
    escrowLogger: base,
    taskLogger: base,
    aiLogger: base,
    stripeLogger: base,
    authLogger: base,
    workerLogger: base,
    dbLogger: base,
  };
});

vi.mock('../../src/services/NotificationService', () => ({
  NotificationService: {
    createNotification: vi.fn().mockResolvedValue({ success: true }),
  },
}));

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    randomUUID: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  };
});

import { db } from '../../src/db';
import { GDPRService, _resetGDPRRateLimitMapForTesting } from '../../src/services/GDPRService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
  // D53-4: reset the in-memory rate-limit Map so each test gets a fresh bucket
  _resetGDPRRateLimitMapForTesting();
});

describe('GDPRService', () => {
  // -------------------------------------------------------------------------
  // createRequest
  // -------------------------------------------------------------------------
  describe('createRequest', () => {
    it('requires exportFormat for export requests', async () => {
      const result = await GDPRService.createRequest({
        userId: 'user-1',
        requestType: 'export',
        // No exportFormat
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_INPUT');
        expect(result.error.message).toContain('Export format');
      }
    });

    it('prevents duplicate pending requests of same type', async () => {
      // Check existing — found a pending one
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'existing-req' }], rowCount: 1,
      } as never);

      const result = await GDPRService.createRequest({
        userId: 'user-1',
        requestType: 'export',
        exportFormat: 'json',
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
        expect(result.error.message).toContain('already have');
      }
    });

    it('creates export request with 30-day deadline', async () => {
      // Check existing — none
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // INSERT
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'req-1', user_id: 'user-1', request_type: 'export',
          status: 'pending', deadline: new Date(Date.now() + 30 * 86400000),
        }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.createRequest({
        userId: 'user-1',
        requestType: 'export',
        exportFormat: 'json',
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.request_type).toBe('export');
        expect(result.data.status).toBe('pending');
      }
    });

    it('creates deletion request with 7-day deadline', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'req-2', user_id: 'user-1', request_type: 'deletion',
          status: 'pending', deadline: new Date(Date.now() + 7 * 86400000),
        }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.createRequest({
        userId: 'user-1',
        requestType: 'deletion',
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.request_type).toBe('deletion');

      // Verify deadline is ~7 days from now
      const insertArgs = mockDb.query.mock.calls[1][1] as unknown[];
      const deadline = insertArgs[3] as Date;
      const daysUntilDeadline = (deadline.getTime() - Date.now()) / (86400000);
      expect(daysUntilDeadline).toBeCloseTo(7, 0);
    });

    it('creates rectification request without exportFormat', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'req-3', request_type: 'rectification', status: 'pending' }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.createRequest({
        userId: 'user-1',
        requestType: 'rectification',
        requestDetails: { field: 'email', newValue: 'new@example.com' },
      });

      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getRequestById
  // -------------------------------------------------------------------------
  describe('getRequestById', () => {
    it('returns request when user owns it', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'req-1', user_id: 'user-1', request_type: 'export' }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.getRequestById('req-1', 'user-1');
      expect(result.success).toBe(true);
    });

    it('returns NOT_FOUND when user does not own request', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await GDPRService.getRequestById('req-1', 'wrong-user');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // getUserRequests
  // -------------------------------------------------------------------------
  describe('getUserRequests', () => {
    it('returns all requests for user', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { id: 'req-1', request_type: 'export' },
          { id: 'req-2', request_type: 'deletion' },
        ],
        rowCount: 2,
      } as never);

      const result = await GDPRService.getUserRequests('user-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // cancelRequest
  // -------------------------------------------------------------------------
  describe('cancelRequest', () => {
    it('cancels a pending request', async () => {
      // Verify request
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'req-1', status: 'pending', request_type: 'export',
          deadline: new Date(Date.now() + 86400000),
        }],
        rowCount: 1,
      } as never);
      // UPDATE to cancelled
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'req-1', status: 'cancelled' }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.cancelRequest('req-1', 'user-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.status).toBe('cancelled');
    });

    it('returns NOT_FOUND when request missing or wrong user', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await GDPRService.cancelRequest('req-missing', 'user-1');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('rejects cancellation of completed request', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'req-1', status: 'completed', request_type: 'export',
          deadline: new Date(),
        }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.cancelRequest('req-1', 'user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.code).toBe('INVALID_STATE');
        expect(result.error.message).toContain('completed');
      }
    });

    it('rejects deletion cancellation after grace period expired', async () => {
      // Deadline in the past
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'req-1', status: 'pending', request_type: 'deletion',
          deadline: new Date(Date.now() - 86400000), // 1 day ago
        }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.cancelRequest('req-1', 'user-1');
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.message).toContain('grace period');
      }
    });

    it('allows deletion cancellation within grace period', async () => {
      // Deadline in the future
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'req-1', status: 'pending', request_type: 'deletion',
          deadline: new Date(Date.now() + 5 * 86400000), // 5 days from now
        }],
        rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'req-1', status: 'cancelled' }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.cancelRequest('req-1', 'user-1');
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // updateConsent
  // -------------------------------------------------------------------------
  describe('updateConsent', () => {
    it('grants consent with upsert', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'consent-1', user_id: 'user-1', consent_type: 'marketing',
          granted: true, granted_at: new Date(),
        }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.updateConsent({
        userId: 'user-1',
        consentType: 'marketing',
        purpose: 'Receive marketing emails',
        granted: true,
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.granted).toBe(true);
    });

    it('revokes consent', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: 'consent-1', user_id: 'user-1', consent_type: 'analytics',
          granted: false, withdrawn_at: new Date(),
        }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.updateConsent({
        userId: 'user-1',
        consentType: 'analytics',
        purpose: 'Analytics tracking',
        granted: false,
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.granted).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getConsentStatus
  // -------------------------------------------------------------------------
  describe('getConsentStatus', () => {
    it('returns all consents for user', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { consent_type: 'marketing', granted: true },
          { consent_type: 'analytics', granted: false },
        ],
        rowCount: 2,
      } as never);

      const result = await GDPRService.getConsentStatus('user-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toHaveLength(2);
    });

    it('filters by consent type when provided', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ consent_type: 'marketing', granted: true }],
        rowCount: 1,
      } as never);

      const result = await GDPRService.getConsentStatus('user-1', 'marketing');
      expect(result.success).toBe(true);

      // Verify filter was applied
      const sql = mockDb.query.mock.calls[0][0] as string;
      expect(sql).toContain('consent_type = $2');
    });
  });
});
