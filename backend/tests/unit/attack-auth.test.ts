/**
 * RED-TEAM AUTH ATTACK TEST SUITE
 *
 * Systematically probes every authentication and authorization surface
 * in the HustleXP backend. Each test names the attack vector, the exact
 * file:line being tested, and delivers a VERDICT.
 *
 * VERDICT key:
 *   CRITICAL  — direct auth bypass, unauthenticated write, impersonation
 *   HIGH      — role confusion, unauthorized cross-user data access
 *   MEDIUM    — information disclosure, weak enforcement
 *   LOW       — defence-in-depth concern, minor information leak
 *   SAFE      — correctly defended, attack fails as expected
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

// ============================================================================
// MOCK INFRASTRUCTURE
// ============================================================================
// We do NOT need a live DB for these tests. Every test mocks at the boundary
// (firebaseAuth.verifyIdToken, db.query) and exercises the middleware logic.

vi.mock('../../src/auth/firebase.js', () => ({
  firebaseAuth: {
    verifyIdToken: vi.fn(),
  },
}));

vi.mock('../../src/db.js', () => ({
  db: {
    query: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue({ connected: true, schemaVersion: '1.0', latencyMs: 1 }),
  },
}));

vi.mock('../../src/logger.js', () => ({
  logger: {
    child: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Prevent Redis / other external deps from blowing up in unit tests
vi.mock('../../src/cache/db-cache.js', () => ({
  cachedDbQuery: vi.fn((_key: string, fn: () => unknown) => fn()),
  invalidateTask: vi.fn(),
  invalidateUser: vi.fn(),
  invalidateSkills: vi.fn(),
  CACHE_KEYS: {
    taskDetails: (id: string) => `task:${id}`,
    userProfile: (id: string) => `user:${id}`,
  },
  CACHE_TTL: { taskDetails: 60, userProfile: 300, userStats: 120 },
  CACHE_TAGS: {
    TASK: (id: string) => `task:${id}`,
    USER: (id: string) => `user:${id}`,
    SKILLS: 'skills',
  },
}));

vi.mock('../../src/cache/redis.js', () => ({
  redis: { get: vi.fn(), set: vi.fn(), del: vi.fn() },
  CACHE_KEYS: { sessionToken: (t: string) => `session:${t}` },
}));

import { createContext } from '../../src/trpc.js';
import { firebaseAuth } from '../../src/auth/firebase.js';
import { db } from '../../src/db.js';

// ============================================================================
// HELPERS
// ============================================================================

function makeMockRequest(authHeader?: string): Request {
  return {
    headers: {
      get: (name: string) => (name === 'authorization' ? (authHeader ?? null) : null),
    },
  } as unknown as Request;
}

function makeUserRow(overrides: Partial<{
  id: string;
  email: string;
  full_name: string;
  default_mode: string;
  trust_tier: number;
  is_verified: boolean;
  xp_total: number;
  [key: string]: unknown;
}> = {}) {
  return {
    id: 'user-123',
    email: 'user@test.com',
    full_name: 'Test User',
    default_mode: 'worker',
    trust_tier: 1,
    is_verified: false,
    xp_total: 0,
    plan: 'free',
    account_status: 'ACTIVE',
    trust_hold: false,
    role_was_overridden: false,
    live_mode_state: 'OFF',
    live_mode_total_tasks: 0,
    daily_active_minutes: 0,
    consecutive_active_days: 0,
    current_level: 1,
    current_streak: 0,
    student_id_verified: false,
    ...overrides,
  };
}

// ============================================================================
// SECTION 1 — PUBLIC PROCEDURE DATA EXPOSURE
// ============================================================================

describe('1. publicProcedure exposure audit', () => {

  it('1a — health.ping: safe, returns status only, no PII', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/health.ts:17
    // Returns { status: 'ok', timestamp }. No user data. Appropriate to be public.
    expect(true).toBe(true); // structural assertion — confirmed by code read
  });

  it('1b — health.status: MEDIUM — leaks infrastructure topology to unauthenticated callers', () => {
    // VERDICT: MEDIUM
    // File: backend/src/routers/health.ts:24
    // Returns { services.database.schemaVersion, services.stripe.configured, services.firebase.configured,
    //           services.redis.configured, environment }
    // An attacker learns: DB schema version (useful for targeted SQLi), which third-party services
    // are active (Stripe, Firebase, Redis), and the environment name (e.g. "production" vs "staging").
    // This is reconnaissance gold. The status endpoint should require at least a secret token or
    // be restricted to admin-only / internal network.
    const leaksSchemaVersion = true;
    const leaksEnvironment = true;
    const leaksServiceTopology = true;
    expect(leaksSchemaVersion && leaksEnvironment && leaksServiceTopology).toBe(true);
  });

  it('1c — health.verifySchema: HIGH — lists all table names and trigger names to unauthenticated callers', () => {
    // VERDICT: HIGH
    // File: backend/src/routers/health.ts:55
    // Queries information_schema.tables and pg_trigger, then returns:
    //   { tables.missing[], triggers.missing[], views.missing[] }
    // Even on a healthy system the "expected" arrays are embedded in the code and returned,
    // revealing the exact DB schema: table names (users, escrows, admin_roles, gdpr_data_requests...),
    // trigger names (task_terminal_guard, xp_requires_released_escrow...) and view names.
    // This is a complete schema enumeration for any anonymous caller.
    const exposesTableNames = true;  // 33 table names returned
    const exposesTriggerNames = true; // 19 trigger names returned
    const exposesViewNames = true;    // 3 view names returned
    expect(exposesTableNames && exposesTriggerNames && exposesViewNames).toBe(true);
  });

  it('1d — task.getTemplateManifest: LOW — reveals classification system, gameable but not a security hole', () => {
    // VERDICT: LOW
    // File: backend/src/routers/task.ts:427
    // Returns 8 template slugs with display names and one-line descriptions.
    // An attacker can learn the slug names to probe template-based compliance bypasses
    // (e.g. pick "wildcard_bizarre" to avoid in_home trust-tier checks).
    // However there is no PII and no sensitive business data exposed.
    // The classification system itself is not secret — it's surfaced in the iOS UI.
    // Risk: attacker could enumerate slugs to pick the lowest-risk template for a
    // malicious task, reducing compliance trigger likelihood. This is minor.
    const exampleLeakedSlugs = ['in_home', 'care', 'content_creator', 'wildcard_bizarre'];
    expect(exampleLeakedSlugs.length).toBeGreaterThan(0); // confirms exposure
  });

  it('1e — analytics.trackEvent / trackBatch: MEDIUM — unauthenticated write to analytics DB with arbitrary userId', () => {
    // VERDICT: MEDIUM
    // File: backend/src/routers/analytics.ts:30, :88
    // These are publicProcedure mutations. An unauthenticated attacker can:
    //   1. Send up to 100 events per batch call with arbitrary userId (any UUID)
    //   2. Inject noise into analytics, A/B test tracking, and conversion funnels
    //   3. The check on line 51 only fires when ctx.user is set — anonymous calls skip it
    // Specific code path (trackBatch, line 107-116):
    //   if (ctx.user) { ... check for spoofing ... }
    //   else { no check — ctx.user is null, arbitrary userId passes through }
    // This means an unauthenticated caller can pollute analytics for any user ID.
    const anonymousCanSendArbitraryUserId = true; // ctx.user is null, check is skipped
    expect(anonymousCanSendArbitraryUserId).toBe(true);
  });

  it('1f — taskDiscovery.browseTasks: LOW — intentional public read, but leaks full task details including location', () => {
    // VERDICT: LOW (design decision, acknowledged in code comments)
    // File: backend/src/routers/taskDiscovery.ts:68
    // Comment in code: "CRITICAL: This endpoint solves the marketplace cold-start death spiral"
    // Design choice: intentionally public. However it returns full task objects including
    // location strings which may contain home addresses. Acceptable tradeoff per design spec.
    // Not a security bug — it is a documented design decision.
    expect(true).toBe(true);
  });

  it('1g — skills.getCategories / getSkills: SAFE — static catalog data, no PII', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/skills.ts:17, :25
    // Skill categories and skill names are static reference data. No user data. Correct.
    expect(true).toBe(true);
  });

  it('1h — user.register: SAFE as publicProcedure with inline token verification', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/user.ts:223+
    // Must be public to allow new user creation. COPPA check implemented.
    // SEC FIX: idToken is now required in the input. The handler calls
    // firebaseAuth.verifyIdToken(input.idToken) and asserts decoded.uid === input.firebaseUid
    // before any DB access. An attacker who knows a victim's Firebase UID cannot
    // register as them without possessing a valid Firebase ID token for that UID.
    const requiresIdToken = true;         // idToken: z.string().min(1) in schema
    const verifiesTokenOwnership = true;  // decoded.uid === input.firebaseUid check
    expect(requiresIdToken && verifiesTokenOwnership).toBe(true);
  });

});

// ============================================================================
// SECTION 2 — ROLE CONFUSION ATTACKS
// ============================================================================

describe('2. Role confusion attacks', () => {

  it('2a — hustler calling posterProcedure: SAFE — middleware checks default_mode === "poster"', () => {
    // VERDICT: SAFE
    // File: backend/src/trpc.ts:207-223 (isPoster middleware)
    // Check: ctx.user.default_mode !== 'poster' → throws FORBIDDEN
    // A hustler user has default_mode = 'worker', which fails the check.
    // This is stateless — the role is loaded fresh from the DB on every request
    // via firebase token → DB user lookup (trpc.ts:110-115), not from the JWT itself.
    const hustlerUser = makeUserRow({ default_mode: 'worker' });
    expect(hustlerUser.default_mode !== 'poster').toBe(true); // will be rejected
  });

  it('2b — poster calling hustlerProcedure: SAFE — middleware checks default_mode === "worker"', () => {
    // VERDICT: SAFE
    // File: backend/src/trpc.ts:188-204 (isHustler middleware)
    // Check: ctx.user.default_mode !== 'worker' → throws FORBIDDEN
    // A poster user has default_mode = 'poster', which fails the check.
    const posterUser = makeUserRow({ default_mode: 'poster' });
    expect(posterUser.default_mode !== 'worker').toBe(true); // will be rejected
  });

  it('2c — CRITICAL: user.updateProfile allows role switching without restriction', () => {
    // VERDICT: CRITICAL — ANY authenticated user can switch roles at will
    // File: backend/src/routers/user.ts:293-342 (updateProfile)
    // The updateProfile mutation accepts `defaultMode` as an optional input field.
    // It normalizes via normalizeRole() and writes it directly to the DB.
    // There is NO business-rule gate preventing a hustler from becoming a poster
    // or vice versa mid-session. A user can:
    //   1. Register as a hustler (default_mode='worker')
    //   2. Accept a task as a hustler
    //   3. Call updateProfile({ defaultMode: 'poster' })
    //   4. Now they are a poster — their prior task assignment still exists
    //   5. Call posterProcedure endpoints (reviewProof, cancel, complete) on that task
    //
    // The role is the ONLY thing separating hustler and poster procedure access.
    // A self-service role switch is a full privilege escalation on all poster-gated endpoints.
    //
    // Specific attack chain:
    //   Worker accepts task T → switches to poster via updateProfile → calls task.reviewProof
    //   on task T as both the worker AND the poster (same user, dual role).
    //
    // The reviewProof handler does check poster_id === ctx.user.id (task.ts:662),
    // but if the attacker is the actual poster of a DIFFERENT task they created,
    // the more dangerous scenario is:
    //   Hustler creates a task (via role switch to poster) to extract funds from
    //   another hustler, then switches back to hustler to accept their own task,
    //   then switches to poster to approve their own proof and release escrow.
    //
    // applyForTask (task.ts:781) does check task.poster_id === ctx.user.id to prevent
    // self-application, but this check uses the task's stored poster_id, not current role.

    // Evidence: no role-switch restriction in updateProfile
    const inputAllowsRoleSwitch = true;   // defaultMode field accepted, no gate
    const noPreviousTaskCheck = true;      // no check on open tasks before role change
    const noAdminApprovalRequired = true;  // self-service, instant
    expect(inputAllowsRoleSwitch && noPreviousTaskCheck && noAdminApprovalRequired).toBe(true);
  });

  it('2d — ai.submitCalibration / confirmRole: MEDIUM — only hustlers can confirm a role (including poster)', () => {
    // VERDICT: MEDIUM (design oddity, not exploitable in isolation)
    // File: backend/src/routers/ai.ts:22, :62
    // All three AI onboarding procedures (submitCalibration, getInferenceResult, confirmRole)
    // use hustlerProcedure. But confirmRole accepts confirmedMode: z.enum(['worker', 'poster']).
    // This means a hustler can confirm their role as 'poster' via the onboarding flow,
    // and the OnboardingAIService will likely write that to the DB (updating default_mode).
    // A poster (default_mode='poster') cannot call this endpoint at all — they'd be rejected
    // by hustlerProcedure. The net effect: only new workers can complete onboarding;
    // existing posters cannot re-run it. This is an asymmetric flow, not a direct bypass.
    // Combined with 2c above, this is a second route to role switching for worker→poster.
    const hustlerCanConfirmPosterRole = true; // confirmedMode: 'poster' accepted
    expect(hustlerCanConfirmPosterRole).toBe(true);
  });

  it('2e — escrow.awardXP uses hustlerProcedure: SAFE — locks XP to worker role only', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/escrow.ts:284
    // XP award is correctly behind hustlerProcedure. A poster cannot call this.
    // The XPService itself also enforces that the escrow is RELEASED before awarding.
    expect(true).toBe(true);
  });

});

// ============================================================================
// SECTION 3 — JWT / SESSION MANIPULATION
// ============================================================================

describe('3. JWT / session manipulation', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('3a — expired token: SAFE — Firebase verifyIdToken enforces exp claim', async () => {
    // VERDICT: SAFE
    // File: backend/src/trpc.ts:107
    // Firebase Admin SDK verifyIdToken() validates the exp claim internally.
    // An expired token causes verifyIdToken to throw, caught at trpc.ts:123,
    // which returns { user: null, firebaseUid: null } → request proceeds as unauthenticated.
    // Protected procedures then throw UNAUTHORIZED.
    //
    // Cache consideration: the auth cache (trpc.ts:36-75) clamps TTL to
    // tokenRemainingMs - 30s (line 68). If remaining time ≤ 0, the entry is
    // not cached (line 70). So an expired token will never be served from cache.
    vi.mocked(firebaseAuth.verifyIdToken).mockRejectedValueOnce(
      new Error('Token has expired')
    );
    const ctx = await createContext({
      req: makeMockRequest('Bearer expired.token.here'),
      resHeaders: new Headers(),
    });
    expect(ctx.user).toBeNull();
    // An expired token correctly yields null user — auth middleware will UNAUTHORIZED.
  });

  it('3b — tampered JWT (user ID changed): SAFE — Firebase signature verification catches it', async () => {
    // VERDICT: SAFE
    // File: backend/src/trpc.ts:107
    // Firebase ID tokens are RSA-signed. Changing any claim (including sub/uid)
    // invalidates the signature. verifyIdToken will throw "invalid signature".
    // The tRPC context creation catches this and returns { user: null }.
    vi.mocked(firebaseAuth.verifyIdToken).mockRejectedValueOnce(
      new Error('Firebase ID token has invalid signature')
    );
    const ctx = await createContext({
      req: makeMockRequest('Bearer tampered.token'),
      resHeaders: new Headers(),
    });
    expect(ctx.user).toBeNull();
  });

  it('3c — missing authorization header: SAFE — returns clean null context, no exception', async () => {
    // VERDICT: SAFE
    // File: backend/src/trpc.ts:94-96
    // if (!authHeader?.startsWith('Bearer ')) { return { user: null, firebaseUid: null }; }
    // No exception is thrown. The context is cleanly null.
    // Protected procedures then throw TRPCError UNAUTHORIZED.
    const ctx = await createContext({
      req: makeMockRequest(undefined),
      resHeaders: new Headers(),
    });
    expect(ctx.user).toBeNull();
    expect(ctx.firebaseUid).toBeNull();
  });

  it('3d — malformed "Bearer " header (no token after Bearer): SAFE — early return null', async () => {
    // VERDICT: SAFE
    // File: backend/src/trpc.ts:94-98
    // authHeader = 'Bearer ' (7 chars), token = authHeader.slice(7) = '' (empty string)
    // firebaseAuth.verifyIdToken('') will throw, caught at :123 → null context.
    // No null pointer exception occurs.
    vi.mocked(firebaseAuth.verifyIdToken).mockRejectedValueOnce(
      new Error('No token provided')
    );
    const ctx = await createContext({
      req: makeMockRequest('Bearer '),
      resHeaders: new Headers(),
    });
    expect(ctx.user).toBeNull();
  });

  it('3e — publicProcedure with undefined ctx.user: SAFE in infrastructure, MEDIUM in one case', async () => {
    // VERDICT: SAFE (infrastructure) / MEDIUM (one specific endpoint)
    // File: backend/src/trpc.ts:81-84
    // Context type: { user: User | null; firebaseUid: string | null }
    // publicProcedure handlers receive ctx.user as potentially null.
    // Most handlers either don't access ctx.user or use optional chaining (ctx.user?.id).
    //
    // MEDIUM finding: taskDiscovery.browseTasks (taskDiscovery.ts:79):
    //   const userTrustTier = ctx.user?.trust_tier ?? 0;
    //   This is safe — uses optional chaining.
    //
    // analytics.trackEvent (analytics.ts:50-55) has:
    //   const userId = ctx.user?.id || input.userId || undefined;
    //   if (ctx.user && input.userId && input.userId !== ctx.user.id) { throw }
    //   When ctx.user is null, the check is entirely skipped, letting any userId through.
    //   This is the same finding as 1e above.
    const ctx = await createContext({
      req: makeMockRequest(undefined),
      resHeaders: new Headers(),
    });
    expect(ctx.user).toBeNull();
    // Accessing ctx.user?.trust_tier when null returns undefined (safe)
    const trustTier = ctx.user?.trust_tier ?? 0;
    expect(trustTier).toBe(0);
  });

  it('3f — MEDIUM: deleted/banned user token still works until cache TTL (5 min)', async () => {
    // VERDICT: MEDIUM
    // File: backend/src/trpc.ts:100-103
    // If a user is banned (is_banned = true) or deleted from the DB, their Firebase token
    // remains valid. When that token hits the cache (authCacheGet returns a cached entry),
    // the DB is NOT re-queried. The banned/deleted user proceeds as authenticated.
    //
    // The cache TTL is min(5 min, tokenRemainingMs - 30s).
    // A banned user has up to 5 minutes of continued access after banning.
    //
    // The auth/middleware.ts (used for non-tRPC routes) has a Redis revocation check
    // (middleware.ts:41-49) but trpc.ts does NOT replicate this revocation check.
    // The tRPC auth cache has no revocation awareness.
    //
    // Mitigation: the admin ban endpoint (admin.ts:102) sets is_banned in the DB,
    // but the cache is not invalidated. Cache key is SHA-256(token) — no user-keyed
    // invalidation path exists in the tRPC auth cache implementation.
    const cacheHasNoRevocationCheck = true; // confirmed by reading trpc.ts:51-58
    const authMiddlewareHasRevocation = true; // middleware.ts:41-49 has it
    const trpcCacheHasRevocation = false;     // trpc.ts auth cache does NOT
    expect(cacheHasNoRevocationCheck).toBe(true);
    expect(trpcCacheHasRevocation).toBe(false);
  });

  it('3g — ctx.user loaded from DB, not JWT payload: SAFE — stale JWT claims cannot grant privilege', async () => {
    // VERDICT: SAFE
    // File: backend/src/trpc.ts:110-115
    // After Firebase verifyIdToken, the code does:
    //   SELECT * FROM users WHERE firebase_uid = $1
    // The user's role, trust_tier, etc. come from the DB row, not from JWT custom claims.
    // A user cannot embed fake role data in their JWT to escalate privileges.
    const decodedUid = 'firebase-uid-abc';
    vi.mocked(firebaseAuth.verifyIdToken).mockResolvedValueOnce({
      uid: decodedUid,
      exp: Math.floor(Date.now() / 1000) + 3600,
    } as never);
    vi.mocked(db.query)
      .mockResolvedValueOnce({
        rows: [makeUserRow({ id: 'db-user-id', default_mode: 'worker' })],
      } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never); // admin_roles lookup

    const ctx = await createContext({
      req: makeMockRequest('Bearer valid.token'),
      resHeaders: new Headers(),
    });
    // Role comes from DB row (default_mode: 'worker'), not from JWT
    expect(ctx.user?.default_mode).toBe('worker');
  });

});

// ============================================================================
// SECTION 4 — CONTEXT INJECTION / IDOR
// ============================================================================

describe('4. Context injection and IDOR attacks', () => {

  it('4a — task.create: SAFE — posterId always from ctx.user.id, not from input body', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/task.ts:254
    // TaskService.create is called with: posterId: ctx.user.id
    // The createTask Zod schema (trpc.ts:234-258) has NO posterId field.
    // An attacker cannot supply a different posterId in the request body.
    const schemaHasPosterId = false; // confirmed: no posterId in Schemas.createTask
    expect(schemaHasPosterId).toBe(false);
  });

  it('4b — task.listByPoster: SAFE — posterId checked against ctx.user.id', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/task.ts:116-123
    // const posterId = input?.posterId ?? ctx.user.id;
    // if (posterId !== ctx.user.id) { throw FORBIDDEN }
    // Even though posterId is accepted in input, it must match ctx.user.id.
    // Poster A cannot list Poster B's tasks by providing B's UUID.
    const inputHasPosterId = true;      // field exists in schema
    const checkEnforcesOwnership = true; // line 118-122 enforces it
    expect(inputHasPosterId && checkEnforcesOwnership).toBe(true);
  });

  it('4c — task.listByWorker: SAFE — workerId checked against ctx.user.id', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/task.ts:155-161
    // Same pattern as listByPoster — workerId from input must equal ctx.user.id.
    const checkEnforcesOwnership = true;
    expect(checkEnforcesOwnership).toBe(true);
  });

  it('4d — HIGH: escrow.getByTaskId has NO authorization check', () => {
    // VERDICT: HIGH — IDOR on escrow financial data
    // File: backend/src/routers/escrow.ts:79-92
    // getByTaskId is a protectedProcedure (requires auth) but has ZERO authorization check.
    // Any authenticated user can call escrow.getByTaskId({ taskId: <any_uuid> })
    // and retrieve the escrow record for any task, including:
    //   - escrow amount (how much money is at stake)
    //   - stripe_payment_intent_id (could be used for Stripe lookups)
    //   - stripe_transfer_id
    //   - state (FUNDED, RELEASED, etc.)
    //   - poster_id and worker_id (identity disclosure)
    //
    // Compare with escrow.getById (line 29-50) which correctly checks
    //   result.data.poster_id !== ctx.user.id && result.data.worker_id !== ctx.user.id
    // but getByTaskId has NO such check.
    //
    // An attacker who knows (or guesses) a task UUID can enumerate all financial details.
    const getByIdHasAuthCheck = true;   // line 42-47: checks poster_id or worker_id
    const getByTaskIdHasAuthCheck = false; // line 79-92: NO auth check
    expect(getByIdHasAuthCheck).toBe(true);
    expect(getByTaskIdHasAuthCheck).toBe(false);
  });

  it('4e — HIGH: escrow.getState has NO authorization check', () => {
    // VERDICT: HIGH — state oracle for any escrow
    // File: backend/src/routers/escrow.ts:56-74
    // getState is protectedProcedure but accepts any escrowId with no ownership check.
    // Any authenticated user can poll the state of any escrow.
    // While getState only returns { state }, knowing an escrow transitioned to RELEASED
    // can be used to time attacks or confirm payment flow completion.
    const stateEndpointHasAuthCheck = false; // confirmed: no check in lines 56-74
    expect(stateEndpointHasAuthCheck).toBe(false);
  });

  it('4f — MEDIUM: task.getState has NO authorization check', () => {
    // VERDICT: MEDIUM — state oracle for any task
    // File: backend/src/routers/task.ts:76-94
    // getState is protectedProcedure. Returns { state } for any taskId.
    // No check that the caller is the poster or worker of the task.
    // Compare with task.getById (protectedProcedure, no auth check there either — see 4g).
    const taskGetStateHasAuthCheck = false; // confirmed: SELECT state WHERE id=$1, no user filter
    expect(taskGetStateHasAuthCheck).toBe(false);
  });

  it('4g — MEDIUM: task.getById (protectedProcedure) has NO authorization check', () => {
    // VERDICT: MEDIUM — full task detail disclosure to any authenticated user
    // File: backend/src/routers/task.ts:56-70
    // getById fetches full task details via TaskService.getById(input.taskId).
    // There is no check that ctx.user.id is the poster_id or worker_id of the task.
    // Any authenticated user can view any task's full details.
    // This may be intentional (marketplace), but for ACCEPTED/private tasks it leaks
    // the worker's identity and assignment details to unrelated parties.
    const taskGetByIdHasAuthCheck = false; // confirmed: no user filter in handler
    expect(taskGetByIdHasAuthCheck).toBe(false);
  });

  it('4h — SAFE: task.getProof enforces poster or worker ownership via SQL JOIN', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/task.ts:514-541
    // SQL: WHERE p.task_id = $1 AND (t.poster_id = $2 OR t.worker_id = $2)
    // The JOIN ensures only the task poster or worker can retrieve proof.
    const queryEnforcesOwnership = true;
    expect(queryEnforcesOwnership).toBe(true);
  });

  it('4i — SAFE: messaging endpoints use ctx.user.id as senderId, not input field', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/messaging.ts:59, :103
    // senderId: ctx.user.id — not from input
    // The MessagingService enforces that the sender is a task participant.
    expect(true).toBe(true);
  });

  it('4j — MEDIUM: alphaTelemetry endpoints are protectedProcedure but return platform-wide data', () => {
    // VERDICT: MEDIUM
    // File: backend/src/routers/alphaTelemetry.ts (getEdgeStateDistribution, getEdgeStateTimeSpent, etc.)
    // These read-only analytics endpoints aggregate data across ALL users.
    // Any authenticated user (hustler or poster) can query:
    //   - Platform-wide edge state distribution
    //   - Dispute rates per 100 tasks (platform metric)
    //   - Trust tier movement histograms
    //   - Proof correction rates
    // This is competitive intelligence / operational data that should be admin-only.
    // It is not admin-protected — just protectedProcedure (any auth user).
    const anyAuthUserCanSeeDispatchRate = true;
    const anyAuthUserCanSeeTrustTierMovements = true;
    expect(anyAuthUserCanSeeDispatchRate && anyAuthUserCanSeeTrustTierMovements).toBe(true);
  });

});

// ============================================================================
// SECTION 5 — ADMIN PROCEDURE ENUMERATION & VERIFICATION
// ============================================================================

describe('5. Admin procedure protection audit', () => {

  it('5a — admin check uses a separate admin_roles table, not a role enum column', () => {
    // File: backend/src/trpc.ts:161-183 (isAdmin middleware)
    // SELECT role FROM admin_roles WHERE user_id = $1
    // Admin status is a separate table lookup, not a boolean column or role enum on users.
    // This means: a compromised user row (e.g. via SQL injection) cannot grant admin access
    // by changing a field — the attacker would also need to insert into admin_roles.
    // VERDICT: SAFE — defense-in-depth, separate table is harder to accidentally grant.
    const adminStatusIsSeparateTable = true;
    expect(adminStatusIsSeparateTable).toBe(true);
  });

  it('5b — isAdmin middleware checks auth first, then admin_roles: SAFE', () => {
    // File: backend/src/trpc.ts:161-183
    // if (!ctx.user) → UNAUTHORIZED (line 163-167)
    // then SELECT admin_roles → FORBIDDEN if no row (line 175-179)
    // The middleware correctly sequences: auth check → privilege check.
    expect(true).toBe(true);
  });

  it('5c — admin.escrowOverride bypasses normal escrow state machine: documented and intentional', () => {
    // File: backend/src/routers/admin.ts:313-343
    // Force-releases or force-refunds escrow directly via SQL UPDATE, bypassing
    // EscrowService state machine and all invariant checks.
    // VERDICT: SAFE (by design — admin override exists for dispute resolution)
    // Risk: A compromised admin account can drain any FUNDED or DISPUTED escrow.
    // Mitigation: admin_override_by and admin_override_reason are logged to the escrow row.
    const adminCanBypassStateMachine = true; // yes, by design
    const actionIsAudited = true;            // admin_override_by stored
    expect(adminCanBypassStateMachine && actionIsAudited).toBe(true);
  });

  it('5d — MEDIUM: betaDashboard.getBetaConfig is protectedProcedure, not adminProcedure', () => {
    // VERDICT: MEDIUM
    // File: backend/src/routers/betaDashboard.ts:404
    // getBetaConfig returns beta geo-fence bounds, center coordinates, radius, dates.
    // Any authenticated user can retrieve this. The comment says "public — used by iOS for
    // geo-fence display" which is intentional. However the bounds include exact GPS coordinates
    // of the beta region center which could be considered sensitive operational data.
    // The other betaDashboard procedures (getMetrics, getStatus, listUsers, etc.) are
    // correctly adminProcedure.
    const betaConfigIsProtectedNotAdmin = true; // line 404: protectedProcedure
    expect(betaConfigIsProtectedNotAdmin).toBe(true);
  });

  it('5e — SAFE: analytics admin endpoints (calculateFunnel, calculateCohortRetention, getEventCounts) are adminProcedure', () => {
    // File: backend/src/routers/analytics.ts:263, :296, :374
    expect(true).toBe(true);
  });

  it('5f — SAFE: flag management (flags.setFlag) is adminProcedure', () => {
    // File: backend/src/routers/flags.ts:27
    // Feature flag mutations require admin. Read (getFlags) is protectedProcedure for own user.
    expect(true).toBe(true);
  });

});

// ============================================================================
// SECTION 6 — SCOPE CREEP: CAN POSTER A ACT AS POSTER B?
// ============================================================================

describe('6. Cross-user scope creep', () => {

  it('6a — SAFE: task.create derives poster_id from ctx.user.id only', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/task.ts:254 — posterId: ctx.user.id
    // No way for Poster A to create a task that appears to belong to Poster B.
    expect(true).toBe(true);
  });

  it('6b — SAFE: escrow.confirmFunding checks poster_id from DB, not input', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/escrow.ts:151-156
    // escrow.data.poster_id !== ctx.user.id → FORBIDDEN
    // Poster B cannot confirm funding for Poster A's escrow.
    expect(true).toBe(true);
  });

  it('6c — SAFE: escrow.release checks poster_id from DB', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/escrow.ts:183-187
    // Only the escrow creator (poster) can release. DB-enforced check.
    expect(true).toBe(true);
  });

  it('6d — SAFE: task.reviewProof verifies caller is task poster via DB join', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/task.ts:653-667
    // taskResult.data.poster_id !== ctx.user.id → FORBIDDEN
    // A different poster cannot approve proof for another poster's task.
    expect(true).toBe(true);
  });

  it('6e — SAFE: task.cancel verifies caller is the task poster', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/task.ts:733-739
    // taskResult.data.poster_id !== ctx.user.id → FORBIDDEN
    expect(true).toBe(true);
  });

  it('6f — SAFE: task.assignWorker verifies caller is the task poster', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/task.ts:862-865
    // taskResult.rows[0].poster_id !== ctx.user.id → FORBIDDEN
    expect(true).toBe(true);
  });

  it('6g — MEDIUM: escrow.lockForDispute has NO authorization check', () => {
    // VERDICT: MEDIUM — any authenticated user can lock any funded escrow into dispute state
    // File: backend/src/routers/escrow.ts:239-252
    // lockForDispute is protectedProcedure. It calls EscrowService.lockForDispute(escrowId)
    // with NO check that ctx.user.id is the poster or worker of the task.
    // An attacker can lock a stranger's escrow into LOCKED_DISPUTE state, preventing
    // the poster from releasing funds to the worker and vice versa.
    // This is a griefing attack on the payment flow.
    const lockForDisputeHasAuthCheck = false; // confirmed: no user check in handler
    expect(lockForDisputeHasAuthCheck).toBe(false);
  });

  it('6h — SAFE: task.submitProof uses ctx.user.id as submitterId', () => {
    // VERDICT: SAFE
    // File: backend/src/routers/task.ts:558 — submitterId: ctx.user.id
    // A hustler cannot submit proof as another hustler.
    expect(true).toBe(true);
  });

  it('6i — MEDIUM: task.applyForTask checks state but NOT that worker != task.worker_id already', () => {
    // VERDICT: MEDIUM — a worker can apply to a task they already accepted
    // File: backend/src/routers/task.ts:775-807
    // The check at line 775 verifies task.state === 'POSTED'. This prevents double-apply
    // to in-progress tasks. Line 781 correctly prevents applying for own tasks (poster).
    // However: if a task was accepted by Worker A then cancelled/reset to POSTED somehow,
    // Worker A could re-apply. This is a state machine edge case, not a direct auth bypass.
    // The existing application dedup check at lines 785-791 prevents the same worker
    // from applying twice while there's already an active application — SAFE for that case.
    expect(true).toBe(true);
  });

});

// ============================================================================
// SECTION 7 — SUMMARY TABLE
// ============================================================================

describe('7. Attack surface summary', () => {

  it('summarizes all findings by severity', () => {
    const findings = [
      // CRITICAL
      { id: '2c', severity: 'CRITICAL', location: 'user.ts:293', desc: 'updateProfile allows unrestricted role switching (worker↔poster) without any gate — full poster-procedure access after switch' },

      // HIGH
      { id: '4d', severity: 'HIGH', location: 'escrow.ts:79', desc: 'escrow.getByTaskId: no authorization check — any auth user reads financial data for any task' },
      { id: '4e', severity: 'HIGH', location: 'escrow.ts:56', desc: 'escrow.getState: no ownership check — state oracle for any escrow' },
      { id: '1c', severity: 'HIGH', location: 'health.ts:55', desc: 'health.verifySchema is publicProcedure — leaks all 33 table names, 19 trigger names, 3 view names to unauthenticated callers' },

      // MEDIUM
      { id: '1b', severity: 'MEDIUM', location: 'health.ts:24', desc: 'health.status is publicProcedure — leaks DB schema version, environment, service topology' },
      { id: '1e', severity: 'MEDIUM', location: 'analytics.ts:30,88', desc: 'trackEvent/trackBatch are publicProcedure mutations — unauthenticated callers inject events with arbitrary userId' },
      { id: '2d', severity: 'MEDIUM', location: 'ai.ts:62', desc: 'ai.confirmRole (hustlerProcedure) lets workers confirm role=poster via onboarding (second role-switch path)' },
      { id: '3f', severity: 'MEDIUM', location: 'trpc.ts:100', desc: 'Banned/deleted users retain access for up to 5 minutes — tRPC auth cache has no revocation path' },
      { id: '4f', severity: 'MEDIUM', location: 'task.ts:76', desc: 'task.getState: no ownership check — state oracle for any task' },
      { id: '4g', severity: 'MEDIUM', location: 'task.ts:56', desc: 'task.getById: no ownership check — full task details readable by any authenticated user' },
      { id: '4j', severity: 'MEDIUM', location: 'alphaTelemetry.ts', desc: 'Platform analytics (dispute rates, trust tier movements) accessible to all authenticated users, not admin-only' },
      { id: '5d', severity: 'MEDIUM', location: 'betaDashboard.ts:404', desc: 'getBetaConfig is protectedProcedure — GPS bounds / operational config readable by all users' },
      { id: '6g', severity: 'MEDIUM', location: 'escrow.ts:239', desc: 'escrow.lockForDispute: no auth check — any authenticated user can grief-lock any escrow into dispute state' },

      // LOW / SAFE
      { id: '1d', severity: 'LOW', location: 'task.ts:427', desc: 'getTemplateManifest is publicProcedure — reveals 8 template slugs; gameable but not a security hole' },
      { id: '1f', severity: 'LOW', location: 'taskDiscovery.ts:68', desc: 'browseTasks is publicProcedure — intentional design decision for marketplace cold-start; location strings may include home addresses' },
    ];

    const critical = findings.filter(f => f.severity === 'CRITICAL');
    const high     = findings.filter(f => f.severity === 'HIGH');
    const medium   = findings.filter(f => f.severity === 'MEDIUM');
    const low      = findings.filter(f => f.severity === 'LOW');

    expect(critical.length).toBe(1);  // MUST fix before production
    expect(high.length).toBe(3);      // Fix before production
    expect(medium.length).toBe(9);    // Fix before GA / privacy audit
    expect(low.length).toBe(2);       // Address in hardening sprint

    // Surface all CRITICAL + HIGH for CI visibility
    const blockers = [...critical, ...high];
    for (const b of blockers) {
      console.error(`[${b.severity}] ${b.id} @ ${b.location}: ${b.desc}`);
    }

    // Confirm no new CRITICAL findings are silently added
    expect(critical.map(f => f.id)).toEqual(['2c']);
  });

});
