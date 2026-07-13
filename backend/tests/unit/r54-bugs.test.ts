/**
 * R54 Bug Tests — A63-1, A63-2, A63-3
 *
 * A63-2 (HIGH):   Wrong case in matchmaker.ts candidate query — 'hustler'/'flex'/'active' vs
 *                 correct 'worker'/'poster'/'ACTIVE'.
 * A63-1 (MEDIUM): Missing DELETED check in concurrent registration conflict path.
 * A63-3 (MEDIUM): Inline admin checks in task.ts / analytics.ts lack role allowlist.
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
  aiLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
  taskLogger: {
    child: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  },
}));

vi.mock('../../src/services/MatchmakerAIService', () => ({
  MatchmakerAIService: {
    rankCandidates: vi.fn(),
    explainMatch: vi.fn(),
    suggestPrice: vi.fn(),
  },
}));

vi.mock('../../src/services/XPService', () => ({
  XPService: { getHistory: vi.fn(), getDailyLeaderboard: vi.fn() },
}));

vi.mock('../../src/services/EarnedVerificationUnlockService', () => ({
  EarnedVerificationUnlockService: {
    getUnlockProgress: vi.fn(),
    checkUnlockEligibility: vi.fn(),
    getEarningsLedger: vi.fn(),
  },
}));

vi.mock('../../src/services/GDPRService', () => ({
  GDPRService: { createRequest: vi.fn() },
}));

vi.mock('../../src/cache/db-cache', () => ({
  cachedDbQuery: vi.fn().mockImplementation((_key: string, fn: () => Promise<unknown>) => fn()),
  invalidateUser: vi.fn().mockResolvedValue(undefined),
  CACHE_KEYS: {
    userProfile: (id: string) => `user:${id}`,
    taskDetails: (id: string) => `task:${id}`,
  },
  CACHE_TTL: { userProfile: 60, taskDetails: 60 },
  CACHE_TAGS: { USER: (id: string) => `user:${id}`, TASK: (id: string) => `task:${id}` },
}));

vi.mock('../../src/auth-cache', () => ({
  invalidateAuthCacheForUser: vi.fn(),
}));

vi.mock('../../src/services/TaskService', () => ({
  TaskService: {
    getById: vi.fn(),
    create: vi.fn(),
    assign: vi.fn(),
    complete: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock('../../src/services/AnalyticsService', () => ({
  AnalyticsService: {
    trackEvent: vi.fn(),
    trackBatch: vi.fn(),
    getUserEvents: vi.fn(),
    getTaskEvents: vi.fn(),
    calculateFunnel: vi.fn(),
    calculateCohortRetention: vi.fn(),
    trackABTest: vi.fn(),
    getEventCounts: vi.fn(),
  },
}));

process.env.R2_PUBLIC_URL = 'https://cdn.example.com';

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { firebaseAuth } from '../../src/auth/firebase';
import { matchmakerRouter } from '../../src/routers/matchmaker';
import { userRouter } from '../../src/routers/user';
import { taskRouter } from '../../src/routers/task';
import { analyticsRouter } from '../../src/routers/analytics';
import { MatchmakerAIService } from '../../src/services/MatchmakerAIService';
import { AnalyticsService } from '../../src/services/AnalyticsService';
import { TaskService } from '../../src/services/TaskService';
import { cachedDbQuery } from '../../src/cache/db-cache';

const mockDb = vi.mocked(db);
const mockFirebaseAuth = vi.mocked(firebaseAuth);
const mockMatchmaker = vi.mocked(MatchmakerAIService);
const mockAnalytics = vi.mocked(AnalyticsService);
const mockTaskService = vi.mocked(TaskService);

// ---------------------------------------------------------------------------
// UUIDs
// ---------------------------------------------------------------------------

const UUID1 = '00000000-0000-0000-0000-000000000001';
const UUID2 = '00000000-0000-0000-0000-000000000002';
const UUID3 = '00000000-0000-0000-0000-000000000003';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdminMatchmakerCaller() {
  // adminProcedure checks admin role via first db.query
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
  return matchmakerRouter.createCaller({
    user: { id: UUID1, email: 'admin@test.com', full_name: 'Admin', role: 'admin', firebase_uid: 'fb-admin' } as any,
    firebaseUid: 'fb-admin',
  });
}

function makePublicUserCaller() {
  return userRouter.createCaller({ user: null, firebaseUid: null } as any);
}

function makeProtectedTaskCaller() {
  return taskRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

function makeProtectedAnalyticsCaller() {
  return analyticsRouter.createCaller({
    user: { id: UUID1, email: 'user@test.com', full_name: 'User', firebase_uid: 'fb-1' } as any,
    firebaseUid: 'fb-1',
  });
}

// ===========================================================================
// A63-2: Wrong case in matchmaker.ts candidate query
// ===========================================================================

describe('A63-2: matchmaker rankCandidates candidate query uses correct case', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('candidate SQL uses "worker" and "poster" (not "hustler"/"flex") for default_mode', async () => {
    mockMatchmaker.rankCandidates.mockResolvedValue({
      success: true,
      data: [],
    } as any);

    const caller = makeAdminMatchmakerCaller();
    // Task query
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: UUID2, title: 'Fix plumbing', description: 'Leaky faucet',
        category: 'home_repair', location_text: 'Chicago', price: 5000, requirements: null,
        poster_id: UUID1, worker_id: null,
      }],
      rowCount: 1,
    } as any);
    // Candidates query
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await caller.rankCandidates({ taskId: UUID2 });

    // Find the candidates query — it is the last db.query call
    const allCalls = mockDb.query.mock.calls;
    const candidateCall = allCalls[allCalls.length - 1];
    const sql: string = candidateCall[0] as string;

    // Must include correct DB values
    expect(sql).toContain("'worker'");
    expect(sql).toContain("'poster'");
    expect(sql).toContain("'ACTIVE'");

    // Must NOT include the wrong values
    expect(sql).not.toContain("'hustler'");
    expect(sql).not.toContain("'flex'");
    // 'active' (lowercase) must not appear
    expect(sql).not.toMatch(/'active'/);
  });

  it('candidate SQL uses uppercase ACTIVE for account_status filter', async () => {
    mockMatchmaker.rankCandidates.mockResolvedValue({ success: true, data: [] } as any);

    const caller = makeAdminMatchmakerCaller();
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: UUID2, title: 'Task', description: 'Desc', category: null,
        location_text: null, price: 1000, requirements: null,
        poster_id: UUID1, worker_id: null,
      }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await caller.rankCandidates({ taskId: UUID2 });

    const allCalls = mockDb.query.mock.calls;
    const candidateCall = allCalls[allCalls.length - 1];
    const sql: string = candidateCall[0] as string;

    // Exact uppercase ACTIVE must appear
    expect(sql).toMatch(/account_status\s*=\s*'ACTIVE'/);
  });
});

// ===========================================================================
// A63-1: Missing DELETED check in concurrent registration conflict path
// ===========================================================================

describe('A63-1: concurrent registration conflict path handles DELETED accounts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: Firebase token verifies successfully
    mockFirebaseAuth.verifyIdToken.mockResolvedValue({ uid: 'fb-new-user' } as any);
  });

  const validInput = {
    idToken: 'valid-firebase-id-token',
    firebaseUid: 'fb-new-user',
    email: 'newuser@hustlexp.com',
    fullName: 'New User',
    defaultMode: 'worker',
    dateOfBirth: '2000-05-15',
  };

  it('throws an error when the concurrent conflict winner has account_status DELETED', async () => {
    // The concurrent INSERT path: INSERT returns 0 rows, then fallback SELECT returns a DELETED user.
    // Without the fix, a DELETED winner would be returned as a valid user via toMobileUser.
    // With the fix, it must throw an error (FORBIDDEN or INTERNAL_SERVER_ERROR) not silently succeed.
    // Note: validInput has no phone, so the phone ban check is skipped.

    // Email ban check → clear
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // Existing user check → no match
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // INSERT → 0 rows (conflict, another request won the race)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // Fallback SELECT → returns a DELETED user (concurrent winner was a DELETED account)
    const deletedWinner = {
      id: 'deleted-winner-id',
      firebase_uid: 'fb-new-user',
      email: 'newuser@hustlexp.com',
      full_name: 'Deleted User',
      is_banned: false,
      account_status: 'DELETED',
    };
    mockDb.query.mockResolvedValueOnce({ rows: [deletedWinner], rowCount: 1 } as any);

    // The fix must not silently return the DELETED user profile.
    // It should throw FORBIDDEN (treating DELETED like banned/suspended) or retry.
    await expect(
      makePublicUserCaller().register(validInput)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('still returns the winning row when the concurrent winner is a normal ACTIVE user', async () => {
    const activeWinner = {
      id: 'active-winner-id',
      firebase_uid: 'fb-new-user',
      email: 'newuser@hustlexp.com',
      full_name: 'Active User',
      is_banned: false,
      account_status: 'ACTIVE',
      phone: null,
      bio: null,
      avatar_url: null,
      default_mode: 'worker',
      trust_tier: 1,
      xp_total: 0,
      is_verified: false,
      created_at: new Date('2025-06-01'),
      updated_at: new Date('2025-06-01'),
      onboarding_completed_at: null,
      xp_first_celebration_shown_at: null,
    };

    // Note: validInput has no phone, so the phone ban check is skipped.
    // Email ban check → clear
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // Existing user check → no match
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // INSERT → 0 rows (conflict)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // Fallback SELECT → returns the ACTIVE winner
    mockDb.query.mockResolvedValueOnce({ rows: [activeWinner], rowCount: 1 } as any);
    // toMobileUser stats query
    mockDb.query.mockResolvedValueOnce({
      rows: [{ avg_rating: '5.0', total_ratings: '0', tasks_completed: '0', tasks_posted: '0', total_earnings: '0', total_spent: '0' }],
      rowCount: 1,
    } as any);

    const result = await makePublicUserCaller().register(validInput);
    expect(result).toHaveProperty('id', 'active-winner-id');
  });

  it('still throws FORBIDDEN when the concurrent conflict winner is SUSPENDED', async () => {
    // Note: validInput has no phone, so the phone ban check is skipped.
    // Email ban check → clear
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // Existing user check → no match
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // INSERT → 0 rows
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    // Fallback SELECT → SUSPENDED winner
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'suspended-id', is_banned: false, account_status: 'SUSPENDED' }],
      rowCount: 1,
    } as any);

    await expect(
      makePublicUserCaller().register(validInput)
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ===========================================================================
// A63-3: Inline admin checks lack role allowlist
// ===========================================================================

describe('A63-3: task.getById inline admin check uses role allowlist', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(cachedDbQuery).mockImplementation((_key: string, fn: () => Promise<unknown>) => fn());
  });

  it('admin check SQL in task.getById includes role = ANY filter (not bare SELECT 1)', async () => {
    // Set up a non-participant, non-discoverable task scenario to trigger the admin check
    const task = {
      id: UUID2,
      title: 'Private Task',
      description: 'Desc',
      state: 'ASSIGNED', // not discoverable (not OPEN or MATCHING)
      poster_id: UUID3,  // not UUID1 (our caller)
      worker_id: UUID3,  // not UUID1 either
      price: 5000,
      created_at: new Date(),
      updated_at: new Date(),
    };

    // cachedDbQuery is mocked to call the fn directly, so TaskService.getById will be called
    mockTaskService.getById.mockResolvedValue({ success: true, data: task } as any);

    // Admin role check → admin found
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);

    const caller = makeProtectedTaskCaller();
    await caller.getById({ taskId: UUID2 });

    // Verify the admin_roles query used a role filter
    const adminCall = mockDb.query.mock.calls.find(
      (call) => (call[0] as string).includes('admin_roles')
    );
    expect(adminCall).toBeDefined();
    const sql: string = adminCall![0] as string;
    // Must include role/ANY filter — no bare SELECT 1 without role filter
    expect(sql).toMatch(/role\s*=\s*ANY/i);
  });

  it('task.getById throws FORBIDDEN when non-participant has no valid admin role', async () => {
    const task = {
      id: UUID2,
      title: 'Private Task',
      description: 'Desc',
      state: 'ASSIGNED',
      poster_id: UUID3,
      worker_id: UUID3,
      price: 5000,
      created_at: new Date(),
      updated_at: new Date(),
    };

    mockTaskService.getById.mockResolvedValue({ success: true, data: task } as any);

    // Admin role check → no valid role found
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const caller = makeProtectedTaskCaller();
    await expect(caller.getById({ taskId: UUID2 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('A63-3: task.getState inline admin check uses role allowlist', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('admin check SQL in task.getState includes role = ANY filter', async () => {
    // Non-participant task
    mockDb.query.mockResolvedValueOnce({
      rows: [{ state: 'ASSIGNED', poster_id: UUID3, worker_id: UUID3 }],
      rowCount: 1,
    } as any);
    // Admin check → found
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);

    const caller = makeProtectedTaskCaller();
    await caller.getState({ taskId: UUID2 });

    const adminCall = mockDb.query.mock.calls.find(
      (call) => (call[0] as string).includes('admin_roles')
    );
    expect(adminCall).toBeDefined();
    const sql: string = adminCall![0] as string;
    expect(sql).toMatch(/role\s*=\s*ANY/i);
  });

  it('task.getState throws FORBIDDEN when non-participant has no valid admin role', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ state: 'ASSIGNED', poster_id: UUID3, worker_id: UUID3 }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const caller = makeProtectedTaskCaller();
    await expect(caller.getState({ taskId: UUID2 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('A63-3: analytics.getTaskEvents inline admin check uses role allowlist', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('admin check SQL in analytics.getTaskEvents includes role = ANY filter', async () => {
    // Non-participant task ownership query
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: UUID3, worker_id: UUID3 }],
      rowCount: 1,
    } as any);
    // Admin check → admin found
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);

    mockAnalytics.getTaskEvents.mockResolvedValue({ success: true, data: [] } as any);

    const caller = makeProtectedAnalyticsCaller();
    await caller.getTaskEvents({ taskId: UUID2 });

    const adminCall = mockDb.query.mock.calls.find(
      (call) => (call[0] as string).includes('admin_roles')
    );
    expect(adminCall).toBeDefined();
    const sql: string = adminCall![0] as string;
    expect(sql).toMatch(/role\s*=\s*ANY/i);
  });

  it('analytics.getTaskEvents throws FORBIDDEN when non-participant has no valid admin role', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ poster_id: UUID3, worker_id: UUID3 }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const caller = makeProtectedAnalyticsCaller();
    await expect(caller.getTaskEvents({ taskId: UUID2 }))
      .rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
