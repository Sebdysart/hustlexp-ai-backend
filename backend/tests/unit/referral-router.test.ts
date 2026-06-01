/**
 * Referral Router Unit Tests
 *
 * Tests all protected procedures:
 * - getOrCreateCode (mutation)
 * - redeemCode (mutation)
 * - getReferralStats (query)
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
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { referralRouter } from '../../src/routers/referral';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';

function makeCaller(userId = UUID1) {
  return referralRouter.createCaller({
    user: { id: userId, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1', default_mode: 'worker' } as any,
    firebaseUid: 'fb-1',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('referral router', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // getOrCreateCode
  // =========================================================================
  describe('getOrCreateCode', () => {
    it('returns existing code with stats', async () => {
      // Existing code query
      mockDb.query.mockResolvedValueOnce({
        rows: [{ code: 'HXABC123', uses_count: 5 }],
        rowCount: 1,
      } as any);
      // Earned query
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total: '2500' }],
        rowCount: 1,
      } as any);

      const caller = makeCaller();
      const result = await caller.getOrCreateCode();

      expect(result.code).toBe('HXABC123');
      expect(result.usesCount).toBe(5);
      expect(result.totalEarnedCents).toBe(2500);
    });

    it('creates new code when none exists', async () => {
      // Existing code query: none found
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Insert succeeds
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.getOrCreateCode();

      expect(result.code).toMatch(/^HX/);
      expect(result.usesCount).toBe(0);
      expect(result.totalEarnedCents).toBe(0);
    });

    it('retries on unique constraint violation when creating code', async () => {
      // Existing code query: none
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // First insert fails (unique violation)
      mockDb.query.mockRejectedValueOnce(new Error('unique_violation'));
      // Second insert succeeds
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.getOrCreateCode();

      expect(result.code).toMatch(/^HX/);
      expect(mockDb.query).toHaveBeenCalledTimes(3);
    });
  });

  // =========================================================================
  // redeemCode
  // =========================================================================
  describe('redeemCode', () => {
    it('redeems code successfully', async () => {
      // Already referred check: not referred
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Find code
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'code-id', user_id: UUID2 }],
        rowCount: 1,
      } as any);
      // Insert redemption
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
      // Increment uses count
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

      const caller = makeCaller();
      const result = await caller.redeemCode({ code: 'HXABC123' });

      expect(result.success).toBe(true);
      expect(result.message).toContain('first task');
    });

    it('throws BAD_REQUEST when already referred', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'existing-redemption' }],
        rowCount: 1,
      } as any);

      const caller = makeCaller();
      await expect(caller.redeemCode({ code: 'HXABC123' }))
        .rejects.toThrow('Already used a referral code');
    });

    it('throws NOT_FOUND when code is invalid', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      await expect(caller.redeemCode({ code: 'INVALID' }))
        .rejects.toThrow('Invalid referral code');
    });

    it('throws BAD_REQUEST when using own referral code', async () => {
      // Not already referred
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Code belongs to same user
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'code-id', user_id: UUID1 }],
        rowCount: 1,
      } as any);

      const caller = makeCaller();
      await expect(caller.redeemCode({ code: 'MYCODE' }))
        .rejects.toThrow('Cannot use your own referral code');
    });

    it('converts code to uppercase before lookup', async () => {
      // Not referred
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Code lookup
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const caller = makeCaller();
      try {
        await caller.redeemCode({ code: 'hxabc123' });
      } catch {
        // Expected to throw NOT_FOUND
      }

      const codeQuery = (mockDb.query as any).mock.calls[1];
      expect(codeQuery[1]).toContain('HXABC123');
    });
  });

  // =========================================================================
  // getReferralStats
  // =========================================================================
  describe('getReferralStats', () => {
    it('returns referral stats', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total_referrals: '10', qualified_referrals: '7', total_earned: '3500' }],
        rowCount: 1,
      } as any);

      const caller = makeCaller();
      const result = await caller.getReferralStats();

      expect(result).toEqual({
        totalReferrals: 10,
        qualifiedReferrals: 7,
        totalEarnedCents: 3500,
      });
    });

    it('returns zero stats when no referrals', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ total_referrals: '0', qualified_referrals: '0', total_earned: '0' }],
        rowCount: 1,
      } as any);

      const caller = makeCaller();
      const result = await caller.getReferralStats();

      expect(result).toEqual({
        totalReferrals: 0,
        qualifiedReferrals: 0,
        totalEarnedCents: 0,
      });
    });
  });
});
