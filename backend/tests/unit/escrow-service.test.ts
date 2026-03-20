/**
 * EscrowService Unit Tests
 *
 * Tests state machine integrity, INV-2 enforcement, terminal state rejection,
 * amount validation, and gamification integration.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------
// The db mock exposes both `query` (for direct queries) and `transaction`
// (for methods wrapped in db.transaction()). The transaction mock calls the
// provided callback with the same `query` spy so existing mockResolvedValueOnce
// sequences work seamlessly inside and outside transactions.
vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  logger: { child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }) },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: { recordEarnings: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPTaxService', () => ({
  XPTaxService: { recordOfflinePayment: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: { awardXP: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../src/services/SelfInsurancePoolService.js', () => ({
  SelfInsurancePoolService: { recordContribution: vi.fn().mockResolvedValue({ success: true }) },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

vi.mock('../../src/services/StripeService', () => ({
  StripeService: {
    createRefund: vi.fn().mockResolvedValue({ success: true, data: { refundId: 're_test', amount: 5000, status: 'succeeded' } }),
    createTransfer: vi.fn().mockResolvedValue({ success: true, data: { transferId: 'tr_test', amount: 3000 } }),
    cancelRefund: vi.fn().mockResolvedValue({ success: true, data: { refundId: 're_test', status: 'cancelled' } }),
  },
}));

import { db, isInvariantViolation, isUniqueViolation, getErrorMessage } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService';
import { EarnedVerificationUnlockService } from '../../src/services/EarnedVerificationUnlockService';
import { XPService } from '../../src/services/XPService';
import { SelfInsurancePoolService } from '../../src/services/SelfInsurancePoolService.js';

const mockDb = vi.mocked(db);
const mockIsInvariantViolation = vi.mocked(isInvariantViolation);
const mockIsUniqueViolation = vi.mocked(isUniqueViolation);
const mockGetErrorMessage = vi.mocked(getErrorMessage);

function makeEscrow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'esc-1',
    task_id: 'task-1',
    amount: 5000,
    state: 'PENDING',
    stripe_payment_intent_id: null,
    stripe_transfer_id: null,
    funded_at: null,
    released_at: null,
    refunded_at: null,
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsInvariantViolation.mockReturnValue(false);
  mockIsUniqueViolation.mockReturnValue(false);
});

// ===========================================================================
// TESTS
// ===========================================================================

describe('EscrowService', () => {
  // -------------------------------------------------------------------------
  // getById
  // -------------------------------------------------------------------------
  describe('getById', () => {
    it('returns escrow when found', async () => {
      const escrow = makeEscrow();
      mockDb.query.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

      const result = await EscrowService.getById('esc-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.id).toBe('esc-1');
    });

    it('returns NOT_FOUND when escrow missing', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.getById('esc-missing');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns DB_ERROR on query failure', async () => {
      mockDb.query.mockRejectedValueOnce(new Error('connection timeout'));

      const result = await EscrowService.getById('esc-1');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DB_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------
  describe('create', () => {
    it('creates escrow with valid amount', async () => {
      const escrow = makeEscrow({ amount: 5000 });
      mockDb.query.mockResolvedValueOnce({ rows: [escrow], rowCount: 1 } as never);

      const result = await EscrowService.create({ taskId: 'task-1', amount: 5000 });
      expect(result.success).toBe(true);
    });

    it('rejects zero amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: 0 });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('positive integer');
    });

    it('rejects negative amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: -100 });
      expect(result.success).toBe(false);
    });

    it('rejects float amount', async () => {
      const result = await EscrowService.create({ taskId: 'task-1', amount: 49.99 });
      expect(result.success).toBe(false);
    });

    it('returns DUPLICATE on unique violation', async () => {
      const err = Object.assign(new Error('dup'), { code: '23505' });
      mockDb.query.mockRejectedValueOnce(err);
      mockIsUniqueViolation.mockReturnValueOnce(true);

      const result = await EscrowService.create({ taskId: 'task-1', amount: 5000 });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('DUPLICATE');
    });
  });

  // -------------------------------------------------------------------------
  // fund
  // -------------------------------------------------------------------------
  // fund() is now wrapped in db.transaction() with SELECT FOR UPDATE then UPDATE.
  // The transaction mock calls the callback with the same mockDb.query spy, so
  // mockResolvedValueOnce sequences are consumed in order:
  //   1st call: SELECT state, version ... FOR UPDATE  → returns lock row
  //   2nd call: UPDATE escrows ... RETURNING *        → returns updated row
  // -------------------------------------------------------------------------
  describe('fund', () => {
    it('funds escrow from PENDING state', async () => {
      const funded = makeEscrow({ state: 'FUNDED', funded_at: new Date() });
      // 1st: SELECT FOR UPDATE → lock row with state=PENDING, version=0
      mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'PENDING', version: 0 }], rowCount: 1 } as never);
      // 2nd: cross-escrow PI dedup check → no conflict (happy path)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // 3rd: UPDATE → funded row
      mockDb.query.mockResolvedValueOnce({ rows: [funded], rowCount: 1 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('FUNDED');
    });

    it('fails when not in PENDING state', async () => {
      // 1st: SELECT FOR UPDATE → row with wrong state
      mockDb.query.mockResolvedValueOnce({ rows: [{ state: 'FUNDED', version: 1 }], rowCount: 1 } as never);
      // 2nd: cross-escrow PI dedup check → no conflict (runs before the state check)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('expected PENDING');
    });

    it('returns NOT_FOUND when escrow does not exist', async () => {
      // SELECT FOR UPDATE → no rows → early return, no PI dedup check needed
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });
  });

  // -------------------------------------------------------------------------
  // release (INV-2 enforcement)
  // -------------------------------------------------------------------------
  describe('release', () => {
    it('releases escrow from FUNDED state (happy path)', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never) // SELECT escrow
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)   // SELECT task
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never) // KYC check
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never); // UPDATE

      const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_123' });
      expect(result.success).toBe(true);

      // Verify gamification: recordEarnings called with net payout (85% after 15% platform fee, minus 2% insurance)
      // gross=5000, fee=750, net=4250, insurance=Math.round(4250*0.02)=85, final=4250-85=4165
      expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
        'worker-1', 'task-1', 'esc-1', 4165
      );

      // Verify XP award: price / 10
      expect(XPService.awardXP).toHaveBeenCalledWith({
        userId: 'worker-1', taskId: 'task-1', escrowId: 'esc-1', baseXP: 500,
      });

      // Verify self-insurance contribution: 2% of NET payout (after 15% platform fee)
      // gross=5000, fee=750, net=4250, insurance=Math.round(4250*0.02)=85
      expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
        'task-1', 'worker-1', 85,
      );
    });

    it('continues release even if self-insurance contribution fails', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

      vi.mocked(SelfInsurancePoolService.recordContribution).mockRejectedValueOnce(
        new Error('DB pool unreachable')
      );

      const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_svc' });
      // Payout must still succeed despite insurance failure
      expect(result.success).toBe(true);
    });

    it('returns INV_2_VIOLATION when trigger fires HX201', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never) // KYC check
        .mockRejectedValueOnce(Object.assign(new Error('INV-2'), { code: 'HX201' }));

      mockIsInvariantViolation.mockReturnValueOnce(true);
      mockGetErrorMessage.mockReturnValueOnce('INV-2 VIOLATION');

      const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_svc' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('HX201'); // ErrorCodes.INV_2_VIOLATION = 'HX201'
    });

    it('returns ESCROW_TERMINAL when already released', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never) // KYC check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE returns 0
        .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'RELEASED' })], rowCount: 1 } as never); // getById

      const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_svc' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('HX002'); // ErrorCodes.ESCROW_TERMINAL = 'HX002'
    });

    it('returns NOT_FOUND when escrow does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.release({ escrowId: 'esc-missing', stripeTransferId: 'tr_test_svc' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns INVALID_STATE when task has no worker', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ worker_id: null, price: 5000 }], rowCount: 1 } as never);

      const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_svc' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('no assigned worker');
    });

    it('continues release even if XP award fails', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      const taskRow = { worker_id: 'worker-1', price: 5000 };
      const workerKycRow = { payouts_enabled: true, stripe_connect_id: 'acct_test', stripe_connect_status: 'complete' };
      const released = makeEscrow({ state: 'RELEASED' });

      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [taskRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [workerKycRow], rowCount: 1 } as never) // KYC check
        .mockResolvedValueOnce({ rows: [released], rowCount: 1 } as never);

      vi.mocked(XPService.awardXP).mockRejectedValueOnce(new Error('XP failure'));

      const result = await EscrowService.release({ escrowId: 'esc-1', stripeTransferId: 'tr_test_svc' });
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // refund
  // -------------------------------------------------------------------------
  describe('refund', () => {
    it('refunds from FUNDED state', async () => {
      const refunded = makeEscrow({ state: 'REFUNDED' });
      // Transaction callback query sequence:
      //   1st: SELECT ... FOR UPDATE (escrow pre-check — now includes stripe_payment_intent_id + amount)
      //   2nd: SELECT worker_id, state FROM tasks (task state check moved inside transaction — LL4)
      //   3rd: UPDATE escrows RETURNING * (state transition)
      //   4th: INSERT INTO escrow_events (logEscrowEvent — called outside transaction)
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', version: 0, state: 'FUNDED', stripe_payment_intent_id: 'pi_test', amount: 5000 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', state: 'OPEN' }], rowCount: 1 } as never) // task state check
        .mockResolvedValueOnce({ rows: [refunded], rowCount: 1 } as never) // UPDATE
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // logEscrowEvent

      const result = await EscrowService.refund({ escrowId: 'esc-1' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('REFUNDED');
    });

    it('blocks refund when task is in ACCEPTED state (LL4 race fix)', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', version: 0, state: 'FUNDED', stripe_payment_intent_id: null, amount: 5000 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1', state: 'ACCEPTED' }], rowCount: 1 } as never); // task assigned

      const result = await EscrowService.refund({ escrowId: 'esc-1' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('accepted by a worker');
    });

    it('returns ESCROW_TERMINAL when already refunded', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [{ task_id: 'task-1', version: 0, state: 'FUNDED', stripe_payment_intent_id: null, amount: 5000 }], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ worker_id: null, state: 'OPEN' }], rowCount: 1 } as never) // task state check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE rowCount=0
        .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'REFUNDED' })], rowCount: 1 } as never); // getById fallback

      const result = await EscrowService.refund({ escrowId: 'esc-1' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('HX002'); // ErrorCodes.ESCROW_TERMINAL = 'HX002'
    });
  });

  // -------------------------------------------------------------------------
  // lockForDispute
  // -------------------------------------------------------------------------
  describe('lockForDispute', () => {
    it('locks from FUNDED state', async () => {
      const locked = makeEscrow({ state: 'LOCKED_DISPUTE' });
      // Window check returns no rows (no completed_at — window guard skipped)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // Bug 2 fix: existing dispute count check — 0 open disputes
      mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never);
      // UPDATE escrows SET state = 'LOCKED_DISPUTE'
      mockDb.query.mockResolvedValueOnce({ rows: [locked], rowCount: 1 } as never);
      // logEscrowEvent INSERT
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const result = await EscrowService.lockForDispute('esc-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('LOCKED_DISPUTE');
    });

    it('fails when not in FUNDED state', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // window check
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as never) // Bug 2 fix: existing dispute check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // UPDATE — 0 rows
        .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'PENDING' })], rowCount: 1 } as never); // getById

      const result = await EscrowService.lockForDispute('esc-1');
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('expected FUNDED');
    });
  });

  // -------------------------------------------------------------------------
  // partialRefund
  // -------------------------------------------------------------------------
  describe('partialRefund', () => {
    it('partial refunds from LOCKED_DISPUTE with valid percentages', async () => {
      const partial = makeEscrow({ state: 'REFUND_PARTIAL' });
      // partialRefund() uses TWO db.transaction() calls (R22 Stripe-first pattern):
      //
      // Transaction 1 (read-lock — no UPDATE):
      //   1st query: SELECT version, state, task_id, amount, stripe_payment_intent_id,
      //              stripe_transfer_id, stripe_refund_id FROM escrows FOR UPDATE
      //   2nd query: SELECT worker_id FROM tasks (inside Tx1)
      //   3rd query: SELECT stripe_connect_id FROM users (inside Tx1)
      //
      // Stripe calls (outside DB transactions):
      //   StripeService.createTransfer → mocked (returns tr_test)
      //   StripeService.createRefund   → mocked (returns re_test)
      //
      // Transaction 2 (terminalize — single UPDATE with both Stripe IDs):
      //   4th query: UPDATE escrows SET state='REFUND_PARTIAL', stripe_transfer_id=...,
      //              stripe_refund_id=... WHERE version=$V RETURNING *
      //
      //   5th query: INSERT INTO escrow_events (logEscrowEvent — outside Tx2)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ version: 0, state: 'LOCKED_DISPUTE', task_id: 'task-1', amount: 5000, stripe_payment_intent_id: 'pi_test', stripe_transfer_id: null, stripe_refund_id: null }],
        rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [partial], rowCount: 1 } as never);
      // logEscrowEvent INSERT
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 40,
      });
      expect(result.success).toBe(true);

      // Verify Stripe was called with the correct amounts (60% worker, 40% poster)
      expect(vi.mocked(MockStripe.createTransfer)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(MockStripe.createRefund)).toHaveBeenCalledTimes(1);

      // Verify the terminalizing UPDATE carries both Stripe IDs via COALESCE
      const updateCalls = mockDb.query.mock.calls.filter(
        (c) => typeof c[0] === 'string' && (c[0] as string).includes("SET state = 'REFUND_PARTIAL'")
      );
      expect(updateCalls).toHaveLength(1);
      // params: [escrowId, version, resolvedTransferId, resolvedRefundId]
      expect(updateCalls[0][1]).toEqual(['esc-1', 0, 'tr_test', 're_test']);
    });

    it('skips Stripe transfer when stripe_transfer_id already recorded (idempotency)', async () => {
      const partial = makeEscrow({ state: 'REFUND_PARTIAL', stripe_transfer_id: 'tr_existing' });
      // Tx1: SELECT FOR UPDATE returns existing stripe_transfer_id — transfer already done
      mockDb.query.mockResolvedValueOnce({
        rows: [{ version: 1, state: 'LOCKED_DISPUTE', task_id: 'task-1', amount: 5000, stripe_payment_intent_id: 'pi_test', stripe_transfer_id: 'tr_existing', stripe_refund_id: null }],
        rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never);
      // Tx2: terminalizing UPDATE (both Stripe IDs passed via COALESCE)
      mockDb.query.mockResolvedValueOnce({ rows: [partial], rowCount: 1 } as never);
      // logEscrowEvent INSERT
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 40,
      });
      expect(result.success).toBe(true);

      // createTransfer must NOT have been called (idempotency: already recorded)
      expect(vi.mocked(MockStripe.createTransfer)).not.toHaveBeenCalled();
      // createRefund must still have been called (refund side not yet done)
      expect(vi.mocked(MockStripe.createRefund)).toHaveBeenCalledTimes(1);
    });

    it('skips Stripe refund when stripe_refund_id already recorded (idempotency)', async () => {
      const partial = makeEscrow({ state: 'REFUND_PARTIAL', stripe_refund_id: 're_existing' });
      // Tx1: SELECT FOR UPDATE returns existing stripe_refund_id — refund already done
      mockDb.query.mockResolvedValueOnce({
        rows: [{ version: 1, state: 'LOCKED_DISPUTE', task_id: 'task-1', amount: 5000, stripe_payment_intent_id: 'pi_test', stripe_transfer_id: null, stripe_refund_id: 're_existing' }],
        rowCount: 1,
      } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1' }], rowCount: 1 } as never);
      mockDb.query.mockResolvedValueOnce({ rows: [{ stripe_connect_id: 'acct_test' }], rowCount: 1 } as never);
      // Tx2: terminalizing UPDATE (both Stripe IDs passed via COALESCE)
      mockDb.query.mockResolvedValueOnce({ rows: [partial], rowCount: 1 } as never);
      // logEscrowEvent INSERT
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

      const { StripeService: MockStripe } = await import('../../src/services/StripeService');

      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 40,
      });
      expect(result.success).toBe(true);

      // createTransfer must still have been called (transfer side not yet done)
      expect(vi.mocked(MockStripe.createTransfer)).toHaveBeenCalledTimes(1);
      // createRefund must NOT have been called (idempotency: already recorded)
      expect(vi.mocked(MockStripe.createRefund)).not.toHaveBeenCalled();
    });

    it('rejects when percentages do not sum to 100', async () => {
      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 50,
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('sum to 100');
    });
  });

  // -------------------------------------------------------------------------
  // State Machine Helpers
  // -------------------------------------------------------------------------
  describe('isTerminalState', () => {
    it('returns true for RELEASED, REFUNDED, REFUND_PARTIAL', () => {
      expect(EscrowService.isTerminalState('RELEASED')).toBe(true);
      expect(EscrowService.isTerminalState('REFUNDED')).toBe(true);
      expect(EscrowService.isTerminalState('REFUND_PARTIAL')).toBe(true);
    });

    it('returns false for PENDING, FUNDED, LOCKED_DISPUTE', () => {
      expect(EscrowService.isTerminalState('PENDING')).toBe(false);
      expect(EscrowService.isTerminalState('FUNDED')).toBe(false);
      expect(EscrowService.isTerminalState('LOCKED_DISPUTE')).toBe(false);
    });
  });

  describe('isValidTransition', () => {
    it('allows valid transitions', () => {
      expect(EscrowService.isValidTransition('PENDING', 'FUNDED')).toBe(true);
      expect(EscrowService.isValidTransition('FUNDED', 'RELEASED')).toBe(true);
      expect(EscrowService.isValidTransition('FUNDED', 'LOCKED_DISPUTE')).toBe(true);
      expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'RELEASED')).toBe(true);
      expect(EscrowService.isValidTransition('LOCKED_DISPUTE', 'REFUND_PARTIAL')).toBe(true);
    });

    it('blocks invalid transitions', () => {
      expect(EscrowService.isValidTransition('RELEASED', 'FUNDED')).toBe(false);
      expect(EscrowService.isValidTransition('PENDING', 'RELEASED')).toBe(false);
      expect(EscrowService.isValidTransition('PENDING', 'LOCKED_DISPUTE')).toBe(false);
    });
  });

  describe('getValidTransitions', () => {
    it('returns correct transitions for each state', () => {
      expect(EscrowService.getValidTransitions('PENDING')).toEqual(['FUNDED', 'REFUNDED']);
      expect(EscrowService.getValidTransitions('RELEASED')).toEqual([]);
      expect(EscrowService.getValidTransitions('LOCKED_DISPUTE')).toEqual(['RELEASED', 'REFUNDED', 'REFUND_PARTIAL']);
    });
  });
});
