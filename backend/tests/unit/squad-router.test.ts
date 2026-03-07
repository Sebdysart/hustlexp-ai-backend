/**
 * Squad Router Unit Tests — cursor-based pagination
 *
 * Tests that squad.listMine, squad.listInvites, and squad.listTasks
 * return { items, nextCursor } with correct cursor-based pagination semantics.
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
// squad.listMine — cursor-based pagination
// ===========================================================================

describe('squad.listMine — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeSquad({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeUserCaller().listMine({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of squad objects', async () => {
      const squads = [makeSquad({ id: 'aaa', name: 'Alpha Squad' })];
      mockDb.query.mockResolvedValueOnce({ rows: squads, rowCount: 1 } as any);

      const result = await makeUserCaller().listMine({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].name).toBe('Alpha Squad');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const squads = [makeSquad(), makeSquad(), makeSquad()];
      mockDb.query.mockResolvedValueOnce({ rows: squads, rowCount: 3 } as any);

      const result = await makeUserCaller().listMine({ limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const squads = [makeSquad({ id: 'aaa' }), makeSquad({ id: 'bbb' })];
      mockDb.query.mockResolvedValueOnce({ rows: squads, rowCount: 2 } as any);

      const result = await makeUserCaller().listMine({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeUserCaller().listMine({ limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. nextCursor: non-null when more results exist (sentinel detected)
  // -------------------------------------------------------------------------

  describe('nextCursor — more pages exist', () => {
    it('is the id of the last visible item when there is a next page', async () => {
      const squads = [
        makeSquad({ id: 'id-aaa' }),
        makeSquad({ id: 'id-bbb' }),
        makeSquad({ id: 'id-ccc' }), // sentinel row
      ];
      mockDb.query.mockResolvedValueOnce({ rows: squads, rowCount: 3 } as any);

      const result = await makeUserCaller().listMine({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((s: any) => s.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition present in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listMine({
        cursor: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        limit: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('s.id >');
      expect(params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('does not add s.id > clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listMine({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).not.toContain('s.id >');
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listMine({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      // user_id is $1, so limit+1 sentinel is at some position — verify it's in params
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listMine({ limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(3);
    });
  });
});

// ===========================================================================
// squad.listInvites — cursor-based pagination
// ===========================================================================

describe('squad.listInvites — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeInvite({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeUserCaller().listInvites({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of invite objects', async () => {
      const invites = [makeInvite({ id: 'aaa', squad_name: 'Cool Squad' })];
      mockDb.query.mockResolvedValueOnce({ rows: invites, rowCount: 1 } as any);

      const result = await makeUserCaller().listInvites({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].squadName).toBe('Cool Squad');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const invites = [makeInvite(), makeInvite()];
      mockDb.query.mockResolvedValueOnce({ rows: invites, rowCount: 2 } as any);

      const result = await makeUserCaller().listInvites({ limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const invites = [makeInvite({ id: 'aaa' }), makeInvite({ id: 'bbb' })];
      mockDb.query.mockResolvedValueOnce({ rows: invites, rowCount: 2 } as any);

      const result = await makeUserCaller().listInvites({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeUserCaller().listInvites({ limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. nextCursor: non-null when more results exist
  // -------------------------------------------------------------------------

  describe('nextCursor — more pages exist', () => {
    it('is the id of the last visible item when there is a next page', async () => {
      const invites = [
        makeInvite({ id: 'id-aaa' }),
        makeInvite({ id: 'id-bbb' }),
        makeInvite({ id: 'id-ccc' }), // sentinel row
      ];
      mockDb.query.mockResolvedValueOnce({ rows: invites, rowCount: 3 } as any);

      const result = await makeUserCaller().listInvites({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((i: any) => i.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition present in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listInvites({
        cursor: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        limit: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('si.id >');
      expect(params).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    });

    it('does not add si.id > clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listInvites({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).not.toContain('si.id >');
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listInvites({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listInvites({ limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(3);
    });
  });
});

// ===========================================================================
// squad.listTasks — cursor-based pagination
// ===========================================================================

describe('squad.listTasks — cursor-based pagination', () => {
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

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      setupMemberAndTasks([makeSquadTask({ id: 'aaa' })]);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of squad task objects', async () => {
      const tasks = [makeSquadTask({ id: 'aaa', t_title: 'Mow the Lawn' })];
      setupMemberAndTasks(tasks);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].task.title).toBe('Mow the Lawn');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const tasks = [makeSquadTask(), makeSquadTask()];
      setupMemberAndTasks(tasks);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const tasks = [makeSquadTask({ id: 'aaa' }), makeSquadTask({ id: 'bbb' })];
      setupMemberAndTasks(tasks);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      setupMemberAndTasks([]);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. nextCursor: non-null when more results exist
  // -------------------------------------------------------------------------

  describe('nextCursor — more pages exist', () => {
    it('is the id of the last visible item when there is a next page', async () => {
      const tasks = [
        makeSquadTask({ id: 'id-aaa' }),
        makeSquadTask({ id: 'id-bbb' }),
        makeSquadTask({ id: 'id-ccc' }), // sentinel row
      ];
      setupMemberAndTasks(tasks);

      const result = await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((t: any) => t.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition present in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      // Membership check
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 } as any);
      // listTasks query
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listTasks({
        squadId: SQUAD_ID,
        cursor: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        limit: 5,
      });

      const calls = (mockDb.query as any).mock.calls;
      const [sql, params] = calls[1]; // calls[0] is membership check
      expect(sql).toContain('sta.id >');
      expect(params).toContain('cccccccc-cccc-cccc-cccc-cccccccccccc');
    });

    it('does not add sta.id > clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).not.toContain('sta.id >');
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'member-row' }], rowCount: 1 } as any);
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listTasks({ squadId: SQUAD_ID, limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      expect(params).toContain(3);
    });
  });
});
