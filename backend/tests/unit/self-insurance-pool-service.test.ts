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
import { StripeService } from '../../src/services/StripeService.js';

vi.mock('../../src/services/StripeService.js', () => ({
  StripeService: {
    createTransfer: vi.fn().mockResolvedValue({ success: true, data: { transferId: 'tr_test', amount: 8000 } }),
  },
}));

const mockDb = vi.mocked(db);
const mockStripe = vi.mocked(StripeService);

beforeEach(() => {
  vi.resetAllMocks();
  // Re-bind transaction mock after resetAllMocks() wipes the implementation
  mockDb.transaction.mockImplementation(async (fn: (q: typeof mockDb.query) => Promise<unknown>) => fn(mockDb.query));
  // Re-bind Stripe mock default after resetAllMocks() wipes the implementation.
  // Tests that need Stripe to throw or return failure must override this with mockResolvedValueOnce/mockRejectedValueOnce.
  mockStripe.createTransfer.mockResolvedValue({ success: true, data: { transferId: 'tr_test', amount: 8000 } } as any);
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
      // F-28: INSERT+UPDATE merged into a single CTE query
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // CTE: INSERT + conditional UPDATE

      const result = await SelfInsurancePoolService.recordContribution('task-1', 'hustler-1', 200);

      expect(result.success).toBe(true);
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('is idempotent (ON CONFLICT DO NOTHING)', async () => {
      // F-28: single CTE; if ON CONFLICT fires, the UPDATE is skipped inside PostgreSQL
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // CTE: conflict → no update

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
      // F-02 FIX: fileClaim now wraps the balance check + INSERT in a transaction.
      // F49-7 FIX: duplicate check moved INSIDE the transaction (FOR UPDATE).
      // F58-3 FIX: pool balance debited inside transaction to prevent concurrent over-commitment.
      // Sequence:
      //   0. getPoolStatus (outer db.query — reads pool config)
      //   Inside db.transaction:
      //     1. SELECT duplicate check FOR UPDATE (no existing claim)
      //     2. SELECT available_balance_cents, coverage_percentage FOR UPDATE (pool lock)
      //     3. UPDATE self_insurance_pool SET total_claims_cents += coveredAmount (F58-3 reservation)
      //     4. INSERT insurance_claims RETURNING id
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never); // getPoolStatus
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // F49-7 duplicate check FOR UPDATE — no existing claim
      mockDb.query.mockResolvedValueOnce({ rows: [{ available_balance_cents: 80000, coverage_percentage: 80 }], rowCount: 1 } as never); // FOR UPDATE lock
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE pool (F58-3 reservation)
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'claim-1' }], rowCount: 1 } as never); // INSERT

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 25000, 'Tool damage', ['https://r2.dev/evidence.jpg']
      );

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe('claim-1');
    });

    it('returns CLAIM_ALREADY_EXISTS when a pending claim already exists', async () => {
      // F49-7 FIX: duplicate guard now fires INSIDE the transaction (FOR UPDATE).
      // getPoolStatus runs first (outer db.query), then the transaction starts and
      // the duplicate check finds an existing claim — throws CLAIM_ALREADY_EXISTS.
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never); // getPoolStatus
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'claim-existing' }], rowCount: 1 } as never); // duplicate check FOR UPDATE — existing pending claim

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 25000, 'Tool damage', []
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CLAIM_ALREADY_EXISTS');
      // getPoolStatus + duplicate check = 2 db.query calls total
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });

    it('allows filing claim when previous claim was rejected', async () => {
      // F49-7 FIX: duplicate check now runs inside the transaction (FOR UPDATE).
      // Rejected row does not count — the query filters status NOT IN ('rejected', 'withdrawn').
      // F58-3 FIX: pool reservation UPDATE added to transaction.
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never); // getPoolStatus
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // F49-7 duplicate check FOR UPDATE — no non-rejected/non-withdrawn claim
      mockDb.query.mockResolvedValueOnce({ rows: [{ available_balance_cents: 80000, coverage_percentage: 80 }], rowCount: 1 } as never); // FOR UPDATE lock
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE pool (F58-3 reservation)
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'claim-new' }], rowCount: 1 } as never); // INSERT

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 25000, 'Tool damage', []
      );

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe('claim-new');
    });

    it('files claim successfully even when covered amount exceeds max_claim_cents (F51-5: CLAIM_EXCEEDS_MAX deferred to payClaim)', async () => {
      // F51-5 FIX: The pre-flight CLAIM_EXCEEDS_MAX check has been removed from fileClaim.
      // The reliable in-transaction check in payClaim (under FOR UPDATE) handles the cap.
      // fileClaim now only checks INSUFFICIENT_POOL_BALANCE (live balance vs covered amount).
      // 700000 * 80% = 560000 — if pool balance >= 560000, the claim is filed successfully.
      // F58-3 FIX: pool reservation UPDATE added to transaction.
      mockDb.query
        .mockResolvedValueOnce({ rows: [makePoolRow({ max_claim_cents: 500000, coverage_percentage: 80, available_balance_cents: 1000000 })], rowCount: 1 } as never) // getPoolStatus
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // duplicate check FOR UPDATE — no existing claim
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 1000000, coverage_percentage: 80 }], rowCount: 1 } as never) // FOR UPDATE lock
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE pool (F58-3 reservation)
        .mockResolvedValueOnce({ rows: [{ id: 'claim-1' }], rowCount: 1 } as never); // INSERT

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 700000, 'Major damage', []
      );

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe('claim-1');
    });

    it('allows claim where raw amount > max but covered amount <= max (F47-6)', async () => {
      // F47-6 FIX: 600000 raw, 80% coverage → estimatedCoveredCents = 480000 < 500000 max
      // Old bug: would have rejected this because 600000 > 500000.
      // New behavior: pre-flight passes; subsequent balance check inside transaction is the gate.
      // F49-7 FIX: duplicate check now runs inside transaction (no pre-flight db.query).
      // F58-3 FIX: pool reservation UPDATE added to transaction.
      mockDb.query
        .mockResolvedValueOnce({ rows: [makePoolRow({ max_claim_cents: 500000, coverage_percentage: 80, available_balance_cents: 1000000 })], rowCount: 1 } as never) // getPoolStatus
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // F49-7 duplicate check FOR UPDATE — no existing claim
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 1000000, coverage_percentage: 80 }], rowCount: 1 } as never) // FOR UPDATE lock
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE pool (F58-3 reservation)
        .mockResolvedValueOnce({ rows: [{ id: 'claim-2' }], rowCount: 1 } as never); // INSERT

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 600000, 'Major damage', []
      );

      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBe('claim-2');
    });

    it('rejects claim when locked balance is insufficient', async () => {
      // Pool status shows balance, but the FOR UPDATE re-read shows insufficient balance
      // F49-7 FIX: duplicate check now runs inside transaction (no pre-flight db.query).
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow({ available_balance_cents: 50000 })], rowCount: 1 } as never); // getPoolStatus
      // Inside transaction: duplicate check passes, then FOR UPDATE returns a lower balance (concurrent claim reduced it)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // F49-7 duplicate check FOR UPDATE — no existing claim
      mockDb.query.mockResolvedValueOnce({ rows: [{ available_balance_cents: 100, coverage_percentage: 80 }], rowCount: 1 } as never); // FOR UPDATE lock

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 25000, 'Damage', []
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INSUFFICIENT_POOL_BALANCE');
    });

    it('handles pool status failure', async () => {
      // F49-7 FIX: duplicate check now inside transaction; getPoolStatus runs first and fails
      mockDb.query.mockRejectedValueOnce(new Error('db error')); // getPoolStatus fails

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
    it('approves a pending claim', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await SelfInsurancePoolService.reviewClaim('claim-1', 'admin-1', true, 'Valid claim');

      expect(result.success).toBe(true);
      const params = mockDb.query.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe('approved');
    });

    it('denies a pending claim', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await SelfInsurancePoolService.reviewClaim('claim-1', 'admin-1', false, 'Insufficient evidence');

      expect(result.success).toBe(true);
      const params = mockDb.query.mock.calls[0][1] as unknown[];
      expect(params[0]).toBe('denied');
    });

    it('returns CLAIM_NOT_REVIEWABLE when claim is not in pending status (F-04 fix)', async () => {
      // UPDATE returns rowCount=0 when the AND status='pending' guard rejects it
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await SelfInsurancePoolService.reviewClaim('claim-1', 'admin-1', true, 'ok');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CLAIM_NOT_REVIEWABLE');
    });

    it('returns error on DB failure', async () => {
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
      // F-04 FIX: coverage_percentage is now read INSIDE the transaction (no outer SELECT).
      // Pool FOR UPDATE returns BOTH available_balance_cents AND coverage_percentage.
      // F46-4 FIX: pre-check SELECT stripe_connect_id runs BEFORE the transaction.
      // F48-2: pool FOR UPDATE also returns max_claim_cents.
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 100000 })],
          rowCount: 1,
        } as never) // claim (outer SELECT)
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test123' }], rowCount: 1 } as never) // pre-check SELECT stripe_connect_id (F46-4)
        // F-25: inside transaction — claim re-check FOR UPDATE, then pool FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 100000 }], rowCount: 1 } as never) // claim FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 1000, coverage_percentage: 80, max_claim_cents: 500000 }], rowCount: 1 } as never); // pool FOR UPDATE (F-04/F48-2)

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INSUFFICIENT_POOL_BALANCE');
    });

    it('returns CLAIM_EXCEEDS_MAX when coverage raise makes payout exceed pool cap (F48-2)', async () => {
      // F48-2: claim filed at 80% coverage (covered=8000), but coverage raised to 200%
      // inside the transaction covered=20000 > max_claim_cents=10000 → CLAIM_EXCEEDS_MAX
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 10000 })],
          rowCount: 1,
        } as never) // claim (outer SELECT)
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test123' }], rowCount: 1 } as never) // pre-check stripe_connect_id
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 10000 }], rowCount: 1 } as never) // claim FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 500000, coverage_percentage: 200, max_claim_cents: 10000 }], rowCount: 1 } as never); // pool FOR UPDATE — coverage raised, max is 10000, covered=20000

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CLAIM_EXCEEDS_MAX');
    });

    it('pays claim successfully (F-06: uses StripeService.createTransfer)', async () => {
      const { StripeService: MockStripe } = await import('../../src/services/StripeService.js');

      // F-04 FIX: coverage_percentage is now read INSIDE the transaction under FOR UPDATE.
      // No outer SELECT for coverage_percentage — pool FOR UPDATE returns both columns.
      // F46-4 FIX: pre-check SELECT stripe_connect_id runs BEFORE the transaction.
      // The post-transaction code reuses the pre-checked connectId — no second DB SELECT.
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 10000 })],
          rowCount: 1,
        } as never) // claim (outer SELECT)
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never) // pre-check SELECT stripe_connect_id (F46-4)
        // F-25: inside transaction — claim re-check FOR UPDATE, then rest of transaction
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 10000 }], rowCount: 1 } as never) // claim FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 50000, coverage_percentage: 80, max_claim_cents: 500000 }], rowCount: 1 } as never) // pool FOR UPDATE (F-04/F48-2: includes coverage_percentage + max_claim_cents)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE pool
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE claim to paid
        // After transaction: StripeService.createTransfer (mocked globally), then record transfer ID
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE stripe_transfer_id

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(true);
      expect(vi.mocked(MockStripe.createTransfer)).toHaveBeenCalledOnce();
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
  // F53-3: denied status mismatch — fileClaim must treat 'denied' as terminal
  // --------------------------------------------------------------------------
  describe('fileClaim — F53-3: denied claims must block re-filing (status NOT IN fix)', () => {
    it('returns CLAIM_ALREADY_EXISTS when a DENIED claim exists for the same task (F53-3)', async () => {
      // F53-3 BUG: The query used `status NOT IN ('rejected', 'withdrawn')`.
      // 'rejected' is not a real ClaimStatus; 'denied' is the actual terminal status.
      // A denied claim should block re-filing just like a pending/approved/paid claim.
      // After the fix the query uses `NOT IN ('denied', 'withdrawn')`.
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never); // getPoolStatus
      // Duplicate check FOR UPDATE: finds a denied claim (denied is now treated as blocking)
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'claim-denied' }], rowCount: 1 } as never);

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 25000, 'Tool damage', []
      );

      // With the bug: denied claim would NOT appear (NOT IN ('rejected', 'withdrawn') passes denied)
      // so fileClaim would try to file a second claim — wrong.
      // After fix: denied is in the NOT IN list so the duplicate check returns the row → CLAIM_ALREADY_EXISTS.
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('CLAIM_ALREADY_EXISTS');
    });

    it('allows re-filing after a withdrawn claim (withdrawn is still excluded) (F53-3)', async () => {
      // 'withdrawn' must remain excluded from the blocking set — a withdrawn claim should allow re-filing.
      // F58-3 FIX: pool reservation UPDATE added to transaction.
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never); // getPoolStatus
      // Duplicate check finds no blocking claim (withdrawn is excluded from the NOT IN list's complement)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ available_balance_cents: 80000, coverage_percentage: 80 }], rowCount: 1 } as never); // pool lock
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE pool (F58-3 reservation)
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'claim-new' }], rowCount: 1 } as never); // INSERT

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 25000, 'Tool damage', []
      );

      expect(result.success).toBe(true);
    });

    it('SQL uses denied not rejected — duplicate check query contains denied (F53-3)', async () => {
      // Verify the actual SQL string contains 'denied' not 'rejected'
      // F58-3 FIX: pool reservation UPDATE added to transaction.
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never); // getPoolStatus
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // duplicate check
      mockDb.query.mockResolvedValueOnce({ rows: [{ available_balance_cents: 80000, coverage_percentage: 80 }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE pool (F58-3 reservation)
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'claim-new' }], rowCount: 1 } as never);

      await SelfInsurancePoolService.fileClaim('task-1', 'hustler-1', 10000, 'Damage', []);

      // The second query call is the duplicate check inside the transaction
      const duplicateCheckCall = mockDb.query.mock.calls[1];
      const sql = duplicateCheckCall[0] as string;
      expect(sql).toContain("'denied'");
      expect(sql).not.toContain("'rejected'");
    });
  });

  // --------------------------------------------------------------------------
  // F53-5: transfer amount floor — coveredAmountCents must be >= 50 before Stripe
  // --------------------------------------------------------------------------
  describe('payClaim — F53-5: minimum transfer amount floor (50 cents)', () => {
    it('returns TRANSFER_AMOUNT_TOO_LOW when covered amount is below 50 cents (F53-5)', async () => {
      // coveredAmountCents = round(40 * 80/100) = 32 < 50 → must fail before Stripe
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 40 })],
          rowCount: 1,
        } as never) // claim outer SELECT
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never) // pre-check stripe_connect_id
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 40 }], rowCount: 1 } as never) // claim FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 50000, coverage_percentage: 80, max_claim_cents: 500000 }], rowCount: 1 } as never); // pool FOR UPDATE

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('TRANSFER_AMOUNT_TOO_LOW');
    });

    it('returns TRANSFER_AMOUNT_TOO_LOW for exactly 49 cents covered (F53-5)', async () => {
      // claim_amount_cents=62, coverage=80% → round(62*0.8)=50 → should pass at 50
      // claim_amount_cents=60, coverage=80% → round(60*0.8)=48 < 50 → must fail
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 60 })],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 60 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 50000, coverage_percentage: 80, max_claim_cents: 500000 }], rowCount: 1 } as never);

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('TRANSFER_AMOUNT_TOO_LOW');
    });

    it('does NOT debit the pool when covered amount is below 50 cents (F56-1: pre-flight check)', async () => {
      // F56-1 BUG: The coveredAmountCents < 50 check fired AFTER the DB transaction
      // committed — the pool was debited and claim marked 'paid' before the check ran.
      // Fix: move the check INSIDE the transaction but BEFORE the pool debit and
      // claim status UPDATE statements. The transaction then throws and rolls back
      // before any writes, so the pool is never debited.
      // coveredAmountCents = round(40 * 80/100) = 32 < 50
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 40 })],
          rowCount: 1,
        } as never) // claim outer SELECT
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never) // pre-check stripe_connect_id
        // Inside transaction: claim FOR UPDATE, then pool FOR UPDATE — check fires, transaction rolls back
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 40 }], rowCount: 1 } as never) // claim FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 50000, coverage_percentage: 80, max_claim_cents: 500000 }], rowCount: 1 } as never); // pool FOR UPDATE

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('TRANSFER_AMOUNT_TOO_LOW');

      // Critical: the pool debit UPDATE (total_claims_cents) must NOT have been called.
      // With the bug the transaction commits before the check; with the fix it rolls back.
      const allSqlCalls = mockDb.query.mock.calls.map((c) => c[0] as string);
      const poolDebitCalled = allSqlCalls.some((sql) => sql.includes('total_claims_cents'));
      expect(poolDebitCalled).toBe(false);
    });

    it('succeeds when covered amount is exactly 50 cents (F53-5 boundary)', async () => {
      const { StripeService: MockStripe } = await import('../../src/services/StripeService.js');
      // claim_amount_cents=63, coverage=80% → round(63*0.8)=50 → exactly at floor → ok
      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 63 })],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 63 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 50000, coverage_percentage: 80, max_claim_cents: 500000 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE pool
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE claim to paid
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE stripe_transfer_id

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(true);
      expect(vi.mocked(MockStripe.createTransfer)).toHaveBeenCalledOnce();
    });
  });

  // --------------------------------------------------------------------------
  // F53-10: payClaim must NOT swallow Stripe failures
  // --------------------------------------------------------------------------
  describe('payClaim — F53-10: Stripe failures must not return success', () => {
    it('returns failure when Stripe createTransfer throws (F53-10)', async () => {
      const { StripeService: MockStripe } = await import('../../src/services/StripeService.js');
      vi.mocked(MockStripe.createTransfer).mockRejectedValueOnce(new Error('stripe network error'));

      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 10000 })],
          rowCount: 1,
        } as never) // claim outer SELECT
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never) // pre-check stripe_connect_id
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 10000 }], rowCount: 1 } as never) // claim FOR UPDATE
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 50000, coverage_percentage: 80, max_claim_cents: 500000 }], rowCount: 1 } as never) // pool FOR UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE pool
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE claim to paid

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      // F53-10 BUG: currently returns { success: true } even when Stripe throws.
      // After fix: must propagate the error.
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_TRANSFER_FAILED');
    });

    it('returns failure when Stripe createTransfer returns success:false (F53-10)', async () => {
      const { StripeService: MockStripe } = await import('../../src/services/StripeService.js');
      vi.mocked(MockStripe.createTransfer).mockResolvedValueOnce({
        success: false,
        error: { message: 'insufficient funds in platform account' },
      } as any);

      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 10000 })],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 10000 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 50000, coverage_percentage: 80, max_claim_cents: 500000 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never) // UPDATE pool
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE claim to paid

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('STRIPE_TRANSFER_FAILED');
    });

    it('does NOT return success:true when Stripe throws (regression guard for F53-10)', async () => {
      // Extra explicit assertion: success must be falsy when Stripe blows up
      const { StripeService: MockStripe } = await import('../../src/services/StripeService.js');
      vi.mocked(MockStripe.createTransfer).mockRejectedValueOnce(new Error('timeout'));

      mockDb.query
        .mockResolvedValueOnce({
          rows: [makeClaimRow({ status: 'approved', claim_amount_cents: 5000 })],
          rowCount: 1,
        } as never)
        .mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ status: 'approved', stripe_transfer_id: null, claim_amount_cents: 5000 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ available_balance_cents: 50000, coverage_percentage: 80, max_claim_cents: 500000 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await SelfInsurancePoolService.payClaim('claim-1');

      expect(result.success).not.toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // F58-3: fileClaim must debit pool balance at filing time to prevent over-commitment
  // --------------------------------------------------------------------------
  describe('fileClaim — F58-3: pool balance debited at filing time (concurrent over-commitment fix)', () => {
    it('debits total_claims_cents in fileClaim transaction to reserve pool balance (F58-3)', async () => {
      // After fileClaim succeeds, the pool UPDATE must have been called inside the transaction.
      // This reserves the covered amount so concurrent callers see the reduced balance.
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never); // getPoolStatus
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // duplicate check FOR UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [{ available_balance_cents: 80000, coverage_percentage: 80 }], rowCount: 1 } as never); // pool FOR UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE pool (reservation)
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'claim-1' }], rowCount: 1 } as never); // INSERT claim

      const result = await SelfInsurancePoolService.fileClaim(
        'task-1', 'hustler-1', 25000, 'Tool damage', ['https://r2.dev/evidence.jpg']
      );

      expect(result.success).toBe(true);

      // The pool UPDATE must have been called inside the transaction
      const allSqls = mockDb.query.mock.calls.map(c => (c[0] as string).toLowerCase());
      const poolDebitCall = allSqls.find(sql =>
        sql.includes('update self_insurance_pool') && sql.includes('total_claims_cents')
      );
      expect(poolDebitCall).toBeDefined();
    });

    it('second fileClaim fails with INSUFFICIENT_POOL_BALANCE when first reserved the balance (F58-3)', async () => {
      // Pool has 80000 available_balance_cents, coverage 80%.
      // First claim: 25000 * 80% = 20000 covered. Pool debited → 60000 remaining.
      // Second claim: 25000 * 80% = 20000 covered. Pool debited again → 40000 remaining? No —
      // In this test we simulate that after the first claim debited the pool,
      // the second fileClaim's FOR UPDATE sees only the residual balance.
      // Since we can't truly run concurrent DB ops in unit tests, we verify that
      // fileClaim issues the UPDATE self_insurance_pool query (the debit reservation),
      // and that when available_balance_cents is 0 at the FOR UPDATE step, it correctly fails.

      // Second claim attempt — pool FOR UPDATE returns 0 after first reservation
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow({ available_balance_cents: 0 })], rowCount: 1 } as never); // getPoolStatus
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // duplicate check FOR UPDATE (no existing claim for task-2)
      mockDb.query.mockResolvedValueOnce({ rows: [{ available_balance_cents: 0, coverage_percentage: 80 }], rowCount: 1 } as never); // pool FOR UPDATE — balance already reserved

      const result = await SelfInsurancePoolService.fileClaim(
        'task-2', 'hustler-1', 25000, 'Concurrent claim', []
      );

      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('INSUFFICIENT_POOL_BALANCE');
    });

    it('fileClaim transaction issues UPDATE self_insurance_pool with correct coveredAmount (F58-3)', async () => {
      // Verify the reservation UPDATE uses the correct covered amount: 25000 * 80% = 20000
      mockDb.query.mockResolvedValueOnce({ rows: [makePoolRow()], rowCount: 1 } as never); // getPoolStatus
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // duplicate check FOR UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [{ available_balance_cents: 80000, coverage_percentage: 80 }], rowCount: 1 } as never); // pool FOR UPDATE
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE pool reservation
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'claim-1' }], rowCount: 1 } as never); // INSERT claim

      await SelfInsurancePoolService.fileClaim('task-1', 'hustler-1', 25000, 'Damage', []);

      // Find the UPDATE self_insurance_pool call
      const poolUpdateCall = mockDb.query.mock.calls.find(c => {
        const sql = (c[0] as string).toLowerCase();
        return sql.includes('update self_insurance_pool') && sql.includes('total_claims_cents');
      });
      expect(poolUpdateCall).toBeDefined();
      // The parameter should be 20000 (25000 * 80%)
      const params = poolUpdateCall![1] as unknown[];
      expect(params[0]).toBe(20000);
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
