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
    mockDb.query.mockReset();
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
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: UUID1, worker_id: UUID1 }], rowCount: 1 } as any);
      mockInsurance.fileClaim.mockResolvedValue({ success: true, data: 'claim-1' } as any);

      const caller = makeCaller();
      const result = await caller.fileClaim({
        task_id: UUID2,
        claim_amount_cents: 10000,
        reason: 'Property damaged during task',
        evidence_urls: ['https://hustlexp.r2.cloudflarestorage.com/photo.jpg'],
      });

      expect(result.success).toBe(true);
      expect(result.claim_id).toBe('claim-1');
      expect(mockInsurance.fileClaim).toHaveBeenCalledWith(
        UUID2, UUID1, 10000, 'Property damaged during task', ['https://hustlexp.r2.cloudflarestorage.com/photo.jpg'],
      );
    });

    it('files claim with camelCase params', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: UUID1, worker_id: UUID1 }], rowCount: 1 } as any);
      mockInsurance.fileClaim.mockResolvedValue({ success: true, data: 'claim-2' } as any);

      const caller = makeCaller();
      const result = await caller.fileClaim({
        taskId: UUID2,
        requestedAmountCents: 5000,
        incidentDescription: 'Tool was broken',
        evidence_urls: ['https://hustlexp.r2.cloudflarestorage.com/evidence.jpg'],
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
      mockDb.query.mockResolvedValueOnce({ rows: [{ poster_id: UUID1, worker_id: UUID1 }], rowCount: 1 } as any);
      mockInsurance.fileClaim.mockResolvedValue({
        success: false,
        error: { message: 'Pool depleted' },
      } as any);

      const caller = makeCaller();
      await expect(caller.fileClaim({
        task_id: UUID2,
        claim_amount_cents: 500000,
        reason: 'Major damage occurred during task',
        evidence_urls: ['https://hustlexp.r2.cloudflarestorage.com/evidence.jpg'],
      })).rejects.toThrow('Pool depleted');
    });
  });

  // =========================================================================
  // reviewClaim (admin)
  // =========================================================================
  describe('reviewClaim', () => {
    it.each([true, false])('holds approved=%s before claim state can change', async (approved) => {
      await expect(makeAdminCaller().reviewClaim({
        claim_id: UUID2,
        approved,
        review_notes: 'Claim decisions require a separately approved authority command.',
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(mockInsurance.reviewClaim).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // payClaim (admin)
  // =========================================================================
  describe('payClaim', () => {
    it('holds payout and replay paths before the insurance service can create a value effect', async () => {
      await expect(makeAdminCaller().payClaim({ claim_id: UUID2 }))
        .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(mockInsurance.payClaim).not.toHaveBeenCalled();
    });
  });
});
