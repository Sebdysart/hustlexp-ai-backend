import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db module
// transaction() and serializableTransaction() call the provided callback with
// the same `query` spy so mockResolvedValueOnce sequences work seamlessly
// inside and outside transactions.
vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      transaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
      serializableTransaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
    isInvariantViolation: vi.fn(() => false),
    isUniqueViolation: vi.fn(() => false),
    getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
  };
});

vi.mock('../../src/logger', () => ({
  escrowLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  stripeLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: { recordEarnings: vi.fn() },
}));

vi.mock('../../src/services/XPTaxService', () => ({
  XPTaxService: { recordOfflinePayment: vi.fn() },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: { awardXP: vi.fn() },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

vi.mock('../../src/config', () => ({
  config: { stripe: { platformFeePercent: 15 } },
}));

import { EscrowService } from '../../src/services/EscrowService';
import { db } from '../../src/db';

describe('EscrowService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('create', () => {
    it('should create escrow with valid amount', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', task_id: 't1', amount: 5000, state: 'PENDING' }], rowCount: 1 });
      const result = await EscrowService.create({ taskId: 't1', amount: 5000 });
      expect(result.success).toBe(true);
      expect(result.data?.state).toBe('PENDING');
    });

    it('should reject non-positive amount', async () => {
      const result = await EscrowService.create({ taskId: 't1', amount: 0 });
      expect(result.success).toBe(false);
    });

    it('should reject non-integer amount', async () => {
      const result = await EscrowService.create({ taskId: 't1', amount: 50.5 });
      expect(result.success).toBe(false);
    });
  });

  describe('fund', () => {
    it('should fund PENDING escrow', async () => {
      // fund() is now wrapped in db.transaction():
      //   1st query: SELECT state, version FOR UPDATE → lock row
      //   2nd query: UPDATE escrows ... RETURNING *   → funded row
      (db.query as any).mockResolvedValueOnce({ rows: [{ state: 'PENDING', version: 0 }], rowCount: 1 });
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'FUNDED' }], rowCount: 1 });
      const result = await EscrowService.fund({ escrowId: 'e1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(true);
    });
  });

  describe('refund', () => {
    it('should refund FUNDED escrow', async () => {
      // FIX 3: refund() now pre-fetches task_id + worker_id before the UPDATE
      (db.query as any).mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }], rowCount: 1 }); // SELECT task_id
      (db.query as any).mockResolvedValueOnce({ rows: [{ worker_id: null }], rowCount: 1 });   // SELECT worker_id (null = no clawback)
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'REFUNDED' }], rowCount: 1 }); // UPDATE
      (db.query as any).mockResolvedValueOnce({ rowCount: 1 }); // logEscrowEvent
      const result = await EscrowService.refund({ escrowId: 'e1' });
      expect(result.success).toBe(true);
    });
  });

  describe('lockForDispute', () => {
    it('should lock FUNDED escrow for dispute', async () => {
      // FIX 5: lockForDispute now does a window-check query first.
      // Return no rows so the window guard is skipped (no completed_at to check).
      (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 }); // window check
      (db.query as any).mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 }); // dup dispute check
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'LOCKED_DISPUTE' }], rowCount: 1 });
      const result = await EscrowService.lockForDispute('e1');
      expect(result.success).toBe(true);
    });
  });

  describe('release', () => {
    it('should calculate platform fee and XP from escrow.amount, not task.price (surge pricing bug)', async () => {
      // Scenario: $100 base task price but $120 escrowed (with $20 surge)
      // escrow.amount = 12000 cents, task.price = 10000 cents
      // Bug: grossPayoutCents = task.price => XP = 1000, net = 8500
      // Fix: grossPayoutCents = escrow.amount => XP = 1200, net = 10200

      const { EarnedVerificationUnlockService } = await import('../../src/services/EarnedVerificationUnlockService');
      const { XPService } = await import('../../src/services/XPService');

      // Query 1: fetch escrow (amount=12000, the true escrowed value including surge)
      (db.query as any).mockResolvedValueOnce({
        rows: [{ id: 'e-surge', task_id: 't-surge', amount: 12000, state: 'FUNDED' }],
        rowCount: 1,
      });
      // Query 2: fetch task (price=10000, the base price — does NOT include surge)
      (db.query as any).mockResolvedValueOnce({
        rows: [{ worker_id: 'w-1', price: 10000 }],
        rowCount: 1,
      });
      // Query 3: KYC check — worker is fully onboarded
      (db.query as any).mockResolvedValueOnce({
        rows: [{ payouts_enabled: true, stripe_connect_id: 'acct_123', stripe_connect_status: 'active' }],
        rowCount: 1,
      });
      // Query 4: UPDATE escrows SET state = 'RELEASED'
      (db.query as any).mockResolvedValueOnce({
        rows: [{ id: 'e-surge', task_id: 't-surge', amount: 12000, state: 'RELEASED' }],
        rowCount: 1,
      });

      const result = await EscrowService.release({ escrowId: 'e-surge', stripeTransferId: 'tr_test_surge' });

      expect(result.success).toBe(true);

      // Platform fee = 15% of 12000 = 1800 cents; net = 12000 - 1800 = 10200
      expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
        'w-1',
        't-surge',
        'e-surge',
        10200  // derived from escrow.amount=12000, NOT task.price=10000 (which would give 8500)
      );

      // XP = Math.round(12000 / 10) = 1200, NOT 1000 (which task.price/10 would give)
      expect(XPService.awardXP).toHaveBeenCalledWith(
        expect.objectContaining({ baseXP: 1200 })
      );
    });
  });

  describe('state machine', () => {
    it('should validate PENDING -> FUNDED transition', () => {
      expect(EscrowService.isValidTransition('PENDING' as any, 'FUNDED' as any)).toBe(true);
    });

    it('should reject RELEASED -> anything transition', () => {
      expect(EscrowService.isValidTransition('RELEASED' as any, 'FUNDED' as any)).toBe(false);
    });

    it('should identify terminal states', () => {
      expect(EscrowService.isTerminalState('RELEASED' as any)).toBe(true);
      expect(EscrowService.isTerminalState('FUNDED' as any)).toBe(false);
    });
  });
});
