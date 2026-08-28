/**
 * AlphaInstrumentation Unit Tests
 *
 * Tests each telemetry emit method: verifies correct event_group, params,
 * and silent-fail behavior on db errors.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks (inline vi.fn()) ──────────────────────────────────────────────────
vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  default: { query: vi.fn() },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({
      warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
    }),
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────
import { db } from '../../src/db';
import { AlphaInstrumentation } from '../../src/services/AlphaInstrumentation';

const mockQuery = vi.mocked(db.query);

const now = new Date();

beforeEach(() => {
  vi.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

// ============================================================================
// emitEdgeStateImpression
// ============================================================================

describe('AlphaInstrumentation.emitEdgeStateImpression', () => {
  it('inserts edge_state_impression event with correct params', async () => {
    await AlphaInstrumentation.emitEdgeStateImpression({
      user_id: 'user-1',
      role: 'hustler',
      state: 'E1_NO_TASKS_AVAILABLE',
      trust_tier: 2,
      instant_mode_enabled: false,
      timestamp: now,
    });

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO alpha_telemetry');
    expect(params[0]).toBe('edge_state_impression');
    expect(params[1]).toBe('user-1');
    expect(params[2]).toBe('hustler');
    expect(params[3]).toBe('E1_NO_TASKS_AVAILABLE');
    expect(params[4]).toBe(2);
    expect(params[5]).toBeNull(); // location_radius_miles not set
    expect(params[6]).toBe(false);
    expect(params[8]).toBe(now);
  });

  it('passes location_radius_miles when provided', async () => {
    await AlphaInstrumentation.emitEdgeStateImpression({
      user_id: 'user-2',
      role: 'poster',
      state: 'E2_ELIGIBILITY_MISMATCH',
      trust_tier: 3,
      location_radius_miles: 5,
      instant_mode_enabled: true,
      timestamp: now,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[5]).toBe(5);
    expect(params[6]).toBe(true);
  });

  it('silently fails when db throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));

    // Should NOT throw
    await expect(
      AlphaInstrumentation.emitEdgeStateImpression({
        user_id: 'user-1',
        role: 'hustler',
        state: 'E3_TRUST_TIER_LOCKED',
        trust_tier: 1,
        instant_mode_enabled: false,
        timestamp: now,
      })
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// emitEdgeStateExit
// ============================================================================

describe('AlphaInstrumentation.emitEdgeStateExit', () => {
  it('inserts edge_state_exit event with correct params', async () => {
    await AlphaInstrumentation.emitEdgeStateExit({
      user_id: 'user-1',
      role: 'hustler',
      state: 'E1_NO_TASKS_AVAILABLE',
      time_on_screen_ms: 5000,
      exit_type: 'back',
      timestamp: now,
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO alpha_telemetry');
    expect(params[0]).toBe('edge_state_exit');
    expect(params[1]).toBe('user-1');
    expect(params[2]).toBe('hustler');
    expect(params[3]).toBe('E1_NO_TASKS_AVAILABLE');
    expect(params[4]).toBe(5000);
    expect(params[5]).toBe('back');
    expect(params[7]).toBe(now);
  });

  it('handles app_background exit type', async () => {
    await AlphaInstrumentation.emitEdgeStateExit({
      user_id: 'user-2',
      role: 'poster',
      state: 'E2_ELIGIBILITY_MISMATCH',
      time_on_screen_ms: 12000,
      exit_type: 'app_background',
      timestamp: now,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[5]).toBe('app_background');
  });

  it('silently fails when db throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Connection lost'));
    await expect(
      AlphaInstrumentation.emitEdgeStateExit({
        user_id: 'u', role: 'hustler', state: 'E3_TRUST_TIER_LOCKED',
        time_on_screen_ms: 1000, exit_type: 'continue', timestamp: now,
      })
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// emitDisputeEntryAttempt
// ============================================================================

describe('AlphaInstrumentation.emitDisputeEntryAttempt', () => {
  it('inserts dispute_entry_attempt event with correct params', async () => {
    await AlphaInstrumentation.emitDisputeEntryAttempt({
      user_id: 'user-1',
      role: 'poster',
      task_id: 'task-1',
      trigger_state: 'BLOCKED',
      time_since_completion_seconds: 300,
      reason_selected: 'REQUIRED_DELIVERABLES_MISSING',
      timestamp: now,
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO alpha_telemetry');
    expect(params[0]).toBe('dispute_entry_attempt');
    expect(params[1]).toBe('user-1');
    expect(params[2]).toBe('poster');
    expect(params[3]).toBe('task-1');
    expect(params[4]).toBe('BLOCKED');
    expect(params[5]).toBe(300);
    expect(params[6]).toBe('REQUIRED_DELIVERABLES_MISSING');
    expect(params[8]).toBe(now);
  });

  it('handles APPROVED trigger state', async () => {
    await AlphaInstrumentation.emitDisputeEntryAttempt({
      user_id: 'u', role: 'hustler', task_id: 't',
      trigger_state: 'APPROVED', time_since_completion_seconds: 60,
      reason_selected: 'PROOF_NOT_MEET_CRITERIA', timestamp: now,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[4]).toBe('APPROVED');
  });

  it('silently fails when db throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('Timeout'));
    await expect(
      AlphaInstrumentation.emitDisputeEntryAttempt({
        user_id: 'u', role: 'hustler', task_id: 't',
        trigger_state: 'BLOCKED', time_since_completion_seconds: 100,
        reason_selected: 'SAFETY_ISSUE_PREVENTED', timestamp: now,
      })
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// emitDisputeSubmissionResult
// ============================================================================

describe('AlphaInstrumentation.emitDisputeSubmissionResult', () => {
  it('inserts dispute_submission_result event', async () => {
    await AlphaInstrumentation.emitDisputeSubmissionResult({
      user_id: 'user-1',
      role: 'poster',
      task_id: 'task-1',
      submitted: true,
      rejected_by_guard: false,
      cooldown_hit: false,
      timestamp: now,
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO alpha_telemetry');
    expect(params[0]).toBe('dispute_submission_result');
    expect(params[4]).toBe(true);   // submitted
    expect(params[5]).toBe(false);  // rejected_by_guard
    expect(params[6]).toBe(false);  // cooldown_hit
  });

  it('handles rejected_by_guard=true and cooldown_hit=true', async () => {
    await AlphaInstrumentation.emitDisputeSubmissionResult({
      user_id: 'u', role: 'hustler', task_id: 't',
      submitted: false, rejected_by_guard: true, cooldown_hit: true, timestamp: now,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[4]).toBe(false); // submitted
    expect(params[5]).toBe(true);  // rejected_by_guard
    expect(params[6]).toBe(true);  // cooldown_hit
  });

  it('silently fails when db throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    await expect(
      AlphaInstrumentation.emitDisputeSubmissionResult({
        user_id: 'u', role: 'hustler', task_id: 't',
        submitted: false, rejected_by_guard: false, cooldown_hit: false, timestamp: now,
      })
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// emitProofSubmission
// ============================================================================

describe('AlphaInstrumentation.emitProofSubmission', () => {
  it('inserts proof_submission event with pass result', async () => {
    await AlphaInstrumentation.emitProofSubmission({
      user_id: 'user-1',
      role: 'hustler',
      task_id: 'task-1',
      attempt_number: 1,
      proof_type: 'photo',
      gps_verified: true,
      verification_result: 'pass',
      timestamp: now,
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO alpha_telemetry');
    expect(params[0]).toBe('proof_submission');
    expect(params[4]).toBe(1);        // attempt_number
    expect(params[5]).toBe('photo');  // proof_type
    expect(params[6]).toBe(true);     // gps_verified
    expect(params[7]).toBe('pass');   // verification_result
    expect(params[8]).toBeNull();     // failure_reason (not provided)
  });

  it('includes failure_reason when provided', async () => {
    await AlphaInstrumentation.emitProofSubmission({
      user_id: 'u', role: 'hustler', task_id: 't',
      attempt_number: 2, proof_type: 'video',
      gps_verified: false, verification_result: 'fail',
      failure_reason: 'GPS location mismatch',
      timestamp: now,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[7]).toBe('fail');
    expect(params[8]).toBe('GPS location mismatch');
  });

  it('silently fails when db throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    await expect(
      AlphaInstrumentation.emitProofSubmission({
        user_id: 'u', role: 'hustler', task_id: 't',
        attempt_number: 1, proof_type: 'photo',
        gps_verified: true, verification_result: 'pass', timestamp: now,
      })
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// emitProofCorrectionOutcome
// ============================================================================

describe('AlphaInstrumentation.emitProofCorrectionOutcome', () => {
  it('inserts proof_correction_outcome event', async () => {
    await AlphaInstrumentation.emitProofCorrectionOutcome({
      user_id: 'user-1',
      role: 'hustler',
      task_id: 'task-1',
      resolved: true,
      xp_released: true,
      escrow_released: true,
      timestamp: now,
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO alpha_telemetry');
    expect(params[0]).toBe('proof_correction_outcome');
    expect(params[4]).toBe(true);  // resolved
    expect(params[5]).toBe(true);  // xp_released
    expect(params[6]).toBe(true);  // escrow_released
    expect(params[8]).toBe(now);
  });

  it('handles unresolved outcome', async () => {
    await AlphaInstrumentation.emitProofCorrectionOutcome({
      user_id: 'u', role: 'poster', task_id: 't',
      resolved: false, xp_released: false, escrow_released: false, timestamp: now,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[4]).toBe(false);
    expect(params[5]).toBe(false);
    expect(params[6]).toBe(false);
  });

  it('silently fails when db throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    await expect(
      AlphaInstrumentation.emitProofCorrectionOutcome({
        user_id: 'u', role: 'hustler', task_id: 't',
        resolved: false, xp_released: false, escrow_released: false, timestamp: now,
      })
    ).resolves.toBeUndefined();
  });
});

// ============================================================================
// emitTrustDeltaApplied
// ============================================================================

describe('AlphaInstrumentation.emitTrustDeltaApplied', () => {
  it('inserts trust_delta_applied event with task_id', async () => {
    await AlphaInstrumentation.emitTrustDeltaApplied({
      user_id: 'user-1',
      role: 'hustler',
      delta_type: 'xp',
      delta_amount: 50,
      reason_code: 'TASK_COMPLETED',
      task_id: 'task-1',
      timestamp: now,
    });

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO alpha_telemetry');
    expect(params[0]).toBe('trust_delta_applied');
    expect(params[3]).toBe('xp');          // delta_type
    expect(params[4]).toBe(50);            // delta_amount
    expect(params[5]).toBe('TASK_COMPLETED'); // reason_code
    expect(params[6]).toBe('task-1');      // task_id
  });

  it('passes null for task_id when not provided', async () => {
    await AlphaInstrumentation.emitTrustDeltaApplied({
      user_id: 'u', role: 'hustler',
      delta_type: 'tier', delta_amount: 1,
      reason_code: 'TIER_PROMOTION', timestamp: now,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[6]).toBeNull();
  });

  it('handles streak delta_type', async () => {
    await AlphaInstrumentation.emitTrustDeltaApplied({
      user_id: 'u', role: 'hustler',
      delta_type: 'streak', delta_amount: 5,
      reason_code: 'DAILY_STREAK', timestamp: now,
    });

    const params = mockQuery.mock.calls[0][1] as unknown[];
    expect(params[3]).toBe('streak');
  });

  it('silently fails when db throws', async () => {
    mockQuery.mockRejectedValueOnce(new Error('DB error'));
    await expect(
      AlphaInstrumentation.emitTrustDeltaApplied({
        user_id: 'u', role: 'hustler',
        delta_type: 'xp', delta_amount: 10,
        reason_code: 'TEST', timestamp: now,
      })
    ).resolves.toBeUndefined();
  });

  it('silently handles non-Error exceptions', async () => {
    mockQuery.mockRejectedValueOnce('string error');
    await expect(
      AlphaInstrumentation.emitTrustDeltaApplied({
        user_id: 'u', role: 'hustler',
        delta_type: 'xp', delta_amount: 10,
        reason_code: 'TEST', timestamp: now,
      })
    ).resolves.toBeUndefined();
  });
});
