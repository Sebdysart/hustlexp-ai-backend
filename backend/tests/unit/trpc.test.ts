/**
 * trpc.ts Unit Tests
 *
 * Tests tRPC context creation, auth caching, middleware, and input schemas.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ───────────────────────────────────────────────────────────────────
vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: {
    verifyIdToken: vi.fn(),
  },
}));

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
import { createContext, Schemas, router, publicProcedure, protectedProcedure } from '../../src/trpc';
import { firebaseAuth } from '../../src/auth/firebase';
import { db } from '../../src/db';

const mockVerifyIdToken = vi.mocked(firebaseAuth.verifyIdToken);
const mockDbQuery = vi.mocked(db.query);

const mockUser = {
  id: 'user-1',
  firebase_uid: 'uid-1',
  email: 'test@test.com',
  full_name: 'Test',
  default_mode: 'worker',
};

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader) headers.set('authorization', authHeader);
  return new Request('http://localhost/', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// createContext
// ============================================================================

describe('createContext', () => {
  it('returns null user when no authorization header', async () => {
    const ctx = await createContext({ req: makeRequest(), resHeaders: new Headers() });
    expect(ctx.user).toBeNull();
    expect(ctx.firebaseUid).toBeNull();
  });

  it('returns null user when authorization does not start with Bearer', async () => {
    const ctx = await createContext({ req: makeRequest('Basic abc123'), resHeaders: new Headers() });
    expect(ctx.user).toBeNull();
    expect(ctx.firebaseUid).toBeNull();
  });

  it('returns null user when Bearer prefix is missing entirely', async () => {
    const ctx = await createContext({ req: makeRequest('token-only'), resHeaders: new Headers() });
    expect(ctx.user).toBeNull();
    expect(ctx.firebaseUid).toBeNull();
  });

  it('returns user when valid Bearer token and user found in db', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'uid-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockDbQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

    const ctx = await createContext({ req: makeRequest('Bearer valid-token'), resHeaders: new Headers() });

    expect(ctx.user).toEqual(mockUser);
    expect(ctx.firebaseUid).toBe('uid-1');
    expect(mockVerifyIdToken).toHaveBeenCalledWith('valid-token');
    expect(mockDbQuery).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE firebase_uid = $1',
      ['uid-1']
    );
  });

  it('returns firebaseUid but null user when user not in db', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'uid-new', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockDbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const ctx = await createContext({ req: makeRequest('Bearer new-token'), resHeaders: new Headers() });

    expect(ctx.user).toBeNull();
    expect(ctx.firebaseUid).toBe('uid-new');
  });

  it('returns null user when firebase verification fails', async () => {
    mockVerifyIdToken.mockRejectedValueOnce(new Error('Token expired'));

    const ctx = await createContext({ req: makeRequest('Bearer bad-token'), resHeaders: new Headers() });

    expect(ctx.user).toBeNull();
    expect(ctx.firebaseUid).toBeNull();
  });

  it('strips Bearer prefix before calling verifyIdToken', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'uid-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockDbQuery.mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 });

    await createContext({ req: makeRequest('Bearer my-actual-token'), resHeaders: new Headers() });

    expect(mockVerifyIdToken).toHaveBeenCalledWith('my-actual-token');
    // Should NOT be called with 'Bearer my-actual-token'
    expect(mockVerifyIdToken).not.toHaveBeenCalledWith('Bearer my-actual-token');
  });

  it('does not cache when user not found in db', async () => {
    mockVerifyIdToken.mockResolvedValue({ uid: 'uid-uncached', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 });

    // Two calls with same token — both should hit firebase since user not found
    await createContext({ req: makeRequest('Bearer uncached-token'), resHeaders: new Headers() });
    await createContext({ req: makeRequest('Bearer uncached-token'), resHeaders: new Headers() });

    expect(mockVerifyIdToken).toHaveBeenCalledTimes(2);
  });

  it('caches successful auth to avoid redundant firebase calls', async () => {
    const uniqueToken = `Bearer cache-test-token-${Date.now()}`;
    mockVerifyIdToken.mockResolvedValue({ uid: 'uid-cache', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockDbQuery.mockResolvedValue({ rows: [mockUser], rowCount: 1 });

    // First call — should go to firebase
    const ctx1 = await createContext({ req: makeRequest(uniqueToken), resHeaders: new Headers() });
    // Second call with same token — should use cache
    const ctx2 = await createContext({ req: makeRequest(uniqueToken), resHeaders: new Headers() });

    expect(ctx1.user).toEqual(mockUser);
    expect(ctx2.user).toEqual(mockUser);
    // Firebase called once (cache hit on second)
    expect(mockVerifyIdToken).toHaveBeenCalledTimes(1);
  });

  it('does not cache token very close to expiry', async () => {
    const nearExpiryToken = `Bearer near-expiry-${Date.now()}`;
    // exp is in the past (already expired minus 30s) → tokenRemainingMs < 0 → effectiveTtlMs = 0 → don't cache
    mockVerifyIdToken.mockResolvedValue({
      uid: 'uid-expiring',
      exp: Math.floor(Date.now() / 1000) - 1, // already expired
    });
    mockDbQuery.mockResolvedValue({ rows: [mockUser], rowCount: 1 });

    await createContext({ req: makeRequest(nearExpiryToken), resHeaders: new Headers() });
    await createContext({ req: makeRequest(nearExpiryToken), resHeaders: new Headers() });

    // Both calls should hit firebase (not cached)
    expect(mockVerifyIdToken).toHaveBeenCalledTimes(2);
  });
});

// ============================================================================
// Schemas
// ============================================================================

describe('Schemas.uuid', () => {
  it('accepts a valid UUID', () => {
    expect(() => Schemas.uuid.parse('550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
  });

  it('rejects an invalid UUID', () => {
    expect(() => Schemas.uuid.parse('not-a-uuid')).toThrow();
  });
});

describe('Schemas.createTask', () => {
  it('accepts a valid task with required fields', () => {
    const valid = {
      title: 'Move furniture',
      description: 'Move furniture from apt to storage',
      price: 5000,
    };
    const result = Schemas.createTask.parse(valid);
    expect(result.title).toBe('Move furniture');
    expect(result.price).toBe(5000);
    expect(result.requiresProof).toBe(true); // default
    expect(result.mode).toBe('STANDARD');     // default
    expect(result.instantMode).toBe(false);   // default
  });

  it('rejects title that is empty string', () => {
    expect(() => Schemas.createTask.parse({ title: '', description: 'Desc', price: 500 })).toThrow();
  });

  it('rejects price that is zero', () => {
    expect(() => Schemas.createTask.parse({ title: 'T', description: 'D', price: 0 })).toThrow();
  });

  it('rejects price that is negative', () => {
    expect(() => Schemas.createTask.parse({ title: 'T', description: 'D', price: -100 })).toThrow();
  });

  it('rejects price over maximum', () => {
    expect(() => Schemas.createTask.parse({ title: 'T', description: 'D', price: 100_000_000 })).toThrow();
  });

  it('rejects price that is non-integer', () => {
    expect(() => Schemas.createTask.parse({ title: 'T', description: 'D', price: 10.5 })).toThrow();
  });

  it('accepts mode LIVE', () => {
    const result = Schemas.createTask.parse({ title: 'T', description: 'D', price: 1500, mode: 'LIVE' });
    expect(result.mode).toBe('LIVE');
  });

  it('rejects invalid mode', () => {
    expect(() => Schemas.createTask.parse({ title: 'T', description: 'D', price: 1000, mode: 'INVALID' })).toThrow();
  });

  it('accepts optional deadline as datetime string', () => {
    const result = Schemas.createTask.parse({
      title: 'T', description: 'D', price: 1000, deadline: '2026-12-31T00:00:00Z',
    });
    expect(result.deadline).toBe('2026-12-31T00:00:00Z');
  });
});

describe('Schemas.fundEscrow', () => {
  it('accepts valid escrowId and stripePaymentIntentId', () => {
    const result = Schemas.fundEscrow.parse({
      escrowId: '550e8400-e29b-41d4-a716-446655440000',
      stripePaymentIntentId: 'pi_test123',
    });
    expect(result.escrowId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.stripePaymentIntentId).toBe('pi_test123');
  });

  it('rejects invalid escrowId', () => {
    expect(() => Schemas.fundEscrow.parse({ escrowId: 'not-uuid', stripePaymentIntentId: 'pi_test' })).toThrow();
  });
});

describe('Schemas.releaseEscrow', () => {
  it('accepts with optional stripeTransferId', () => {
    const result = Schemas.releaseEscrow.parse({
      escrowId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.stripeTransferId).toBeUndefined();
  });

  it('accepts with provided stripeTransferId', () => {
    const result = Schemas.releaseEscrow.parse({
      escrowId: '550e8400-e29b-41d4-a716-446655440000',
      stripeTransferId: 'tr_123',
    });
    expect(result.stripeTransferId).toBe('tr_123');
  });
});

describe('Schemas.submitProof', () => {
  it('accepts valid taskId', () => {
    const result = Schemas.submitProof.parse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.taskId).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.description).toBeUndefined();
  });

  it('accepts optional description', () => {
    const result = Schemas.submitProof.parse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      description: 'Task done',
    });
    expect(result.description).toBe('Task done');
  });

  it('rejects description over 2000 chars', () => {
    expect(() => Schemas.submitProof.parse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      description: 'a'.repeat(2001),
    })).toThrow();
  });
});

describe('Schemas.reviewProof', () => {
  it('accepts ACCEPTED decision', () => {
    const result = Schemas.reviewProof.parse({
      proofId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'ACCEPTED',
    });
    expect(result.decision).toBe('ACCEPTED');
  });

  it('accepts REJECTED decision', () => {
    const result = Schemas.reviewProof.parse({
      proofId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'REJECTED',
    });
    expect(result.decision).toBe('REJECTED');
  });

  it('rejects invalid decision', () => {
    expect(() => Schemas.reviewProof.parse({
      proofId: '550e8400-e29b-41d4-a716-446655440000',
      decision: 'PENDING',
    })).toThrow();
  });
});

describe('Schemas.awardXP', () => {
  it('accepts valid XP award', () => {
    const result = Schemas.awardXP.parse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      escrowId: '550e8400-e29b-41d4-a716-446655440001',
      baseXP: 100,
    });
    expect(result.baseXP).toBe(100);
  });

  it('rejects non-positive baseXP', () => {
    expect(() => Schemas.awardXP.parse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      escrowId: '550e8400-e29b-41d4-a716-446655440001',
      baseXP: 0,
    })).toThrow();
  });

  it('rejects baseXP over 10000', () => {
    expect(() => Schemas.awardXP.parse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      escrowId: '550e8400-e29b-41d4-a716-446655440001',
      baseXP: 10001,
    })).toThrow();
  });
});

describe('Schemas.pagination', () => {
  it('uses default limit=20 and offset=0', () => {
    const result = Schemas.pagination.parse({});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it('rejects limit over 100', () => {
    expect(() => Schemas.pagination.parse({ limit: 101 })).toThrow();
  });

  it('rejects negative offset', () => {
    expect(() => Schemas.pagination.parse({ offset: -1 })).toThrow();
  });
});

describe('Schemas.cursorPagination', () => {
  it('uses default limit=20 and null cursor', () => {
    const result = Schemas.cursorPagination.parse({});
    expect(result.limit).toBe(20);
    expect(result.cursor).toBeUndefined();
  });

  it('accepts cursor string', () => {
    const result = Schemas.cursorPagination.parse({ cursor: 'eyJpZCI6IjEwIn0=' });
    expect(result.cursor).toBe('eyJpZCI6IjEwIn0=');
  });
});

describe('Schemas.submitCalibration', () => {
  it('accepts valid calibration prompt', () => {
    const result = Schemas.submitCalibration.parse({
      calibrationPrompt: 'I prefer to do physical tasks',
    });
    expect(result.calibrationPrompt).toBe('I prefer to do physical tasks');
    expect(result.onboardingVersion).toBe('1.0.0'); // default
  });

  it('rejects empty calibrationPrompt', () => {
    expect(() => Schemas.submitCalibration.parse({ calibrationPrompt: '' })).toThrow();
  });
});

describe('Schemas.confirmRole', () => {
  it('accepts worker confirmedMode', () => {
    const result = Schemas.confirmRole.parse({ confirmedMode: 'worker' });
    expect(result.confirmedMode).toBe('worker');
    expect(result.overrideAI).toBe(false);
  });

  it('accepts poster confirmedMode', () => {
    const result = Schemas.confirmRole.parse({ confirmedMode: 'poster' });
    expect(result.confirmedMode).toBe('poster');
  });

  it('rejects invalid confirmedMode', () => {
    expect(() => Schemas.confirmRole.parse({ confirmedMode: 'admin' })).toThrow();
  });
});

// ============================================================================
// Router and procedures are exported properly
// ============================================================================

describe('tRPC exports', () => {
  it('router is a function', () => {
    expect(typeof router).toBe('function');
  });

  it('publicProcedure has query method', () => {
    expect(typeof publicProcedure.query).toBe('function');
  });

  it('protectedProcedure has query method', () => {
    expect(typeof protectedProcedure.query).toBe('function');
  });

  it('publicProcedure has mutation method', () => {
    expect(typeof publicProcedure.mutation).toBe('function');
  });

  it('protectedProcedure has mutation method', () => {
    expect(typeof protectedProcedure.mutation).toBe('function');
  });
});
