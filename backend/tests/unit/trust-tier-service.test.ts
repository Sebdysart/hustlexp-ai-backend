/**
 * TrustTierService Unit Tests
 *
 * Tests getTrustTier, evaluatePromotion, applyPromotion, and banUser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db', () => ({
  db: { query: vi.fn() },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error ${code}`),
}));

vi.mock('../../src/logger', () => {
  const child = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });
  return { logger: { child }, aiLogger: { child } };
});

vi.mock('../../src/services/AlphaInstrumentation', () => ({
  AlphaInstrumentation: {
    emitTrustDeltaApplied: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue({ id: 'outbox-1', idempotencyKey: 'key-1' }),
}));

import { TrustTierService, TrustTier } from '../../src/services/TrustTierService';
import { db } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// getTrustTier
// ============================================================================
describe('TrustTierService.getTrustTier', () => {
  it('returns ROOKIE for tier 1', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.ROOKIE);
  });

  it('returns VERIFIED for tier 2', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.VERIFIED);
  });

  it('returns TRUSTED for tier 3', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.TRUSTED);
  });

  it('returns ELITE for tier 4', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 4 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.ELITE);
  });

  it('returns BANNED for tier 9', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 9 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.BANNED);
  });

  it('throws when user not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(TrustTierService.getTrustTier('u_missing')).rejects.toThrow('not found');
  });

  it('returns ELITE for tier >= 4 (e.g., tier 5)', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 5 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.ELITE);
  });
});

// ============================================================================
// evaluatePromotion
// ============================================================================
describe('TrustTierService.evaluatePromotion', () => {
  it('returns not eligible for banned user', async () => {
    // getTrustTier call
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 9 }], rowCount: 1 });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('User is banned');
  });

  it('returns not eligible for ELITE user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 4 }], rowCount: 1 });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('Already at maximum tier');
  });

  it('evaluates ROOKIE -> VERIFIED: eligible when verified with phone and stripe', async () => {
    // getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    // user details query
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: true, verified_at: new Date(), phone: '+1234', stripe_customer_id: 'cus_123' }],
      rowCount: 1,
    });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(true);
    expect(result.targetTier).toBe(TrustTier.VERIFIED);
  });

  it('evaluates ROOKIE -> VERIFIED: not eligible without phone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: true, verified_at: new Date(), phone: null, stripe_customer_id: 'cus_123' }],
      rowCount: 1,
    });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('Phone verification required');
  });

  it('evaluates ROOKIE -> VERIFIED: not eligible without verification', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: false, verified_at: null, phone: '+1234', stripe_customer_id: 'cus_123' }],
      rowCount: 1,
    });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('ID verification required');
  });

  it('evaluates VERIFIED -> TRUSTED: eligible with 20+ tasks and clean record', async () => {
    // getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    // account age
    mockQuery.mockResolvedValueOnce({ rows: [{ account_age_days: 30 }] });
    // task stats
    mockQuery.mockResolvedValueOnce({
      rows: [{ completed_count: '25', dispute_count: '0', on_time_count: '25', total_count: '25' }],
    });
    // risk check
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(true);
    expect(result.targetTier).toBe(TrustTier.TRUSTED);
  });

  it('evaluates VERIFIED -> TRUSTED: not eligible with disputes', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{ account_age_days: 30 }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ completed_count: '25', dispute_count: '2', on_time_count: '25', total_count: '25' }],
    });
    mockQuery.mockResolvedValueOnce({ rows: [{ count: '0' }] });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons.some(r => r.includes('dispute'))).toBe(true);
  });
});

// ============================================================================
// applyPromotion
// ============================================================================
describe('TrustTierService.applyPromotion', () => {
  it('throws for banned user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 9 }], rowCount: 1 });

    await expect(
      TrustTierService.applyPromotion('u1', TrustTier.VERIFIED, 'system'),
    ).rejects.toThrow('Cannot promote banned user');
  });

  it('throws when target tier <= current tier', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3 }], rowCount: 1 });

    await expect(
      TrustTierService.applyPromotion('u1', TrustTier.VERIFIED, 'system'),
    ).rejects.toThrow('Cannot promote to tier');
  });

  it('throws when preconditions not met', async () => {
    // getTrustTier for applyPromotion
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    // evaluatePromotion -> getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    // evaluatePromotion -> user details (missing verification)
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: false, verified_at: null, phone: null, stripe_customer_id: null }],
      rowCount: 1,
    });

    await expect(
      TrustTierService.applyPromotion('u1', TrustTier.VERIFIED, 'system'),
    ).rejects.toThrow('preconditions not met');
  });

  it('successfully promotes when eligible', async () => {
    // getTrustTier for applyPromotion
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    // evaluatePromotion -> getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    // evaluatePromotion -> user details
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: true, verified_at: new Date(), phone: '+1234', stripe_customer_id: 'cus_1' }],
      rowCount: 1,
    });
    // UPDATE users SET trust_tier (rowCount=1 means the CAS matched)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', trust_tier: 2 }], rowCount: 1 });
    // INSERT trust_ledger
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT default_mode for instrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'worker' }] });

    const result = await TrustTierService.applyPromotion('u1', TrustTier.VERIFIED, 'system');
    expect(result).toEqual({ success: true });
  });

  it('returns alreadyApplied when concurrent promotion beats CAS', async () => {
    // getTrustTier for applyPromotion
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    // evaluatePromotion -> getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    // evaluatePromotion -> user details
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: true, verified_at: new Date(), phone: '+1234', stripe_customer_id: 'cus_1' }],
      rowCount: 1,
    });
    // UPDATE users SET trust_tier — rowCount=0: concurrent promotion already applied
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await TrustTierService.applyPromotion('u1', TrustTier.VERIFIED, 'system');
    expect(result).toEqual({ success: true, alreadyApplied: true });
    // No further queries (trust_ledger, instrumentation) should be fired
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });
});

// ============================================================================
// banUser
// ============================================================================
describe('TrustTierService.banUser', () => {
  it('bans a normal user with no active tasks', async () => {
    // getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    // UPDATE users SET trust_tier = BANNED
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT active tasks — none
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks (cancel active)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT default_mode for instrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'hustler' }] });

    await expect(
      TrustTierService.banUser('u1', 'fraud'),
    ).resolves.toBeUndefined();
  });

  it('does nothing for already banned user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 9 }], rowCount: 1 });

    await TrustTierService.banUser('u1', 'repeated offenses');
    // Only one query (getTrustTier), no update
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('cancels active tasks on ban', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3 }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // update users
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // select active tasks — none
    mockQuery.mockResolvedValueOnce({ rows: [] }); // cancel tasks UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'poster' }] }); // instrumentation

    await TrustTierService.banUser('u1', 'abuse');
    // The fourth call (index 3) should be the cancel tasks query
    const cancelCall = mockQuery.mock.calls[3];
    expect(cancelCall[0]).toContain('CANCELLED');
  });

  it('emits escrow refund outbox events for funded escrows on active tasks', async () => {
    const { writeToOutbox: mockWriteToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWrite = mockWriteToOutbox as ReturnType<typeof vi.fn>;

    // getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    // UPDATE users SET trust_tier = BANNED
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT active tasks — one task with id 'task-1'
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 });
    // SELECT escrow for task-1 — funded escrow exists
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'escrow-1' }], rowCount: 1 });
    // UPDATE tasks (cancel active)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT default_mode for instrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'hustler' }] });

    await TrustTierService.banUser('u1', 'fraud');

    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'escrow.refund_requested',
        aggregateType: 'escrow',
        aggregateId: 'escrow-1',
        queueName: 'critical_payments',
        idempotencyKey: 'ban_refund:task-1',
        payload: expect.objectContaining({ escrowId: 'escrow-1', taskId: 'task-1', reason: 'worker_banned' }),
      })
    );
  });

  it('skips outbox event when active task has no funded escrow', async () => {
    const { writeToOutbox: mockWriteToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWrite = mockWriteToOutbox as ReturnType<typeof vi.fn>;
    mockWrite.mockClear();

    // getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    // UPDATE users SET trust_tier = BANNED
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT active tasks — one task with id 'task-2'
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'task-2' }], rowCount: 1 });
    // SELECT escrow for task-2 — no funded escrow
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks (cancel active)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT default_mode for instrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'hustler' }] });

    await TrustTierService.banUser('u1', 'fraud');

    expect(mockWrite).not.toHaveBeenCalled();
  });
});
