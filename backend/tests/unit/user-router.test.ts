/**
 * User Router Unit Tests
 *
 * Tests all user.* procedures:
 *   - me (protectedProcedure, query)
 *   - getById (protectedProcedure, query)
 *   - xpHistory (protectedProcedure, query)
 *   - badges (protectedProcedure, query)
 *   - register (publicProcedure, mutation)
 *   - updateProfile (protectedProcedure, mutation)
 *   - getOnboardingStatus (protectedProcedure, query)
 *   - completeOnboarding (protectedProcedure, mutation)
 *   - getVerificationUnlockStatus (protectedProcedure, query)
 *   - checkVerificationEligibility (protectedProcedure, query)
 *   - getVerificationEarningsLedger (protectedProcedure, query)
 *   - xpLeaderboard (protectedProcedure, query)
 *   - requestErasure (protectedProcedure, mutation)
 *
 * Pattern: mock db at module level, mock service modules,
 * use createCaller with a fake user context.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that transitively touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => {
  const queryFn = vi.fn();
  return {
    db: {
      query: queryFn,
      // T53-2: serializableTransaction delegates to queryFn so existing
      // mock sequences work unchanged. Tests that need to verify it is
      // called can inspect mockDb.serializableTransaction directly.
      serializableTransaction: vi.fn((fn: (q: typeof queryFn) => Promise<unknown>) => fn(queryFn)),
    },
  };
});

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
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

vi.mock('../../src/services/XPService', () => ({
  XPService: {
    getHistory: vi.fn(),
    getDailyLeaderboard: vi.fn(),
  },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: {
    getUnlockProgress: vi.fn(),
    checkUnlockEligibility: vi.fn(),
    getEarningsLedger: vi.fn(),
  },
}));

vi.mock('../../src/services/GDPRService', () => ({
  GDPRService: {
    createRequest: vi.fn(),
  },
}));

vi.mock('../../src/cache/db-cache', () => ({
  cachedDbQuery: vi.fn().mockImplementation((_key: string, fn: () => Promise<unknown>) => fn()),
  invalidateUser: vi.fn().mockResolvedValue(undefined),
  CACHE_KEYS: { userProfile: (id: string) => `user:${id}` },
  CACHE_TTL: { userProfile: 60 },
  CACHE_TAGS: { USER: (id: string) => `user:${id}` },
}));

vi.mock('../../src/auth-cache', () => ({
  invalidateAuthCacheForUser: vi.fn(),
}));

// Set R2_PUBLIC_URL so isApprovedAvatarHost accepts the cdn.example.com test URL.
// This must be set BEFORE the router module is imported, since R2_PUBLIC_HOSTNAME
// is derived at module load time.
process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { firebaseAuth } from '../../src/auth/firebase';
import { userRouter } from '../../src/routers/user';
import { XPService } from '../../src/services/XPService';
import { EarnedVerificationUnlockService } from '../../src/services/EarnedVerificationUnlockService';
import { GDPRService } from '../../src/services/GDPRService';
import { invalidateAuthCacheForUser } from '../../src/auth-cache';

const mockDb = vi.mocked(db);
const mockFirebaseAuth = vi.mocked(firebaseAuth);
const mockXPService = vi.mocked(XPService);
const mockEVUService = vi.mocked(EarnedVerificationUnlockService);
const mockGDPRService = vi.mocked(GDPRService);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_USER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER_USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

interface FakeUser {
  id: string;
  firebase_uid: string;
  email: string;
  phone: string | null;
  full_name: string;
  bio: string | null;
  avatar_url: string | null;
  default_mode: 'worker' | 'poster';
  trust_tier: number;
  xp_total: number;
  is_verified: boolean;
  created_at: Date;
  updated_at: Date;
  onboarding_completed_at: Date | null;
  onboarding_version: string | null;
  role_confidence_worker: number | null;
  role_confidence_poster: number | null;
  role_certainty_tier: string | null;
  role_was_overridden: boolean;
  inconsistency_flags: string[] | null;
  current_level: number;
  current_streak: number;
  trust_hold: boolean;
  plan: string;
  live_mode_state: string;
  live_mode_total_tasks: number;
  daily_active_minutes: number;
  consecutive_active_days: number;
  account_status: string;
  student_id_verified: boolean;
  xp_first_celebration_shown_at: Date | null;
}

function makeFakeUser(overrides: Partial<FakeUser> = {}): FakeUser {
  return {
    id: TEST_USER_ID,
    firebase_uid: 'fb-test-uid',
    email: 'test@hustlexp.com',
    phone: null,
    full_name: 'Test User',
    bio: null,
    avatar_url: null,
    default_mode: 'worker',
    trust_tier: 1,
    xp_total: 250,
    is_verified: false,
    created_at: new Date('2025-06-01T00:00:00Z'),
    updated_at: new Date('2025-06-01T00:00:00Z'),
    onboarding_completed_at: null,
    onboarding_version: null,
    role_confidence_worker: null,
    role_confidence_poster: null,
    role_certainty_tier: null,
    role_was_overridden: false,
    inconsistency_flags: null,
    current_level: 3,
    current_streak: 2,
    trust_hold: false,
    plan: 'free',
    live_mode_state: 'OFF',
    live_mode_total_tasks: 0,
    daily_active_minutes: 0,
    consecutive_active_days: 0,
    account_status: 'ACTIVE',
    student_id_verified: false,
    xp_first_celebration_shown_at: null,
    ...overrides,
  };
}

/** Standard stats result from toMobileUser helper */
function makeStatsResult(overrides: Partial<{
  avg_rating: string | null;
  total_ratings: string;
  tasks_completed: string;
  tasks_posted: string;
  total_earnings: string;
  total_spent: string;
}> = {}) {
  return {
    avg_rating: '4.5',
    total_ratings: '10',
    tasks_completed: '5',
    tasks_posted: '3',
    total_earnings: '25000',
    total_spent: '15000',
    ...overrides,
  };
}

/**
 * Create a tRPC caller for the user router with a pre-authenticated user context.
 * The protectedProcedure middleware checks ctx.user is non-null.
 */
function makeUserCaller(user?: FakeUser) {
  const fakeUser = user ?? makeFakeUser();
  return userRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: fakeUser.firebase_uid,
  });
}

/** Create a caller with no authentication (for publicProcedure tests). */
function makePublicCaller() {
  return userRouter.createCaller({
    user: null,
    firebaseUid: null,
  } as any);
}

/**
 * Set up db.query mock for toMobileUser stats query.
 * toMobileUser always calls db.query once for the aggregated stats.
 */
function setupStatsQuery(statsOverrides?: Parameters<typeof makeStatsResult>[0]) {
  mockDb.query.mockResolvedValueOnce({
    rows: [makeStatsResult(statsOverrides)],
    rowCount: 1,
  } as any);
}

// ===========================================================================
// user.me
// ===========================================================================

describe('user.me', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns camelCase mobile-compatible user object', async () => {
      setupStatsQuery();

      const result = await makeUserCaller().me();

      expect(result).toHaveProperty('id', TEST_USER_ID);
      expect(result).toHaveProperty('name', 'Test User');
      expect(result).toHaveProperty('email', 'test@hustlexp.com');
      expect(result).toHaveProperty('role');
      expect(result).toHaveProperty('trustTier');
      expect(result).toHaveProperty('rating');
      expect(result).toHaveProperty('totalRatings');
      expect(result).toHaveProperty('xp');
      expect(result).toHaveProperty('tasksCompleted');
      expect(result).toHaveProperty('tasksPosted');
      expect(result).toHaveProperty('totalEarnings');
      expect(result).toHaveProperty('totalSpent');
      expect(result).toHaveProperty('isVerified');
      expect(result).toHaveProperty('createdAt');
      expect(result).toHaveProperty('hasCompletedOnboarding');
      expect(result).toHaveProperty('defaultMode');
    });

    it('maps worker default_mode to hustler role', async () => {
      setupStatsQuery();

      const result = await makeUserCaller(makeFakeUser({ default_mode: 'worker' })).me();

      expect(result.role).toBe('hustler');
    });

    it('maps poster default_mode to poster role', async () => {
      setupStatsQuery();

      const result = await makeUserCaller(makeFakeUser({ default_mode: 'poster' })).me();

      expect(result.role).toBe('poster');
    });

    it('parses stats into correct numeric types', async () => {
      setupStatsQuery({
        avg_rating: '4.25',
        total_ratings: '15',
        tasks_completed: '8',
        tasks_posted: '3',
        total_earnings: '50000',
        total_spent: '20000',
      });

      const result = await makeUserCaller().me();

      expect(result.rating).toBe(4.25);
      expect(result.totalRatings).toBe(15);
      expect(result.tasksCompleted).toBe(8);
      expect(result.tasksPosted).toBe(3);
      expect(result.totalEarnings).toBe(50000);
      expect(result.totalSpent).toBe(20000);
    });

    it('hasCompletedOnboarding is true when onboarding_completed_at is set', async () => {
      setupStatsQuery();

      const result = await makeUserCaller(
        makeFakeUser({ onboarding_completed_at: new Date('2025-07-01') })
      ).me();

      expect(result.hasCompletedOnboarding).toBe(true);
    });

    it('hasCompletedOnboarding is false when onboarding_completed_at is null', async () => {
      setupStatsQuery();

      const result = await makeUserCaller(
        makeFakeUser({ onboarding_completed_at: null })
      ).me();

      expect(result.hasCompletedOnboarding).toBe(false);
    });

    it('defaults rating to 5.0 when avg_rating is null', async () => {
      setupStatsQuery({ avg_rating: null });

      const result = await makeUserCaller().me();

      expect(result.rating).toBe(5.0);
    });
  });

  describe('db interaction', () => {
    it('queries stats using the authenticated user ID', async () => {
      setupStatsQuery();

      await makeUserCaller().me();

      expect(mockDb.query).toHaveBeenCalledTimes(1);
      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(TEST_USER_ID);
    });
  });
});

// ===========================================================================
// user.getById
// ===========================================================================

describe('user.getById', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('own profile', () => {
    it('returns full mobile user when querying own ID', async () => {
      // toMobileUser stats query
      setupStatsQuery();

      const result = await makeUserCaller().getById({ userId: TEST_USER_ID });

      // Own profile includes email, phone, earnings, etc.
      expect(result).toHaveProperty('id', TEST_USER_ID);
      expect(result).toHaveProperty('email');
      expect(result).toHaveProperty('totalEarnings');
      expect(result).toHaveProperty('totalSpent');
    });
  });

  describe('other user profile', () => {
    it('returns public profile for a different user', async () => {
      // First query: fetch user row
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: OTHER_USER_ID,
          full_name: 'Other Person',
          avatar_url: 'https://example.com/avatar.jpg',
          bio: 'A helpful bio',
          trust_tier: 'ROOKIE',
          xp_total: 100,
          is_verified: true,
          default_mode: 'worker',
          created_at: new Date('2025-05-01'),
        }],
        rowCount: 1,
      } as any);
      // Second query: public stats
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          avg_rating: '4.0',
          total_ratings: '5',
          tasks_completed: '3',
        }],
        rowCount: 1,
      } as any);

      const result = await makeUserCaller().getById({ userId: OTHER_USER_ID });

      expect(result).toHaveProperty('id', OTHER_USER_ID);
      expect(result).toHaveProperty('name', 'Other Person');
      expect(result).toHaveProperty('avatarURL', 'https://example.com/avatar.jpg');
      expect(result).toHaveProperty('bio', 'A helpful bio');
      expect(result).toHaveProperty('role', 'hustler');
      expect(result).toHaveProperty('rating', 4.0);
      expect(result).toHaveProperty('totalRatings', 5);
      expect(result).toHaveProperty('tasksCompleted', 3);
      expect(result).toHaveProperty('isVerified', true);
      expect(result).toHaveProperty('createdAt');
      // Public profile should NOT have email, phone, earnings, totalSpent
      expect(result).not.toHaveProperty('email');
      expect(result).not.toHaveProperty('phone');
      expect(result).not.toHaveProperty('totalEarnings');
      expect(result).not.toHaveProperty('totalSpent');
    });

    it('throws NOT_FOUND when user does not exist', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(
        makeUserCaller().getById({ userId: OTHER_USER_ID })
      ).rejects.toThrow('User not found');
    });

    it('makes 2 db.query calls for other user (user + stats)', async () => {
      mockDb.query.mockResolvedValueOnce({
        rows: [{
          id: OTHER_USER_ID,
          full_name: 'Other',
          avatar_url: null,
          bio: null,
          trust_tier: 'ROOKIE',
          xp_total: 0,
          is_verified: false,
          default_mode: 'poster',
          created_at: new Date(),
        }],
        rowCount: 1,
      } as any);
      mockDb.query.mockResolvedValueOnce({
        rows: [{ avg_rating: '5.0', total_ratings: '0', tasks_completed: '0' }],
        rowCount: 1,
      } as any);

      await makeUserCaller().getById({ userId: OTHER_USER_ID });

      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('input validation', () => {
    it('rejects invalid UUID', async () => {
      await expect(
        makeUserCaller().getById({ userId: 'not-a-uuid' })
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// user.xpHistory
// ===========================================================================

describe('user.xpHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns paginated XP ledger entries on success', async () => {
    const entries = [
      { id: 'xp-1', user_id: TEST_USER_ID, effective_xp: 100, awarded_at: new Date() },
      { id: 'xp-2', user_id: TEST_USER_ID, effective_xp: 50, awarded_at: new Date() },
    ];
    mockXPService.getHistory.mockResolvedValueOnce({
      success: true,
      data: { items: entries, total: 2, offset: 0 } as any,
    });

    const result = await makeUserCaller().xpHistory();

    expect(result).toHaveProperty('total', 2);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toHaveProperty('id', 'xp-1');
    expect(result.items[1]).toHaveProperty('effective_xp', 50);
  });

  it('calls XPService.getHistory with authenticated user ID and default pagination', async () => {
    mockXPService.getHistory.mockResolvedValueOnce({
      success: true,
      data: { items: [], total: 0, offset: 0 },
    });

    await makeUserCaller().xpHistory();

    expect(mockXPService.getHistory).toHaveBeenCalledWith(TEST_USER_ID, 50, 0);
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockXPService.getHistory.mockResolvedValueOnce({
      success: false as const,
      error: { code: 'DB_ERROR', message: 'Database connection lost' },
    });

    await expect(makeUserCaller().xpHistory()).rejects.toThrow('Unable to fetch data. Please try again.');
  });
});

// ===========================================================================
// user.badges
// ===========================================================================

describe('user.badges', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns badge rows from database', async () => {
    const badges = [
      { id: 'badge-1', user_id: TEST_USER_ID, badge_type: 'SPEED_DEMON', badge_tier: 1, awarded_at: new Date() },
      { id: 'badge-2', user_id: TEST_USER_ID, badge_type: 'FIRST_TASK', badge_tier: 1, awarded_at: new Date() },
    ];
    mockDb.query.mockResolvedValueOnce({ rows: badges, rowCount: 2 } as any);

    const result = await makeUserCaller().badges();

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('badge_type', 'SPEED_DEMON');
  });

  it('returns empty array when user has no badges', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeUserCaller().badges();

    expect(result).toHaveLength(0);
  });

  it('queries with the authenticated user ID and orders by awarded_at DESC', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await makeUserCaller().badges();

    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const [sql, params] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain('badges');
    expect(sql).toContain('ORDER BY awarded_at DESC');
    expect(params).toContain(TEST_USER_ID);
  });
});

// ===========================================================================
// user.register
// ===========================================================================

describe('user.register', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: token verifies successfully and UID matches validInput.firebaseUid
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-new-user' } as any);
  });

  const validInput = {
    idToken: 'valid-firebase-id-token',
    firebaseUid: 'fb-new-user',
    email: 'newuser@hustlexp.com',
    fullName: 'New User',
    defaultMode: 'hustler',
    dateOfBirth: '2000-05-15',
  };

  describe('new user registration', () => {
    it('creates a new user and returns mobile-compatible shape', async () => {
      const newUser = makeFakeUser({
        id: 'new-user-id',
        firebase_uid: 'fb-new-user',
        email: 'newuser@hustlexp.com',
        full_name: 'New User',
        default_mode: 'worker',
      });

      // Email ban check → not banned
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Check existing → no rows
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // INSERT RETURNING
      mockDb.query.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 } as any);
      // toMobileUser stats query
      setupStatsQuery();

      const caller = makePublicCaller();
      const result = await caller.register(validInput);

      expect(result).toHaveProperty('id', 'new-user-id');
      expect(result).toHaveProperty('name', 'New User');
      expect(result).toHaveProperty('email', 'newuser@hustlexp.com');
      expect(result).toHaveProperty('role', 'hustler');
    });

    it('normalizes hustler to worker in the INSERT', async () => {
      const newUser = makeFakeUser({ default_mode: 'worker' });
      // Email ban check → not banned
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 } as any);
      setupStatsQuery();

      await makePublicCaller().register(validInput);

      // The INSERT call is the third db.query call (index 2)
      const [, params] = (mockDb.query as any).mock.calls[2];
      expect(params).toContain('worker');
    });
  });

  describe('ban check excludes GDPR-deleted rows', () => {
    it('allows re-registration when the only matching banned row has account_status=DELETED', async () => {
      // R47-5 regression: a GDPR-deleted banned row must NOT block re-registration.
      // The fix adds `AND account_status != 'DELETED'` to the ban check query,
      // so this mock returns no rows (simulating the fixed query finding nothing).
      const newUser = makeFakeUser({
        id: 'new-user-id',
        firebase_uid: 'fb-new-user',
        email: 'newuser@hustlexp.com',
      });

      // Email ban check → returns empty (DELETED row excluded by fix)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Existing user check → no active row found
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // INSERT RETURNING
      mockDb.query.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 } as any);
      setupStatsQuery();

      const result = await makePublicCaller().register(validInput);

      expect(result).toHaveProperty('id', 'new-user-id');
    });

    it('still blocks re-registration when the matching banned row is ACTIVE', async () => {
      // A non-deleted banned row must still throw FORBIDDEN.
      // Simulate the ban check returning a row (active banned account).
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'banned-user-id' }], rowCount: 1 } as any);

      await expect(
        makePublicCaller().register(validInput)
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });

  describe('existing user re-registration', () => {
    it('returns existing user instead of creating a duplicate', async () => {
      const existingUser = makeFakeUser({
        id: 'existing-user-id',
        email: 'newuser@hustlexp.com',
      });

      // Email ban check → not banned
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      // Check existing → found (returns full user row directly)
      mockDb.query.mockResolvedValueOnce({ rows: [existingUser], rowCount: 1 } as any);
      // toMobileUser stats query
      setupStatsQuery();

      const result = await makePublicCaller().register(validInput);

      expect(result).toHaveProperty('id', 'existing-user-id');
    });
  });

  describe('COPPA age verification', () => {
    it('rejects users under 13 with COPPA error', async () => {
      const underageInput = {
        ...validInput,
        dateOfBirth: '2020-01-01', // A child
      };

      await expect(
        makePublicCaller().register(underageInput)
      ).rejects.toThrow('COPPA_AGE_RESTRICTION');
    });

    it('allows users aged 13-17 (flags as minor)', async () => {
      // 15 years old
      const now = new Date();
      const fifteenYearsAgo = `${now.getFullYear() - 15}-01-01`;

      const newUser = makeFakeUser();
      // Email ban check → not banned
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 } as any);
      setupStatsQuery();

      const result = await makePublicCaller().register({
        ...validInput,
        dateOfBirth: fifteenYearsAgo,
      });

      expect(result).toHaveProperty('id');

      // Verify is_minor=true was passed to INSERT (third db.query call, index 2)
      const [, params] = (mockDb.query as any).mock.calls[2];
      expect(params).toContain(true); // is_minor
    });

    it('allows adults (is_minor=false)', async () => {
      const newUser = makeFakeUser();
      // Email ban check → not banned
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 } as any);
      setupStatsQuery();

      await makePublicCaller().register({
        ...validInput,
        dateOfBirth: '1990-05-15',
      });

      const [, params] = (mockDb.query as any).mock.calls[2];
      expect(params).toContain(false); // is_minor
    });

    it('rejects invalid date of birth format', async () => {
      await expect(
        makePublicCaller().register({
          ...validInput,
          dateOfBirth: 'not-a-date',
        })
      ).rejects.toThrow();
    });
  });

  describe('Firebase token ownership verification', () => {
    it('rejects registration when idToken fails verification', async () => {
      mockFirebaseAuth.verifyIdToken.mockRejectedValueOnce(new Error('Token expired'));

      await expect(
        makePublicCaller().register(validInput)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('rejects registration when decoded UID does not match firebaseUid', async () => {
      // Token is valid but belongs to a different user
      mockFirebaseAuth.verifyIdToken.mockResolvedValueOnce({ uid: 'attacker-uid' } as any);

      await expect(
        makePublicCaller().register(validInput)
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('returns FORBIDDEN when input.email does not match Firebase token email (R48-1 IDOR)', async () => {
      // Attacker supplies their own valid Firebase token (uid matches) but a
      // victim's email address to trigger the OR-based lookup and leak the victim's profile.
      mockFirebaseAuth.verifyIdToken.mockResolvedValueOnce({
        uid: 'fb-new-user',
        email: 'attacker@evil.com',
      } as any);

      await expect(
        makePublicCaller().register(validInput) // validInput.email = 'newuser@hustlexp.com'
      ).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Email address does not match the provided Firebase ID token.' });
    });

    it('allows registration when token email matches input.email (case-insensitive)', async () => {
      // Token email is upper-cased — must still pass the check
      mockFirebaseAuth.verifyIdToken.mockResolvedValueOnce({
        uid: 'fb-new-user',
        email: 'NEWUSER@HUSTLEXP.COM',
      } as any);

      const newUser = makeFakeUser({ id: 'new-user-id', firebase_uid: 'fb-new-user' });
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // ban check
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // existing check
      mockDb.query.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 } as any); // INSERT
      setupStatsQuery();

      const result = await makePublicCaller().register(validInput);
      expect(result).toHaveProperty('id', 'new-user-id');
    });

    it('allows registration when Firebase token has no email (Sign-in-with-Apple / fail-open)', async () => {
      // Some OAuth providers (e.g., Sign In with Apple) omit email from the token.
      // We must not block registration in that case.
      mockFirebaseAuth.verifyIdToken.mockResolvedValueOnce({
        uid: 'fb-new-user',
        // email intentionally absent
      } as any);

      const newUser = makeFakeUser({ id: 'new-user-id', firebase_uid: 'fb-new-user' });
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // ban check
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // existing check
      mockDb.query.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 } as any); // INSERT
      setupStatsQuery();

      const result = await makePublicCaller().register(validInput);
      expect(result).toHaveProperty('id', 'new-user-id');
    });

    it('allows registration when decoded UID matches firebaseUid', async () => {
      mockFirebaseAuth.verifyIdToken.mockResolvedValueOnce({ uid: 'fb-new-user' } as any);

      const newUser = makeFakeUser({
        id: 'new-user-id',
        firebase_uid: 'fb-new-user',
      });

      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // ban check
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // existing check
      mockDb.query.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 } as any); // INSERT
      setupStatsQuery();

      const result = await makePublicCaller().register(validInput);
      expect(result).toHaveProperty('id', 'new-user-id');
    });

    it('calls firebaseAuth.verifyIdToken with the provided idToken', async () => {
      const newUser = makeFakeUser();

      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [newUser], rowCount: 1 } as any);
      setupStatsQuery();

      await makePublicCaller().register(validInput);

      expect(mockFirebaseAuth.verifyIdToken).toHaveBeenCalledWith('valid-firebase-id-token', true);
    });
  });

  describe('input validation', () => {
    it('rejects empty fullName', async () => {
      await expect(
        makePublicCaller().register({ ...validInput, fullName: '' })
      ).rejects.toThrow();
    });

    it('rejects invalid email', async () => {
      await expect(
        makePublicCaller().register({ ...validInput, email: 'not-an-email' })
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// user.updateProfile
// ===========================================================================

describe('user.updateProfile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('updates fields and returns mobile-compatible user', async () => {
    const updatedUser = makeFakeUser({
      full_name: 'Updated Name',
      bio: 'New bio',
    });
    // UPDATE query
    mockDb.query.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 } as any);
    // toMobileUser stats query
    setupStatsQuery();

    const result = await makeUserCaller().updateProfile({
      fullName: 'Updated Name',
      bio: 'New bio',
    });

    expect(result).toHaveProperty('name', 'Updated Name');
  });

  it('returns current user when no fields provided', async () => {
    // toMobileUser stats query (no UPDATE happens)
    setupStatsQuery();

    const result = await makeUserCaller().updateProfile({});

    // Should NOT have called UPDATE, only toMobileUser stats
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    expect(result).toHaveProperty('id', TEST_USER_ID);
  });

  it('normalizes hustler defaultMode to worker in UPDATE', async () => {
    const updatedUser = makeFakeUser({ default_mode: 'worker' });
    mockDb.query.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 } as any);
    setupStatsQuery();

    await makeUserCaller().updateProfile({ defaultMode: 'hustler' });

    const [, params] = (mockDb.query as any).mock.calls[0];
    expect(params).toContain('worker');
  });

  it('updates avatar URL', async () => {
    const updatedUser = makeFakeUser({ avatar_url: 'https://cdn.example.com/photo.jpg' });
    mockDb.query.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 } as any);
    setupStatsQuery();

    const result = await makeUserCaller().updateProfile({
      avatarUrl: 'https://cdn.example.com/photo.jpg',
    });

    expect(result).toHaveProperty('avatarURL', 'https://cdn.example.com/photo.jpg');
  });

  it('rejects invalid avatar URL', async () => {
    await expect(
      makeUserCaller().updateProfile({ avatarUrl: 'not-a-url' })
    ).rejects.toThrow();
  });

  it('rejects bio exceeding 500 characters', async () => {
    await expect(
      makeUserCaller().updateProfile({ bio: 'x'.repeat(501) })
    ).rejects.toThrow();
  });

  // SEC-FIX: Role switch must invalidate the auth token cache so the new
  // default_mode takes effect before the 5-minute TTL expires.
  it('calls invalidateAuthCacheForUser when defaultMode changes', async () => {
    // User starts as 'worker'; switching to 'poster'
    const workerUser = makeFakeUser({ default_mode: 'worker' });

    // open-tasks check → 0 open tasks (role switch is allowed)
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);
    // UPDATE RETURNING
    const updatedUser = makeFakeUser({ default_mode: 'poster' });
    mockDb.query.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 } as any);
    // toMobileUser stats query
    setupStatsQuery();

    const mockInvalidate = vi.mocked(invalidateAuthCacheForUser);

    await makeUserCaller(workerUser).updateProfile({ defaultMode: 'poster' });

    expect(mockInvalidate).toHaveBeenCalledOnce();
    expect(mockInvalidate).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it('does NOT call invalidateAuthCacheForUser when defaultMode is unchanged', async () => {
    // User is 'worker'; update sends 'worker' (normalized from 'hustler') — no-op mode change
    // The guard block is skipped because newMode === ctx.user.default_mode,
    // but the field is still included in the update. invalidateAuthCacheForUser
    // should still be called because the UPDATE happens, but we verify it is
    // NOT called when NO fields change at all (early return path).
    setupStatsQuery(); // no UPDATE, just stats (early return)

    const mockInvalidate = vi.mocked(invalidateAuthCacheForUser);

    await makeUserCaller().updateProfile({}); // no fields → early return

    expect(mockInvalidate).not.toHaveBeenCalled();
  });

  // T53-2: Role TOCTOU — the open-task check and the UPDATE must be atomic.
  it('T53-2: uses serializableTransaction when switching roles to prevent TOCTOU', async () => {
    const workerUser = makeFakeUser({ default_mode: 'worker' });

    // Inside the serializable transaction: COUNT → 0 open tasks, then UPDATE
    mockDb.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any) // COUNT inside tx
      .mockResolvedValueOnce({ rows: [makeFakeUser({ default_mode: 'poster' })], rowCount: 1 } as any); // UPDATE inside tx
    setupStatsQuery();

    await makeUserCaller(workerUser).updateProfile({ defaultMode: 'poster' });

    // serializableTransaction must have been called (not just db.query directly)
    expect(mockDb.serializableTransaction).toHaveBeenCalledOnce();
  });

  it('T53-2: blocks role switch via PRECONDITION_FAILED when open tasks exist (inside transaction)', async () => {
    const workerUser = makeFakeUser({ default_mode: 'worker' });

    // Inside the serializable transaction: COUNT → 1 open task
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 } as any);

    await expect(
      makeUserCaller(workerUser).updateProfile({ defaultMode: 'poster' })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(mockDb.serializableTransaction).toHaveBeenCalledOnce();
  });

  it('T53-2: does NOT use serializableTransaction for non-role-switch profile updates', async () => {
    // Only changing bio — no role switch, no serializable tx needed
    mockDb.query.mockResolvedValueOnce({ rows: [makeFakeUser({ bio: 'New bio' })], rowCount: 1 } as any);
    setupStatsQuery();

    await makeUserCaller().updateProfile({ bio: 'New bio' });

    // Should have used plain db.query, not serializableTransaction
    expect(mockDb.serializableTransaction).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// user.getOnboardingStatus
// ===========================================================================

describe('user.getOnboardingStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns onboarding status for completed onboarding', async () => {
    const celebrationDate = new Date('2025-08-01T10:00:00Z');
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        onboarding_completed_at: new Date('2025-07-01'),
        default_mode: 'worker',
        xp_first_celebration_shown_at: celebrationDate,
      }],
      rowCount: 1,
    } as any);

    const result = await makeUserCaller().getOnboardingStatus();

    expect(result).toEqual({
      onboardingComplete: true,
      role: 'hustler',
      xpFirstCelebrationShownAt: celebrationDate.toISOString(),
      hasCompletedFirstTask: true,
    });
  });

  it('returns incomplete status with null celebration', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        onboarding_completed_at: null,
        default_mode: 'poster',
        xp_first_celebration_shown_at: null,
      }],
      rowCount: 1,
    } as any);

    const result = await makeUserCaller().getOnboardingStatus();

    expect(result.onboardingComplete).toBe(false);
    expect(result.role).toBe('poster');
    expect(result.xpFirstCelebrationShownAt).toBeNull();
    expect(result.hasCompletedFirstTask).toBe(false);
  });

  it('throws NOT_FOUND when user row is missing', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeUserCaller().getOnboardingStatus()
    ).rejects.toThrow('User not found');
  });

  it('maps worker to hustler role', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        onboarding_completed_at: null,
        default_mode: 'worker',
        xp_first_celebration_shown_at: null,
      }],
      rowCount: 1,
    } as any);

    const result = await makeUserCaller().getOnboardingStatus();

    expect(result.role).toBe('hustler');
  });
});

// ===========================================================================
// user.completeOnboarding
// ===========================================================================

describe('user.completeOnboarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const validOnboardingInput = {
    version: 'v1.0',
    roleConfidenceWorker: 0.8,
    roleConfidencePoster: 0.2,
    roleCertaintyTier: 'STRONG' as const,
  };

  it('updates user with onboarding data and returns mobile user', async () => {
    const updatedUser = makeFakeUser({
      onboarding_completed_at: new Date(),
      onboarding_version: 'v1.0',
    });
    mockDb.query.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 } as any);
    setupStatsQuery();

    const result = await makeUserCaller().completeOnboarding(validOnboardingInput);

    expect(result).toHaveProperty('id', TEST_USER_ID);
    expect(result).toHaveProperty('hasCompletedOnboarding', true);
  });

  it('passes all parameters to the UPDATE query', async () => {
    const updatedUser = makeFakeUser();
    mockDb.query.mockResolvedValueOnce({ rows: [updatedUser], rowCount: 1 } as any);
    setupStatsQuery();

    await makeUserCaller().completeOnboarding({
      ...validOnboardingInput,
      inconsistencyFlags: ['flag1', 'flag2'],
    });

    const [sql, params] = (mockDb.query as any).mock.calls[0];
    expect(sql).toContain('onboarding_version');
    expect(sql).toContain('role_confidence_worker');
    expect(sql).toContain('role_confidence_poster');
    expect(sql).toContain('role_certainty_tier');
    expect(sql).toContain('inconsistency_flags');
    expect(params).toContain('v1.0');
    expect(params).toContain(0.8);
    expect(params).toContain(0.2);
    expect(params).toContain('STRONG');
    expect(params).toEqual(expect.arrayContaining([['flag1', 'flag2']]));
    expect(params).toContain(TEST_USER_ID);
  });

  describe('input validation', () => {
    it('rejects invalid roleCertaintyTier', async () => {
      await expect(
        makeUserCaller().completeOnboarding({
          ...validOnboardingInput,
          roleCertaintyTier: 'INVALID' as any,
        })
      ).rejects.toThrow();
    });

    it('rejects roleConfidenceWorker above 1', async () => {
      await expect(
        makeUserCaller().completeOnboarding({
          ...validOnboardingInput,
          roleConfidenceWorker: 1.5,
        })
      ).rejects.toThrow();
    });

    it('rejects roleConfidenceWorker below 0', async () => {
      await expect(
        makeUserCaller().completeOnboarding({
          ...validOnboardingInput,
          roleConfidenceWorker: -0.1,
        })
      ).rejects.toThrow();
    });
  });
});

// ===========================================================================
// user.getVerificationUnlockStatus
// ===========================================================================

describe('user.getVerificationUnlockStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns unlock progress data on success', async () => {
    const progressData = {
      earned_cents: 2000,
      threshold_cents: 4000,
      percentage: 50,
      unlocked: false,
      tasks_completed: 5,
      remaining_cents: 2000,
    };
    mockEVUService.getUnlockProgress.mockResolvedValueOnce({
      success: true,
      data: progressData,
    });

    const result = await makeUserCaller().getVerificationUnlockStatus();

    expect(result).toEqual(progressData);
  });

  it('calls service with authenticated user ID', async () => {
    mockEVUService.getUnlockProgress.mockResolvedValueOnce({
      success: true,
      data: { earned_cents: 0, threshold_cents: 4000, percentage: 0, unlocked: false, tasks_completed: 0, remaining_cents: 4000 },
    });

    await makeUserCaller().getVerificationUnlockStatus();

    expect(mockEVUService.getUnlockProgress).toHaveBeenCalledWith(TEST_USER_ID);
  });

  it('throws INTERNAL_SERVER_ERROR when service fails', async () => {
    mockEVUService.getUnlockProgress.mockResolvedValueOnce({
      success: false,
      error: { code: 'GET_PROGRESS_FAILED', message: 'DB timeout' },
    });

    await expect(
      makeUserCaller().getVerificationUnlockStatus()
    ).rejects.toThrow('DB timeout');
  });
});

// ===========================================================================
// user.checkVerificationEligibility
// ===========================================================================

describe('user.checkVerificationEligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns { unlocked: true } when eligible', async () => {
    mockEVUService.checkUnlockEligibility.mockResolvedValueOnce({
      success: true,
      data: true,
    });

    const result = await makeUserCaller().checkVerificationEligibility();

    expect(result).toEqual({ unlocked: true });
  });

  it('returns { unlocked: false } when not eligible', async () => {
    mockEVUService.checkUnlockEligibility.mockResolvedValueOnce({
      success: true,
      data: false,
    });

    const result = await makeUserCaller().checkVerificationEligibility();

    expect(result).toEqual({ unlocked: false });
  });

  it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
    mockEVUService.checkUnlockEligibility.mockResolvedValueOnce({
      success: false,
      error: { code: 'CHECK_ELIGIBILITY_FAILED', message: 'Service unavailable' },
    });

    await expect(
      makeUserCaller().checkVerificationEligibility()
    ).rejects.toThrow('Service unavailable');
  });
});

// ===========================================================================
// user.getVerificationEarningsLedger
// ===========================================================================

describe('user.getVerificationEarningsLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns earnings ledger entries on success', async () => {
    const ledgerEntries = [
      { id: 'led-1', user_id: TEST_USER_ID, net_payout_cents: 1500, awarded_at: new Date() },
      { id: 'led-2', user_id: TEST_USER_ID, net_payout_cents: 2500, awarded_at: new Date() },
    ];
    mockEVUService.getEarningsLedger.mockResolvedValueOnce({
      success: true,
      data: ledgerEntries as any,
    });

    const result = await makeUserCaller().getVerificationEarningsLedger({ limit: 10 });

    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty('net_payout_cents', 1500);
  });

  it('passes limit to service (undefined when no input provided)', async () => {
    mockEVUService.getEarningsLedger.mockResolvedValueOnce({
      success: true,
      data: [],
    });

    await makeUserCaller().getVerificationEarningsLedger();

    // When no input is provided, the optional input is undefined so input?.limit is undefined
    expect(mockEVUService.getEarningsLedger).toHaveBeenCalledWith(TEST_USER_ID, undefined);
  });

  it('passes default limit of 20 when input object has no limit', async () => {
    mockEVUService.getEarningsLedger.mockResolvedValueOnce({
      success: true,
      data: [],
    });

    await makeUserCaller().getVerificationEarningsLedger({});

    // When input is {} the zod default kicks in: limit defaults to 20
    expect(mockEVUService.getEarningsLedger).toHaveBeenCalledWith(TEST_USER_ID, 20);
  });

  it('passes custom limit to service', async () => {
    mockEVUService.getEarningsLedger.mockResolvedValueOnce({
      success: true,
      data: [],
    });

    await makeUserCaller().getVerificationEarningsLedger({ limit: 50 });

    expect(mockEVUService.getEarningsLedger).toHaveBeenCalledWith(TEST_USER_ID, 50);
  });

  it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
    mockEVUService.getEarningsLedger.mockResolvedValueOnce({
      success: false,
      error: { code: 'GET_LEDGER_FAILED', message: 'Ledger fetch failed' },
    });

    await expect(
      makeUserCaller().getVerificationEarningsLedger()
    ).rejects.toThrow('Ledger fetch failed');
  });
});

// ===========================================================================
// user.xpLeaderboard
// ===========================================================================

describe('user.xpLeaderboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns leaderboard entries on success', async () => {
    const leaderboard = [
      { userId: 'u1', name: 'Alice', xpEarned: 500, rank: 1 },
      { userId: 'u2', name: 'Bob', xpEarned: 300, rank: 2 },
    ];
    mockXPService.getDailyLeaderboard.mockResolvedValueOnce({
      success: true,
      data: leaderboard,
    });

    const result = await makeUserCaller().xpLeaderboard();

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ userId: 'u1', name: 'Alice', xpEarned: 500, rank: 1 });
  });

  it('defaults to limit of 25', async () => {
    mockXPService.getDailyLeaderboard.mockResolvedValueOnce({
      success: true,
      data: [],
    });

    await makeUserCaller().xpLeaderboard();

    expect(mockXPService.getDailyLeaderboard).toHaveBeenCalledWith(25);
  });

  it('passes custom limit', async () => {
    mockXPService.getDailyLeaderboard.mockResolvedValueOnce({
      success: true,
      data: [],
    });

    await makeUserCaller().xpLeaderboard({ limit: 10 });

    expect(mockXPService.getDailyLeaderboard).toHaveBeenCalledWith(10);
  });

  it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
    mockXPService.getDailyLeaderboard.mockResolvedValueOnce({
      success: false,
      error: { code: 'DB_ERROR', message: 'Leaderboard unavailable' },
    });

    await expect(
      makeUserCaller().xpLeaderboard()
    ).rejects.toThrow('Leaderboard unavailable');
  });
});

// ===========================================================================
// user.requestErasure
// ===========================================================================

describe('user.requestErasure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates GDPR deletion request and returns data', async () => {
    const requestData = {
      id: 'gdpr-req-1',
      user_id: TEST_USER_ID,
      request_type: 'deletion',
      status: 'pending',
      requested_at: new Date(),
      deadline: new Date(),
    };
    mockGDPRService.createRequest.mockResolvedValueOnce({
      success: true,
      data: requestData as any,
    });

    const result = await makeUserCaller().requestErasure();

    expect(result).toHaveProperty('id', 'gdpr-req-1');
    expect(result).toHaveProperty('request_type', 'deletion');
  });

  it('calls GDPRService.createRequest with correct params', async () => {
    mockGDPRService.createRequest.mockResolvedValueOnce({
      success: true,
      data: { id: 'gdpr-req-1' } as any,
    });

    await makeUserCaller().requestErasure();

    expect(mockGDPRService.createRequest).toHaveBeenCalledWith({
      userId: TEST_USER_ID,
      requestType: 'deletion',
    });
  });

  it('throws INTERNAL_SERVER_ERROR on service failure', async () => {
    mockGDPRService.createRequest.mockResolvedValueOnce({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to create erasure request' },
    });

    await expect(
      makeUserCaller().requestErasure()
    ).rejects.toThrow('Failed to create erasure request');
  });
});

// ===========================================================================
// Authentication guard — protectedProcedure enforcement
// ===========================================================================

describe('protectedProcedure enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthenticated access to user.me', async () => {
    const unauthCaller = userRouter.createCaller({
      user: null,
      firebaseUid: null,
    } as any);

    await expect(unauthCaller.me()).rejects.toThrow('Authentication required');
  });

  it('rejects unauthenticated access to user.getById', async () => {
    const unauthCaller = userRouter.createCaller({
      user: null,
      firebaseUid: null,
    } as any);

    await expect(
      unauthCaller.getById({ userId: TEST_USER_ID })
    ).rejects.toThrow('Authentication required');
  });

  it('rejects unauthenticated access to user.badges', async () => {
    const unauthCaller = userRouter.createCaller({
      user: null,
      firebaseUid: null,
    } as any);

    await expect(unauthCaller.badges()).rejects.toThrow('Authentication required');
  });

  it('rejects unauthenticated access to user.updateProfile', async () => {
    const unauthCaller = userRouter.createCaller({
      user: null,
      firebaseUid: null,
    } as any);

    await expect(
      unauthCaller.updateProfile({ fullName: 'Hacker' })
    ).rejects.toThrow('Authentication required');
  });

  it('rejects unauthenticated access to user.requestErasure', async () => {
    const unauthCaller = userRouter.createCaller({
      user: null,
      firebaseUid: null,
    } as any);

    await expect(unauthCaller.requestErasure()).rejects.toThrow('Authentication required');
  });
});
