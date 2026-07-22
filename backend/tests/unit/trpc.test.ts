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

// Stable child logger so tests can inspect its calls (especially error).
// Must be hoisted so the vi.mock factory (which runs before variable init) can
// reference it.
const mockChildLogger = vi.hoisted(() => ({
  warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
}));

vi.mock('../../src/logger', () => ({
  logger: {
    child: () => mockChildLogger,
  },
}));

// ─── Imports ─────────────────────────────────────────────────────────────────
import { createContext, Schemas, router, publicProcedure, protectedProcedure, hustlerProcedure, posterProcedure, publicTRPCErrorShape } from '../../src/trpc';
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

function makeRequest(authHeader?: string, bridgeKey?: string): Request {
  const headers = new Headers();
  if (authHeader) headers.set('authorization', authHeader);
  if (bridgeKey) headers.set('x-engine-bridge-key', bridgeKey);
  return new Request('http://localhost/', { headers });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('publicTRPCErrorShape', () => {
  it('redacts internal exception details and every stack trace', () => {
    expect(publicTRPCErrorShape({
      message: 'column secret_table.private_value does not exist',
      data: { code: 'INTERNAL_SERVER_ERROR', stack: 'private stack' },
    })).toEqual({
      message: 'Internal server error',
      data: { code: 'INTERNAL_SERVER_ERROR', stack: undefined },
    });
  });

  it('preserves actionable non-internal messages while stripping the stack', () => {
    expect(publicTRPCErrorShape({
      message: 'Authentication required',
      data: { code: 'UNAUTHORIZED', stack: 'private stack' },
    })).toEqual({
      message: 'Authentication required',
      data: { code: 'UNAUTHORIZED', stack: undefined },
    });
  });
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

  it('authenticates a valid engine bridge key without creating a user session', async () => {
    const key = 'bridge-key-that-is-longer-than-thirty-two-characters';
    vi.stubEnv('ENGINE_BRIDGE_WRITE_KEY', key);
    vi.stubEnv('ENGINE_BRIDGE_ACTOR_ID', '550e8400-e29b-41d4-a716-446655440002');
    try {
      const ctx = await createContext({ req: makeRequest(undefined, key), resHeaders: new Headers() });
      expect(ctx.user).toBeNull();
      expect(ctx.engineBridgeAuthorized).toBe(true);
      expect(ctx.engineBridgeActorId).toBe('550e8400-e29b-41d4-a716-446655440002');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects a wrong engine bridge key without leaking an actor identity', async () => {
    vi.stubEnv('ENGINE_BRIDGE_WRITE_KEY', 'bridge-key-that-is-longer-than-thirty-two-characters');
    vi.stubEnv('ENGINE_BRIDGE_ACTOR_ID', '550e8400-e29b-41d4-a716-446655440002');
    try {
      const ctx = await createContext({ req: makeRequest(undefined, 'wrong-key-that-is-also-longer-than-thirty-two'), resHeaders: new Headers() });
      expect(ctx.engineBridgeAuthorized).toBe(false);
      expect(ctx.engineBridgeActorId).toBeNull();
    } finally {
      vi.unstubAllEnvs();
    }
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
    mockDbQuery
      .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 })  // SELECT * FROM users
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });           // SELECT 1 FROM admin_roles

    const ctx = await createContext({ req: makeRequest('Bearer valid-token'), resHeaders: new Headers() });

    expect(ctx.user).toEqual(expect.objectContaining({
      id: mockUser.id,
      email: mockUser.email,
      firebase_uid: mockUser.firebase_uid,
    }));
    expect(ctx.firebaseUid).toBe('uid-1');
    expect(mockVerifyIdToken).toHaveBeenCalledWith('valid-token', true);
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

  it('sanitizes JWT tokens from Firebase error messages before logging (SECURITY FIX v2.9.4)', async () => {
    // Firebase Admin SDK sometimes embeds the raw token in error messages.
    // Verify that the logger never receives the JWT-shaped string.
    const jwtLike = 'eyJhbGciOiJSUzI1NiJ9.eyJ1aWQiOiJ1c2VyLTEifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const errorMsg = `Firebase ID token has invalid signature. Token: ${jwtLike}`;
    mockVerifyIdToken.mockRejectedValueOnce(new Error(errorMsg));

    await createContext({ req: makeRequest('Bearer some-token'), resHeaders: new Headers() });

    // mockChildLogger.error is the stable mock used by the trpc module's child logger
    expect(mockChildLogger.error).toHaveBeenCalled();
    const loggedArg = mockChildLogger.error.mock.calls[0][0] as { err: string };
    expect(loggedArg.err).not.toContain(jwtLike);
    expect(loggedArg.err).toContain('[REDACTED_TOKEN]');
  });

  it('strips Bearer prefix before calling verifyIdToken', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({ uid: 'uid-1', exp: Math.floor(Date.now() / 1000) + 3600 });
    mockDbQuery
      .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 })  // SELECT * FROM users
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });           // SELECT 1 FROM admin_roles

    await createContext({ req: makeRequest('Bearer my-actual-token'), resHeaders: new Headers() });

    expect(mockVerifyIdToken).toHaveBeenCalledWith('my-actual-token', true);
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
    mockDbQuery
      .mockResolvedValueOnce({ rows: [mockUser], rowCount: 1 })  // SELECT * FROM users (first call only)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });           // SELECT 1 FROM admin_roles (first call only)

    // First call — should go to firebase
    const ctx1 = await createContext({ req: makeRequest(uniqueToken), resHeaders: new Headers() });
    // Second call with same token — should use cache
    const ctx2 = await createContext({ req: makeRequest(uniqueToken), resHeaders: new Headers() });

    expect(ctx1.user).toEqual(expect.objectContaining({ id: mockUser.id }));
    expect(ctx2.user).toEqual(expect.objectContaining({ id: mockUser.id }));
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
    // Both calls hit the DB (not cached): users query + admin_roles query per call
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
  const policyFields = { regionCode: 'US-WA', category: 'moving' };

  it('accepts a valid task with required fields', () => {
    const valid = {
      ...policyFields,
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
    expect(() => Schemas.createTask.parse({ ...policyFields, title: '', description: 'Desc', price: 500 })).toThrow();
  });

  it('rejects price that is zero', () => {
    expect(() => Schemas.createTask.parse({ ...policyFields, title: 'T', description: 'D', price: 0 })).toThrow();
  });

  it('rejects price that is negative', () => {
    expect(() => Schemas.createTask.parse({ ...policyFields, title: 'T', description: 'D', price: -100 })).toThrow();
  });

  it('rejects price over maximum', () => {
    expect(() => Schemas.createTask.parse({ ...policyFields, title: 'T', description: 'D', price: 100_000_000 })).toThrow();
  });

  it('rejects price that is non-integer', () => {
    expect(() => Schemas.createTask.parse({ ...policyFields, title: 'T', description: 'D', price: 10.5 })).toThrow();
  });

  it('accepts mode LIVE', () => {
    const result = Schemas.createTask.parse({ ...policyFields, title: 'T', description: 'Valid description text', price: 1500, mode: 'LIVE' });
    expect(result.mode).toBe('LIVE');
  });

  it('rejects invalid mode', () => {
    expect(() => Schemas.createTask.parse({ ...policyFields, title: 'T', description: 'Valid description text', price: 1000, mode: 'INVALID' })).toThrow();
  });

  it('accepts optional deadline as datetime string', () => {
    const result = Schemas.createTask.parse({
      ...policyFields, title: 'T', description: 'Valid description text', price: 1000, deadline: '2026-12-31T00:00:00Z',
    });
    expect(result.deadline).toBe('2026-12-31T00:00:00Z');
  });

  it('rejects missing or malformed region policy identity', () => {
    const task = { title: 'T', description: 'Valid description text', price: 5000, category: 'moving' };
    expect(() => Schemas.createTask.parse(task)).toThrow();
    expect(() => Schemas.createTask.parse({ ...task, regionCode: 'WA' })).toThrow();
  });

  it('rejects missing category', () => {
    expect(() => Schemas.createTask.parse({
      title: 'T', description: 'Valid description text', price: 5000, regionCode: 'US-WA',
    })).toThrow();
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
  it('accepts with required stripeTransferId', () => {
    const result = Schemas.releaseEscrow.parse({
      escrowId: '550e8400-e29b-41d4-a716-446655440000',
      stripeTransferId: 'tr_123',
    });
    expect(result.stripeTransferId).toBe('tr_123');
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
  // SECURITY FIX: baseXP removed from user-facing schema — derived server-side
  // from the escrow record to prevent caller-controlled XP inflation.
  it('accepts valid XP award without baseXP (server-side derivation)', () => {
    const result = Schemas.awardXP.parse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      escrowId: '550e8400-e29b-41d4-a716-446655440001',
    });
    expect((result as Record<string, unknown>).baseXP).toBeUndefined();
  });

  it('caller-supplied baseXP is stripped (not trusted)', () => {
    // Zod strip mode: extra keys are silently dropped — attacker cannot inject baseXP
    const result = Schemas.awardXP.safeParse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
      escrowId: '550e8400-e29b-41d4-a716-446655440001',
      baseXP: 10000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).baseXP).toBeUndefined();
    }
  });

  it('rejects missing taskId', () => {
    expect(() => Schemas.awardXP.parse({
      escrowId: '550e8400-e29b-41d4-a716-446655440001',
    })).toThrow();
  });

  it('rejects missing escrowId', () => {
    expect(() => Schemas.awardXP.parse({
      taskId: '550e8400-e29b-41d4-a716-446655440000',
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

  it('hustlerProcedure has query method', () => {
    expect(typeof hustlerProcedure.query).toBe('function');
  });

  it('posterProcedure has query method', () => {
    expect(typeof posterProcedure.query).toBe('function');
  });
});

// ============================================================================
// Role-based procedures (hustlerProcedure / posterProcedure)
// ============================================================================

describe('hustlerProcedure', () => {
  const testRouter = router({
    hustlerOnly: hustlerProcedure.query(() => 'hustler-ok'),
  });

  it('allows user with default_mode = worker', async () => {
    const caller = testRouter.createCaller({
      user: { ...mockUser, default_mode: 'worker' } as any,
      firebaseUid: 'uid-1',
    });
    const result = await caller.hustlerOnly();
    expect(result).toBe('hustler-ok');
  });

  it('rejects user with default_mode = poster with FORBIDDEN', async () => {
    const caller = testRouter.createCaller({
      user: { ...mockUser, default_mode: 'poster' } as any,
      firebaseUid: 'uid-1',
    });
    await expect(caller.hustlerOnly()).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', message: 'Hustler access required' })
    );
  });

  it('rejects a minor worker from all hustler procedures', async () => {
    const caller = testRouter.createCaller({
      user: { ...mockUser, default_mode: 'worker', is_minor: true } as any,
      firebaseUid: 'uid-1',
    });
    await expect(caller.hustlerOnly()).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', message: 'Hustlers must be at least 18 years old.' })
    );
  });

  it('rejects null user with UNAUTHORIZED', async () => {
    const caller = testRouter.createCaller({
      user: null,
      firebaseUid: null,
    });
    await expect(caller.hustlerOnly()).rejects.toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED', message: 'Authentication required' })
    );
  });
});

describe('posterProcedure', () => {
  const testRouter = router({
    posterOnly: posterProcedure.query(() => 'poster-ok'),
  });

  it('allows user with default_mode = poster', async () => {
    const caller = testRouter.createCaller({
      user: { ...mockUser, default_mode: 'poster' } as any,
      firebaseUid: 'uid-1',
    });
    const result = await caller.posterOnly();
    expect(result).toBe('poster-ok');
  });

  it('rejects user with default_mode = worker with FORBIDDEN', async () => {
    const caller = testRouter.createCaller({
      user: { ...mockUser, default_mode: 'worker' } as any,
      firebaseUid: 'uid-1',
    });
    await expect(caller.posterOnly()).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN', message: 'Poster access required' })
    );
  });

  it('rejects null user with UNAUTHORIZED', async () => {
    const caller = testRouter.createCaller({
      user: null,
      firebaseUid: null,
    });
    await expect(caller.posterOnly()).rejects.toThrow(
      expect.objectContaining({ code: 'UNAUTHORIZED', message: 'Authentication required' })
    );
  });
});
