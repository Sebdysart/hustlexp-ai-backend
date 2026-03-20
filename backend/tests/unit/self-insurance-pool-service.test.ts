/**
 * SelfInsurancePoolService Unit Tests
 *
 * Tests contribution calculation, recording, claim filing,
 * claim review, claim payment, pool status, and user claims.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      // F-16 FIX: recordContribution now wraps INSERT+UPDATE in db.transaction.
      // Delegate to the callback with the same queryFn so mockResolvedValueOnce
      // sequences work seamlessly inside transactions.
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
  };
});

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
  },
}));

import { db } from '../../src/db';
import { SelfInsurancePoolService } from '../../src/services/SelfInsurancePoolService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.resetAllMocks();
  // Re-bind transaction mock after resetAllMocks() wipes the implementation
  mockDb.transaction.mockImplementation(async (fn: (q: typeof mockDb.query) => Promise<unknown>) => fn(mockDb.query));
});

function makePoolRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pool-1',
    total_deposits_cents: 100000,
    total_claims_cents: 20000,
    available_balance_cents: 80000,
    coverage_percentage: 80,
    max_claim_cents: 500000,
    updated_at: new Date(),
    ...overrides,
  };
}

function makeClaimRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'claim-1',
    task_id: 'task-1',
    hustler_id: 'hustler-1',
    claim_amount_cents: 25000,
    status: 'pending',
    claim_reason: 'Tool damage',
    evidence_urls: ['https://r2.dev/evidence1.jpg'],
    reviewed_by: null,
    reviewed_at: null,
    review_notes: null,
    paid_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

describe('SelfInsurancePoolService', () => {
  // --------------------------------------------------------------------------
  // calculateContribution
  // --------------------------------------------------------------------------
  describe('calculateContribution', () => {
    it('calculates 2% contribution by default', () => {
      expect(SelfInsurancePoolService.calculateContribution(10000)).toBe(200);
    });

    it('rounds to nearest cent', () => {
      expect(SelfInsurancePoolService.calculateContribution(333)).toBe(7);
    });

    it('accepts custom percentage', () => {
      expect(SelfInsurancePoolService.calculateContribution(10000, 5.0)).toBe(500);
    });

    it('returns 0 for zero price', () => {
      expect(SelfInsurancePoolService.calculateContribution(0)).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // recordContribution
  // --------------------------------------------------------------------------
  describe('recordContribution', () => {
    it('records contribution and updates pool', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // INSERT contribution
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE pool

      const result = await SelfInsurancePoolService.recordContribution('task-1', 'hustler-1', 200);

      expect(result.success).toBe(true);
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('is idempotent (ON CONFLICT DO NOTHING)', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // ON CONFLICT → no insert
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE pool still runs

      const result = await SelfInsurancePoolService.recordContribution('task-1', 'hustler-1', 200);

      expect(result.success).toBe(true);
    });

    it('returns error on DB failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection lost'));

      const result = await SelfInsurancePoolService.recordContribution('task-1', 'hustler-1', 200);

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('RECORD_CONTRIBUTION_FAILED');
    });
  });

  // --------------------------------------------------------------------------
  // fileClaim
  // --------------------------------------------------------------------------
  describe('fileClaim', () => {
    it('files a claim successfully', async () => {
      // getPoolStatus
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never);
      // INSERT claim
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'claim-1' }], rowCount: 1 } as never);

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 25000, 'Tool damage', ['https://r2.dev/evidence.jpg']
      );

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe('claim-1');
    });

    it('rejects claim exceeding max amount', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makePoolRow({ max_claim_cents: 500000 })],
        rowCount: 1,
      } as never);

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 600000, 'Major damage', []
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CLAIM_EXCEEDS_MAX');
    });

    it('handles pool status failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('db error'));

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 25000, 'Damage', []
      );

      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // reviewClaim
  // --------------------------------------------------------------------------
  describe('reviewClaim', () => {
    it('approves a claim', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await SelfInsurancePoolService.reviewClaim('claim-1', 'admin-1', true, 'Valid claim');

      expect(result.success).toBe(true);
      const params = mockDb.query.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe('approved');
    });

    it('denies a claim', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await SelfInsurancePoolService.reviewClaim('claim-1', 'admin-1', false, 'Insufficient evidence');

      expect(result.success).toBe(true);
      const params = mockDb.query.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe('denied');
    });

    it('returns error on failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('update failed'));

      const result = await SelfInsurancePoolService.reviewClaim('claim-1', 'admin-1', true, 'ok');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('REVIEW_CLAIM_FAILED');
    });
  });

  // --------------------------------------------------------------------------
  // payClaim
  // --------------------------------------------------------------------------
  describe('payClaim', () => {
    it('returns CLAIM_NOT_FOUND when claim does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await SelfInsurancePoolService.payClaim('claim-x');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CLAIM_NOT_FOUND');
    });

    it('returns CLAIM_NOT_APPROVED when claim not approved', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeClaimRow({ status: 'pending' })],
        rowCount: 1,
      } as never);

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CLAIM_NOT_APPROVED');
    });

    it('returns INSUFFICIENT_POOL_BALANCE when pool too low', async () => {
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 100000 })],
          rowCount: 1,
        } as never) // claim
        .mockResolvedValueOnce({ rows: [{ coverage_percentage: 80 }], rowCount: 1 } as never) // coverage% - NEW
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 1000 }], rowCount: 1 } as never); // pool FOR UPDATE

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INSUFFICIENT_POOL_BALANCE');
    });

    it('pays claim successfully (no Stripe key)', async () => {
      const originalKey = process.env.STRIPE_SECRET_KEY;
      delete process.env.STRIPE_SECRET_KEY;

      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 10000 })],
          rowCount: 1,
        } as never) // claim
        .mockResolvedValueOnce({ rows: [{ coverage_percentage: 80 }], rowCount: 1 } as never) // coverage% - NEW
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 50000 }], rowCount: 1 } as never) // pool FOR UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE pool
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE claim to paid

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(true);
      if (originalKey) process.env.STRIPE_SECRET_KEY = originalKey;
    });
  });

  // --------------------------------------------------------------------------
  // getPoolStatus
  // --------------------------------------------------------------------------
  describe('getPoolStatus', () => {
    it('returns pool status', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never);

      const result = await SelfInsurancePoolService.getPoolStatus();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total_deposits_cents).toBe(100000);
        expect(result.data.coverage_percentage).toBe(80);
      }
    });

    it('returns defaults when pool not initialized', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await SelfInsurancePoolService.getPoolStatus();

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.total_deposits_cents).toBe(0);
        expect(result.data.coverage_percentage).toBe(80);
        expect(result.data.max_claim_cents).toBe(500000);
      }
    });

    it('returns error on DB failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('timeout'));

      const result = await SelfInsurancePoolService.getPoolStatus();

      expect(result.success).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getMyClaims
  // --------------------------------------------------------------------------
  describe('getMyClaims', () => {
    it('returns user claims', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [makeClaimRow(), makeClaimRow({ id: 'claim-2' })],
        rowCount: 2,
      } as never);

      const result = await SelfInsurancePoolService.getMyClaims('hustler-1');

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toHaveLength(2);
    });

    it('returns empty array when no claims', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await SelfInsurancePoolService.getMyClaims('hustler-1');

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toEqual([]);
    });

    it('returns error on DB failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection error'));

      const result = await SelfInsurancePoolService.getMyClaims('hustler-1');

      expect(result.success).toBe(false);
    });
  });
});
