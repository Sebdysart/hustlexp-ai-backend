import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks (BEFORE imports) ──────────────────────────────────────────────────

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
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('../../src/services/AlphaInstrumentation', () => ({
  AlphaInstrumentation: { emitTrustDeltaApplied: vi.fn().mockResolvedValue(undefined) },
}));

// No Redis configured — getXPRedis() returns null
vi.mock('../../src/config', () => ({
  config: { redis: { restUrl: '', restToken: '' } },
}));

vi.mock('@upstash/redis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    get: vi.fn().mockResolvedValue(null),
    incrby: vi.fn().mockResolvedValue(1),
    expire: vi.fn().mockResolvedValue(1),
  })),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { XPService } from '../../src/services/XPService';
import { db, isInvariantViolation, isUniqueViolation } from '../../src/db';
import { AlphaInstrumentation } from '../../src/services/AlphaInstrumentation';

const mockQuery = db.query as ReturnType<typeof vi.fn>;
const mockTx = db.serializableTransaction as ReturnType<typeof vi.fn>;
const mockIsInvariant = isInvariantViolation as ReturnType<typeof vi.fn>;
const mockIsUnique = isUniqueViolation as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockIsInvariant.mockReturnValue(false);
  mockIsUnique.mockReturnValue(false);
});

// ═══════════════════════════════════════════════════════════════════════════
// calculateAward
// ═══════════════════════════════════════════════════════════════════════════
describe('XPService.calculateAward', () => {
  it('returns NOT_FOUND when user does not exist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await XPService.calculateAward('user-404', 100);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('calculates XP with ROOKIE trust tier (1.0x) and no streak', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ current_streak: 0, trust_tier: 1 }],
    });

    const result = await XPService.calculateAward('user-1', 100);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streakMultiplier).toBe(1.0);
      expect(result.data.trustMultiplier).toBe(1.0);
      expect(result.data.liveModeMultiplier).toBe(1.0);
      expect(result.data.effectiveXP).toBe(100);
    }
  });

  it('calculates XP with VERIFIED trust tier (1.5x)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ current_streak: 0, trust_tier: 2 }],
    });

    const result = await XPService.calculateAward('user-1', 100);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trustMultiplier).toBe(1.5);
      expect(result.data.effectiveXP).toBe(150);
    }
  });

  it('calculates XP with TRUSTED trust tier (2.0x)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ current_streak: 0, trust_tier: 3 }],
    });

    const result = await XPService.calculateAward('user-1', 100);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trustMultiplier).toBe(2.0);
      expect(result.data.effectiveXP).toBe(200);
    }
  });

  it('calculates XP with ELITE trust tier (2.0x same as TRUSTED)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ current_streak: 0, trust_tier: 4 }],
    });

    const result = await XPService.calculateAward('user-1', 100);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trustMultiplier).toBe(2.0);
    }
  });

  it('applies streak multiplier: 1.0 + streak * 0.05', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ current_streak: 10, trust_tier: 1 }],
    });

    const result = await XPService.calculateAward('user-1', 100);
    expect(result.success).toBe(true);
    if (result.success) {
      // streak=10: 1.0 + 10*0.05 = 1.5
      expect(result.data.streakMultiplier).toBe(1.5);
      expect(result.data.effectiveXP).toBe(150);
    }
  });

  it('caps streak multiplier at 2.0 for large streaks', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ current_streak: 100, trust_tier: 1 }],
    });

    const result = await XPService.calculateAward('user-1', 100);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.streakMultiplier).toBe(2.0);
      expect(result.data.effectiveXP).toBe(200);
    }
  });

  it('applies live mode 1.25x multiplier when task mode is LIVE', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ current_streak: 0, trust_tier: 1 }] })
      .mockResolvedValueOnce({ rows: [{ mode: 'LIVE' }] });

    const result = await XPService.calculateAward('user-1', 100, 'task-live');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.liveModeMultiplier).toBe(1.25);
      expect(result.data.effectiveXP).toBe(125);
    }
  });

  it('does not apply live mode when task mode is STANDARD', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ current_streak: 0, trust_tier: 1 }] })
      .mockResolvedValueOnce({ rows: [{ mode: 'STANDARD' }] });

    const result = await XPService.calculateAward('user-1', 100, 'task-std');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.liveModeMultiplier).toBe(1.0);
    }
  });

  it('returns CALCULATION_ERROR on DB failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB failure'));

    const result = await XPService.calculateAward('user-1', 100);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CALCULATION_ERROR');
    }
  });

  it('handles unknown trust tier defaulting to 1.0x', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ current_streak: 0, trust_tier: 99 }],
    });

    const result = await XPService.calculateAward('user-1', 100);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.trustMultiplier).toBe(1.0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// awardXP
// ═══════════════════════════════════════════════════════════════════════════
describe('XPService.awardXP', () => {
  function makeXPParams(overrides: object = {}) {
    return { userId: 'user-1', taskId: 'task-1', escrowId: 'escrow-1', baseXP: 100, ...overrides };
  }

  function makeLedgerRow(overrides: object = {}) {
    return {
      id: 'xp-entry-1',
      user_id: 'user-1',
      task_id: 'task-1',
      escrow_id: 'escrow-1',
      base_xp: 100,
      streak_multiplier: 1.0,
      trust_multiplier: 1.0,
      live_mode_multiplier: 1.0,
      effective_xp: 100,
      reason: 'task_completion',
      user_xp_before: 0,
      user_xp_after: 100,
      user_level_before: 1,
      user_level_after: 1,
      user_streak_at_award: 0,
      awarded_at: new Date(),
      ...overrides,
    };
  }

  it('awards XP successfully when all checks pass', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // checkDailyXPCap DB fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // checkVelocity

    const ledgerRow = makeLedgerRow();
    mockTx.mockImplementationOnce(async (fn: Function) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ xp_total: 0, current_level: 1, current_streak: 0, trust_tier: 1 }] })
        .mockResolvedValueOnce({ rows: [{ mode: 'STANDARD' }] })
        .mockResolvedValueOnce({ rows: [ledgerRow] })
        .mockResolvedValueOnce({ rowCount: 1 });
      return fn(txQuery);
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'worker' }] });

    const result = await XPService.awardXP(makeXPParams());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.effective_xp).toBe(100);
    }
  });

  it('returns NOT_FOUND when user is missing inside transaction', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // checkDailyXPCap DB fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // checkVelocity

    mockTx.mockImplementationOnce(async (fn: Function) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [] }); // user not found
      return fn(txQuery);
    });

    const result = await XPService.awardXP(makeXPParams());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('NOT_FOUND');
    }
  });

  it('returns HX101 (INV_1_VIOLATION) when escrow is not released', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // checkDailyXPCap DB fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // checkVelocity
    mockIsInvariant.mockReturnValue(true);
    mockTx.mockRejectedValueOnce({ code: 'HX101' });

    const result = await XPService.awardXP(makeXPParams());
    expect(result.success).toBe(false);
    if (!result.success) {
      // ErrorCodes.INV_1_VIOLATION = 'HX101'
      expect(result.error.code).toBe('HX101');
    }
  });

  it('returns 23505 (INV_5_VIOLATION) when XP already awarded for this escrow', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // checkDailyXPCap DB fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // checkVelocity
    mockIsUnique.mockReturnValue(true);
    mockTx.mockRejectedValueOnce(new Error('unique violation'));

    const result = await XPService.awardXP(makeXPParams());
    expect(result.success).toBe(false);
    if (!result.success) {
      // ErrorCodes.INV_5_VIOLATION = '23505'
      expect(result.error.code).toBe('23505');
      expect(result.error.message).toContain('escrow-1');
    }
  });

  it('returns DB_ERROR on unexpected transaction failure', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // checkDailyXPCap DB fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // checkVelocity
    mockTx.mockRejectedValueOnce(new Error('connection lost'));

    const result = await XPService.awardXP(makeXPParams());
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
      expect(result.error.message).toBe('connection lost');
    }
  });

  it('causes a level-up from level 1 to level 2 (100 XP threshold)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // checkDailyXPCap DB fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // checkVelocity

    // User has 50 XP, base 60 pushes to 110 > 100 threshold -> level 2
    const ledgerRow = makeLedgerRow({
      base_xp: 60, effective_xp: 60,
      user_xp_before: 50, user_xp_after: 110,
      user_level_before: 1, user_level_after: 2,
    });

    mockTx.mockImplementationOnce(async (fn: Function) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ xp_total: 50, current_level: 1, current_streak: 0, trust_tier: 1 }] })
        .mockResolvedValueOnce({ rows: [{ mode: 'STANDARD' }] })
        .mockResolvedValueOnce({ rows: [ledgerRow] })
        .mockResolvedValueOnce({ rowCount: 1 });
      return fn(txQuery);
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'worker' }] });

    const result = await XPService.awardXP({ ...makeXPParams(), baseXP: 60 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.user_level_after).toBe(2);
      expect(result.data.user_xp_after).toBe(110);
    }
  });

  it('flags velocity as suspicious but still awards XP when baseXP <= 1000 (advisory)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // checkDailyXPCap DB fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '6' }] }); // suspicious: >5 but baseXP=100 (advisory)

    const ledgerRow = makeLedgerRow();
    mockTx.mockImplementationOnce(async (fn: Function) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ xp_total: 0, current_level: 1, current_streak: 0, trust_tier: 1 }] })
        .mockResolvedValueOnce({ rows: [{ mode: 'STANDARD' }] })
        .mockResolvedValueOnce({ rows: [ledgerRow] })
        .mockResolvedValueOnce({ rowCount: 1 });
      return fn(txQuery);
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'worker' }] });

    const result = await XPService.awardXP(makeXPParams());
    expect(result.success).toBe(true); // velocity check is advisory
  });

  it('emits trust delta with role=poster when user default_mode is poster', async () => {
    const emitSpy = AlphaInstrumentation.emitTrustDeltaApplied as ReturnType<typeof vi.fn>;

    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // checkDailyXPCap DB fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // checkVelocity

    const ledgerRow = makeLedgerRow();
    mockTx.mockImplementationOnce(async (fn: Function) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ xp_total: 0, current_level: 1, current_streak: 0, trust_tier: 1 }] })
        .mockResolvedValueOnce({ rows: [{ mode: 'STANDARD' }] })
        .mockResolvedValueOnce({ rows: [ledgerRow] })
        .mockResolvedValueOnce({ rowCount: 1 });
      return fn(txQuery);
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'poster' }] });

    await XPService.awardXP(makeXPParams());
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'poster', delta_type: 'xp' })
    );
  });

  it('does not block when AlphaInstrumentation.emitTrustDeltaApplied throws', async () => {
    (AlphaInstrumentation.emitTrustDeltaApplied as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('instrumentation down'));

    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // checkDailyXPCap DB fallback
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] }); // checkVelocity

    const ledgerRow = makeLedgerRow();
    mockTx.mockImplementationOnce(async (fn: Function) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [{ xp_total: 0, current_level: 1, current_streak: 0, trust_tier: 1 }] })
        .mockResolvedValueOnce({ rows: [{ mode: 'STANDARD' }] })
        .mockResolvedValueOnce({ rows: [ledgerRow] })
        .mockResolvedValueOnce({ rowCount: 1 });
      return fn(txQuery);
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'worker' }] });

    const result = await XPService.awardXP(makeXPParams());
    expect(result.success).toBe(true); // instrumentation failure is silent
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getHistory
// ═══════════════════════════════════════════════════════════════════════════
describe('XPService.getHistory', () => {
  it('returns XP history entries for a user', async () => {
    const entry = {
      id: 'xp-1', user_id: 'user-1', task_id: 'task-1',
      escrow_id: 'escrow-1', effective_xp: 100, awarded_at: new Date(),
    };
    mockQuery.mockResolvedValueOnce({ rows: [entry] });

    const result = await XPService.getHistory('user-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe('xp-1');
    }
  });

  it('returns empty array when no history', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await XPService.getHistory('user-new');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });

  it('returns DB_ERROR on query failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('timeout'));

    const result = await XPService.getHistory('user-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getByTask
// ═══════════════════════════════════════════════════════════════════════════
describe('XPService.getByTask', () => {
  it('returns the XP ledger entry for a task', async () => {
    const entry = { id: 'xp-1', task_id: 'task-1', effective_xp: 150 };
    mockQuery.mockResolvedValueOnce({ rows: [entry] });

    const result = await XPService.getByTask('task-1');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toBeNull();
      expect(result.data?.effective_xp).toBe(150);
    }
  });

  it('returns null when no XP entry exists for task', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await XPService.getByTask('task-no-xp');
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBeNull();
    }
  });

  it('returns DB_ERROR on query failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB down'));

    const result = await XPService.getByTask('task-1');
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// checkDailyXPCap
// ═══════════════════════════════════════════════════════════════════════════
describe('XPService.checkDailyXPCap', () => {
  it('falls back to DB query when redis not configured (FIX 1: cap always enforced)', async () => {
    // With Redis unconfigured, checkDailyXPCap queries xp_ledger for today's total
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '0' }] }); // 0 XP earned today
    const result = await XPService.checkDailyXPCap('user-1');
    expect(result.allowed).toBe(true); // 0 earned < 10000 cap
    expect(result.earned).toBe(0);
    expect(result.cap).toBe(10000);
    expect(result.remaining).toBe(10000);
  });

  it('blocks when DB shows daily cap reached', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ total: '10000' }] }); // already at cap
    const result = await XPService.checkDailyXPCap('user-1', 100);
    expect(result.allowed).toBe(false); // 10000 + 100 > 10000
    expect(result.earned).toBe(10000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// trackDailyXP
// ═══════════════════════════════════════════════════════════════════════════
describe('XPService.trackDailyXP', () => {
  it('returns without error when redis not configured', async () => {
    await expect(XPService.trackDailyXP('user-1', 100)).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// checkVelocity
// ═══════════════════════════════════════════════════════════════════════════
describe('XPService.checkVelocity', () => {
  it('returns suspicious=false when fewer than 5 recent events', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });

    const result = await XPService.checkVelocity('user-1');
    expect(result.suspicious).toBe(false);
    expect(result.recentEvents).toBe(3);
  });

  it('returns suspicious=true when more than 5 recent events', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '6' }] });

    const result = await XPService.checkVelocity('user-1');
    expect(result.suspicious).toBe(true);
    expect(result.recentEvents).toBe(6);
  });

  it('returns suspicious=false on DB error (fail open)', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await XPService.checkVelocity('user-1');
    expect(result.suspicious).toBe(false);
    expect(result.recentEvents).toBe(0);
  });

  it('handles missing count field gracefully (defaults to 0)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{}] });

    const result = await XPService.checkVelocity('user-1');
    expect(result.suspicious).toBe(false);
    expect(result.recentEvents).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getDailyLeaderboard
// ═══════════════════════════════════════════════════════════════════════════
describe('XPService.getDailyLeaderboard', () => {
  it('returns ranked leaderboard entries', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [
        { user_id: 'user-a', name: 'Alice', xp_earned: '500' },
        { user_id: 'user-b', name: 'Bob',   xp_earned: '300' },
      ],
    });

    const result = await XPService.getDailyLeaderboard(25);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0]).toMatchObject({ userId: 'user-a', xpEarned: 500, rank: 1 });
      expect(result.data[1]).toMatchObject({ userId: 'user-b', xpEarned: 300, rank: 2 });
    }
  });

  it('uses default limit of 25 when not specified', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await XPService.getDailyLeaderboard();
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT'),
      expect.arrayContaining([25]),
    );
  });

  it('falls back to Anonymous when user name is null', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ user_id: 'user-x', name: null, xp_earned: '200' }],
    });

    const result = await XPService.getDailyLeaderboard();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[0].name).toBe('Anonymous');
    }
  });

  it('returns empty array when no XP awarded today', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await XPService.getDailyLeaderboard();
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });

  it('returns DB_ERROR on query failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('query failed'));

    const result = await XPService.getDailyLeaderboard();
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('DB_ERROR');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// clawbackXP — FIX 2: idempotency on retry (unique constraint)
// ═══════════════════════════════════════════════════════════════════════════
describe('XPService.clawbackXP', () => {
  it('deducts XP when original award exists', async () => {
    // 1st query: find the original award
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'xp-1', effective_xp: 500, task_id: 'task-1' }],
    });
    // 2nd query: INSERT ... ON CONFLICT ... RETURNING — new row inserted
    mockQuery.mockResolvedValueOnce({ rowCount: 1, rows: [{ id: 'xp-clawback-1' }] });
    // 3rd query: UPDATE users SET xp_total
    mockQuery.mockResolvedValueOnce({
      rows: [{ xp_total: 0, current_level: 1 }],
    });

    await expect(
      XPService.clawbackXP('user-1', 'escrow-1', 'refund')
    ).resolves.not.toThrow();

    // The INSERT must have been called with ON CONFLICT clause
    const insertCall = mockQuery.mock.calls[1];
    expect(insertCall[0]).toContain('ON CONFLICT');
    expect(insertCall[0]).toContain('DO NOTHING');
  });

  it('is idempotent — second clawback call is a no-op (rowCount=0)', async () => {
    // 1st query: find the original award
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'xp-1', effective_xp: 500, task_id: 'task-1' }],
    });
    // 2nd query: INSERT conflicts — rowCount=0 (already applied)
    mockQuery.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    // No UPDATE should follow — if it does, the mock will return undefined and the
    // test will still pass, but we assert the UPDATE was NOT called.

    await expect(
      XPService.clawbackXP('user-1', 'escrow-1', 'refund')
    ).resolves.not.toThrow();

    // Only 2 queries: SELECT award + INSERT (no UPDATE since rowCount=0)
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('skips entirely when no XP award exists for the escrow', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] }); // no award found

    await expect(
      XPService.clawbackXP('user-1', 'escrow-none', 'refund')
    ).resolves.not.toThrow();

    expect(mockQuery).toHaveBeenCalledTimes(1); // only the SELECT
  });

  it('skips when xpToDeduct rounds to 0 (partial fraction of tiny award)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ id: 'xp-1', effective_xp: 1, task_id: 'task-1' }],
    });

    // fraction=0 means nothing to deduct — returns early before INSERT
    await expect(
      XPService.clawbackXP('user-1', 'escrow-1', 'refund', 0)
    ).resolves.not.toThrow();

    expect(mockQuery).toHaveBeenCalledTimes(1); // only the SELECT
  });
});
