import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock db module
vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
    serializableTransaction: vi.fn(),
  },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error: ${code}`),
}));

vi.mock('../../src/logger', () => ({
  escrowLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
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
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'FUNDED' }], rowCount: 1 });
      const result = await EscrowService.fund({ escrowId: 'e1', stripePaymentIntentId: 'pi_123' });
      expect(result.success).toBe(true);
    });
  });

  describe('refund', () => {
    it('should refund FUNDED escrow', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'REFUNDED' }], rowCount: 1 });
      const result = await EscrowService.refund({ escrowId: 'e1' });
      expect(result.success).toBe(true);
    });
  });

  describe('lockForDispute', () => {
    it('should lock FUNDED escrow for dispute', async () => {
      (db.query as any).mockResolvedValueOnce({ rows: [{ id: 'e1', state: 'LOCKED_DISPUTE' }], rowCount: 1 });
      const result = await EscrowService.lockForDispute('e1');
      expect(result.success).toBe(true);
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
