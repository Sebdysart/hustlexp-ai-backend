/**
 * InsuranceVerificationService Unit Tests
 *
 * Tests insurance submission, approval, rejection, queries,
 * expiration marking, and upcoming expirations.
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
  submitInsurance,
  approveInsurance,
  rejectInsurance,
  getUserInsurance,
  hasValidInsurance,
  getPendingVerifications,
  markExpiredInsurance,
  getUpcomingExpirations,
} from '../../src/services/InsuranceVerificationService';
import { recomputeCapabilityProfile } from '../../src/services/CapabilityRecomputeService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ins-1',
    user_id: 'user-1',
    provider: 'StateFarm',
    policy_number: 'POL-123',
    coverage_amount_cents: 100000000,
    expiration_date: '2027-01-01',
    document_url: null,
    status: 'PENDING',
    submitted_at: '2025-03-01',
    reviewed_at: null,
    reviewed_by: null,
    rejection_reason: null,
    notes: null,
    ...overrides,
  };
}

describe('InsuranceVerificationService', () => {
  // --------------------------------------------------------------------------
  // submitInsurance
  // --------------------------------------------------------------------------
  describe('submitInsurance', () => {
    it('creates a new insurance verification', async () => {
      // No existing verification
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Insert
      mockDb.query.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);

      const result = await submitInsurance({
        userId: 'user-1',
        provider: 'StateFarm',
        policyNumber: 'POL-123',
        coverageAmount: 1_000_000,
        expirationDate: '2027-01-01',
      });

      expect(result.id).toBe('ins-1');
      expect(result.status).toBe('PENDING');
    });

    it('throws CONFLICT when pending verification exists', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ins-1', status: 'PENDING' }],
        rowCount: 1,
      } as never);

      await expect(submitInsurance({
        userId: 'user-1',
        provider: 'StateFarm',
        policyNumber: 'POL-123',
        coverageAmount: 1_000_000,
        expirationDate: '2027-01-01',
      })).rejects.toThrow('Insurance verification already pending');
    });

    it('throws CONFLICT when approved verification exists', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ins-1', status: 'APPROVED' }],
        rowCount: 1,
      } as never);

      await expect(submitInsurance({
        userId: 'user-1',
        provider: 'StateFarm',
        policyNumber: 'POL-123',
        coverageAmount: 1_000_000,
        expirationDate: '2027-01-01',
      })).rejects.toThrow('Valid insurance already on file');
    });

    it('throws BAD_REQUEST when coverage below $500K', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await expect(submitInsurance({
        userId: 'user-1',
        provider: 'StateFarm',
        policyNumber: 'POL-123',
        coverageAmount: 100_000,
        expirationDate: '2027-01-01',
      })).rejects.toThrow('Coverage amount must be at least');
    });
  });

  // --------------------------------------------------------------------------
  // approveInsurance
  // --------------------------------------------------------------------------
  describe('approveInsurance', () => {
    it('approves a pending verification', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'APPROVED', reviewed_by: 'admin-1' })],
        rowCount: 1,
      } as never);

      const result = await approveInsurance('ins-1', 'admin-1', 'Looks good');

      expect(result.status).toBe('APPROVED');
      expect(recomputeCapabilityProfile).toHaveBeenCalledWith('user-1', expect.objectContaining({ reason: 'insurance_approved' }));
    });

    it('throws NOT_FOUND when verification not found or not pending', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await expect(approveInsurance('ins-x', 'admin-1')).rejects.toThrow('not found or not in PENDING status');
    });
  });

  // --------------------------------------------------------------------------
  // rejectInsurance
  // --------------------------------------------------------------------------
  describe('rejectInsurance', () => {
    it('rejects a pending verification', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'REJECTED', rejection_reason: 'Expired policy' })],
        rowCount: 1,
      } as never);

      const result = await rejectInsurance('ins-1', 'admin-1', 'Expired policy');

      expect(result.status).toBe('REJECTED');
      expect(result.rejectionReason).toBe('Expired policy');
    });

    it('throws NOT_FOUND when verification not found or not pending', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await expect(rejectInsurance('ins-x', 'admin-1', 'Bad')).rejects.toThrow('not found or not in PENDING status');
    });
  });

  // --------------------------------------------------------------------------
  // getUserInsurance
  // --------------------------------------------------------------------------
  describe('getUserInsurance', () => {
    it('returns most recent verification', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);

      const result = await getUserInsurance('user-1');

      expect(result).not.toBeNull();
      expect(result!.provider).toBe('StateFarm');
    });

    it('returns null when no verification exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await getUserInsurance('user-1');

      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // hasValidInsurance
  // --------------------------------------------------------------------------
  describe('hasValidInsurance', () => {
    it('returns true when approved non-expired insurance exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never);

      const result = await hasValidInsurance('user-1');

      expect(result).toBe(true);
    });

    it('returns false when no valid insurance', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await hasValidInsurance('user-1');

      expect(result).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getPendingVerifications
  // --------------------------------------------------------------------------
  describe('getPendingVerifications', () => {
    it('returns pending verifications with pagination', async () => {
      const rows = [makeRow(), makeRow({ id: 'ins-2', user_id: 'user-2' })];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as never);

      const result = await getPendingVerifications(50, 0);

      expect(result).toHaveLength(2);
    });

    it('returns empty array when none pending', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await getPendingVerifications();

      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // markExpiredInsurance
  // --------------------------------------------------------------------------
  describe('markExpiredInsurance', () => {
    it('marks expired policies and recomputes capabilities', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { id: 'ins-1', user_id: 'user-1' },
          { id: 'ins-2', user_id: 'user-2' },
        ],
        rowCount: 2,
      } as never);

      const count = await markExpiredInsurance();

      expect(count).toBe(2);
      expect(recomputeCapabilityProfile).toHaveBeenCalledTimes(2);
      expect(recomputeCapabilityProfile).toHaveBeenCalledWith('user-1', { reason: 'insurance_expired' });
      expect(recomputeCapabilityProfile).toHaveBeenCalledWith('user-2', { reason: 'insurance_expired' });
    });

    it('returns 0 when nothing expired', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const count = await markExpiredInsurance();

      expect(count).toBe(0);
      expect(recomputeCapabilityProfile).not.toHaveBeenCalled();
    });

    it('deduplicates users when multiple policies expire', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [
          { id: 'ins-1', user_id: 'user-1' },
          { id: 'ins-2', user_id: 'user-1' }, // same user
        ],
        rowCount: 2,
      } as never);

      await markExpiredInsurance();

      // Only called once for user-1 (deduped via Set)
      expect(recomputeCapabilityProfile).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // getUpcomingExpirations
  // --------------------------------------------------------------------------
  describe('getUpcomingExpirations', () => {
    it('returns upcoming expirations', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ user_id: 'user-1', expiration_date: '2025-04-01' }],
        rowCount: 1,
      } as never);

      const result = await getUpcomingExpirations(30);

      expect(result).toHaveLength(1);
      expect(result[0].userId).toBe('user-1');
    });

    it('returns empty array when no upcoming expirations', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await getUpcomingExpirations();

      expect(result).toEqual([]);
    });
  });
});
