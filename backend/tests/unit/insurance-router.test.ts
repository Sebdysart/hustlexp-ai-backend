/**
 * Insurance Router Unit Tests
 *
 * Tests all procedures:
 * - getPoolStatus (protected), getMyClaims (protected), fileClaim (protected)
 * - reviewClaim (admin), payClaim (admin)
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

vi.mock('../../src/services/SelfInsurancePoolService', () => ({
  SelfInsurancePoolService: {
    getPoolStatus: vi.fn(),
    getMyClaims: vi.fn(),
    fileClaim: vi.fn(),
    reviewClaim: vi.fn(),
    payClaim: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { insuranceRouter } from '../../src/routers/insurance';
import { SelfInsurancePoolService } from '../../src/services/SelfInsurancePoolService';

const mockDb = vi.mocked(db);
const mockInsurance = vi.mocked(SelfInsurancePoolService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';

function makeCaller() {
  return insuranceRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1', default_mode: 'worker' } as any,
    firebaseUid: 'fb-1',
  });
}

function makeAdminCaller() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return insuranceRouter.createCaller({
    user: { id: UUID1, email: 'admin@test.com', full_name: 'Admin', role: 'admin', firebase_uid: 'fb-admin' } as any,
    firebaseUid: 'fb-admin',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('insurance router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // getPoolStatus
  // =========================================================================
  describe('getPoolStatus', () => {
    it('returns pool status on success', async () => {
      const data = { balance_cents: 50000, total_contributions: 100 };
      mockInsurance.getPoolStatus.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.getPoolStatus();

      expect(result).toEqual(data);
    });

    it('throws on failure', async () => {
      mockInsurance.getPoolStatus.mockResolvedValue({
        success: false,
        error: { message: 'Pool error' },
      } as any);

      const caller = makeCaller();
      await expect(caller.getPoolStatus()).rejects.toThrow('Pool error');
    });
  });

  // =========================================================================
  // getMyClaims
  // =========================================================================
  describe('getMyClaims', () => {
    it('returns user claims', async () => {
      const data = [{ id: 'claim-1', status: 'pending' }];
      mockInsurance.getMyClaims.mockResolvedValue({ success: true, data } as any);

      const caller = makeCaller();
      const result = await caller.getMyClaims();

      expect(result).toEqual(data);
      expect(mockInsurance.getMyClaims).toHaveBeenCalledWith(UUID1);
    });
  });

  // =========================================================================
  // fileClaim
  // =========================================================================
  describe('fileClaim', () => {
    it('files claim with snake_case params', async () => {
      mockInsurance.fileClaim.mockResolvedValue({ success: true, data: 'claim-1' } as any);

      const caller = makeCaller();
      const result = await caller.fileClaim({
        task_id: UUID2,
        claim_amount_cents: 10000,
        reason: 'Property damaged during task',
        evidence_urls: ['https://example.com/photo.jpg'],
      });

      expect(result.success).toBe(true);
      expect(result.claim_id).toBe('claim-1');
      expect(mockInsurance.fileClaim).toHaveBeenCalledWith(
        UUID2, UUID1, 10000, 'Property damaged during task', ['https://example.com/photo.jpg'],
      );
    });

    it('files claim with camelCase params', async () => {
      mockInsurance.fileClaim.mockResolvedValue({ success: true, data: 'claim-2' } as any);

      const caller = makeCaller();
      const result = await caller.fileClaim({
        taskId: UUID2,
        requestedAmountCents: 5000,
        incidentDescription: 'Tool was broken',
      });

      expect(result.success).toBe(true);
      expect(result.claim_id).toBe('claim-2');
    });

    it('throws BAD_REQUEST when missing required fields', async () => {
      const caller = makeCaller();
      await expect(caller.fileClaim({}))
        .rejects.toThrow('taskId, amount, and reason are required');
    });

    it('throws on service failure', async () => {
      mockInsurance.fileClaim.mockResolvedValue({
        success: false,
        error: { message: 'Pool depleted' },
      } as any);

      const caller = makeCaller();
      await expect(caller.fileClaim({
        task_id: UUID2,
        claim_amount_cents: 500000,
        reason: 'Major damage occurred during task',
      })).rejects.toThrow('Pool depleted');
    });
  });

  // =========================================================================
  // reviewClaim (admin)
  // =========================================================================
  describe('reviewClaim', () => {
    it('approves claim and returns success', async () => {
      mockInsurance.reviewClaim.mockResolvedValue({ success: true, data: true } as any);

      const caller = makeAdminCaller();
      const result = await caller.reviewClaim({
        claim_id: UUID2,
        approved: true,
        review_notes: 'Looks legitimate and well documented',
      });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Claim approved');
    });

    it('denies claim and returns message', async () => {
      mockInsurance.reviewClaim.mockResolvedValue({ success: true, data: true } as any);

      const caller = makeAdminCaller();
      const result = await caller.reviewClaim({
        claim_id: UUID2,
        approved: false,
        review_notes: 'Insufficient evidence provided for claim',
      });

      expect(result.message).toBe('Claim denied');
    });

    it('throws on service failure', async () => {
      mockInsurance.reviewClaim.mockResolvedValue({
        success: false,
        error: { message: 'Claim not found' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.reviewClaim({
        claim_id: UUID2,
        approved: true,
        review_notes: 'Claim review notes here',
      })).rejects.toThrow('Claim not found');
    });
  });

  // =========================================================================
  // payClaim (admin)
  // =========================================================================
  describe('payClaim', () => {
    it('pays claim on success', async () => {
      mockInsurance.payClaim.mockResolvedValue({ success: true, data: true } as any);

      const caller = makeAdminCaller();
      const result = await caller.payClaim({ claim_id: UUID2 });

      expect(result.success).toBe(true);
      expect(result.message).toBe('Claim paid successfully');
    });

    it('throws on failure', async () => {
      mockInsurance.payClaim.mockResolvedValue({
        success: false,
        error: { message: 'Insufficient funds' },
      } as any);

      const caller = makeAdminCaller();
      await expect(caller.payClaim({ claim_id: UUID2 }))
        .rejects.toThrow('Insufficient funds');
    });
  });
});
