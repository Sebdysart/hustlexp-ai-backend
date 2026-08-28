/**
 * BackgroundCheckService Unit Tests
 *
 * Tests background check initiation, status updates (webhooks),
 * manual review, queries, expiration marking, and upcoming expirations.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../src/services/CapabilityRecomputeService', () => ({
  recomputeCapabilityProfile: vi.fn().mockResolvedValue(undefined),
}));

import { db } from '../../src/db';
import {
  initiateBackgroundCheck,
  updateBackgroundCheckStatus,
  reviewBackgroundCheck,
  getUserBackgroundCheck,
  hasValidBackgroundCheck,
  getPendingReviews,
  getChecksByStatus,
  markExpiredChecks,
  getUpcomingExpirations,
} from '../../src/services/BackgroundCheckService';
import { recomputeCapabilityProfile } from '../../src/services/CapabilityRecomputeService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bc-1',
    user_id: 'user-1',
    provider: 'checkr',
    check_id: 'bc_123_abc',
    status: 'PENDING',
    initiated_at: '2025-03-01',
    completed_at: null,
    expires_at: '2026-03-01',
    result_summary: null,
    details: null,
    reviewed_by: null,
    reviewed_at: null,
    notes: null,
    ...overrides,
  };
}

describe('BackgroundCheckService', () => {
  // --------------------------------------------------------------------------
  // initiateBackgroundCheck
  // --------------------------------------------------------------------------
  describe('initiateBackgroundCheck', () => {
    it('creates a new background check', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'consent-1', provider: 'checkr', disclosure_version: 'hx-worker-screening-rights-v1' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // No existing
        .mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never) // Insert
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // Event

      const result = await initiateBackgroundCheck({
        userId: 'user-1',
        provider: 'checkr',
        consentId: 'consent-1',
      });

      expect(result.id).toBe('bc-1');
      expect(result.status).toBe('PENDING');
    });

    it('throws CONFLICT when check in progress', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'consent-1', provider: 'checkr', disclosure_version: 'hx-worker-screening-rights-v1' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'bc-1', status: 'PENDING' }], rowCount: 1 } as never);

      await expect(initiateBackgroundCheck({
        userId: 'user-1',
        provider: 'checkr',
        consentId: 'consent-1',
      })).rejects.toThrow('already in progress');
    });

    it('throws CONFLICT when valid check on file', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'consent-1', provider: 'checkr', disclosure_version: 'hx-worker-screening-rights-v1' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'bc-1', status: 'CLEAR' }], rowCount: 1 } as never);

      await expect(initiateBackgroundCheck({
        userId: 'user-1',
        provider: 'checkr',
        consentId: 'consent-1',
      })).rejects.toThrow('already on file');
    });

    it('throws CONFLICT for IN_PROGRESS status', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ id: 'consent-1', provider: 'checkr', disclosure_version: 'hx-worker-screening-rights-v1' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ id: 'bc-1', status: 'IN_PROGRESS' }], rowCount: 1 } as never);

      await expect(initiateBackgroundCheck({
        userId: 'user-1',
        provider: 'checkr',
        consentId: 'consent-1',
      })).rejects.toThrow('already in progress');
    });

    it('fails closed without current provider-matched written consent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      await expect(initiateBackgroundCheck({
        userId: 'user-1', provider: 'checkr', consentId: 'missing-consent',
      })).rejects.toThrow('Current written screening consent is required');
    });
  });

  // --------------------------------------------------------------------------
  // updateBackgroundCheckStatus
  // --------------------------------------------------------------------------
  describe('updateBackgroundCheckStatus', () => {
    it('updates status to CLEAR and triggers capability recompute', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'CLEAR', completed_at: '2025-03-02' })],
        rowCount: 1,
      } as never);

      const result = await updateBackgroundCheckStatus('bc_123_abc', 'CLEAR', 'All clear');

      expect(result.status).toBe('CLEAR');
      expect(recomputeCapabilityProfile).toHaveBeenCalledWith('user-1', expect.objectContaining({ reason: 'background_check_cleared' }));
    });

    it('updates status to IN_PROGRESS without recompute', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'IN_PROGRESS' })],
        rowCount: 1,
      } as never);

      const result = await updateBackgroundCheckStatus('bc_123_abc', 'IN_PROGRESS');

      expect(result.status).toBe('IN_PROGRESS');
      expect(recomputeCapabilityProfile).not.toHaveBeenCalled();
    });

    it('updates to CONSIDER (requires manual review)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'CONSIDER', result_summary: 'Minor offense' })],
        rowCount: 1,
      } as never);

      const result = await updateBackgroundCheckStatus('bc_123_abc', 'CONSIDER', 'Minor offense');

      expect(result.status).toBe('CONSIDER');
    });

    it('throws NOT_FOUND when check not found', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await expect(updateBackgroundCheckStatus('nonexistent', 'CLEAR')).rejects.toThrow('not found');
    });
  });

  // --------------------------------------------------------------------------
  // reviewBackgroundCheck
  // --------------------------------------------------------------------------
  describe('reviewBackgroundCheck', () => {
    it('clears a CONSIDER check and triggers recompute', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'CLEAR', reviewed_by: 'admin-1' })],
        rowCount: 1,
      } as never);

      const result = await reviewBackgroundCheck('bc-1', 'admin-1', 'CLEAR', 'Reviewed and cleared');

      expect(result.status).toBe('CLEAR');
      expect(recomputeCapabilityProfile).toHaveBeenCalled();
    });

    it('blocks direct failure without pre-adverse rights', async () => {
      await expect(reviewBackgroundCheck('bc-1', 'admin-1', 'FAILED', 'Disqualifying offense'))
        .rejects.toThrow('report access, pre-adverse notice, review time, and dispute handling');
      expect(recomputeCapabilityProfile).not.toHaveBeenCalled();
      expect(mockDb.query).not.toHaveBeenCalled();
    });

    it('throws NOT_FOUND when check not found or not in CONSIDER status', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await expect(reviewBackgroundCheck('bc-x', 'admin-1', 'CLEAR')).rejects.toThrow('not found or not in CONSIDER status');
    });
  });

  // --------------------------------------------------------------------------
  // getUserBackgroundCheck
  // --------------------------------------------------------------------------
  describe('getUserBackgroundCheck', () => {
    it('returns most recent check', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);

      const result = await getUserBackgroundCheck('user-1');

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('checkr');
    });

    it('returns null when no check exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await getUserBackgroundCheck('user-1');

      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // hasValidBackgroundCheck
  // --------------------------------------------------------------------------
  describe('hasValidBackgroundCheck', () => {
    it('returns true when valid check exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never);

      expect(await hasValidBackgroundCheck('user-1')).toBe(true);
    });

    it('returns false when no valid check', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      expect(await hasValidBackgroundCheck('user-1')).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getPendingReviews
  // --------------------------------------------------------------------------
  describe('getPendingReviews', () => {
    it('returns CONSIDER checks for admin review', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'CONSIDER' })],
        rowCount: 1,
      } as never);

      const result = await getPendingReviews(50, 0);

      expect(result).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // getChecksByStatus
  // --------------------------------------------------------------------------
  describe('getChecksByStatus', () => {
    it('returns checks filtered by status', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'CLEAR' }), makeRow({ id: 'bc-2', status: 'CLEAR' })],
        rowCount: 2,
      } as never);

      const result = await getChecksByStatus('CLEAR');

      expect(result).toHaveLength(2);
    });
  });

  // --------------------------------------------------------------------------
  // markExpiredChecks
  // --------------------------------------------------------------------------
  describe('markExpiredChecks', () => {
    it('marks expired checks and recomputes capabilities', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'bc-1', user_id: 'user-1' }],
        rowCount: 1,
      } as never);

      const count = await markExpiredChecks();

      expect(count).toBe(1);
      expect(recomputeCapabilityProfile).toHaveBeenCalledWith('user-1', { reason: 'background_check_expired' });
    });

    it('returns 0 when nothing expired', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      expect(await markExpiredChecks()).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // getUpcomingExpirations
  // --------------------------------------------------------------------------
  describe('getUpcomingExpirations', () => {
    it('returns upcoming expirations', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'user-1', expires_at: '2025-04-01' }],
        rowCount: 1,
      } as never);

      const result = await getUpcomingExpirations(30);

      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('user-1');
    });
  });
});
