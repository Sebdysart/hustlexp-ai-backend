/**
 * GDPR Router Unit Tests
 *
 * Tests all protected procedures:
 * - createRequest, getRequestStatus, getMyRequests, cancelRequest
 * - getConsentStatus, updateConsent
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

vi.mock('../../src/services/GDPRService', () => ({
  GDPRService: {
    createRequest: vi.fn(),
    getRequestById: vi.fn(),
    getUserRequests: vi.fn(),
    cancelRequest: vi.fn(),
    getConsentStatus: vi.fn(),
    updateConsent: vi.fn(),
    hasBiometricConsent: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { gdprRouter } from '../../src/routers/gdpr';
import { GDPRService } from '../../src/services/GDPRService';

const mockGDPR = vi.mocked(GDPRService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';

function makeCaller() {
  return gdprRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gdpr router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // createRequest
  // =========================================================================
  describe('createRequest', () => {
    it('creates export request with format', async () => {
      const data = { id: 'req-1', status: 'pending' };
      mockGDPR.createRequest.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.createRequest({
        requestType: 'export',
        exportFormat: 'json',
      });

      expect(result).toEqual(data);
      expect(mockGDPR.createRequest).toHaveBeenCalledWith({
        userId: UUID1,
        requestType: 'export',
        exportFormat: 'json',
        scope: undefined,
        requestDetails: undefined,
      });
    });

    it('throws BAD_REQUEST when export request missing format', async () => {
      const caller = makeCaller();
      await expect(caller.createRequest({ requestType: 'export' }))
        .rejects.toThrow('Export format is required');
    });

    it('creates deletion request without format', async () => {
      mockGDPR.createRequest.mockResolvedValue({ success: true, data: { id: 'req-2' } } as any);

      const caller = makeCaller();
      const result = await caller.createRequest({ requestType: 'deletion' });

      expect(result).toEqual({ id: 'req-2' });
    });

    it('throws on service failure with INVALID_STATE as BAD_REQUEST', async () => {
      mockGDPR.createRequest.mockResolvedValue({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Already pending' },
      } as any);

      const caller = makeCaller();
      await expect(caller.createRequest({ requestType: 'deletion' }))
        .rejects.toThrow('Already pending');
    });
  });

  // =========================================================================
  // getRequestStatus
  // =========================================================================
  describe('getRequestStatus', () => {
    it('returns request status on success', async () => {
      const data = { id: UUID2, status: 'processing' };
      mockGDPR.getRequestById.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.getRequestStatus({ requestId: UUID2 });

      expect(result).toEqual(data);
      expect(mockGDPR.getRequestById).toHaveBeenCalledWith(UUID2, UUID1);
    });

    it('throws NOT_FOUND when request not found', async () => {
      mockGDPR.getRequestById.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Request not found' },
      } as any);

      const caller = makeCaller();
      await expect(caller.getRequestStatus({ requestId: UUID2 }))
        .rejects.toThrow('Request not found');
    });
  });

  // =========================================================================
  // getMyRequests
  // =========================================================================
  describe('getMyRequests', () => {
    it('returns all user requests', async () => {
      const data = [{ id: 'req-1' }, { id: 'req-2' }];
      mockGDPR.getUserRequests.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.getMyRequests();

      expect(result).toEqual(data);
      expect(mockGDPR.getUserRequests).toHaveBeenCalledWith(UUID1);
    });

    it('throws on service failure', async () => {
      mockGDPR.getUserRequests.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'failed' },
      } as any);

      const caller = makeCaller();
      await expect(caller.getMyRequests()).rejects.toThrow('failed');
    });
  });

  // =========================================================================
  // cancelRequest
  // =========================================================================
  describe('cancelRequest', () => {
    it('cancels request on success', async () => {
      const data = { id: UUID2, status: 'cancelled' };
      mockGDPR.cancelRequest.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.cancelRequest({ requestId: UUID2 });

      expect(result).toEqual(data);
      expect(mockGDPR.cancelRequest).toHaveBeenCalledWith(UUID2, UUID1);
    });

    it('throws NOT_FOUND when request not found', async () => {
      mockGDPR.cancelRequest.mockResolvedValue({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Not found' },
      } as any);

      const caller = makeCaller();
      await expect(caller.cancelRequest({ requestId: UUID2 }))
        .rejects.toThrow('Not found');
    });

    it('throws BAD_REQUEST on INVALID_STATE', async () => {
      mockGDPR.cancelRequest.mockResolvedValue({
        success: false,
        error: { code: 'INVALID_STATE', message: 'Already processing' },
      } as any);

      const caller = makeCaller();
      await expect(caller.cancelRequest({ requestId: UUID2 }))
        .rejects.toThrow('Already processing');
    });
  });

  // =========================================================================
  // getConsentStatus
  // =========================================================================
  describe('getConsentStatus', () => {
    it('returns consent status', async () => {
      const data = [{ consentType: 'analytics', granted: true }];
      mockGDPR.getConsentStatus.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.getConsentStatus({ consentType: 'analytics' });

      expect(result).toEqual(data);
      expect(mockGDPR.getConsentStatus).toHaveBeenCalledWith(UUID1, 'analytics');
    });

    it('returns all consents when no type specified', async () => {
      const data = [{ consentType: 'analytics', granted: true }];
      mockGDPR.getConsentStatus.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      await caller.getConsentStatus({});

      expect(mockGDPR.getConsentStatus).toHaveBeenCalledWith(UUID1, undefined);
    });
  });

  // =========================================================================
  // updateConsent
  // =========================================================================
  describe('updateConsent', () => {
    it('updates consent on success', async () => {
      const data = { id: 'c-1', granted: true };
      mockGDPR.updateConsent.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.updateConsent({
        consentType: 'marketing',
        purpose: 'Receive marketing emails',
        granted: true,
      });

      expect(result).toEqual(data);
      expect(mockGDPR.updateConsent).toHaveBeenCalledWith({
        userId: UUID1,
        consentType: 'marketing',
        purpose: 'Receive marketing emails',
        granted: true,
        ipAddress: undefined,
        userAgent: undefined,
      });
    });

    it('throws on service failure', async () => {
      mockGDPR.updateConsent.mockResolvedValue({
        success: false,
        error: { code: 'DB_ERROR', message: 'failed' },
      } as any);

      const caller = makeCaller();
      await expect(caller.updateConsent({
        consentType: 'analytics',
        purpose: 'Track usage',
        granted: false,
      })).rejects.toThrow('failed');
    });
  });
});
