import { describe, it, expect, vi, beforeEach } from 'vitest';

const payoutDestination = vi.hoisted(() => vi.fn());

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
  XPService: { awardXP: vi.fn(), clawbackXP: vi.fn() },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: { logEvent: vi.fn().mockResolvedValue({ success: true, data: { id: 'rev-1' } }) },
}));

vi.mock('../../src/config', () => ({
  config: { stripe: { platformFeePercent: 15 } },
}));

vi.mock('../../src/services/TaskPayoutDestinationService.js', () => ({
  loadCurrentTaskPayoutDestination: payoutDestination,
}));

import { EscrowService } from '../../src/services/EscrowService';
import { XPService } from '../../src/services/XPService';
import { db } from '../../src/db';

describe('EscrowService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    payoutDestination.mockImplementation(async (query,binding) => {
      const result=await query('SELECT payouts_enabled,stripe_connect_id,stripe_connect_status FROM users WHERE id=$1',[binding.payoutRecipientUserId]);
      const row=result.rows[0];
      return row?.stripe_connect_id && row.payouts_enabled!==false
        ? { ready:true,stripeConnectId:row.stripe_connect_id,reason:'READY' }
        : { ready:false,stripeConnectId:null,reason:'PAYOUT_ACCOUNT_NOT_READY' };
    });
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
      //   2nd query: cross-escrow PI dedup check → no conflict
      //   3rd query: UPDATE escrows ... RETURNING *   → funded row
      (db.query as any).mockResolvedValueOnce({ rows: [{ state: 'PENDING', version: 0 }], rowCount: 1 });
      (db.query as any).mockResolvedValueOnce({ rows: [], rowCount: 0 });
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
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', version: 0, state: 'FUNDED' }], rowCount: 1 }); // F-05: T2 FOR UPDATE NOWAIT
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'REFUNDED' }], rowCount: 1 }); // UPDATE
      (db.query as any).mockResolvedValueOnce({ rowCount: 1 }); // logEscrowEvent
      const result = await EscrowService.refund({ escrowId: 'e1' });
      expect(result.success).toBe(true);
    });

    it('claws back previously awarded XP after a worker refund', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [{ task_id: 'task-1' }], rowCount: 1 });
      (db.query as any).mockResolvedValueOnce({ rows: [{ worker_id: 'worker-1' }], rowCount: 1 });
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', version: 0, state: 'FUNDED' }], rowCount: 1 });
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'REFUNDED' }], rowCount: 1 });
      (db.query as any).mockResolvedValueOnce({ rowCount: 1 });

      const result = await EscrowService.refund({ escrowId: 'e1' });

      expect(result.success).toBe(true);
      expect(XPService.clawbackXP).toHaveBeenCalledWith('worker-1', 'e1', 'task_refunded');
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
        9960  // gross=12000, platformFee=15%=1800, netBeforeInsurance=10200, insurance=2% of gross=240, resolvedNet=9960
      );

      // XP = Math.round(12000 / 10) = 1200, NOT 1000 (which task.price/10 would give)
      expect(XPService.awardXP).toHaveBeenCalledWith(
        expect.objectContaining({ baseXP: 1200 })
      );
    });
  });

  describe('release — insurance contribution base (F54-2)', () => {
    it('calculates insurance contribution from gross escrow amount, not net-of-platform-fee (F54-2)', async () => {
      // Spec: insurance = 2% of task price (gross), not 2% of (gross - platformFee)
      // gross=12000, platformFee=15%=1800, net-before-insurance=10200
      // BUGGY:  insurance = 2% of 10200 = 204  → resolvedNet = 10200 - 204 = 9996
      // CORRECT: insurance = 2% of 12000 = 240  → resolvedNet = 10200 - 240 = 9960
      const { EarnedVerificationUnlockService } = await import('../../src/services/EarnedVerificationUnlockService');
      const { XPService } = await import('../../src/services/XPService');

      // Query 1: fetch escrow
      (db.query as any).mockResolvedValueOnce({
        rows: [{ id: 'e-ins', task_id: 't-ins', amount: 12000, state: 'FUNDED' }],
        rowCount: 1,
      });
      // Query 2: fetch task
      (db.query as any).mockResolvedValueOnce({
        rows: [{ worker_id: 'w-ins', price: 12000 }],
        rowCount: 1,
      });
      // Query 3: KYC check
      (db.query as any).mockResolvedValueOnce({
        rows: [{ payouts_enabled: true, stripe_connect_id: 'acct_ins', stripe_connect_status: 'active' }],
        rowCount: 1,
      });
      // Query 4: UPDATE escrows SET state = 'RELEASED'
      (db.query as any).mockResolvedValueOnce({
        rows: [{ id: 'e-ins', task_id: 't-ins', amount: 12000, state: 'RELEASED' }],
        rowCount: 1,
      });

      const result = await EscrowService.release({ escrowId: 'e-ins', stripeTransferId: 'tr_ins' });

      expect(result.success).toBe(true);

      // gross=12000, platformFee=15% of 12000=1800, netBeforeInsurance=10200
      // insurance = 2% of gross=12000 = 240 (NOT 2% of 10200=204)
      // resolvedNet = 10200 - 240 = 9960
      expect(EarnedVerificationUnlockService.recordEarnings).toHaveBeenCalledWith(
        'w-ins',
        't-ins',
        'e-ins',
        9960  // 2% insurance on gross 12000 = 240; net = 10200 - 240 = 9960
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
