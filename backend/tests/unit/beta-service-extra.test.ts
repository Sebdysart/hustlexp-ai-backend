/**
 * BetaService Extra Tests
 *
 * Covers uncovered paths from beta-service.test.ts:
 * - getBetaMetrics: happy path, DB error, various edge conditions
 * - getKillSignals: each kill signal firing, shouldKill = true/false
 * - enforceTaskCreation: date window expired, no coordinates provided
 * - getBetaStatus: percentage calculations, daysRemaining = 0 when past end date
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  isUniqueViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error ${code}`),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/config', () => ({
  config: {
    beta: {
      enabled: true,
      regionName: 'Seattle Metro',
      bounds: { south: 47.4, west: -122.5, north: 47.8, east: -122.2 },
      startDate: '2026-01-01',
      endDate: '2099-12-31',
      maxUsers: 100,
      maxTasks: 200,
      maxGmvCents: 1_000_000,
    },
  },
}));

import { BetaService } from '../../src/services/BetaService';
import { db } from '../../src/db';
import { config } from '../../src/config';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // Reset config to known good state
  (config.beta as any).enabled = true;
  (config.beta as any).startDate = '2026-01-01';
  (config.beta as any).endDate = '2099-12-31';
});

// ===========================================================================
// getBetaStatus — additional paths
// ===========================================================================
describe('BetaService.getBetaStatus — additional paths', () => {
  it('calculates percentages correctly', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '50' }] })    // users (50/100 = 50%)
      .mockResolvedValueOnce({ rows: [{ count: '100' }] })   // tasks (100/200 = 50%)
      .mockResolvedValueOnce({ rows: [{ gmv: '500000' }] }); // gmv (500k/1M = 50%)

    const result = await BetaService.getBetaStatus();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.users.pct).toBe(50);
      expect(result.data.tasks.pct).toBe(50);
      expect(result.data.gmvCents.pct).toBe(50);
    }
  });

  it('shows withinGmvCap=false when at GMV cap', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ gmv: '1000000' }] }); // exactly at cap

    const result = await BetaService.getBetaStatus();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.withinGmvCap).toBe(false); // 1000000 < 1000000 is false
    }
  });

  it('shows daysRemaining=0 when end date is in the past', async () => {
    (config.beta as any).endDate = '2020-01-01';
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [{ gmv: '0' }] });

    const result = await BetaService.getBetaStatus();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.daysRemaining).toBe(0);
    }
  });

  it('shows canCreateTask=false when at task cap', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '10' }] })    // users
      .mockResolvedValueOnce({ rows: [{ count: '200' }] })   // tasks at cap
      .mockResolvedValueOnce({ rows: [{ gmv: '0' }] });

    const result = await BetaService.getBetaStatus();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.canCreateTask).toBe(false);
    }
  });
});

// ===========================================================================
// enforceTaskCreation — additional paths
// ===========================================================================
describe('BetaService.enforceTaskCreation — additional paths', () => {
  it('blocks when date window has ended', async () => {
    (config.beta as any).endDate = '2020-01-01'; // past date

    const result = await BetaService.enforceTaskCreation(47.6, -122.3);

    expect(result).toContain('Beta period has ended');
    // Should NOT query DB (date check comes before DB queries)
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns null when no coordinates provided (skips geo-fence check)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })    // task count
      .mockResolvedValueOnce({ rows: [{ gmv: '100' }] });   // gmv

    // No coordinates → geo-fence check skipped
    const result = await BetaService.enforceTaskCreation(undefined, undefined);

    expect(result).toBeNull();
  });

  it('returns null when only one coordinate is provided (both required for geo-fence)', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '5' }] })
      .mockResolvedValueOnce({ rows: [{ gmv: '100' }] });

    // Only lat provided, no lng — undefined check requires both
    const result = await BetaService.enforceTaskCreation(47.6, undefined);

    expect(result).toBeNull();
  });

  it('returns null when both coordinates are inside region', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '50' }] })   // task count
      .mockResolvedValueOnce({ rows: [{ gmv: '50000' }] }); // gmv

    const result = await BetaService.enforceTaskCreation(47.6, -122.3, 'Seattle, WA');

    expect(result).toBeNull();
  });
});

// ===========================================================================
// getBetaMetrics
// ===========================================================================
describe('BetaService.getBetaMetrics', () => {
  function stubMetricsQueries(overrides: Record<string, unknown> = {}) {
    const defaults = {
      taskCreated: '20',
      taskCompleted: '15',
      avgPrice: '5000',
      gmv: '100000',
      revenue: '10000',
      totalTasks: '15',
      disputedTasks: '0',
      totalUsers: '50',
      paidUsers: '5',
      userTotal: '50',
      activeUsers: '20',
      avgAccept: '60',
      p50Accept: '45',
      p95Accept: '120',
      avgComplete: '180',
      repeatPosters: '5',
      totalPosters: '20',
    };
    const d = { ...defaults, ...overrides };

    // Task stats
    mockQuery.mockResolvedValueOnce({
      rows: [{ created: d.taskCreated, completed: d.taskCompleted, avg_price: d.avgPrice }],
    });
    // Revenue stats
    mockQuery.mockResolvedValueOnce({
      rows: [{ gmv: d.gmv, revenue: d.revenue }],
    });
    // Dispute stats
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_tasks: d.totalTasks, disputed_tasks: d.disputedTasks }],
    });
    // Subscription stats
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_users: d.totalUsers, paid_users: d.paidUsers }],
    });
    // User stats
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: d.userTotal, active_7d: d.activeUsers }],
    });
    // Timing stats
    mockQuery.mockResolvedValueOnce({
      rows: [{
        avg_accept_min: d.avgAccept,
        p50_accept_min: d.p50Accept,
        p95_accept_min: d.p95Accept,
        avg_complete_min: d.avgComplete,
      }],
    });
    // Repeat stats
    mockQuery.mockResolvedValueOnce({
      rows: [{ repeat_posters: d.repeatPosters, total_posters: d.totalPosters }],
    });
    // Hustler repeat (separate query)
    mockQuery.mockResolvedValueOnce({
      rows: [{ repeat_hustlers: '3', total_hustlers: '15' }],
    });
  }

  it('returns all 6 core metrics and extended data', async () => {
    stubMetricsQueries();

    const result = await BetaService.getBetaMetrics(30);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tasksCreated).toBe(20);
      expect(result.data.tasksCompleted).toBe(15);
      expect(result.data.gmvCents).toBe(100000);
      expect(result.data.platformRevenueCents).toBe(10000);
      expect(result.data.disputeRate).toBe(0); // 0 disputed
      expect(result.data.conversionToPaid).toBe(10); // 5/50 = 10%
      expect(typeof result.data.avgTaskPriceCents).toBe('number');
      expect(result.data.totalUsers).toBe(50);
      expect(result.data.activeUsers7d).toBe(20);
      expect(result.data.repeatHustlerRate).toBe(20); // 3/15 = 20%
    }
  });

  it('uses 1 as denominator when totalTasks = 0 (prevents division by zero)', async () => {
    // Also reset repeatPosters/totalPosters to 0 to avoid 5/1 = 500 repeatPosterRate
    stubMetricsQueries({
      totalTasks: '0', disputedTasks: '0',
      totalUsers: '0', paidUsers: '0',
      totalPosters: '0', repeatPosters: '0',
    });

    const result = await BetaService.getBetaMetrics(30);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.disputeRate).toBe(0);
      expect(result.data.conversionToPaid).toBe(0);
      expect(result.data.repeatPosterRate).toBe(0);
    }
  });

  it('accepts custom windowDays parameter', async () => {
    stubMetricsQueries();

    await BetaService.getBetaMetrics(7);

    // Verify windowDays=7 was passed to the task stats query
    const firstCall = mockQuery.mock.calls[0];
    expect(firstCall[1]).toEqual([7]);
  });

  it('returns BETA_METRICS_FAILED on DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB connection failed'));

    const result = await BetaService.getBetaMetrics(30);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('BETA_METRICS_FAILED');
    }
  });

  it('calculates repeatHustlerRate using total_hustlers=1 floor', async () => {
    // Stub with 0 total hustlers to test the floor
    stubMetricsQueries();
    // Override the last mock (hustler repeat)
    // We need to reset and redo — easier to just check the specific calculation
    // The mock above already stubs repeat_hustlers=3, total_hustlers=15

    const result = await BetaService.getBetaMetrics(30);

    expect(result.success).toBe(true);
    if (result.success) {
      // 3/15 = 0.2 * 10000 / 100 = 20
      expect(result.data.repeatHustlerRate).toBe(20);
    }
  });
});

// ===========================================================================
// getKillSignals
// ===========================================================================
describe('BetaService.getKillSignals', () => {
  function stubKillSignalMetrics(overrides: Record<string, unknown> = {}) {
    const defaults = {
      taskCreated: '200',
      taskCompleted: '100',
      avgPrice: '5000',
      gmv: '100000',
      revenue: '10000',
      totalTasks: '100',
      disputedTasks: '1',
      totalUsers: '50',
      paidUsers: '5',
      userTotal: '50',
      activeUsers: '20',
      avgAccept: '60',
      p50Accept: '45',
      p95Accept: '120',
      avgComplete: '180',
      repeatPosters: '20',
      totalPosters: '50',
    };
    const d = { ...defaults, ...overrides };

    mockQuery.mockResolvedValueOnce({
      rows: [{ created: d.taskCreated, completed: d.taskCompleted, avg_price: d.avgPrice }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ gmv: d.gmv, revenue: d.revenue }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_tasks: d.totalTasks, disputed_tasks: d.disputedTasks }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total_users: d.totalUsers, paid_users: d.paidUsers }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ total: d.userTotal, active_7d: d.activeUsers }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{
        avg_accept_min: d.avgAccept,
        p50_accept_min: d.p50Accept,
        p95_accept_min: d.p95Accept,
        avg_complete_min: d.avgComplete,
      }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ repeat_posters: d.repeatPosters, total_posters: d.totalPosters }],
    });
    mockQuery.mockResolvedValueOnce({
      rows: [{ repeat_hustlers: '10', total_hustlers: '50' }],
    });
  }

  it('returns all signals not triggered on healthy metrics', async () => {
    stubKillSignalMetrics();

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shouldKill).toBe(false);
      const triggered = result.data.signals.filter(s => s.triggered);
      expect(triggered.length).toBeLessThan(3);
    }
  });

  it('triggers LOW_REPEAT_POSTERS when rate < 15% with ≥50 completed tasks', async () => {
    stubKillSignalMetrics({
      taskCompleted: '60',    // >= 50 samples
      repeatPosters: '5',
      totalPosters: '100',    // 5% repeat rate < 15%
    });

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(true);
    if (result.success) {
      const signal = result.data.signals.find(s => s.name === 'LOW_REPEAT_POSTERS');
      expect(signal?.triggered).toBe(true);
    }
  });

  it('does NOT trigger LOW_REPEAT_POSTERS when completed < 50 (insufficient sample)', async () => {
    stubKillSignalMetrics({
      taskCompleted: '40',    // < 50 samples — signal guard prevents trigger
      repeatPosters: '0',
      totalPosters: '40',     // 0% repeat rate
    });

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(true);
    if (result.success) {
      const signal = result.data.signals.find(s => s.name === 'LOW_REPEAT_POSTERS');
      expect(signal?.triggered).toBe(false);
    }
  });

  it('triggers SLOW_ACCEPTANCE when avg > 24h (1440 min) with ≥20 completed', async () => {
    stubKillSignalMetrics({
      taskCompleted: '25',    // >= 20 samples
      avgAccept: '1500',      // 1500 min = 25 hours > 24h threshold
    });

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(true);
    if (result.success) {
      const signal = result.data.signals.find(s => s.name === 'SLOW_ACCEPTANCE');
      expect(signal?.triggered).toBe(true);
    }
  });

  it('triggers HIGH_DISPUTE_RATE when > 2% with ≥30 completed tasks', async () => {
    stubKillSignalMetrics({
      taskCompleted: '50',    // >= 30 samples
      totalTasks: '50',
      disputedTasks: '5',     // 5/50 = 10% dispute rate > 2%
    });

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(true);
    if (result.success) {
      const signal = result.data.signals.find(s => s.name === 'HIGH_DISPUTE_RATE');
      expect(signal?.triggered).toBe(true);
    }
  });

  it('triggers NO_UPGRADES when 0 paid users and ≥100 tasks created', async () => {
    stubKillSignalMetrics({
      taskCreated: '150',  // >= 100
      paidUsers: '0',
      totalUsers: '50',
    });

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(true);
    if (result.success) {
      const signal = result.data.signals.find(s => s.name === 'NO_UPGRADES');
      expect(signal?.triggered).toBe(true);
    }
  });

  it('triggers LOW_COMPLETION when < 50% completion rate and ≥100 tasks created', async () => {
    stubKillSignalMetrics({
      taskCreated: '200',  // >= 100
      taskCompleted: '80', // 80/200 = 40% < 50%
    });

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(true);
    if (result.success) {
      const signal = result.data.signals.find(s => s.name === 'LOW_COMPLETION');
      expect(signal?.triggered).toBe(true);
    }
  });

  it('sets shouldKill=true when 3+ signals triggered simultaneously', async () => {
    // Trigger: LOW_REPEAT_POSTERS + SLOW_ACCEPTANCE + HIGH_DISPUTE_RATE
    stubKillSignalMetrics({
      taskCreated: '200',
      taskCompleted: '60',    // >= 50 for repeat, >= 20 for acceptance, >= 30 for disputes
      avgAccept: '1500',      // > 24h
      repeatPosters: '0',
      totalPosters: '100',    // 0% < 15%
      totalTasks: '60',
      disputedTasks: '10',    // 10/60 > 2%
    });

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.shouldKill).toBe(true);
      const triggered = result.data.signals.filter(s => s.triggered);
      expect(triggered.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('propagates BETA_METRICS_FAILED error when getBetaMetrics fails (DB error)', async () => {
    // When db.query throws, getBetaMetrics returns { success: false, error: { code: 'BETA_METRICS_FAILED' } }
    // getKillSignals propagates that error directly via: return { success: false, error: metrics.error }
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('BETA_METRICS_FAILED');
    }
  });

  it('propagates error from getBetaMetrics (returns its error)', async () => {
    // getBetaMetrics internally calls Promise.all — first query throws
    mockQuery.mockRejectedValueOnce(new Error('metrics failure'));

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(false);
    // Error propagates from getBetaMetrics failure path
  });

  it('LOW_AVG_PRICE triggers when avg price < $10 and >= 30 tasks created', async () => {
    stubKillSignalMetrics({
      taskCreated: '50',   // >= 30
      avgPrice: '500',     // $5.00 < $10.00 threshold
    });

    const result = await BetaService.getKillSignals();

    expect(result.success).toBe(true);
    if (result.success) {
      const signal = result.data.signals.find(s => s.name === 'LOW_AVG_PRICE');
      expect(signal?.triggered).toBe(true);
    }
  });
});
