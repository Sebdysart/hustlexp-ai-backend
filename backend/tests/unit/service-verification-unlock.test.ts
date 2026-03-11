/**
 * EarnedVerificationUnlockService Unit Tests
 *
 * Covers: recordEarnings, checkUnlockEligibility, getUnlockProgress,
 * getEarningsLedger, adminGrantUnlock — and their error paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
  },
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn() }),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { EarnedVerificationUnlockService } from '../../src/services/EarnedVerificationUnlockService';

const mockDb = vi.mocked(db);

beforeEach(() => {
  vi.clearAllMocks();
});

// ===========================================================================
// recordEarnings
// ===========================================================================

describe('EarnedVerificationUnlockService.recordEarnings', () => {
  it('records earnings below threshold without notification', async () => {
    // SELECT cumulative earnings
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_net_earnings_cents: 1000 }],
      rowCount: 1,
    } as never);
    // INSERT ledger
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await EarnedVerificationUnlockService.recordEarnings(
      'user-1', 'task-1', 'escrow-1', 500,
    );

    expect(result.success).toBe(true);
    // No notification query — total is 1500, still below 4000 threshold
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('triggers notification when user crosses $40 threshold', async () => {
    // cumulativeBefore = 3900, netPayout = 200 → cumulativeAfter = 4100 (crosses 4000)
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_net_earnings_cents: 3900 }],
      rowCount: 1,
    } as never);
    // INSERT ledger
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    // INSERT notification (fire-and-forget)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await EarnedVerificationUnlockService.recordEarnings(
      'user-1', 'task-2', 'escrow-2', 200,
    );

    expect(result.success).toBe(true);

    // Wait for the fire-and-forget notification promise to settle
    await new Promise(r => setTimeout(r, 10));

    // Should have made 3 query calls (tracking, ledger insert, notification)
    expect(mockDb.query).toHaveBeenCalledTimes(3);
  });

  it('exactly at threshold (4000 before, 0 after) does NOT trigger notification', async () => {
    // cumulativeBefore = 4000, after = 4500 → NOT < 4000, so no notification
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_net_earnings_cents: 4000 }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await EarnedVerificationUnlockService.recordEarnings(
      'user-1', 'task-3', 'escrow-3', 500,
    );

    expect(result.success).toBe(true);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('uses 0 as cumulativeBefore when user has no tracking record', async () => {
    // No rows → cumulativeBefore defaults to 0
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await EarnedVerificationUnlockService.recordEarnings(
      'user-new', 'task-1', 'escrow-1', 1000,
    );

    expect(result.success).toBe(true);

    // Verify ledger insert was called with cumulative_before = 0
    const insertCall = mockDb.query.mock.calls[1];
    expect(insertCall[1]).toContain(0); // cumulativeBefore = 0
    expect(insertCall[1]).toContain(1000); // cumulativeAfter = 0 + 1000
  });

  it('returns error on database failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB connection lost'));

    const result = await EarnedVerificationUnlockService.recordEarnings(
      'user-1', 'task-1', 'escrow-1', 500,
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('RECORD_EARNINGS_FAILED');
      expect(result.error.message).toContain('DB connection lost');
    }
  });

  it('handles notification insert failure gracefully (fire-and-forget)', async () => {
    // Crosses threshold
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_net_earnings_cents: 3000 }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    // Notification query fails
    mockDb.query.mockRejectedValueOnce(new Error('Notification table error'));

    const result = await EarnedVerificationUnlockService.recordEarnings(
      'user-1', 'task-5', 'escrow-5', 1500,
    );

    // recordEarnings should still succeed
    expect(result.success).toBe(true);
  });

  it('is idempotent — ON CONFLICT DO NOTHING prevents duplicate ledger entries', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ total_net_earnings_cents: 2000 }],
      rowCount: 1,
    } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // conflict → nothing inserted

    const result = await EarnedVerificationUnlockService.recordEarnings(
      'user-1', 'task-1', 'escrow-dup', 500,
    );

    expect(result.success).toBe(true);

    // Verify the ledger INSERT uses ON CONFLICT DO NOTHING
    const [insertSql] = mockDb.query.mock.calls[1];
    expect(insertSql).toContain('ON CONFLICT');
    expect(insertSql).toContain('DO NOTHING');
  });
});

// ===========================================================================
// checkUnlockEligibility
// ===========================================================================

describe('EarnedVerificationUnlockService.checkUnlockEligibility', () => {
  it('returns true when user has unlocked verification', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ earned_unlock_achieved: true }],
      rowCount: 1,
    } as never);

    const result = await EarnedVerificationUnlockService.checkUnlockEligibility('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(true);
    }
  });

  it('returns false when user has not unlocked verification', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ earned_unlock_achieved: false }],
      rowCount: 1,
    } as never);

    const result = await EarnedVerificationUnlockService.checkUnlockEligibility('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(false);
    }
  });

  it('returns false when user has no tracking record', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EarnedVerificationUnlockService.checkUnlockEligibility('user-new');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe(false);
    }
  });

  it('returns error on database failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB timeout'));

    const result = await EarnedVerificationUnlockService.checkUnlockEligibility('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('CHECK_ELIGIBILITY_FAILED');
    }
  });

  it('queries verification_earnings_tracking table', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await EarnedVerificationUnlockService.checkUnlockEligibility('user-42');

    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain('verification_earnings_tracking');
    expect(params).toContain('user-42');
  });
});

// ===========================================================================
// getUnlockProgress
// ===========================================================================

describe('EarnedVerificationUnlockService.getUnlockProgress', () => {
  it('returns default progress when user has no earnings record', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EarnedVerificationUnlockService.getUnlockProgress('user-new');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.earned_cents).toBe(0);
      expect(result.data.threshold_cents).toBe(4000);
      expect(result.data.percentage).toBe(0);
      expect(result.data.unlocked).toBe(false);
      expect(result.data.tasks_completed).toBe(0);
      expect(result.data.remaining_cents).toBe(4000);
    }
  });

  it('calculates correct progress percentage', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        total_net_earnings_cents: 2000,
        earned_unlock_threshold_cents: 4000,
        earned_unlock_achieved: false,
        completed_task_count: 10,
      }],
      rowCount: 1,
    } as never);

    const result = await EarnedVerificationUnlockService.getUnlockProgress('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.percentage).toBe(50);
      expect(result.data.remaining_cents).toBe(2000);
      expect(result.data.tasks_completed).toBe(10);
    }
  });

  it('caps percentage at 100 when earned exceeds threshold', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        total_net_earnings_cents: 5000,
        earned_unlock_threshold_cents: 4000,
        earned_unlock_achieved: true,
        completed_task_count: 25,
      }],
      rowCount: 1,
    } as never);

    const result = await EarnedVerificationUnlockService.getUnlockProgress('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.percentage).toBe(100);
      expect(result.data.remaining_cents).toBe(0);
      expect(result.data.unlocked).toBe(true);
    }
  });

  it('returns remaining_cents as 0 when earned exceeds threshold', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        total_net_earnings_cents: 6000,
        earned_unlock_threshold_cents: 4000,
        earned_unlock_achieved: true,
        completed_task_count: 30,
      }],
      rowCount: 1,
    } as never);

    const result = await EarnedVerificationUnlockService.getUnlockProgress('user-1');

    if (result.success) {
      expect(result.data.remaining_cents).toBe(0); // Math.max(4000 - 6000, 0) = 0
    }
  });

  it('returns error on database failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('DB unreachable'));

    const result = await EarnedVerificationUnlockService.getUnlockProgress('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('GET_PROGRESS_FAILED');
    }
  });

  it('queries all required fields', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await EarnedVerificationUnlockService.getUnlockProgress('user-1');

    const [sql] = mockDb.query.mock.calls[0];
    expect(sql).toContain('total_net_earnings_cents');
    expect(sql).toContain('earned_unlock_threshold_cents');
    expect(sql).toContain('earned_unlock_achieved');
    expect(sql).toContain('completed_task_count');
  });
});

// ===========================================================================
// getEarningsLedger
// ===========================================================================

describe('EarnedVerificationUnlockService.getEarningsLedger', () => {
  it('returns ledger entries in descending order', async () => {
    const entries = [
      {
        id: 'entry-2', user_id: 'user-1', task_id: 'task-2', escrow_id: 'escrow-2',
        net_payout_cents: 500, cumulative_earnings_before_cents: 1500,
        cumulative_earnings_after_cents: 2000, awarded_at: new Date('2024-02-01'),
      },
      {
        id: 'entry-1', user_id: 'user-1', task_id: 'task-1', escrow_id: 'escrow-1',
        net_payout_cents: 1500, cumulative_earnings_before_cents: 0,
        cumulative_earnings_after_cents: 1500, awarded_at: new Date('2024-01-01'),
      },
    ];
    mockDb.query.mockResolvedValueOnce({ rows: entries, rowCount: 2 } as never);

    const result = await EarnedVerificationUnlockService.getEarningsLedger('user-1');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(2);
      expect(result.data[0].id).toBe('entry-2');
    }
  });

  it('returns empty array when no ledger entries', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    const result = await EarnedVerificationUnlockService.getEarningsLedger('user-new');

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveLength(0);
    }
  });

  it('uses default limit of 20', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await EarnedVerificationUnlockService.getEarningsLedger('user-1');

    const params = mockDb.query.mock.calls[0][1] as unknown[];
    expect(params).toContain(20);
  });

  it('accepts custom limit', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await EarnedVerificationUnlockService.getEarningsLedger('user-1', 50);

    const params = mockDb.query.mock.calls[0][1] as unknown[];
    expect(params).toContain(50);
  });

  it('returns error on database failure', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('Query timeout'));

    const result = await EarnedVerificationUnlockService.getEarningsLedger('user-1');

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('GET_LEDGER_FAILED');
    }
  });

  it('queries correct table and user', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await EarnedVerificationUnlockService.getEarningsLedger('user-99');

    const [sql, params] = mockDb.query.mock.calls[0];
    expect(sql).toContain('verification_earnings_ledger');
    expect(params).toContain('user-99');
  });
});

// ===========================================================================
// adminGrantUnlock
// ===========================================================================

describe('EarnedVerificationUnlockService.adminGrantUnlock', () => {
  it('grants unlock and logs to admin_actions', async () => {
    // UPDATE verification_earnings_tracking
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    // INSERT admin_actions
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await EarnedVerificationUnlockService.adminGrantUnlock(
      'user-1', 'admin-1', 'Special case override',
    );

    expect(result.success).toBe(true);
    expect(mockDb.query).toHaveBeenCalledTimes(2);
  });

  it('logs admin action with correct metadata', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await EarnedVerificationUnlockService.adminGrantUnlock(
      'user-1', 'admin-1', 'Beta tester exception',
    );

    const [, adminInsertParams] = mockDb.query.mock.calls[1];
    const params = adminInsertParams as unknown[];
    expect(params).toContain('admin-1');
    expect(params).toContain('verification_unlock_granted');
    expect(params).toContain('user-1');
    expect(params).toContain('Beta tester exception');
  });

  it('sets earned_unlock_achieved to TRUE and earned_unlock_achieved_at to NOW()', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await EarnedVerificationUnlockService.adminGrantUnlock('user-1', 'admin-1', 'reason');

    const [updateSql, updateParams] = mockDb.query.mock.calls[0];
    expect(updateSql).toContain('earned_unlock_achieved = TRUE');
    expect(updateSql).toContain('earned_unlock_achieved_at');
    expect(updateParams).toContain('user-1');
  });

  it('returns error when UPDATE fails', async () => {
    mockDb.query.mockRejectedValueOnce(new Error('User not found in tracking table'));

    const result = await EarnedVerificationUnlockService.adminGrantUnlock(
      'user-ghost', 'admin-1', 'test',
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('ADMIN_GRANT_FAILED');
      expect(result.error.message).toContain('User not found');
    }
  });

  it('returns error when admin_actions INSERT fails', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never); // UPDATE ok
    mockDb.query.mockRejectedValueOnce(new Error('Audit table write failed'));

    const result = await EarnedVerificationUnlockService.adminGrantUnlock(
      'user-1', 'admin-1', 'reason',
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe('ADMIN_GRANT_FAILED');
    }
  });

  it('includes action timestamp in metadata JSON', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    await EarnedVerificationUnlockService.adminGrantUnlock('user-1', 'admin-1', 'test');

    const [, adminInsertParams] = mockDb.query.mock.calls[1];
    const params = adminInsertParams as unknown[];
    const metadata = JSON.parse(params[5] as string);
    expect(metadata.action).toBe('admin_grant_verification_unlock');
    expect(metadata.timestamp).toBeDefined();
  });
});
