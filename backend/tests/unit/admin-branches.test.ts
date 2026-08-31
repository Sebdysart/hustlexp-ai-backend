/**
 * Admin Router Branch Coverage Tests
 *
 * Targets uncovered branches in admin.ts:
 * - setUserBan/setSuspension: terminal authority hold before side effects
 * - revenueBreakdown: all parsed fields, zero values
 * - aiCostSummary: model breakdown, empty breakdown, zero cost
 * - escrowOverride: terminal authority hold for release and refund
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

function resetRouterMocks() {
  vi.clearAllMocks();
  mockDb.query.mockReset();
  mockDb.transaction.mockImplementation(async (work: any) => work(mockDb.query));
}

// ---------------------------------------------------------------------------
// setUserBan
// ---------------------------------------------------------------------------

describe('admin.setUserBan branches', () => {
  beforeEach(resetRouterMocks);

  it.each([true, false])('terminally holds banned=%s before any sanction or recovery write', async (banned) => {
    prependAdminCheck();
    await expect(makeAdminCaller().setUserBan({
      userId: USER_UUID,
      banned,
      reason: 'Sanction requires a separately approved authority command.',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(issueDeactivationAppealRight).not.toHaveBeenCalled();
    expect(mockEscrowService.refund).not.toHaveBeenCalled();
    expect(mockEscrowService.lockForDispute).not.toHaveBeenCalled();
  });
});

describe('admin.setSuspension branches', () => {
  beforeEach(resetRouterMocks);

  it.each([true, false])('terminally holds suspended=%s before any standing write', async (suspended) => {
    prependAdminCheck();
    await expect(makeAdminCaller().setSuspension({
      userId: USER_UUID,
      suspended,
      reason: 'Standing changes require a separately approved authority command.',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockDb.transaction).not.toHaveBeenCalled();
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockEscrowService.refund).not.toHaveBeenCalled();
    expect(mockEscrowService.lockForDispute).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// revenueBreakdown
// ---------------------------------------------------------------------------

describe('admin.revenueBreakdown branches', () => {
  beforeEach(resetRouterMocks);

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
  beforeEach(resetRouterMocks);

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
  beforeEach(resetRouterMocks);

  it.each(['force_release', 'force_refund'] as const)(
    'terminally holds %s before any escrow service or audit mutation',
    async (action) => {
      prependAdminCheck();
      await expect(makeAdminCaller().escrowOverride({
        escrowId: ESC_UUID,
        action,
        reason: 'Escrow overrides require a separately approved authority command.',
      })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(mockEscrowService.release).not.toHaveBeenCalled();
      expect(mockEscrowService.refund).not.toHaveBeenCalled();
      expect(mockDb.query).toHaveBeenCalledTimes(1);
    },
  );
});

// ---------------------------------------------------------------------------
// listUsers — additional branches
// ---------------------------------------------------------------------------

describe('admin.listUsers — isBanned filter branches', () => {
  beforeEach(resetRouterMocks);

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
  beforeEach(resetRouterMocks);

  it('holds role grants before hierarchy lookup or any role write', async () => {
    prependAdminCheck();

    await expect(makeAdminCaller().grantAdminRole({
      userId: USER_UUID,
      role: 'support',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query.mock.calls.every(([sql]) => !String(sql).includes('INSERT INTO admin_roles'))).toBe(true);
  });

  it('holds role revocation before hierarchy lookup or any role write', async () => {
    prependAdminCheck();

    await expect(makeAdminCaller().revokeAdminRole({
      userId: USER_UUID,
      role: 'admin',
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(mockDb.query.mock.calls.every(([sql]) => !String(sql).includes('DELETE FROM admin_roles'))).toBe(true);
  });
});
