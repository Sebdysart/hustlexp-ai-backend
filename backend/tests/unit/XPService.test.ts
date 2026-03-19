import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
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
  // clawbackXP — partial clawback ledger amounts (BUG FIX)
  // ===========================================================================

  describe('clawbackXP — partial fraction ledger correctness', () => {
    const userId = 'user-111';
    const escrowId = 'escrow-222';
    const taskId = 'task-333';

    function setupClawbackMocks(baseXP: number, effectiveXP: number, fraction: number) {
      // 1. SELECT original award row (now includes base_xp)
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ledger-1', base_xp: baseXP, effective_xp: effectiveXP, task_id: taskId }],
        rowCount: 1,
      } as never);
      // 2. INSERT clawback row → rowCount 1 means newly inserted
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'ledger-cb-1' }], rowCount: 1 } as never);
      // 3. UPDATE users xp_total
      mockDb.query.mockResolvedValueOnce({
        rows: [{ xp_total: 400, current_level: 2 }],
        rowCount: 1,
      } as never);
    }

    it('records fraction-adjusted base_xp and effective_xp for a 60% partial clawback', async () => {
      // Original award: base_xp=1000, effective_xp=1000
      // fraction=0.6 → adjustedBaseXP=-600, adjustedEffectiveXP=-600
      setupClawbackMocks(1000, 1000, 0.6);

      await XPService.clawbackXP(userId, escrowId, 'dispute_partial', 0.6);

      const insertCall = mockDb.query.mock.calls[1]; // second call is the INSERT
      const params = insertCall[1] as unknown[];
      // params: [userId, escrowId, taskId, reason, adjustedBaseXP, adjustedEffectiveXP, xpToDeduct]
      const adjustedBaseXP = params[4] as number;
      const adjustedEffectiveXP = params[5] as number;
      const xpToDeduct = params[6] as number;

      expect(adjustedBaseXP).toBe(-600);       // -Math.round(1000 * 0.6)
      expect(adjustedEffectiveXP).toBe(-600);  // -xpToDeduct
      expect(xpToDeduct).toBe(600);
    });

    it('records full amounts when fraction=1.0 (full clawback)', async () => {
      setupClawbackMocks(500, 750, 1.0);

      await XPService.clawbackXP(userId, escrowId, 'dispute_full', 1.0);

      const insertCall = mockDb.query.mock.calls[1];
      const params = insertCall[1] as unknown[];
      const adjustedBaseXP = params[4] as number;
      const adjustedEffectiveXP = params[5] as number;
      const xpToDeduct = params[6] as number;

      expect(adjustedBaseXP).toBe(-500);   // full base
      expect(adjustedEffectiveXP).toBe(-750); // full effective
      expect(xpToDeduct).toBe(750);
    });

    it('records proportional amounts for a 25% partial clawback with multiplied XP', async () => {
      // base_xp=400, effective_xp=1000 (multiplied by streak/trust), fraction=0.25
      setupClawbackMocks(400, 1000, 0.25);

      await XPService.clawbackXP(userId, escrowId, 'dispute_quarter', 0.25);

      const insertCall = mockDb.query.mock.calls[1];
      const params = insertCall[1] as unknown[];
      const adjustedBaseXP = params[4] as number;
      const adjustedEffectiveXP = params[5] as number;
      const xpToDeduct = params[6] as number;

      expect(adjustedBaseXP).toBe(-100);    // -Math.round(400 * 0.25)
      expect(adjustedEffectiveXP).toBe(-250); // -Math.round(1000 * 0.25)
      expect(xpToDeduct).toBe(250);
    });

    it('skips clawback when no award exists for the escrow', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await XPService.clawbackXP(userId, 'no-escrow', 'dispute_full', 1.0);

      // Only the SELECT was called — no INSERT, no UPDATE
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('skips clawback when fraction rounds to 0 XP deducted', async () => {
      // effective_xp=1, fraction=0.1 → Math.round(1 * 0.1) = 0 → early exit
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ledger-1', base_xp: 1, effective_xp: 1, task_id: taskId }],
        rowCount: 1,
      } as never);

      await XPService.clawbackXP(userId, escrowId, 'dispute_tiny', 0.1);

      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });

    it('is idempotent — does not deduct again when clawback row already exists', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{ id: 'ledger-1', base_xp: 200, effective_xp: 200, task_id: taskId }],
        rowCount: 1,
      } as never);
      // INSERT returns rowCount=0 (ON CONFLICT DO NOTHING — already exists)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

      await XPService.clawbackXP(userId, escrowId, 'dispute_full', 1.0);

      // Only SELECT + INSERT — no UPDATE users
      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
  });
});
