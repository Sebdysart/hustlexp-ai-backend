/**
 * BetaDashboard Router Extra Unit Tests
 *
 * Covers branches NOT in betaDashboard-router.test.ts:
 * - getMetrics (success, service error)
 * - getStatus (success, service error)
 * - getKillSignals (success, service error)
 * - getRevenueSummary (success, service error)
 * - getMonthlyPnl (success, service error)
 * - verifyLedgerIntegrity (success, service error)
 * - getDisputeRate (success, service error)
 * - getDailyTaskCounts (success, DB rows mapped)
 * - getDailyRevenue (success, DB rows mapped)
 * - getActivityFeed (success, with amounts)
 * - getBetaConfig (success — reads from config)
 * - requestKillSwitchToggle (success — logs intent)
 * - getKillSwitchHistory (success, DB rows mapped)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/BetaService', () => ({
  BetaService: {
    getBetaMetrics: vi.fn(),
    getBetaStatus: vi.fn(),
    getKillSignals: vi.fn(),
    logBetaStateChange: vi.fn(),
  },
}));

vi.mock('../../src/services/RevenueService', () => ({
  RevenueService: {
    getRevenueSummary: vi.fn(),
    getMonthlyPnl: vi.fn(),
    verifyLedgerIntegrity: vi.fn(),
  },
}));

vi.mock('../../src/services/ChargebackService', () => ({
  ChargebackService: {
    getPlatformDisputeRate: vi.fn(),
  },
}));

vi.mock('../../src/config', () => ({
  config: {
    beta: {
      enabled: true,
      regionName: 'Seattle',
      bounds: { north: 47.9, south: 47.4, east: -121.9, west: -122.6 },
      center: { lat: 47.6, lng: -122.3 },
      radiusMiles: 25,
      startDate: '2025-01-01',
      endDate: '2025-06-01',
    },
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { betaDashboardRouter } from '../../src/routers/betaDashboard';
import { BetaService } from '../../src/services/BetaService';
import { RevenueService } from '../../src/services/RevenueService';
import { ChargebackService } from '../../src/services/ChargebackService';

const mockDb = vi.mocked(db);
const mockBeta = vi.mocked(BetaService);
const mockRevenue = vi.mocked(RevenueService);
const mockChargeback = vi.mocked(ChargebackService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADMIN_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_UUID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function makeAdminCaller() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return betaDashboardRouter.createCaller({
    user: {
      id: ADMIN_UUID,
      email: 'admin@hustlexp.com',
      full_name: 'Admin User',
      role: 'admin',
      firebase_uid: 'fb-admin',
    } as any,
    firebaseUid: 'fb-admin',
  });
}

function makeUserCaller() {
  return betaDashboardRouter.createCaller({
    user: {
      id: USER_UUID,
      email: 'user@hustlexp.com',
      full_name: 'Regular User',
      role: 'hustler',
      firebase_uid: 'fb-user',
    } as any,
    firebaseUid: 'fb-user',
  });
}

// ---------------------------------------------------------------------------
// getMetrics
// ---------------------------------------------------------------------------

describe('betaDashboard.getMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns metrics on success', async () => {
    const data = { tasksCreated: 10, gmv: 5000 };
    mockBeta.getBetaMetrics.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeAdminCaller().getMetrics({});

    expect(result).toEqual(data);
    expect(mockBeta.getBetaMetrics).toHaveBeenCalledWith(30);
  });

  it('uses custom windowDays', async () => {
    mockBeta.getBetaMetrics.mockResolvedValueOnce({ success: true, data: {} } as any);

    await makeAdminCaller().getMetrics({ windowDays: 7 });

    expect(mockBeta.getBetaMetrics).toHaveBeenCalledWith(7);
  });

  it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
    mockBeta.getBetaMetrics.mockResolvedValueOnce({
      success: false, error: { message: 'Metrics unavailable' },
    } as any);

    await expect(makeAdminCaller().getMetrics({})).rejects.toThrow('Metrics unavailable');
  });
});

// ---------------------------------------------------------------------------
// getStatus
// ---------------------------------------------------------------------------

describe('betaDashboard.getStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns status on success', async () => {
    const data = { hustlerCount: 5, posterCount: 3, remainingHustler: 95 };
    mockBeta.getBetaStatus.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeAdminCaller().getStatus();

    expect(result).toEqual(data);
  });

  it('throws on service failure', async () => {
    mockBeta.getBetaStatus.mockResolvedValueOnce({
      success: false, error: { message: 'Status error' },
    } as any);

    await expect(makeAdminCaller().getStatus()).rejects.toThrow('Status error');
  });
});

// ---------------------------------------------------------------------------
// getKillSignals
// ---------------------------------------------------------------------------

describe('betaDashboard.getKillSignals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns kill signals on success', async () => {
    const data = { signals: [], triggered: false };
    mockBeta.getKillSignals.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeAdminCaller().getKillSignals();

    expect(result).toEqual(data);
  });

  it('throws on service failure', async () => {
    mockBeta.getKillSignals.mockResolvedValueOnce({
      success: false, error: { message: 'Kill signal error' },
    } as any);

    await expect(makeAdminCaller().getKillSignals()).rejects.toThrow('Kill signal error');
  });
});

// ---------------------------------------------------------------------------
// getRevenueSummary
// ---------------------------------------------------------------------------

describe('betaDashboard.getRevenueSummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns revenue summary with default days', async () => {
    const data = [{ event_type: 'platform_fee', total: 1000 }];
    mockRevenue.getRevenueSummary.mockResolvedValueOnce({ success: true, data } as any);

    await makeAdminCaller().getRevenueSummary({});

    expect(mockRevenue.getRevenueSummary).toHaveBeenCalledWith(30);
  });

  it('uses custom days', async () => {
    mockRevenue.getRevenueSummary.mockResolvedValueOnce({ success: true, data: [] } as any);

    await makeAdminCaller().getRevenueSummary({ days: 7 });

    expect(mockRevenue.getRevenueSummary).toHaveBeenCalledWith(7);
  });

  it('throws on service failure', async () => {
    mockRevenue.getRevenueSummary.mockResolvedValueOnce({
      success: false, error: { message: 'Revenue error' },
    } as any);

    await expect(makeAdminCaller().getRevenueSummary({})).rejects.toThrow('Revenue error');
  });
});

// ---------------------------------------------------------------------------
// getMonthlyPnl
// ---------------------------------------------------------------------------

describe('betaDashboard.getMonthlyPnl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns P&L data', async () => {
    const data = [{ month: '2025-01', revenue: 5000 }];
    mockRevenue.getMonthlyPnl.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeAdminCaller().getMonthlyPnl({});

    expect(result).toEqual(data);
    expect(mockRevenue.getMonthlyPnl).toHaveBeenCalledWith(6);
  });

  it('uses custom months', async () => {
    mockRevenue.getMonthlyPnl.mockResolvedValueOnce({ success: true, data: [] } as any);

    await makeAdminCaller().getMonthlyPnl({ months: 12 });

    expect(mockRevenue.getMonthlyPnl).toHaveBeenCalledWith(12);
  });

  it('throws on service failure', async () => {
    mockRevenue.getMonthlyPnl.mockResolvedValueOnce({
      success: false, error: { message: 'P&L error' },
    } as any);

    await expect(makeAdminCaller().getMonthlyPnl({})).rejects.toThrow('P&L error');
  });
});

// ---------------------------------------------------------------------------
// verifyLedgerIntegrity
// ---------------------------------------------------------------------------

describe('betaDashboard.verifyLedgerIntegrity', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns integrity result', async () => {
    const data = { valid: true, discrepancy: 0 };
    mockRevenue.verifyLedgerIntegrity.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeAdminCaller().verifyLedgerIntegrity();

    expect(result).toEqual(data);
  });

  it('throws on failure', async () => {
    mockRevenue.verifyLedgerIntegrity.mockResolvedValueOnce({
      success: false, error: { message: 'Integrity check failed' },
    } as any);

    await expect(makeAdminCaller().verifyLedgerIntegrity()).rejects.toThrow('Integrity check failed');
  });
});

// ---------------------------------------------------------------------------
// getDisputeRate
// ---------------------------------------------------------------------------

describe('betaDashboard.getDisputeRate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns dispute rate', async () => {
    const data = { rate30d: 0.02, rate90d: 0.015 };
    mockChargeback.getPlatformDisputeRate.mockResolvedValueOnce({ success: true, data } as any);

    const result = await makeAdminCaller().getDisputeRate();

    expect(result).toEqual(data);
  });

  it('throws on failure', async () => {
    mockChargeback.getPlatformDisputeRate.mockResolvedValueOnce({
      success: false, error: { message: 'Rate error' },
    } as any);

    await expect(makeAdminCaller().getDisputeRate()).rejects.toThrow('Rate error');
  });
});

// ---------------------------------------------------------------------------
// getDailyTaskCounts
// ---------------------------------------------------------------------------

describe('betaDashboard.getDailyTaskCounts', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns mapped daily task counts', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { day: '2025-01-01', created: '5', completed: '3', cancelled: '1' },
        { day: '2025-01-02', created: '8', completed: '6', cancelled: '0' },
      ],
      rowCount: 2,
    } as any);

    const result = await makeAdminCaller().getDailyTaskCounts({});

    expect(result).toHaveLength(2);
    expect(result[0].created).toBe(5);
    expect(result[0].completed).toBe(3);
    expect(result[0].cancelled).toBe(1);
    expect(result[1].created).toBe(8);
  });

  it('uses custom days parameter', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeAdminCaller().getDailyTaskCounts({ days: 7 });

    const [, params] = (mockDb.query as any).mock.calls[1];
    expect(params).toContain(7);
  });

  it('returns empty array when no data', async () => {
    // makeAdminCaller() sets up the admin check mock internally;
    // create the caller first, then set up the data mock
    const caller = makeAdminCaller();
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await caller.getDailyTaskCounts({});

    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getDailyRevenue
// ---------------------------------------------------------------------------

describe('betaDashboard.getDailyRevenue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns mapped daily revenue rows', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [
        { day: '2025-01-01', event_type: 'platform_fee', total_amount_cents: '5000', event_count: '3' },
      ],
      rowCount: 1,
    } as any);

    const result = await makeAdminCaller().getDailyRevenue({});

    expect(result).toHaveLength(1);
    expect(result[0].eventType).toBe('platform_fee');
    expect(result[0].totalAmountCents).toBe(5000);
    expect(result[0].eventCount).toBe(3);
  });

  it('uses custom days parameter', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeAdminCaller().getDailyRevenue({ days: 14 });

    const [, params] = (mockDb.query as any).mock.calls[1];
    expect(params).toContain(14);
  });
});

// ---------------------------------------------------------------------------
// getActivityFeed
// ---------------------------------------------------------------------------

describe('betaDashboard.getActivityFeed', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns mapped activity feed rows', async () => {
    // Create caller first so the admin-check mock is next in queue
    const caller = makeAdminCaller();
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          event_time: '2025-01-01T10:00:00Z',
          event_type: 'task_created',
          entity_type: 'task',
          entity_id: 'task-1',
          user_id: USER_UUID,
          user_email: 'user@test.com',
          detail: 'Mow the lawn',
          amount_cents: '5000',
        },
        {
          event_time: '2025-01-01T09:00:00Z',
          event_type: 'escrow_funded',
          entity_type: 'escrow',
          entity_id: 'escrow-1',
          user_id: USER_UUID,
          user_email: 'user@test.com',
          detail: 'Escrow funded',
          amount_cents: null,
        },
      ],
      rowCount: 2,
    } as any);

    const result = await caller.getActivityFeed({});

    expect(result).toHaveLength(2);
    expect(result[0].eventType).toBe('task_created');
    expect(result[0].amountCents).toBe(5000);
    expect(result[1].amountCents).toBeNull(); // null amount_cents
  });

  it('uses custom limit', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeAdminCaller().getActivityFeed({ limit: 10 });

    const [, params] = (mockDb.query as any).mock.calls[1];
    expect(params).toContain(10);
  });
});

// ---------------------------------------------------------------------------
// getBetaConfig (protectedProcedure — regular user can call)
// ---------------------------------------------------------------------------

describe('betaDashboard.getBetaConfig', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns beta config from config module', async () => {
    const result = await makeUserCaller().getBetaConfig();

    expect(result.enabled).toBe(true);
    expect(result.region).toBe('Seattle');
    expect(result.radiusMiles).toBe(25);
    expect(result.startDate).toBe('2025-01-01');
    expect(result.bounds).toBeDefined();
    expect(result.center).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// requestKillSwitchToggle
// ---------------------------------------------------------------------------

describe('betaDashboard.requestKillSwitchToggle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('logs disable intent and returns requiresRedeploy=true', async () => {
    mockBeta.logBetaStateChange.mockResolvedValueOnce(undefined as any);

    const result = await makeAdminCaller().requestKillSwitchToggle({
      action: 'DISABLE',
      reason: 'Beta is unstable',
    });

    expect(result.logged).toBe(true);
    expect(result.currentState).toBe(true); // config.beta.enabled=true
    expect(result.requestedState).toBe(false); // DISABLE
    expect(result.requiresRedeploy).toBe(true);
    expect(mockBeta.logBetaStateChange).toHaveBeenCalledWith(
      ADMIN_UUID,
      'BETA_DISABLED',
      expect.objectContaining({ reason: 'Beta is unstable', requiresRedeploy: true })
    );
  });

  it('logs enable intent when beta already enabled and returns no-change message', async () => {
    mockBeta.logBetaStateChange.mockResolvedValueOnce(undefined as any);

    const result = await makeAdminCaller().requestKillSwitchToggle({
      action: 'ENABLE',
      reason: 'Ensuring beta is on',
    });

    expect(result.requiresRedeploy).toBe(false); // currentState === requestedState
    expect(result.message).toContain('already');
  });
});

// ---------------------------------------------------------------------------
// getKillSwitchHistory
// ---------------------------------------------------------------------------

describe('betaDashboard.getKillSwitchHistory', () => {
  beforeEach(() => vi.resetAllMocks());

  it('returns mapped kill switch history rows', async () => {
    // Create caller first so the admin-check mock is next in queue
    const caller = makeAdminCaller();
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          admin_user_id: ADMIN_UUID,
          action_type: 'BETA_DISABLED',
          action_details: JSON.stringify({ reason: 'Test', requiresRedeploy: true }),
          created_at: '2025-01-01T00:00:00Z',
        },
      ],
      rowCount: 1,
    } as any);

    const result = await caller.getKillSwitchHistory();

    expect(result).toHaveLength(1);
    expect(result[0].actionType).toBe('BETA_DISABLED');
    expect(result[0].adminUserId).toBe(ADMIN_UUID);
    expect(result[0].details.reason).toBe('Test');
  });

  it('handles pre-parsed JSON action_details object', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          admin_user_id: ADMIN_UUID,
          action_type: 'BETA_ENABLED',
          action_details: { reason: 'Already parsed', requiresRedeploy: false }, // not a string
          created_at: '2025-01-02T00:00:00Z',
        },
      ],
      rowCount: 1,
    } as any);

    const result = await makeAdminCaller().getKillSwitchHistory();

    expect(result[0].details.reason).toBe('Already parsed');
  });

  it('returns empty array when no history', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeAdminCaller().getKillSwitchHistory();

    expect(result).toEqual([]);
  });
});
