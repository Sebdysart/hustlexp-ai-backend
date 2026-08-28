/**
 * TrustTierService Unit Tests
 *
 * Tests getTrustTier, evaluatePromotion, applyPromotion, and banUser.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// serializableTransaction and transaction both run the callback with a txQuery
// that delegates to db.query, so all query calls share the same mock queue.
const { mockSerializableTransaction, mockTransaction } = vi.hoisted(() => {
  const mockSerializableTransaction = vi.fn().mockImplementation(
    async (fn: (txQuery: typeof import('../../src/db').db.query) => Promise<void>) => {
      const { db: mockDb } = await import('../../src/db');
      return fn(mockDb.query as typeof mockDb.query);
    }
  );
  const mockTransaction = vi.fn().mockImplementation(
    async (fn: (txQuery: typeof import('../../src/db').db.query) => Promise<void>) => {
      const { db: mockDb } = await import('../../src/db');
      return fn(mockDb.query as typeof mockDb.query);
    }
  );
  return { mockSerializableTransaction, mockTransaction };
});

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    serializableTransaction: mockSerializableTransaction,
    transaction: mockTransaction,
  },
  isInvariantViolation: vi.fn(() => false),
  getErrorMessage: vi.fn((code: string) => `Error ${code}`),
}));

// Mock auth-cache so invalidateAuthCacheForUser doesn't make extra db.query calls
vi.mock('../../src/auth-cache', () => ({
  invalidateAuthCacheForUser: vi.fn().mockResolvedValue(undefined),
  authCache: new Map(),
  authCacheKey: vi.fn(),
  authCacheGet: vi.fn().mockReturnValue(null),
  authCacheSet: vi.fn(),
}));

vi.mock('../../src/logger', () => {
  const child = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() });
  return { logger: { child }, aiLogger: { child }, authLogger: { child, warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } };
});

vi.mock('../../src/auth/middleware', () => ({
  revokeUserSessions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/realtime/connection-registry', () => ({
  forceDisconnectUser: vi.fn(),
}));

vi.mock('../../src/services/AlphaInstrumentation', () => ({
  AlphaInstrumentation: {
    emitTrustDeltaApplied: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../src/lib/outbox-helpers', () => ({
  writeToOutbox: vi.fn().mockResolvedValue({ id: 'outbox-1', idempotencyKey: 'key-1' }),
}));

vi.mock('../../src/services/WorkerStandingDecisionService', () => ({
  issueDeactivationAppealRight: vi.fn().mockResolvedValue({
    decisionId: 'standing-decision-1', appealDeadlineAt: 'later', appealPath: '/earn/appeal/test', newlyIssued: true,
  }),
}));

import { TrustTierService, TrustTier } from '../../src/services/TrustTierService';
import { issueDeactivationAppealRight } from '../../src/services/WorkerStandingDecisionService';
import { db } from '../../src/db';

const mockQuery = db.query as ReturnType<typeof vi.fn>;
const productionIdentity = {
  identity_verification_status: 'VERIFIED',
  identity_verification_environment: 'PRODUCTION',
  identity_verification_expires_at: new Date('2099-01-01T00:00:00.000Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// getTrustTier
// ============================================================================
describe('TrustTierService.getTrustTier', () => {
  it('returns Explorer for tier 0', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.EXPLORER);
  });

  it('returns Verified for tier 1', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.VERIFIED);
  });

  it('returns Home Ready for tier 2', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.HOME_READY);
  });

  it('returns Pro for tier 3', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.PRO);
  });

  it('returns Licensed Specialist for tier 4', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 4 }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.LICENSED_SPECIALIST);
  });

  it('returns BANNED when the terminal ban flag is set', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2, is_banned: true }], rowCount: 1 });
    const tier = await TrustTierService.getTrustTier('u1');
    expect(tier).toBe(TrustTier.BANNED);
  });

  it('throws when user not found', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(TrustTierService.getTrustTier('u_missing')).rejects.toThrow('not found');
  });

  it('fails closed for unsupported Tier 5 rather than treating Enterprise Crew as an individual tier', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 5 }], rowCount: 1 });
    await expect(TrustTierService.getTrustTier('u1')).rejects.toThrow('Invalid persisted trust tier 5');
  });
});

// ============================================================================
// evaluatePromotion
// ============================================================================
describe('TrustTierService.evaluatePromotion', () => {
  it('returns not eligible for banned user', async () => {
    // getTrustTier call
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2, is_banned: true }], rowCount: 1 });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('User is banned');
  });

  it('returns not eligible for a Licensed Specialist', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 4 }], rowCount: 1 });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('Already at maximum tier');
  });

  it('evaluates Explorer -> Verified when identity, phone, and payout onboarding are current', async () => {
    // getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // user details query
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: true, verified_at: new Date(), ...productionIdentity, phone: '+1234', stripe_connect_id: 'acct_123', payouts_enabled: true }],
      rowCount: 1,
    });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(true);
    expect(result.targetTier).toBe(TrustTier.VERIFIED);
  });

  it('does not promote Explorer without a verified phone', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: true, verified_at: new Date(), ...productionIdentity, phone: null, stripe_connect_id: 'acct_123', payouts_enabled: true }],
      rowCount: 1,
    });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('Phone verification required');
  });

  it('does not promote Explorer without verified identity', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: false, verified_at: null, phone: '+1234', stripe_connect_id: 'acct_123', payouts_enabled: true }],
      rowCount: 1,
    });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toContain('ID verification required');
  });

  it('evaluates Verified -> Home Ready using current production screening and production history', async () => {
    // getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1, is_banned: false }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{ current_screening: true }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ completed_count: '5', active_dispute_count: '0' }],
    });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(true);
    expect(result.targetTier).toBe(TrustTier.HOME_READY);
  });

  it('does not grant Home Ready from test screening, insufficient history, or an active dispute', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 1, is_banned: false }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [{ current_screening: false }] });
    mockQuery.mockResolvedValueOnce({
      rows: [{ completed_count: '2', active_dispute_count: '1' }],
    });

    const result = await TrustTierService.evaluatePromotion('u1');
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'Current production enhanced screening required',
      expect.stringContaining('verified production completions'),
      expect.stringContaining('Active dispute review'),
    ]));
  });

  it('classifies Pro and Licensed Specialist progression as unavailable in Build Now', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2, is_banned: false }], rowCount: 1 });
    await expect(TrustTierService.evaluatePromotion('u1')).resolves.toMatchObject({
      eligible: false,
      reasons: [expect.stringContaining('Pro progression is not enabled')],
    });

    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3, is_banned: false }], rowCount: 1 });
    await expect(TrustTierService.evaluatePromotion('u1')).resolves.toMatchObject({
      eligible: false,
      reasons: [expect.stringContaining('Licensed Specialist progression is not enabled')],
    });
  });
});

// ============================================================================
// applyPromotion
// ============================================================================
describe('TrustTierService.applyPromotion', () => {
  it('throws for banned user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3, is_banned: true }], rowCount: 1 });

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
    // getTrustTier for applyPromotion (pre-flight)
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // serializableTransaction → txQuery: SELECT trust_tier FOR UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // evaluatePromotion -> getTrustTier (inside transaction)
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // evaluatePromotion -> user details (missing verification — not eligible)
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: false, verified_at: null, phone: null, stripe_connect_id: null, payouts_enabled: false }],
      rowCount: 1,
    });

    await expect(
      TrustTierService.applyPromotion('u1', TrustTier.VERIFIED, 'system'),
    ).rejects.toThrow('preconditions not met');
  });

  it('successfully promotes when eligible', async () => {
    // getTrustTier for applyPromotion (pre-flight)
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // serializableTransaction → txQuery: SELECT trust_tier FOR UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // evaluatePromotion -> getTrustTier (inside transaction)
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // evaluatePromotion -> user details (inside transaction)
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: true, verified_at: new Date(), ...productionIdentity, phone: '+1234', stripe_connect_id: 'acct_1', payouts_enabled: true }],
      rowCount: 1,
    });
    // transaction-local promotion authority
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // serializableTransaction → txQuery: UPDATE users SET trust_tier (CAS matched → rowCount=1)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', trust_tier: 1 }], rowCount: 1 });
    // synchronized capability profile
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // append-only trust ledger
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // A59-2 FIX: SELECT firebase_uid FROM users for invalidateAuthCacheForUser
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-u1' }], rowCount: 1 });
    // SELECT default_mode for AlphaInstrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'worker' }] });

    const result = await TrustTierService.applyPromotion('u1', TrustTier.VERIFIED, 'system');
    expect(result).toEqual({ success: true });
  });

  it('returns alreadyApplied when concurrent promotion beats CAS', async () => {
    // getTrustTier for applyPromotion (pre-flight)
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // serializableTransaction → txQuery: SELECT trust_tier FOR UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // evaluatePromotion -> getTrustTier (inside transaction)
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // evaluatePromotion -> user details (inside transaction)
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: true, verified_at: new Date(), ...productionIdentity, phone: '+1234', stripe_connect_id: 'acct_1', payouts_enabled: true }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // authority marker
    // serializableTransaction → txQuery: UPDATE users SET trust_tier — rowCount=0: concurrent promotion already applied
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const result = await TrustTierService.applyPromotion('u1', TrustTier.VERIFIED, 'system');
    expect(result).toEqual({ success: true, alreadyApplied: true });
    // No further queries (trust_ledger, instrumentation) should be fired
    expect(mockQuery).toHaveBeenCalledTimes(6);
  });

  it('A59-2: invalidateAuthCacheForUser is called with both userId AND firebaseUid on successful promotion', async () => {
    const { invalidateAuthCacheForUser } = await import('../../src/auth-cache');
    const mockInvalidate = vi.mocked(invalidateAuthCacheForUser);

    // getTrustTier for applyPromotion (pre-flight)
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // serializableTransaction → txQuery: SELECT trust_tier FOR UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // evaluatePromotion -> getTrustTier (inside transaction)
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 0, is_banned: false }], rowCount: 1 });
    // evaluatePromotion -> user details (inside transaction)
    mockQuery.mockResolvedValueOnce({
      rows: [{ is_verified: true, verified_at: new Date(), ...productionIdentity, phone: '+1234', stripe_connect_id: 'acct_1', payouts_enabled: true }],
      rowCount: 1,
    });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // authority marker
    // serializableTransaction → txQuery: UPDATE users SET trust_tier (CAS matched → rowCount=1)
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'u1', trust_tier: 1 }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // capability profile
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // trust ledger
    // A59-2 FIX: SELECT firebase_uid FROM users
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-abc' }], rowCount: 1 });
    // SELECT default_mode for AlphaInstrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'worker' }] });

    await TrustTierService.applyPromotion('u1', TrustTier.VERIFIED, 'system');

    // Must be called with both userId AND the firebaseUid fetched from DB
    expect(mockInvalidate).toHaveBeenCalledWith('u1', 'firebase-abc');
  });
});

// ============================================================================
// banUser
// ============================================================================
describe('TrustTierService.banUser', () => {
  it('bans a normal user with no active tasks', async () => {
    // Lock current worker standing before deactivation.
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2, is_banned: false, default_mode: 'worker' }], rowCount: 1 });
    // UPDATE users SET is_banned = TRUE
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // SELECT firebase_uid FROM users (for revokeUserSessions)
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-u1' }], rowCount: 1 });
    // SELECT active tasks — none
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks (cancel worker-side active)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT poster funded escrows (BUG 3) — none
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks cancel poster OPEN tasks (BUG 3)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT default_mode for instrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'hustler' }] });

    await expect(
      TrustTierService.banUser('u1', 'fraud'),
    ).resolves.toBeUndefined();
    expect(issueDeactivationAppealRight).toHaveBeenCalledWith(expect.objectContaining({
      workerId: 'u1', currentTier: 2, decisionSource: 'SYSTEM', reason: 'fraud',
    }));
  });

  it('does nothing for already banned user', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 4, is_banned: true }], rowCount: 1 });

    await TrustTierService.banUser('u1', 'repeated offenses');
    // Only one query (getTrustTier), no update
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('cancels active tasks on ban', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 3 }], rowCount: 1 });
    mockQuery.mockResolvedValueOnce({ rows: [] }); // update users
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-u1' }], rowCount: 1 }); // SELECT firebase_uid
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // select active tasks — none
    mockQuery.mockResolvedValueOnce({ rows: [] }); // cancel worker-side tasks UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // SELECT poster funded escrows (BUG 3)
    mockQuery.mockResolvedValueOnce({ rows: [] }); // cancel poster OPEN tasks (BUG 3)
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'poster' }] }); // instrumentation

    await TrustTierService.banUser('u1', 'abuse');
    // The fifth call (index 4) should be the cancel worker-side tasks query
    const cancelCall = mockQuery.mock.calls[4];
    expect(cancelCall[0]).toContain('CANCELLED');
  });

  it('emits escrow refund outbox events for funded escrows on active tasks', async () => {
    const { writeToOutbox: mockWriteToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWrite = mockWriteToOutbox as ReturnType<typeof vi.fn>;

    // getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    // UPDATE users SET trust_tier = BANNED
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT firebase_uid FROM users (for revokeUserSessions)
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-u1' }], rowCount: 1 });
    // SELECT active tasks — one task with id 'task-1'
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'task-1' }], rowCount: 1 });
    // SELECT escrow for task-1 — funded escrow exists
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'escrow-1' }], rowCount: 1 });
    // UPDATE tasks (cancel worker-side active tasks)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT poster funded escrows (BUG 3) — none for this user
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks cancel poster OPEN tasks (BUG 3)
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
    // SELECT firebase_uid FROM users (for revokeUserSessions)
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-u1' }], rowCount: 1 });
    // SELECT active tasks — one task with id 'task-2'
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'task-2' }], rowCount: 1 });
    // SELECT escrow for task-2 — no funded escrow
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks (cancel worker-side active tasks)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT poster funded escrows (BUG 3 fix) — none
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks cancel poster OPEN tasks (BUG 3 fix)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT default_mode for instrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'hustler' }] });

    await TrustTierService.banUser('u1', 'fraud');

    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('enqueues poster escrow refund and cancels poster OPEN tasks on ban (BUG 3)', async () => {
    const { writeToOutbox: mockWriteToOutbox } = await import('../../src/lib/outbox-helpers');
    const mockWrite = mockWriteToOutbox as ReturnType<typeof vi.fn>;
    mockWrite.mockClear();

    // getTrustTier
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    // UPDATE users SET trust_tier = BANNED
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT firebase_uid FROM users
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-poster' }], rowCount: 1 });
    // SELECT worker active tasks — none for this test
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks cancel worker-side
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT poster funded escrows — one funded escrow
    mockQuery.mockResolvedValueOnce({ rows: [{ escrow_id: 'escrow-p1', task_id: 'task-p1' }], rowCount: 1 });
    // UPDATE tasks cancel poster OPEN tasks
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT default_mode for instrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'poster' }] });

    await TrustTierService.banUser('poster-u1', 'fraud');

    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'escrow.refund_requested',
        aggregateId: 'escrow-p1',
        payload: expect.objectContaining({ escrowId: 'escrow-p1', taskId: 'task-p1', reason: 'poster_banned' }),
        idempotencyKey: 'ban_poster_refund:task-p1',
      })
    );

    // Verify poster cancel query was called
    const cancelCall = mockQuery.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes("poster_id") && call[0].includes("CANCELLED")
    );
    expect(cancelCall).toBeDefined();
  });

  // A60-1: the terminal ban flag is authoritative; the valid 1-4 trust tier is preserved.
  it('A60-1: banUser sets is_banned = TRUE without corrupting trust_tier', async () => {
    // transaction -> SELECT trust_tier FOR UPDATE
    mockQuery.mockResolvedValueOnce({ rows: [{ trust_tier: 2 }], rowCount: 1 });
    // transaction -> UPDATE users SET is_banned = TRUE (the call under test)
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    // SELECT firebase_uid FROM users
    mockQuery.mockResolvedValueOnce({ rows: [{ firebase_uid: 'firebase-u1' }], rowCount: 1 });
    // SELECT active tasks — none
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks (cancel worker-side active)
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT poster funded escrows — none
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    // UPDATE tasks cancel poster active tasks
    mockQuery.mockResolvedValueOnce({ rows: [] });
    // SELECT default_mode for instrumentation
    mockQuery.mockResolvedValueOnce({ rows: [{ default_mode: 'worker' }] });

    await TrustTierService.banUser('u1', 'fraud');

    // The ban UPDATE must set the terminal flag without writing an out-of-range tier.
    const banUpdateCall = mockQuery.mock.calls.find(
      (call) =>
        typeof call[0] === 'string' &&
        call[0].includes('UPDATE users') &&
        call[0].includes('is_banned = TRUE')
    );
    expect(banUpdateCall).toBeDefined();
    expect(banUpdateCall![0]).toMatch(/is_banned\s*=\s*TRUE/i);
    expect(banUpdateCall![0]).not.toMatch(/SET\s+trust_tier\s*=/i);
    expect(banUpdateCall![1]).toEqual(['u1']);
  });
});
