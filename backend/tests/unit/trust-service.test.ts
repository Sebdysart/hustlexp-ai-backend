/**
 * TrustService Unit Tests
 *
 * Tests getLedger, getCurrentTier, promote, and checkPromotionEligibility.
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
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/auth-cache', () => ({
  invalidateAuthCacheForUser: vi.fn().mockResolvedValue(undefined),
}));

import { TrustService } from '../../src/services/TrustService';
import { db, isInvariantViolation } from '../../src/db';
import { invalidateAuthCacheForUser } from '../../src/auth-cache';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// getLedger
// ============================================================================
describe('TrustService.getLedger', () => {
  it('returns ledger entries for a user', async () => {
    const entries = [
      { id: 'le1', user_id: 'u1', old_tier: 1, new_tier: 2 },
      { id: 'le2', user_id: 'u1', old_tier: 2, new_tier: 3 },
    ];
    mockQuery.mockResolvedValueOnce({ rows: entries });

    const result = await TrustService.getLedger('u1');
    expect(result.success).toBe(true);
    expect(result.data).toEqual(entries);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('trust_ledger'),
      ['u1'],
    );
  });

  it('returns empty array when user has no ledger entries', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await TrustService.getLedger('u1');
    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
  });

  it('returns error on DB failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection lost'));

    const result = await TrustService.getLedger('u1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
    expect(result.error?.message).toContain('connection lost');
  });
});

// ============================================================================
// getCurrentTier
// ============================================================================
describe('TrustService.getCurrentTier', () => {
  it('returns current trust tier for a user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3 }] });

    const result = await TrustService.getCurrentTier('u1');
    expect(result.success).toBe(true);
    expect(result.data).toBe(3);
  });

  it('returns NOT_FOUND for missing user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await TrustService.getCurrentTier('u_missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('returns error on DB failure', async () => {
    mockQuery.mockRejectedValueOnce(new Error('timeout'));

    const result = await TrustService.getCurrentTier('u1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });
});

// ============================================================================
// promote
// ============================================================================
describe('TrustService.promote', () => {
  const baseParams = {
    userId: 'u1',
    newTier: 2,
    reason: 'Completed 5 tasks',
    changedBy: 'system',
  };

  it('promotes user from tier 1 to tier 2', async () => {
    // Current tier query
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }] });
    // Update query
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', trust_tier: 2 }] });
    // A60-4: SELECT firebase_uid for cache invalidation
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'fb-u1' }] });
    // Ledger insert
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await TrustService.promote(baseParams);
    expect(result.success).toBe(true);
    expect(result.data?.trust_tier).toBe(2);
  });

  it('rejects invalid tier below 1', async () => {
    const result = await TrustService.promote({ ...baseParams, newTier: 0 });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TIER');
  });

  it('rejects invalid tier above 4', async () => {
    const result = await TrustService.promote({ ...baseParams, newTier: 5 });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TIER');
  });

  it('rejects demotion (new tier < current)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3 }] });

    const result = await TrustService.promote({ ...baseParams, newTier: 2 });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TRANSITION');
  });

  it('returns user unchanged when newTier equals currentTier', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', trust_tier: 2 }] });

    const result = await TrustService.promote({ ...baseParams, newTier: 2 });
    expect(result.success).toBe(true);
  });

  it('returns NOT_FOUND for missing user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await TrustService.promote(baseParams);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('handles invariant violation', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }] });
    const invError = Object.assign(new Error('inv'), { code: 'INV_ERR' });
    mockQuery.mockRejectedValueOnce(invError);
    (isInvariantViolation as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const result = await TrustService.promote(baseParams);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INV_ERR');
  });

  it('handles generic DB error during promote', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }] });
    mockQuery.mockRejectedValueOnce(new Error('deadlock'));

    const result = await TrustService.promote(baseParams);
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });

  it('passes reasonDetails and optional fields to ledger insert', async () => {
    const params = {
      ...baseParams,
      reasonDetails: { note: 'auto-promoted' },
      taskId: 'task1',
      disputeId: 'disp1',
    };
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', trust_tier: 2 }] });
    // A60-4: SELECT firebase_uid for cache invalidation
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'fb-u1' }] });
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await TrustService.promote(params);
    // index 0: getCurrentTier, 1: UPDATE, 2: SELECT firebase_uid, 3: ledger insert
    const ledgerCall = mockQuery.mock.calls[3];
    expect(ledgerCall[1]).toContain('task1');
    expect(ledgerCall[1]).toContain('disp1');
  });
});

// ============================================================================
// checkPromotionEligibility
// ============================================================================
describe('TrustService.checkPromotionEligibility', () => {
  it('returns eligible=true when tasks exceed next tier threshold', async () => {
    // User at tier 1
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }] });
    // 6 completed tasks (>= 5 for tier 2)
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '6' }] });

    const result = await TrustService.checkPromotionEligibility('u1');
    expect(result.success).toBe(true);
    expect(result.data?.eligible).toBe(true);
    expect(result.data?.nextTier).toBe(2);
  });

  it('returns eligible=false when tasks below threshold', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '3' }] });

    const result = await TrustService.checkPromotionEligibility('u1');
    expect(result.success).toBe(true);
    expect(result.data?.eligible).toBe(false);
    expect(result.data?.nextTier).toBeUndefined();
  });

  it('returns eligible=false when already at max tier (4)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 4 }] });
    // Count query still runs
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '200' }] });

    const result = await TrustService.checkPromotionEligibility('u1');
    expect(result.success).toBe(true);
    expect(result.data?.eligible).toBe(false);
    expect(result.data?.currentTier).toBe(4);
  });

  it('returns NOT_FOUND for missing user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await TrustService.checkPromotionEligibility('u_missing');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NOT_FOUND');
  });

  it('handles DB error', async () => {
    mockQuery.mockRejectedValueOnce(new Error('fail'));

    const result = await TrustService.checkPromotionEligibility('u1');
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DB_ERROR');
  });

  it('eligible for tier 3 with 20+ tasks from tier 2', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '25' }] });

    const result = await TrustService.checkPromotionEligibility('u1');
    expect(result.success).toBe(true);
    expect(result.data?.eligible).toBe(true);
    expect(result.data?.nextTier).toBe(3);
  });

  it('eligible for tier 4 with 50+ tasks from tier 3', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3 }] });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '55' }] });

    const result = await TrustService.checkPromotionEligibility('u1');
    expect(result.success).toBe(true);
    expect(result.data?.eligible).toBe(true);
    expect(result.data?.nextTier).toBe(4);
  });
});

// ============================================================================
// A60-4: invalidateAuthCacheForUser after trust_tier update in TrustService.promote
// ============================================================================
describe('TrustService.promote A60-4: auth cache invalidation', () => {
  const baseParams = {
    userId: 'u1',
    newTier: 2,
    reason: 'Completed 5 tasks',
    changedBy: 'system',
  };

  it('calls invalidateAuthCacheForUser with userId after trust_tier update', async () => {
    const mockInvalidate = vi.mocked(invalidateAuthCacheForUser);
    mockInvalidate.mockClear();

    // Current tier query
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }] });
    // Update query
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', trust_tier: 2 }] });
    // SELECT firebase_uid (for cache invalidation)
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'fb-u1' }] });
    // Ledger insert
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await TrustService.promote(baseParams);

    expect(mockInvalidate).toHaveBeenCalledWith('u1', 'fb-u1', false);
  });
});
