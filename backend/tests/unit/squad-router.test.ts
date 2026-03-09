/**
 * Squad Router Unit Tests — offset-based pagination
 *
 * Tests that squad.listMine, squad.listInvites, and squad.listTasks
 * return arrays with correct pagination semantics.
 *
 * - listMine: 1 db.query, returns SquadRow[] with camelCase mapping
 * - listInvites: 1 db.query, returns InviteRow[] with camelCase mapping
 * - listTasks: 2 db.query (membership check + data), returns mapped task objects
 *
 * Pattern: mock db at module level, use createCaller with a fake protected
 * context to bypass middleware, then call procedures directly.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must come before any imports that transitively touch these modules
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
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
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

type SquadRow = {
  id: string;
  name: string;
  emoji: string;
  tagline: string | null;
  status: string;
  squad_xp: number;
  squad_level: number;
  total_tasks_completed: number;
  member_count: string;
  my_role: string;
};

type InviteRow = {
  id: string;
  squad_id: string;
  squad_name: string;
  squad_emoji: string;
  inviter_name: string;
  sent_at: Date;
  expires_at: Date;
};

type ListTaskRow = {
  id: string;
  task_id: string;
  squad_id: string;
  required_workers: number;
  payment_split_mode: string;
  per_worker_payment_cents: number;
  status: string;
  created_at: string;
  t_id: string;
  t_title: string;
  t_description: string;
  t_price: number;
  t_location: string | null;
  t_category: string | null;
  t_state: string;
  t_created_at: string;
  t_updated_at: string;
  accepted_workers: string[];
};

function makeSquad(overrides: Partial<SquadRow & { id: string }> = {}): SquadRow {
  const id = overrides.id ?? `squad-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    name: 'Test Squad',
    emoji: '⚡️',
    tagline: null,
    status: 'active',
    squad_xp: 0,
    squad_level: 1,
    total_tasks_completed: 0,
    member_count: '3',
    my_role: 'member',
    ...overrides,
  };
}

function makeInvite(overrides: Partial<InviteRow & { id: string }> = {}): InviteRow {
  const id = overrides.id ?? `invite-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    squad_id: 'squad-abc',
    squad_name: 'Test Squad',
    squad_emoji: '⚡️',
    inviter_name: 'Test Inviter',
    sent_at: new Date('2025-01-01T00:00:00Z'),
    expires_at: new Date('2025-01-08T00:00:00Z'),
    ...overrides,
  };
}

function makeSquadTask(overrides: Partial<ListTaskRow & { id: string }> = {}): ListTaskRow {
  const id = overrides.id ?? `sta-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    task_id: 'task-abc',
    squad_id: 'squad-abc',
    required_workers: 2,
    payment_split_mode: 'equal',
    per_worker_payment_cents: 2500,
    status: 'recruiting',
    created_at: '2025-01-01T00:00:00.000Z',
    t_id: 'task-abc',
    t_title: 'Test Task',
    t_description: 'Do the thing',
    t_price: 5000,
    t_location: null,
    t_category: null,
    t_state: 'open',
    t_created_at: '2025-01-01T00:00:00.000Z',
    t_updated_at: '2025-01-01T00:00:00.000Z',
    accepted_workers: [],
    ...overrides,
  };
}

/** Create a caller for a regular user (trust_tier=4 for squad access). */
function makeUserCaller(userId = 'user-abc') {
  const fakeUser = {
    id: userId,
    email: 'user@hustlexp.com',
    full_name: 'Test User',
    role: 'hustler',
    trust_tier: 4,
    firebase_uid: 'fb-user',
  };
  return squadRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-user',
  });
}

// ===========================================================================
// squad.listMine — returns array of squads
// ===========================================================================

describe('squad.listMine — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns an array of squad objects', async () => {
      const squads = [makeSquad({ id: 'aaa', name: 'Alpha Squad' })];
      mockDb.query.mockResolvedValueOnce({ rows: squads, rowCount: 1 } as any);

      const result = await makeUserCaller().listMine({ limit: 20 });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('maps snake_case DB rows to the response', async () => {
      const squads = [makeSquad({ id: 'aaa', name: 'Alpha Squad', squad_xp: 500 })];
      mockDb.query.mockResolvedValueOnce({ rows: squads, rowCount: 1 } as any);

      const result = await makeUserCaller().listMine({ limit: 20 });

      expect(result).toHaveLength(1);
      // The result should contain the squad data
      const squad = result[0] as any;
      expect(squad.id).toBe('aaa');
      expect(squad.name).toBe('Alpha Squad');
    });
  });

  describe('pagination', () => {
    it('returns empty array when user has no squads', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeUserCaller().listMine({ limit: 20 });

      expect(result).toHaveLength(0);
    });

    it('returns multiple squads', async () => {
      const squads = [makeSquad(), makeSquad(), makeSquad()];
      mockDb.query.mockResolvedValueOnce({ rows: squads, rowCount: 3 } as any);

      const result = await makeUserCaller().listMine({ limit: 50 });

      expect(result).toHaveLength(3);
    });

    it('passes limit and offset to db.query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listMine({ limit: 10, offset: 20 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(10);
      expect(params).toContain(20);
    });

    it('uses default limit of 50 when not provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listMine({});

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(50);
    });

    it('makes 1 db.query call', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeSquad()], rowCount: 1 } as any);

      await makeUserCaller().listMine({ limit: 20 });

      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('ordering', () => {
    it('orders results by last_active_at DESC', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listMine({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('ORDER BY');
      expect(sql).toContain('DESC');
    });
  });

  describe('user scoping', () => {
    it('passes the user ID to the query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller('user-xyz').listMine({ limit: 10 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain('user-xyz');
    });
  });
});

// ===========================================================================
// squad.listInvites — returns array of invite objects
// ===========================================================================

describe('squad.listInvites — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('return shape', () => {
    it('returns an array of invite objects', async () => {
      const invites = [makeInvite({ id: 'aaa' })];
      mockDb.query.mockResolvedValueOnce({ rows: invites, rowCount: 1 } as any);

      const result = await makeUserCaller().listInvites({ limit: 20 });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('maps invite data correctly', async () => {
      const invites = [makeInvite({ id: 'aaa', squad_name: 'Cool Squad' })];
      mockDb.query.mockResolvedValueOnce({ rows: invites, rowCount: 1 } as any);

      const result = await makeUserCaller().listInvites({ limit: 20 });

      expect(result).toHaveLength(1);
      const invite = result[0] as any;
      expect(invite.id).toBe('aaa');
    });
  });

  describe('pagination', () => {
    it('returns empty array when user has no invites', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeUserCaller().listInvites({ limit: 20 });

      expect(result).toHaveLength(0);
    });

    it('returns multiple invites', async () => {
      const invites = [makeInvite(), makeInvite()];
      mockDb.query.mockResolvedValueOnce({ rows: invites, rowCount: 2 } as any);

      const result = await makeUserCaller().listInvites({ limit: 50 });

      expect(result).toHaveLength(2);
    });

    it('passes limit and offset to db.query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listInvites({ limit: 15, offset: 30 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(15);
      expect(params).toContain(30);
    });

    it('makes 1 db.query call', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeInvite()], rowCount: 1 } as any);

      await makeUserCaller().listInvites({ limit: 20 });

      expect(mockDb.query).toHaveBeenCalledTimes(1);
    });
  });

  describe('user scoping', () => {
    it('passes the user ID to filter invites for current user', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller('user-xyz').listInvites({ limit: 10 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain('user-xyz');
    });
  });
});

// ===========================================================================
// squad.listTasks — returns array of task objects (with membership check)
// ===========================================================================

describe('squad.listTasks — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const SQUAD_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

  /** For listTasks: membership check fires first, then the main query. */
  function setupMemberAndTasks(rows: ListTaskRow[]) {
    // Membership check → passes
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 } as any);
    // listTasks data query
    mockDb.query.mockResolvedValueOnce({ rows, rowCount: rows.length } as any);
  }

  describe('return shape', () => {
    it('returns an array of task objects', async () => {
      setupMemberAndTasks([makeSquadTask({ id: 'aaa' })]);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 20 });

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
    });

    it('contains task data', async () => {
      const tasks = [makeSquadTask({ id: 'aaa', t_title: 'Mow the Lawn' })];
      setupMemberAndTasks(tasks);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 20 });

      expect(result).toHaveLength(1);
      // The result should contain mapped task data
      const item = result[0] as any;
      expect(item).toBeDefined();
    });
  });

  describe('pagination', () => {
    it('returns empty array when no tasks assigned to squad', async () => {
      setupMemberAndTasks([]);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 20 });

      expect(result).toHaveLength(0);
    });

    it('returns multiple tasks', async () => {
      const tasks = [makeSquadTask(), makeSquadTask()];
      setupMemberAndTasks(tasks);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 50 });

      expect(result).toHaveLength(2);
    });

    it('passes limit and offset to db.query', async () => {
      setupMemberAndTasks([]);

      await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 10, offset: 20 });

      const calls = (mockDb.query as any).mock.calls;
      const [sql, params] = calls[1]; // calls[0] is membership check
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(10);
      expect(params).toContain(20);
    });

    it('makes 2 db.query calls (membership check + data)', async () => {
      setupMemberAndTasks([makeSquadTask()]);

      await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 20 });

      expect(mockDb.query).toHaveBeenCalledTimes(2);
    });
  });

  describe('membership check', () => {
    it('checks squad membership before listing tasks', async () => {
      setupMemberAndTasks([]);

      await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 10 });

      const calls = (mockDb.query as any).mock.calls;
      const [memberSql, memberParams] = calls[0];
      expect(memberSql).toContain('squad_members');
      expect(memberParams).toContain(SQUAD_ID);
    });

    it('rejects non-members', async () => {
      // Membership check → no rows (not a member)
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await expect(
        makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 10 })
      ).rejects.toThrow();
    });
  });

  describe('squad scoping', () => {
    it('passes squadId to filter tasks', async () => {
      setupMemberAndTasks([]);

      await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 10 });

      const calls = (mockDb.query as any).mock.calls;
      const [, params] = calls[1];
      expect(params).toContain(SQUAD_ID);
    });
  });
});
