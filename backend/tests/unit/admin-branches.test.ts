/**
 * Admin Router Branch Coverage Tests
 *
 * Targets uncovered branches in admin.ts:
 * - setUserBan: NOT_FOUND when user not found
 * - revenueBreakdown: all parsed fields, zero values
 * - aiCostSummary: model breakdown, empty breakdown, zero cost
 * - escrowOverride: NOT_FOUND, force_release vs force_refund enum
 * - listUsers: isBanned=false filter (distinct from undefined), total fallback '0'
 * - listTasks: no state filter (no extra condition)
 * - listDisputes: no status filter
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const query = vi.fn();
  return { db: { query, transaction: vi.fn(async (work) => work(query)) } };
});

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  authLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../src/services/EscrowService', () => ({
  EscrowService: {
    release: vi.fn(),
    refund: vi.fn(),
    lockForDispute: vi.fn(),
  },
}));

vi.mock('../../src/services/WorkerStandingDecisionService', () => ({
  issueDeactivationAppealRight: vi.fn().mockResolvedValue({
    decisionId: 'standing-decision-1', appealDeadlineAt: 'later', appealPath: '/earn/appeal/test', newlyIssued: true,
  }),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { EscrowService } from '../../src/services/EscrowService';
import { issueDeactivationAppealRight } from '../../src/services/WorkerStandingDecisionService';
import { adminRouter } from '../../src/routers/admin';

const mockDb = vi.mocked(db);
const mockEscrowService = vi.mocked(EscrowService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_UUID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ESC_UUID   = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makeAdminCaller() {
  return adminRouter.createCaller({
    user: {
      id: ADMIN_UUID,
      email: 'admin@test.com',
      full_name: 'Admin',
      role: 'admin',
      firebase_uid: 'fb-admin',
    } as any,
    firebaseUid: 'fb-admin',
  });
}

/** Prepend the admin_roles check that adminProcedure middleware requires. */
function prependAdminCheck() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
}

// ---------------------------------------------------------------------------
// setUserBan
// ---------------------------------------------------------------------------

describe('admin.setUserBan branches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns updated row on success (ban=true)', async () => {
    prependAdminCheck();
    // SELECT current status under lock
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: USER_UUID, is_banned: false, trust_tier: 2, default_mode: 'worker' }], rowCount: 1,
    } as any);
    // UPDATE users SET is_banned
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: USER_UUID, is_banned: true }],
      rowCount: 1,
    } as any);
    // INSERT admin_actions
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // GG1 fix: SELECT firebase_uid for Redis revocation key namespace
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-test-uid' }], rowCount: 1 } as any);
    // LL6 fix — Bucket A: SELECT idle FUNDED escrows (task NOT in active states) → refund
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // LL6 fix — Bucket B: SELECT active FUNDED escrows (task IN active states) → lockForDispute
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // UPDATE tasks SET state = 'CANCELLED' for OPEN tasks
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeAdminCaller().setUserBan({
      userId: USER_UUID,
      banned: true,
    });

    expect(result.is_banned).toBe(true);
    expect(result.id).toBe(USER_UUID);
    expect(issueDeactivationAppealRight).toHaveBeenCalledWith(expect.objectContaining({
      workerId: USER_UUID, currentTier: 2, decisionSource: 'ADMIN',
    }));
  });

  it('returns updated row on success (ban=false)', async () => {
    prependAdminCheck();
    // SELECT current status under lock
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: USER_UUID, is_banned: true, trust_tier: 2, default_mode: 'worker' }], rowCount: 1,
    } as any);
    // UPDATE users SET is_banned
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: USER_UUID, is_banned: false }],
      rowCount: 1,
    } as any);
    // INSERT admin_actions audit log
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // GG1 fix: SELECT firebase_uid for Redis revocation key
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-test-uid' }], rowCount: 1 } as any);

    const result = await makeAdminCaller().setUserBan({
      userId: USER_UUID,
      banned: false,
    });

    expect(result.is_banned).toBe(false);
  });

  it('throws NOT_FOUND when user not found', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeAdminCaller().setUserBan({ userId: USER_UUID, banned: true }),
    ).rejects.toThrow('User not found');
  });

  it('includes optional reason in call', async () => {
    prependAdminCheck();
    // SELECT current status under lock
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: USER_UUID, is_banned: false, trust_tier: 2, default_mode: 'worker' }], rowCount: 1,
    } as any);
    // UPDATE users SET is_banned
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: USER_UUID, is_banned: true }],
      rowCount: 1,
    } as any);
    // INSERT admin_actions
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    // GG1 fix: SELECT firebase_uid for Redis revocation key namespace
    mockDb.query.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-test-uid' }], rowCount: 1 } as any);
    // LL6 fix — Bucket A: SELECT idle FUNDED escrows (task NOT in active states) → refund
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // LL6 fix — Bucket B: SELECT active FUNDED escrows (task IN active states) → lockForDispute
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // UPDATE tasks SET state = 'CANCELLED' for OPEN tasks
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    // Should not throw — reason is optional
    const result = await makeAdminCaller().setUserBan({
      userId: USER_UUID,
      banned: true,
      reason: 'Violated terms of service',
    });

    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// revenueBreakdown
// ---------------------------------------------------------------------------

describe('admin.revenueBreakdown branches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns correctly parsed integers for all aggregates', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        total_escrow_funded:   '150000',
        total_escrow_released: '120000',
        total_platform_fees:   '6000',
        task_count:            '42',
      }],
      rowCount: 1,
    } as any);

    const result = await makeAdminCaller().revenueBreakdown({ days: 7 });

    expect(result.totalEscrowFunded).toBe(150000);
    expect(result.totalEscrowReleased).toBe(120000);
    expect(result.totalPlatformFees).toBe(6000);
    expect(result.taskCount).toBe(42);
    expect(result.periodDays).toBe(7);
  });

  it('returns zero values when no transactions exist', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        total_escrow_funded:   '0',
        total_escrow_released: '0',
        total_platform_fees:   '0',
        task_count:            '0',
      }],
      rowCount: 1,
    } as any);

    const result = await makeAdminCaller().revenueBreakdown({ days: 30 });

    expect(result.totalEscrowFunded).toBe(0);
    expect(result.taskCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// aiCostSummary
// ---------------------------------------------------------------------------

describe('admin.aiCostSummary branches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mapped model breakdown', async () => {
    prependAdminCheck();
    // Aggregate row
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        total_cost_cents: '5000',
        total_requests:   '50',
        avg_cost_cents:   '100.0',
      }],
      rowCount: 1,
    } as any);
    // Model breakdown
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { model: 'gpt-4', request_count: '30', total_cost: '4000' },
        { model: 'gpt-3.5', request_count: '20', total_cost: '1000' },
      ],
      rowCount: 2,
    } as any);

    const result = await makeAdminCaller().aiCostSummary({ days: 30 });

    expect(result.totalCostCents).toBe(5000);
    expect(result.totalRequests).toBe(50);
    expect(result.avgCostCents).toBe(100.0);
    expect(result.modelBreakdown).toHaveLength(2);
    expect(result.modelBreakdown[0]).toEqual({
      model: 'gpt-4',
      requestCount: 30,
      totalCost: 4000,
    });
    expect(result.modelBreakdown[1]).toEqual({
      model: 'gpt-3.5',
      requestCount: 20,
      totalCost: 1000,
    });
  });

  it('returns empty model breakdown when no AI calls made', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        total_cost_cents: '0',
        total_requests:   '0',
        avg_cost_cents:   '0',
      }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeAdminCaller().aiCostSummary({ days: 30 });

    expect(result.totalCostCents).toBe(0);
    expect(result.modelBreakdown).toHaveLength(0);
  });

  it('parses avgCostCents as float (not int)', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        total_cost_cents: '111',
        total_requests:   '3',
        avg_cost_cents:   '37.0',
      }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeAdminCaller().aiCostSummary({ days: 1 });

    expect(result.avgCostCents).toBeCloseTo(37.0);
    expect(typeof result.avgCostCents).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// escrowOverride
// ---------------------------------------------------------------------------

describe('admin.escrowOverride branches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('force_release is denied before canonical mutation and writes one actor-attributed failure audit', async () => {
    prependAdminCheck();
    mockEscrowService.release.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'INVALID_STATE',
        message: 'Administrative release cannot create RELEASED economics',
      },
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(makeAdminCaller().escrowOverride({
        escrowId: ESC_UUID,
        action: 'force_release',
        reason: 'Admin override: work completed off-platform',
      }))
      .rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockEscrowService.release).toHaveBeenCalledWith({
      escrowId: ESC_UUID,
      adminOverride: true,
      reason: 'Admin override: work completed off-platform',
    });
    expect(mockEscrowService.refund).not.toHaveBeenCalled();

    const financialWrites = (mockDb.query as any).mock.calls.slice(1);
    expect(financialWrites).toHaveLength(1);
    const [sql, params] = financialWrites[0];
    expect(sql).toContain('INSERT INTO admin_actions');
    expect(sql).not.toContain('UPDATE disputes');
    expect(params).toEqual([
      ADMIN_UUID,
      'escrow_override_failed',
      JSON.stringify({
        override_type: 'force_release',
        reason: 'Admin override: work completed off-platform',
      }),
      ESC_UUID,
      expect.stringContaining('Administrative release cannot create RELEASED economics'),
    ]);
  });

  it('force_release fails closed when its mandatory denial audit cannot be persisted', async () => {
    prependAdminCheck();
    mockEscrowService.release.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_STATE', message: 'Administrative release denied' },
    } as any);
    mockDb.query.mockRejectedValueOnce(new Error('audit storage unavailable'));

    await expect(makeAdminCaller().escrowOverride({
      escrowId: ESC_UUID,
      action: 'force_release',
      reason: 'Attempt while audit is unavailable',
    })).rejects.toThrow('audit storage unavailable');

    expect(mockEscrowService.refund).not.toHaveBeenCalled();
    expect((mockDb.query as any).mock.calls).toHaveLength(2);
    expect(String((mockDb.query as any).mock.calls[1]?.[0])).toContain('INSERT INTO admin_actions');
  });

  it('force_refund is denied before money effects and writes one failure audit', async () => {
    prependAdminCheck();
    mockEscrowService.refund.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'INVALID_STATE',
        message: 'Administrative refund cannot create provider or REFUNDED economics',
      },
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);

    await expect(makeAdminCaller().escrowOverride({
      escrowId: ESC_UUID,
      action: 'force_refund',
      reason: 'Refund requested',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockEscrowService.refund).toHaveBeenCalledWith({
      escrowId: ESC_UUID,
      adminOverride: true,
      reason: 'Refund requested',
    });
    expect(mockEscrowService.release).not.toHaveBeenCalled();
    expect((mockDb.query as any).mock.calls).toHaveLength(2);
    const [sql, params] = (mockDb.query as any).mock.calls[1];
    expect(sql).toContain('INSERT INTO admin_actions');
    expect(sql).not.toContain('UPDATE disputes');
    expect(params[0]).toBe(ADMIN_UUID);
    expect(params[1]).toBe('escrow_override_failed');
    expect(JSON.parse(params[2])).toEqual({
      override_type: 'force_refund',
      reason: 'Refund requested',
    });
    expect(params[3]).toBe(ESC_UUID);
  });

  it('throws NOT_FOUND when EscrowService returns NOT_FOUND failure', async () => {
    // Bug 2 fix: error code is now mapped correctly — NOT_FOUND code → tRPC NOT_FOUND.
    prependAdminCheck();
    // The failure audit log INSERT also fires (fire-and-forget) — mock it so the
    // db mock queue is not left in an unexpected state.
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    mockEscrowService.release.mockResolvedValueOnce({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Escrow not found or not in overridable state' },
    } as any);

    await expect(
      makeAdminCaller().escrowOverride({
        escrowId: ESC_UUID,
        action: 'force_release',
        reason: 'Trying to override released escrow',
      }),
    ).rejects.toThrow('Escrow not found or not in overridable state');
  });

  it('force_refund fails closed when the denial audit is unavailable', async () => {
    prependAdminCheck();
    mockEscrowService.refund.mockResolvedValueOnce({
      success: false,
      error: { code: 'INVALID_STATE', message: 'Administrative refund denied' },
    } as any);
    mockDb.query.mockRejectedValueOnce(new Error('audit storage unavailable'));

    await expect(makeAdminCaller().escrowOverride({
      escrowId: ESC_UUID,
      action: 'force_refund',
      reason: 'Test',
    })).rejects.toThrow('audit storage unavailable');

    expect((mockDb.query as any).mock.calls).toHaveLength(2);
    expect(String((mockDb.query as any).mock.calls[1]?.[0])).toContain('INSERT INTO admin_actions');
  });
});

// ---------------------------------------------------------------------------
// listUsers — additional branches
// ---------------------------------------------------------------------------

describe('admin.listUsers — isBanned filter branches', () => {
  beforeEach(() => vi.clearAllMocks());

  it('adds is_banned condition when isBanned=false', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);

    await makeAdminCaller().listUsers({ isBanned: false });

    const [sql, params] = (mockDb.query as any).mock.calls[1];
    expect(sql).toContain('is_banned');
    expect(params).toContain(false);
  });

  it('does NOT add is_banned WHERE condition when isBanned is undefined', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);

    await makeAdminCaller().listUsers({});

    const [sql, params] = (mockDb.query as any).mock.calls[1];
    // The SELECT column list always has COALESCE(u.is_banned, ...) but the WHERE
    // clause should only have the is_banned = $N condition when isBanned is defined.
    // When isBanned is undefined, params contains only limit and offset (2 values).
    expect(params).toHaveLength(2); // only limit and offset, no is_banned param
    // Confirm no extra conditions beyond "1=1"
    const whereClause = sql.slice(sql.indexOf('WHERE'));
    expect(whereClause).not.toMatch(/is_banned\s*=/);
  });

  it('parses total as 0 when count row missing', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // Simulate count row with undefined count field (edge case)
    mockDb.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any);

    const result = await makeAdminCaller().listUsers({});
    // parseInt(undefined || '0', 10) === 0
    expect(result.total).toBe(0);
  });
});

describe('admin role hierarchy', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects grant-based replacement of an existing founder role before any write', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'founder' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'founder' }], rowCount: 1 } as any);

    await expect(makeAdminCaller().grantAdminRole({
      userId: USER_UUID,
      role: 'support',
    })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(mockDb.query).toHaveBeenCalledTimes(3);
    expect(mockDb.query.mock.calls.every(([sql]) => !String(sql).includes('INSERT INTO admin_roles'))).toBe(true);
  });

  it('rejects peer administrator revocation before user or role writes', async () => {
    prependAdminCheck();
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);

    await expect(makeAdminCaller().revokeAdminRole({
      userId: USER_UUID,
      role: 'admin',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });

    expect(mockDb.query).toHaveBeenCalledTimes(2);
    expect(mockDb.query.mock.calls.every(([sql]) => !String(sql).includes('DELETE FROM admin_roles'))).toBe(true);
  });
});
