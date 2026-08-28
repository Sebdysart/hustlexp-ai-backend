/**
 * Alpha Telemetry Router Unit Tests (new file — 0% coverage)
 *
 * Tests all procedures:
 * - getEdgeStateDistribution: with and without role filter
 * - getEdgeStateTimeSpent: with and without state filter
 * - getDisputeRate: zero tasks, non-zero tasks
 * - getProofCorrectionRate: zero failures, non-zero failures
 * - getTrustTierMovement: with and without delta_type filter
 * - emitEdgeStateImpression: success path
 * - emitEdgeStateExit: success path + duration clamping
 *
 * v2.9.8: aggregate read procedures changed to adminProcedure.
 * Tests now call mockAdminCheck() in beforeEach to satisfy the
 * admin_roles guard; DATA_CALL_IDX=1 accounts for the extra query.
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

vi.mock('../../src/services/AlphaInstrumentation', () => ({
  AlphaInstrumentation: {
    emitEdgeStateImpression: vi.fn().mockResolvedValue(undefined),
    emitEdgeStateExit: vi.fn().mockResolvedValue(undefined),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { alphaTelemetryRouter } from '../../src/routers/alphaTelemetry';
import { AlphaInstrumentation } from '../../src/services/AlphaInstrumentation';

const mockDb = vi.mocked(db);
const mockAlpha = vi.mocked(AlphaInstrumentation);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

function makeCaller() {
  return alphaTelemetryRouter.createCaller({
    user: {
      id: USER_UUID,
      email: 'user@hustlexp.com',
      full_name: 'Test User',
      role: 'hustler',
      trust_tier: 2,
      firebase_uid: 'fb-user',
    } as any,
    firebaseUid: 'fb-user',
  });
}

/**
 * Prepend admin_roles mock so adminProcedure middleware passes.
 * The admin check queries admin_roles first, consuming mock slot 0.
 * All data query assertions must use DATA_CALL_IDX (1) instead of 0.
 */
function mockAdminCheck() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
}

/** Index of the first actual data query (after admin_roles check). */
const DATA_CALL_IDX = 1;

const START_DATE = new Date('2025-01-01T00:00:00Z');
const END_DATE   = new Date('2025-02-01T00:00:00Z');

// ---------------------------------------------------------------------------
// getEdgeStateDistribution
// ---------------------------------------------------------------------------

describe('alphaTelemetry.getEdgeStateDistribution', () => {
  beforeEach(() => { vi.clearAllMocks(); mockAdminCheck(); });

  it('returns distribution rows without role filter', async () => {
    const rows = [
      { state: 'E1_NO_TASKS_AVAILABLE', count: '5', unique_users: '3' },
      { state: 'E2_ELIGIBILITY_MISMATCH', count: '2', unique_users: '2' },
    ];
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as any);

    const result = await makeCaller().getEdgeStateDistribution({
      start_date: START_DATE,
    });

    expect(result).toHaveLength(2);
    expect(result[0].state).toBe('E1_NO_TASKS_AVAILABLE');
    // Verify query was called with just 2 params (no role) — call[1] is data query, call[0] is admin check
    const [, params] = (mockDb.query as any).mock.calls[DATA_CALL_IDX];
    expect(params).toHaveLength(2);
  });

  it('filters by role when provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeCaller().getEdgeStateDistribution({
      start_date: START_DATE,
      role: 'hustler',
    });

    const [sql, params] = (mockDb.query as any).mock.calls[DATA_CALL_IDX];
    expect(sql).toContain('role = $3');
    expect(params).toContain('hustler');
    expect(params).toHaveLength(3);
  });

  it('uses end_date when provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeCaller().getEdgeStateDistribution({
      start_date: START_DATE,
      end_date: END_DATE,
    });

    const [, params] = (mockDb.query as any).mock.calls[DATA_CALL_IDX];
    // Date objects compare by identity; use toStrictEqual for value equality
    expect(params[1]).toStrictEqual(END_DATE);
  });

  it('defaults end_date to now when not provided', async () => {
    const before = new Date();
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeCaller().getEdgeStateDistribution({ start_date: START_DATE });

    const [, params] = (mockDb.query as any).mock.calls[DATA_CALL_IDX];
    const usedEndDate: Date = params[1];
    const after = new Date();
    expect(usedEndDate.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(usedEndDate.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('returns empty array when no data', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    const result = await makeCaller().getEdgeStateDistribution({ start_date: START_DATE });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getEdgeStateTimeSpent
// ---------------------------------------------------------------------------

describe('alphaTelemetry.getEdgeStateTimeSpent', () => {
  beforeEach(() => { vi.clearAllMocks(); mockAdminCheck(); });

  it('returns time spent rows without state filter', async () => {
    const rows = [
      { state: 'E1_NO_TASKS_AVAILABLE', avg_time_ms: 3000, median_time_ms: 2500, p90_time_ms: 5000, exit_count: 10 },
    ];
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 } as any);

    const result = await makeCaller().getEdgeStateTimeSpent({ start_date: START_DATE });

    expect(result).toHaveLength(1);
    const [, params] = (mockDb.query as any).mock.calls[DATA_CALL_IDX];
    expect(params).toHaveLength(2); // no state filter
  });

  it('filters by state when provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeCaller().getEdgeStateTimeSpent({
      start_date: START_DATE,
      state: 'E2_ELIGIBILITY_MISMATCH',
    });

    const [sql, params] = (mockDb.query as any).mock.calls[DATA_CALL_IDX];
    expect(sql).toContain('state = $3');
    expect(params).toContain('E2_ELIGIBILITY_MISMATCH');
  });

  it('returns empty array when no exit data', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    const result = await makeCaller().getEdgeStateTimeSpent({ start_date: START_DATE });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getDisputeRate
// ---------------------------------------------------------------------------

describe('alphaTelemetry.getDisputeRate', () => {
  beforeEach(() => { vi.clearAllMocks(); mockAdminCheck(); });

  it('returns dispute_rate_per_100 of 0 when totalTasks=0', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ total_tasks: '0' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ total_attempts: '5' }], rowCount: 1 } as any);

    const result = await makeCaller().getDisputeRate({ start_date: START_DATE });

    expect(result.total_tasks).toBe(0);
    expect(result.total_attempts).toBe(5);
    expect(result.dispute_rate_per_100).toBe(0);
  });

  it('calculates correct rate when tasks > 0', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ total_tasks: '100' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ total_attempts: '3' }], rowCount: 1 } as any);

    const result = await makeCaller().getDisputeRate({ start_date: START_DATE });

    expect(result.dispute_rate_per_100).toBeCloseTo(3, 5);
  });

  it('handles missing count gracefully', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any); // no total_tasks key
    mockDb.query.mockResolvedValueOnce({ rows: [{}], rowCount: 1 } as any); // no total_attempts

    const result = await makeCaller().getDisputeRate({ start_date: START_DATE });

    expect(result.total_tasks).toBe(0);
    expect(result.total_attempts).toBe(0);
    expect(result.dispute_rate_per_100).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getProofCorrectionRate
// ---------------------------------------------------------------------------

describe('alphaTelemetry.getProofCorrectionRate', () => {
  beforeEach(() => { vi.clearAllMocks(); mockAdminCheck(); });

  it('returns correction_success_rate of 0 when totalFailures=0', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ total_failures: '0' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ total_resolved: '0' }], rowCount: 1 } as any);

    const result = await makeCaller().getProofCorrectionRate({ start_date: START_DATE });

    expect(result.correction_success_rate).toBe(0);
  });

  it('calculates rate when failures > 0', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ total_failures: '10' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ total_resolved: '7' }], rowCount: 1 } as any);

    const result = await makeCaller().getProofCorrectionRate({ start_date: START_DATE });

    expect(result.correction_success_rate).toBeCloseTo(70, 5);
    expect(result.total_failures).toBe(10);
    expect(result.total_resolved).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// getTrustTierMovement
// ---------------------------------------------------------------------------

describe('alphaTelemetry.getTrustTierMovement', () => {
  beforeEach(() => { vi.clearAllMocks(); mockAdminCheck(); });

  it('returns movement rows without delta_type filter', async () => {
    const rows = [
      { delta_type: 'xp', reason_code: 'task_complete', count: '5', avg_delta: '10', total_delta: '50' },
    ];
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 } as any);

    const result = await makeCaller().getTrustTierMovement({ start_date: START_DATE });

    expect(result).toHaveLength(1);
    const [, params] = (mockDb.query as any).mock.calls[DATA_CALL_IDX];
    expect(params).toHaveLength(2); // no delta_type
  });

  it('filters by delta_type when provided', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeCaller().getTrustTierMovement({
      start_date: START_DATE,
      delta_type: 'tier',
    });

    const [sql, params] = (mockDb.query as any).mock.calls[DATA_CALL_IDX];
    expect(sql).toContain('delta_type = $3');
    expect(params).toContain('tier');
  });

  it('returns empty array when no movement data', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    const result = await makeCaller().getTrustTierMovement({ start_date: START_DATE });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// emitEdgeStateImpression
// ---------------------------------------------------------------------------

describe('alphaTelemetry.emitEdgeStateImpression', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls AlphaInstrumentation.emitEdgeStateImpression with correct payload', async () => {
    const result = await makeCaller().emitEdgeStateImpression({
      state: 'E1_NO_TASKS_AVAILABLE',
      role: 'hustler',
      trust_tier: 2,
      instant_mode_enabled: false,
    });

    expect(result.success).toBe(true);
    expect(mockAlpha.emitEdgeStateImpression).toHaveBeenCalledOnce();
    const [payload] = mockAlpha.emitEdgeStateImpression.mock.calls[0];
    expect(payload.user_id).toBe(USER_UUID);
    expect(payload.state).toBe('E1_NO_TASKS_AVAILABLE');
    expect(payload.role).toBe('hustler');
    expect(payload.trust_tier).toBe(2);
    expect(payload.instant_mode_enabled).toBe(false);
    expect(payload.timestamp).toBeInstanceOf(Date);
  });

  it('includes location_radius_miles when provided', async () => {
    await makeCaller().emitEdgeStateImpression({
      state: 'E2_ELIGIBILITY_MISMATCH',
      role: 'poster',
      trust_tier: 3,
      location_radius_miles: 10,
      instant_mode_enabled: true,
    });

    const [payload] = mockAlpha.emitEdgeStateImpression.mock.calls[0];
    expect(payload.location_radius_miles).toBe(10);
  });

  it('emits for each valid state', async () => {
    const states = ['E1_NO_TASKS_AVAILABLE', 'E2_ELIGIBILITY_MISMATCH', 'E3_TRUST_TIER_LOCKED'] as const;
    for (const state of states) {
      vi.clearAllMocks();
      const result = await makeCaller().emitEdgeStateImpression({
        state,
        role: 'hustler',
        trust_tier: 1,
        instant_mode_enabled: false,
      });
      expect(result.success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// emitEdgeStateExit
// ---------------------------------------------------------------------------

describe('alphaTelemetry.emitEdgeStateExit', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls AlphaInstrumentation.emitEdgeStateExit with correct payload', async () => {
    const result = await makeCaller().emitEdgeStateExit({
      state: 'E1_NO_TASKS_AVAILABLE',
      role: 'hustler',
      time_on_screen_ms: 5000,
      exit_type: 'back',
    });

    expect(result.success).toBe(true);
    expect(mockAlpha.emitEdgeStateExit).toHaveBeenCalledOnce();
    const [payload] = mockAlpha.emitEdgeStateExit.mock.calls[0];
    expect(payload.user_id).toBe(USER_UUID);
    expect(payload.state).toBe('E1_NO_TASKS_AVAILABLE');
    expect(payload.time_on_screen_ms).toBe(5000);
    expect(payload.exit_type).toBe('back');
  });

  it('clamps time_on_screen_ms to minimum 250ms', async () => {
    await makeCaller().emitEdgeStateExit({
      state: 'E2_ELIGIBILITY_MISMATCH',
      role: 'poster',
      time_on_screen_ms: 100, // below 250 minimum
      exit_type: 'continue',
    });

    const [payload] = mockAlpha.emitEdgeStateExit.mock.calls[0];
    expect(payload.time_on_screen_ms).toBe(250); // clamped
  });

  it('does not clamp when time_on_screen_ms >= 250', async () => {
    await makeCaller().emitEdgeStateExit({
      state: 'E3_TRUST_TIER_LOCKED',
      role: 'hustler',
      time_on_screen_ms: 1000,
      exit_type: 'session_end',
    });

    const [payload] = mockAlpha.emitEdgeStateExit.mock.calls[0];
    expect(payload.time_on_screen_ms).toBe(1000);
  });

  it('clamps exact 250ms boundary (no change)', async () => {
    await makeCaller().emitEdgeStateExit({
      state: 'E1_NO_TASKS_AVAILABLE',
      role: 'hustler',
      time_on_screen_ms: 250,
      exit_type: 'back',
    });

    const [payload] = mockAlpha.emitEdgeStateExit.mock.calls[0];
    expect(payload.time_on_screen_ms).toBe(250);
  });
});
