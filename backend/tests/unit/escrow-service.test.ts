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
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error ${code}`),
}));

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
  describe('fund', () => {
    it('funds escrow from PENDING state', async () => {
      const funded = makeEscrow({ state: 'FUNDED', funded_at: new Date() });
      mockDb.query.mockResolvedValueOnce({ rows: [funded], rowCount: 1 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('FUNDED');
    });

    it('fails when not in PENDING state', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
      // getById fallback
      mockDb.query.mockResolvedValueOnce({ rows: [makeEscrow({ state: 'FUNDED' })], rowCount: 1 } as never);

      const result = await EscrowService.fund({ escrowId: 'esc-1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.message).toContain('expected PENDING');
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

      // Verify gamification: recordEarnings called with net payout (85% after 15% platform fee)
      expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
        'worker-1', 'task-1', 'esc-1', 4250
      );

      // Verify XP award: price / 10
      expect(XPService.awardXP).toHaveBeenCalledWith({
        userId: 'worker-1', taskId: 'task-1', escrowId: 'esc-1', baseXP: 500,
      });

      // Verify self-insurance contribution: 2% of gross payout
      expect(SelfInsurancePoolService.recordContribution).toHaveBeenCalledWith(
        'task-1', 'worker-1', 100,
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

      const result = await EscrowService.release({ escrowId: 'esc-1' });
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

      const result = await EscrowService.release({ escrowId: 'esc-1' });
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

      const result = await EscrowService.release({ escrowId: 'esc-1' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('HX002'); // ErrorCodes.ESCROW_TERMINAL = 'HX002'
    });

    it('returns NOT_FOUND when escrow does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      const result = await EscrowService.release({ escrowId: 'esc-missing' });
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.code).toBe('NOT_FOUND');
    });

    it('returns INVALID_STATE when task has no worker', async () => {
      const escrowRow = { id: 'esc-1', task_id: 'task-1', amount: 5000, state: 'FUNDED' };
      mockDb.query
        .mockResolvedValueOnce({ rows: [escrowRow], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [{ worker_id: null, price: 5000 }], rowCount: 1 } as never);

      const result = await EscrowService.release({ escrowId: 'esc-1' });
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

      const result = await EscrowService.release({ escrowId: 'esc-1' });
      expect(result.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // refund
  // -------------------------------------------------------------------------
  describe('refund', () => {
    it('refunds from FUNDED state', async () => {
      const refunded = makeEscrow({ state: 'REFUNDED' });
      mockDb.query.mockResolvedValueOnce({ rows: [refunded], rowCount: 1 } as never);

      const result = await EscrowService.refund({ escrowId: 'esc-1' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('REFUNDED');
    });

    it('returns ESCROW_TERMINAL when already refunded', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
        .mockResolvedValueOnce({ rows: [makeEscrow({ state: 'REFUNDED' })], rowCount: 1 } as never);

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
      mockDb.query.mockResolvedValueOnce({ rows: [locked], rowCount: 1 } as never);

      const result = await EscrowService.lockForDispute('esc-1');
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.state).toBe('LOCKED_DISPUTE');
    });

    it('fails when not in FUNDED state', async () => {
      mockDb.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never) // window check
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
      mockDb.query.mockResolvedValueOnce({ rows: [partial], rowCount: 1 } as never);

      const result = await EscrowService.partialRefund({
        escrowId: 'esc-1', workerPercent: 60, posterPercent: 40,
      });
      expect(result.success).toBe(true);
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
