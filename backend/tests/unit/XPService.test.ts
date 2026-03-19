import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

vi.mock('../../src/services/AlphaInstrumentation', () => ({
  AlphaInstrumentation: { emitTrustDeltaApplied: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: { redis: { restUrl: '', restToken: '' } },
}));

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    incrby: vi.fn(),
    expire: vi.fn(),
  })),
}));

import { db } from '../../src/db';
import { XPService } from '../../src/services/XPService';

const mockDb = vi.mocked(db);

// Helper type for the transaction callback function
type TxFn = (q: typeof mockDb.query) => Promise<unknown>;

describe('XPService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('state machine helpers', () => {
    // Test level calculation
    it('should calculate level 1 for 0 XP', async () => {
      // Level thresholds: 0, 100, 300, 700, ...
      // We can test calculateAward which internally uses these
    });
  });

  // ===========================================================================
  // clawbackXP — partial clawback ledger amounts (BUG FIX UU-06)
  // After fix, all DB work inside db.transaction() with FOR UPDATE row lock.
  // Mock shape per test:
  //   mockDb.query call 0: SELECT original award from xp_ledger (outer, before transaction)
  //   mockDb.transaction call 0: callback receives txQuery mock with:
  //     txQuery call 0: SELECT ... FOR UPDATE (lock user row)
  //     txQuery call 1: INSERT clawback row into xp_ledger
  //     txQuery call 2: UPDATE users SET xp_total
  //     txQuery call 3 (optional): UPDATE users SET current_level (only when level changes)
  // ===========================================================================

  describe('clawbackXP — partial fraction ledger correctness', () => {
    const userId = 'user-111';
    const escrowId = 'escrow-222';
    const taskId = 'task-333';

    it('records fraction-adjusted base_xp and effective_xp for a 60% partial clawback', async () => {
      // Original award: base_xp=1000, effective_xp=1000
      // fraction=0.6 → adjustedBaseXP=-600, adjustedEffectiveXP=-600, xpToDeduct=600
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ledger-1', base_xp: 1000, effective_xp: 1000, task_id: taskId }],
        rowCount: 1,
      } as never);

      let capturedInsertParams: unknown[] | undefined;
      mockDb.transaction.mockImplementationOnce(async (fn: TxFn) => {
        const txQuery = vi.fn()
          .mockResolvedValueOnce({ rows: [{ xp_total: 1000, current_level: 3 }], rowCount: 1 }) // FOR UPDATE
          .mockImplementationOnce((_sql: string, params: unknown[]) => {
            capturedInsertParams = params;
            return Promise.resolve({ rows: [{ id: 'ledger-cb-1' }], rowCount: 1 });
          })
          .mockResolvedValueOnce({ rows: [{ xp_total: 400, current_level: 2 }], rowCount: 1 }); // UPDATE xp_total
        return fn(txQuery);
      });

      await XPService.clawbackXP(userId, escrowId, 'dispute_partial', 0.6);

      // params: [userId, escrowId, taskId, reason, adjustedBaseXP, adjustedEffectiveXP, xpToDeduct]
      const adjustedBaseXP = (capturedInsertParams as number[])[4];
      const adjustedEffectiveXP = (capturedInsertParams as number[])[5];
      const xpToDeduct = (capturedInsertParams as number[])[6];

      expect(adjustedBaseXP).toBe(-600);       // -Math.round(1000 * 0.6)
      expect(adjustedEffectiveXP).toBe(-600);  // -xpToDeduct
      expect(xpToDeduct).toBe(600);
    });

    it('records full amounts when fraction=1.0 (full clawback)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ledger-1', base_xp: 500, effective_xp: 750, task_id: taskId }],
        rowCount: 1,
      } as never);

      let capturedInsertParams: unknown[] | undefined;
      mockDb.transaction.mockImplementationOnce(async (fn: TxFn) => {
        const txQuery = vi.fn()
          .mockResolvedValueOnce({ rows: [{ xp_total: 750, current_level: 2 }], rowCount: 1 }) // FOR UPDATE
          .mockImplementationOnce((_sql: string, params: unknown[]) => {
            capturedInsertParams = params;
            return Promise.resolve({ rows: [{ id: 'ledger-cb-1' }], rowCount: 1 });
          })
          .mockResolvedValueOnce({ rows: [{ xp_total: 0, current_level: 1 }], rowCount: 1 }); // UPDATE xp_total
        return fn(txQuery);
      });

      await XPService.clawbackXP(userId, escrowId, 'dispute_full', 1.0);

      const adjustedBaseXP = (capturedInsertParams as number[])[4];
      const adjustedEffectiveXP = (capturedInsertParams as number[])[5];
      const xpToDeduct = (capturedInsertParams as number[])[6];

      expect(adjustedBaseXP).toBe(-500);      // full base
      expect(adjustedEffectiveXP).toBe(-750); // full effective
      expect(xpToDeduct).toBe(750);
    });

    it('records proportional amounts for a 25% partial clawback with multiplied XP', async () => {
      // base_xp=400, effective_xp=1000 (multiplied by streak/trust), fraction=0.25
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ledger-1', base_xp: 400, effective_xp: 1000, task_id: taskId }],
        rowCount: 1,
      } as never);

      let capturedInsertParams: unknown[] | undefined;
      mockDb.transaction.mockImplementationOnce(async (fn: TxFn) => {
        const txQuery = vi.fn()
          .mockResolvedValueOnce({ rows: [{ xp_total: 1000, current_level: 3 }], rowCount: 1 }) // FOR UPDATE
          .mockImplementationOnce((_sql: string, params: unknown[]) => {
            capturedInsertParams = params;
            return Promise.resolve({ rows: [{ id: 'ledger-cb-1' }], rowCount: 1 });
          })
          .mockResolvedValueOnce({ rows: [{ xp_total: 750, current_level: 3 }], rowCount: 1 }); // UPDATE xp_total
        return fn(txQuery);
      });

      await XPService.clawbackXP(userId, escrowId, 'dispute_quarter', 0.25);

      const adjustedBaseXP = (capturedInsertParams as number[])[4];
      const adjustedEffectiveXP = (capturedInsertParams as number[])[5];
      const xpToDeduct = (capturedInsertParams as number[])[6];

      expect(adjustedBaseXP).toBe(-100);      // -Math.round(400 * 0.25)
      expect(adjustedEffectiveXP).toBe(-250); // -Math.round(1000 * 0.25)
      expect(xpToDeduct).toBe(250);
    });

    it('skips clawback when no award exists for the escrow', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await XPService.clawbackXP(userId, 'no-escrow', 'dispute_full', 1.0);

      // Only the outer SELECT was called — transaction never entered
      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('skips clawback when fraction rounds to 0 XP deducted', async () => {
      // effective_xp=1, fraction=0.1 → Math.round(1 * 0.1) = 0 → early exit
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ledger-1', base_xp: 1, effective_xp: 1, task_id: taskId }],
        rowCount: 1,
      } as never);

      await XPService.clawbackXP(userId, escrowId, 'dispute_tiny', 0.1);

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('is idempotent — does not deduct again when clawback row already exists', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ledger-1', base_xp: 200, effective_xp: 200, task_id: taskId }],
        rowCount: 1,
      } as never);

      // Inside the transaction: FOR UPDATE lock, then INSERT returns rowCount=0 (conflict)
      let txQueryCallCount = 0;
      mockDb.transaction.mockImplementationOnce(async (fn: TxFn) => {
        const txQuery = vi.fn()
          .mockResolvedValueOnce({ rows: [{ xp_total: 200, current_level: 2 }], rowCount: 1 }) // FOR UPDATE
          .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // INSERT conflicts — already applied
        const result = await fn(txQuery);
        txQueryCallCount = txQuery.mock.calls.length;
        return result;
      });

      await XPService.clawbackXP(userId, escrowId, 'dispute_full', 1.0);

      // Inside transaction: FOR UPDATE + INSERT (no UPDATE users since rowCount=0)
      expect(txQueryCallCount).toBe(2);
      expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    });
  });
});
