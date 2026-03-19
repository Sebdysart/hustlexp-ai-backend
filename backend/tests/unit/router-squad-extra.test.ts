/**
 * Squad Router Extra Unit Tests
 *
 * Covers the branches NOT tested by squad-router.test.ts:
 * - create (success, CONFLICT if already organizer, FORBIDDEN if tier < 4)
 * - getById (success, NOT_FOUND membership, NOT_FOUND squad)
 * - invite (success, FORBIDDEN not organizer, BAD_REQUEST full, NOT_FOUND invitee, CONFLICT)
 * - respondToInvite (accept=true, accept=false, NOT_FOUND)
 * - leave (success, NOT_FOUND not member, BAD_REQUEST organizer)
 * - disband (success, FORBIDDEN not organizer)
 * - acceptTask (success with ready status, success still recruiting, NOT_FOUND, FORBIDDEN)
 * - leaderboard (returns array)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: {
    query: vi.fn(),
    transaction: vi.fn(),
  },
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
}));

vi.mock('../../src/services/ComplianceGuardianService', () => ({
  ComplianceGuardianService: {
    evaluate: vi.fn().mockResolvedValue({ tier: 'clean', score: 0, triggeredRules: [] }),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { squadRouter } from '../../src/routers/squad';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SQUAD_UUID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_UUID  = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER2_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const INVITE_UUID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const TASK_UUID  = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

function makeEliteCaller(userId = USER_UUID, trustTier = 4) {
  return squadRouter.createCaller({
    user: {
      id: userId,
      email: 'user@hustlexp.com',
      full_name: 'Elite User',
      role: 'hustler',
      trust_tier: trustTier,
      firebase_uid: 'fb-user',
      default_mode: 'poster',
    } as any,
    firebaseUid: 'fb-user',
  });
}

function makeHustlerCaller(userId = USER_UUID, trustTier = 4) {
  return squadRouter.createCaller({
    user: {
      id: userId,
      email: 'user@hustlexp.com',
      full_name: 'Elite User',
      role: 'hustler',
      trust_tier: trustTier,
      firebase_uid: 'fb-user',
      default_mode: 'worker',
    } as any,
    firebaseUid: 'fb-user',
  });
}

// ---------------------------------------------------------------------------
// squad.create
// ---------------------------------------------------------------------------

describe('squad.create', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws FORBIDDEN when trust_tier < 4', async () => {
    const caller = makeEliteCaller(USER_UUID, 3);
    await expect(
      caller.create({ name: 'My Squad', emoji: '🔥' })
    ).rejects.toThrow('Squads Mode requires Elite trust tier');
  });

  it('throws CONFLICT when user already organizes an active squad', async () => {
    // existing organizer check returns a row
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: SQUAD_UUID }], rowCount: 1 } as any);

    await expect(
      makeEliteCaller().create({ name: 'My Squad' })
    ).rejects.toThrow('You already organize an active squad');
  });

  it('creates squad and returns result on success', async () => {
    // existing organizer check: no rows
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const squadRow = {
      id: SQUAD_UUID,
      name: 'Alpha Squad',
      emoji: '⚡️',
      tagline: null,
      max_members: 5,
      status: 'active',
      created_at: new Date('2025-01-01'),
    };

    // transaction mock: calls fn with a query function
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const transactionQuery = vi.fn()
        .mockResolvedValueOnce({ rows: [squadRow], rowCount: 1 }) // INSERT squad
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });          // INSERT organizer member
      return fn(transactionQuery);
    });

    const result = await makeEliteCaller().create({ name: 'Alpha Squad', emoji: '⚡️' });

    expect(result.id).toBe(SQUAD_UUID);
    expect(result.name).toBe('Alpha Squad');
    expect(result.memberCount).toBe(1);
    expect(result.status).toBe('active');
  });

  it('assertEliteTier handles string trust_tier values', async () => {
    // trust_tier as string (DB might return it as string)
    const caller = squadRouter.createCaller({
      user: {
        id: USER_UUID,
        trust_tier: '3', // string, < 4
        default_mode: 'poster',
      } as any,
      firebaseUid: 'fb-user',
    });

    await expect(
      caller.create({ name: 'My Squad' })
    ).rejects.toThrow('Squads Mode requires Elite trust tier');
  });
});

// ---------------------------------------------------------------------------
// squad.getById
// ---------------------------------------------------------------------------

describe('squad.getById', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws FORBIDDEN when user is not a member', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeEliteCaller().getById({ squadId: SQUAD_UUID })
    ).rejects.toThrow('Not a member of this squad');
  });

  it('throws NOT_FOUND when squad does not exist', async () => {
    // Member check passes
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 } as any);
    // Squad query returns nothing
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeEliteCaller().getById({ squadId: SQUAD_UUID })
    ).rejects.toThrow('Squad not found');
  });

  it('returns full squad details with members on success', async () => {
    // Member check
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 } as any);
    // Squad query
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: SQUAD_UUID,
        name: 'Alpha Squad',
        emoji: '⚡️',
        tagline: 'We hustle hard',
        organizer_id: USER_UUID,
        max_members: 5,
        status: 'active',
        total_tasks_completed: 10,
        total_earnings_cents: 50000,
        average_rating: '4.5',
        squad_xp: 1000,
        squad_level: 3,
        created_at: new Date('2025-01-01'),
      }],
      rowCount: 1,
    } as any);
    // Members query
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        user_id: USER_UUID,
        role: 'organizer',
        joined_at: new Date('2025-01-01'),
        full_name: 'Elite User',
        avatar_url: null,
        trust_tier: '4',
        xp_total: 500,
      }],
      rowCount: 1,
    } as any);

    const result = await makeEliteCaller().getById({ squadId: SQUAD_UUID });

    expect(result.id).toBe(SQUAD_UUID);
    expect(result.name).toBe('Alpha Squad');
    expect(result.averageRating).toBe(4.5);
    expect(result.members).toHaveLength(1);
    expect(result.members[0].role).toBe('organizer');
    expect(result.totalTasksCompleted).toBe(10);
  });

  it('handles null average_rating as 0', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: SQUAD_UUID, name: 'Squad', emoji: '⚡️', tagline: null,
        organizer_id: USER_UUID, max_members: 5, status: 'active',
        total_tasks_completed: 0, total_earnings_cents: 0, average_rating: null,
        squad_xp: 0, squad_level: 1, created_at: new Date(),
      }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeEliteCaller().getById({ squadId: SQUAD_UUID });
    expect(result.averageRating).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// squad.invite
// ---------------------------------------------------------------------------

describe('squad.invite', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws FORBIDDEN when caller is not organizer', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeEliteCaller().invite({ squadId: SQUAD_UUID, inviteeId: USER2_UUID })
    ).rejects.toThrow('Only the organizer can invite members');
  });

  it('throws BAD_REQUEST when squad is full', async () => {
    // Organizer check passes
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'org' }], rowCount: 1 } as any);
    // Count check: 5/5 full
    mockDb.query.mockResolvedValueOnce({
      rows: [{ count: '5', max_members: 5 }],
      rowCount: 1,
    } as any);

    await expect(
      makeEliteCaller().invite({ squadId: SQUAD_UUID, inviteeId: USER2_UUID })
    ).rejects.toThrow('Squad is full');
  });

  it('throws NOT_FOUND when invitee user does not exist', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'org' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '3', max_members: 5 }], rowCount: 1 } as any);
    // Invitee lookup: no user
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeEliteCaller().invite({ squadId: SQUAD_UUID, inviteeId: USER2_UUID })
    ).rejects.toThrow('User not found');
  });

  it('throws CONFLICT when invite already exists (INSERT returns no rows)', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'org' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '2', max_members: 5 }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: '4' }], rowCount: 1 } as any);
    // INSERT returns no rows (ON CONFLICT DO NOTHING)
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeEliteCaller().invite({ squadId: SQUAD_UUID, inviteeId: USER2_UUID })
    ).rejects.toThrow('Invite already pending');
  });

  it('returns inviteId and expiresAt on success', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'org' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '2', max_members: 5 }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ trust_tier: '4' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        id: INVITE_UUID,
        status: 'pending',
        expires_at: new Date('2025-01-15'),
      }],
      rowCount: 1,
    } as any);

    const result = await makeEliteCaller().invite({ squadId: SQUAD_UUID, inviteeId: USER2_UUID });

    expect(result.inviteId).toBe(INVITE_UUID);
    expect(result.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// squad.respondToInvite
// ---------------------------------------------------------------------------

describe('squad.respondToInvite', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NOT_FOUND when invite not found or already responded', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const txQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
      return fn(txQuery);
    });

    await expect(
      makeHustlerCaller().respondToInvite({ inviteId: INVITE_UUID, accept: true })
    ).rejects.toThrow('Invite not found or already responded');
  });

  it('accepts invite and adds user as member', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ id: INVITE_UUID, squad_id: SQUAD_UUID, invitee_id: USER_UUID, status: 'pending' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE invite status
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // INSERT member
      return fn(txQuery);
    });

    const result = await makeHustlerCaller().respondToInvite({ inviteId: INVITE_UUID, accept: true });
    expect(result.status).toBe('accepted');
  });

  it('declines invite and does not insert member', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ id: INVITE_UUID, squad_id: SQUAD_UUID, invitee_id: USER_UUID, status: 'pending' }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE invite status (decline)
      return fn(txQuery);
    });

    const result = await makeHustlerCaller().respondToInvite({ inviteId: INVITE_UUID, accept: false });
    expect(result.status).toBe('declined');
  });
});

// ---------------------------------------------------------------------------
// squad.leave
// ---------------------------------------------------------------------------

describe('squad.leave', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NOT_FOUND when user is not a member', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeHustlerCaller().leave({ squadId: SQUAD_UUID })
    ).rejects.toThrow('Not a member of this squad');
  });

  it('throws BAD_REQUEST when organizer tries to leave', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{ role: 'organizer' }],
      rowCount: 1,
    } as any);

    await expect(
      makeHustlerCaller().leave({ squadId: SQUAD_UUID })
    ).rejects.toThrow('Organizers cannot leave');
  });

  it('removes member and returns success', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'member' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // DELETE

    const result = await makeHustlerCaller().leave({ squadId: SQUAD_UUID });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// squad.disband
// ---------------------------------------------------------------------------

describe('squad.disband', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws FORBIDDEN when caller is not organizer', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    await expect(
      makeEliteCaller().disband({ squadId: SQUAD_UUID })
    ).rejects.toThrow('Only the organizer can disband');
  });

  it('updates status to disbanded and returns success', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'org' }], rowCount: 1 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any); // UPDATE

    const result = await makeEliteCaller().disband({ squadId: SQUAD_UUID });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// squad.acceptTask
// ---------------------------------------------------------------------------

describe('squad.acceptTask', () => {
  beforeEach(() => vi.clearAllMocks());

  it('throws NOT_FOUND when squad task not found or not recruiting', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const txQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
      return fn(txQuery);
    });

    await expect(
      makeHustlerCaller().acceptTask({ squadTaskId: TASK_UUID })
    ).rejects.toThrow('Recruiting squad task not found');
  });

  it('throws FORBIDDEN when user is not a squad member', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ id: TASK_UUID, squad_id: SQUAD_UUID, task_id: 'task-1', required_workers: 2, status: 'recruiting', s_id: SQUAD_UUID }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // not a member
      return fn(txQuery);
    });

    await expect(
      makeHustlerCaller().acceptTask({ squadTaskId: TASK_UUID })
    ).rejects.toThrow('Not a member of this squad');
  });

  it('returns taskStatus=recruiting when not enough workers yet', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ id: TASK_UUID, squad_id: SQUAD_UUID, task_id: 'task-1', required_workers: 3, status: 'recruiting', s_id: SQUAD_UUID }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 })
        // Self-dealing guard: poster_id is different from the caller → allowed
        .mockResolvedValueOnce({ rows: [{ poster_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'worker-row', accepted_at: new Date() }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 }); // count < required
      return fn(txQuery);
    });

    const result = await makeHustlerCaller().acceptTask({ squadTaskId: TASK_UUID });
    expect(result.taskStatus).toBe('recruiting');
  });

  it('returns taskStatus=ready when fully recruited', async () => {
    mockDb.transaction.mockImplementationOnce(async (fn: any) => {
      const txQuery = vi.fn()
        .mockResolvedValueOnce({
          rows: [{ id: TASK_UUID, squad_id: SQUAD_UUID, task_id: 'task-1', required_workers: 2, status: 'recruiting', s_id: SQUAD_UUID }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 })
        // Self-dealing guard: poster_id is different from the caller → allowed
        .mockResolvedValueOnce({ rows: [{ poster_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ id: 'worker-row', accepted_at: new Date() }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ count: '2' }], rowCount: 1 }) // count >= required
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // UPDATE status to ready
      return fn(txQuery);
    });

    const result = await makeHustlerCaller().acceptTask({ squadTaskId: TASK_UUID });
    expect(result.taskStatus).toBe('ready');
    expect(result.squadTaskId).toBe(TASK_UUID);
  });
});

// ---------------------------------------------------------------------------
// squad.leaderboard
// ---------------------------------------------------------------------------

describe('squad.leaderboard', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns array of leaderboard entries', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [
        {
          rank: '1',
          id: SQUAD_UUID,
          name: 'Alpha Squad',
          emoji: '⚡️',
          tagline: 'Top squad',
          organizer_id: USER_UUID,
          organizer_name: 'Elite User',
          status: 'active',
          total_tasks_completed: 50,
          total_earnings_cents: 100000,
          squad_xp: 5000,
          squad_level: 5,
          average_rating: '4.8',
          max_members: 5,
          created_at: '2025-01-01T00:00:00Z',
          last_active_at: '2025-02-01T00:00:00Z',
          member_count: 4,
        },
      ],
      rowCount: 1,
    } as any);

    const result = await makeEliteCaller().leaderboard();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].squadXP).toBe(5000);
    expect(result[0].averageRating).toBe(4.8);
    expect(result[0].totalEarnings).toBe(1000); // 100000/100
    expect(result[0].members).toEqual([]);
  });

  it('returns empty array when no active squads', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

    const result = await makeEliteCaller().leaderboard();
    expect(result).toEqual([]);
  });

  it('handles invalid average_rating gracefully', async () => {
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        rank: '1', id: SQUAD_UUID, name: 'Squad', emoji: '⚡️', tagline: null,
        organizer_id: USER_UUID, organizer_name: 'User', status: 'active',
        total_tasks_completed: 0, total_earnings_cents: 0, squad_xp: 0,
        squad_level: 1, average_rating: 'NaN', max_members: 5,
        created_at: '2025-01-01', last_active_at: null, member_count: 1,
      }],
      rowCount: 1,
    } as any);

    const result = await makeEliteCaller().leaderboard();
    expect(result[0].averageRating).toBe(0);
  });
});
