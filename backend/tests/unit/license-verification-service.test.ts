/**
 * LicenseVerificationService Unit Tests
 *
 * Tests license submission, approval, rejection, queries,
 * reciprocity checking, and expiration marking.
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
  submitLicense,
  approveLicense,
  rejectLicense,
  getUserLicenses,
  getPendingVerifications,
  hasValidLicense,
  markExpiredLicenses,
} from '../../src/services/LicenseVerificationService';
import { recomputeCapabilityProfile } from '../../src/services/CapabilityRecomputeService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
});

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lic-1',
    user_id: 'user-1',
    trade_type: 'electrician',
    issuing_state: 'CA',
    license_number: 'LIC-001',
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

describe('LicenseVerificationService', () => {
  // --------------------------------------------------------------------------
  // submitLicense
  // --------------------------------------------------------------------------
  describe('submitLicense', () => {
    it('creates a new license verification', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // No existing
        .mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never); // Insert

      const result = await submitLicense({
        userId: 'user-1',
        tradeType: 'electrician',
        issuingState: 'CA',
        licenseNumber: 'LIC-001',
      });

      expect(result.id).toBe('lic-1');
      expect(result.tradeType).toBe('electrician');
    });

    it('throws BAD_REQUEST for invalid trade type', async () => {
      await expect(submitLicense({
        userId: 'user-1',
        tradeType: 'juggler',
        issuingState: 'CA',
        licenseNumber: 'LIC-001',
      })).rejects.toThrow('does not require licensing');
    });

    it('throws CONFLICT when pending license exists', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'lic-1', status: 'PENDING' }],
        rowCount: 1,
      } as never);

      await expect(submitLicense({
        userId: 'user-1',
        tradeType: 'electrician',
        issuingState: 'CA',
        licenseNumber: 'LIC-001',
      })).rejects.toThrow('already pending');
    });

    it('throws CONFLICT when approved license exists', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'lic-1', status: 'APPROVED' }],
        rowCount: 1,
      } as never);

      await expect(submitLicense({
        userId: 'user-1',
        tradeType: 'electrician',
        issuingState: 'CA',
        licenseNumber: 'LIC-001',
      })).rejects.toThrow('already verified');
    });
  });

  // --------------------------------------------------------------------------
  // approveLicense
  // --------------------------------------------------------------------------
  describe('approveLicense', () => {
    it('approves a pending license', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'APPROVED', reviewed_by: 'admin-1' })],
        rowCount: 1,
      } as never);

      const result = await approveLicense('lic-1', 'admin-1');

      expect(result.status).toBe('APPROVED');
      expect(recomputeCapabilityProfile).toHaveBeenCalledWith('user-1', expect.objectContaining({ reason: 'license_approved' }));
    });

    it('throws NOT_FOUND when not found or not pending', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await expect(approveLicense('lic-x', 'admin-1')).rejects.toThrow('not found or not in PENDING status');
    });
  });

  // --------------------------------------------------------------------------
  // rejectLicense
  // --------------------------------------------------------------------------
  describe('rejectLicense', () => {
    it('rejects a pending license', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow({ status: 'REJECTED', rejection_reason: 'Fake license' })],
        rowCount: 1,
      } as never);

      const result = await rejectLicense('lic-1', 'admin-1', 'Fake license');

      expect(result.status).toBe('REJECTED');
    });

    it('throws NOT_FOUND when not pending', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await expect(rejectLicense('lic-x', 'admin-1', 'Bad')).rejects.toThrow('not found or not in PENDING status');
    });
  });

  // --------------------------------------------------------------------------
  // getUserLicenses
  // --------------------------------------------------------------------------
  describe('getUserLicenses', () => {
    it('returns all licenses for a user', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeRow(), makeRow({ id: 'lic-2', trade_type: 'plumber' })],
        rowCount: 2,
      } as never);

      const result = await getUserLicenses('user-1');

      expect(result).toHaveLength(2);
    });

    it('returns empty array when no licenses', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await getUserLicenses('user-1');

      expect(result).toEqual([]);
    });
  });

  // --------------------------------------------------------------------------
  // getPendingVerifications
  // --------------------------------------------------------------------------
  describe('getPendingVerifications', () => {
    it('returns pending verifications', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeRow()], rowCount: 1 } as never);

      const result = await getPendingVerifications(50, 0);

      expect(result).toHaveLength(1);
    });
  });

  // --------------------------------------------------------------------------
  // hasValidLicense
  // --------------------------------------------------------------------------
  describe('hasValidLicense', () => {
    it('returns true when direct license exists', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never);

      const result = await hasValidLicense('user-1', 'electrician', 'CA');

      expect(result).toBe(true);
    });

    it('checks reciprocity when direct license not found', async () => {
      // Direct check returns nothing
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Reciprocity check (CA has reciprocity with NV, AZ)
      mockDb.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }], rowCount: 1 } as never);

      const result = await hasValidLicense('user-1', 'electrician', 'CA');

      expect(result).toBe(true);
    });

    it('returns false when no license and no reciprocity', async () => {
      // Direct check returns nothing
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Reciprocity check returns nothing
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await hasValidLicense('user-1', 'electrician', 'CA');

      expect(result).toBe(false);
    });

    it('returns false immediately for states with no reciprocity agreements', async () => {
      // Direct check returns nothing
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await hasValidLicense('user-1', 'electrician', 'WA');

      expect(result).toBe(false);
      // Only 1 query (no reciprocity query for WA since it has no agreements)
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // markExpiredLicenses
  // --------------------------------------------------------------------------
  describe('markExpiredLicenses', () => {
    it('marks expired licenses and recomputes capabilities', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'lic-1', user_id: 'user-1' }],
        rowCount: 1,
      } as never);

      const count = await markExpiredLicenses();

      expect(count).toBe(1);
      expect(recomputeCapabilityProfile).toHaveBeenCalledWith('user-1', { reason: 'license_expired' });
    });

    it('returns 0 when nothing expired', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const count = await markExpiredLicenses();

      expect(count).toBe(0);
    });
  });
});
