/**
 * ExpertiseSupply Router Unit Tests — cursor-based pagination
 *
 * Tests that expertiseSupply.listExpertise and expertiseSupply.getMyWaitlist
 * return { items, nextCursor } with correct cursor-based pagination semantics.
 *
 * Both procedures now query the DB directly (bypassing the service layer for
 * list/pagination queries) and use id cursor with ORDER BY id ASC.
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
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
  escrowLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('../../src/services/ExpertiseSupplyService', () => ({
  ExpertiseSupplyService: {
    listExpertise: vi.fn(),
    getUserExpertise: vi.fn(),
    addUserExpertise: vi.fn(),
    removeUserExpertise: vi.fn(),
    promoteExpertise: vi.fn(),
    checkCapacity: vi.fn(),
    getUserWaitlist: vi.fn(),
    acceptWaitlistInvite: vi.fn(),
    getSupplyDashboard: vi.fn(),
    adminUpdateCapacity: vi.fn(),
    recalculateAllCapacity: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { expertiseSupplyRouter } from '../../src/routers/expertiseSupply';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ExpertiseRow = {
  id: string;
  slug: string;
  display_name: string;
  description: string | null;
  risk_tier: string;
  active: boolean;
};

type WaitlistRow = {
  id: string;
  slug: string;
  display_name: string;
  geo_zone: string;
  position: number;
  requested_weight: string;
  status: string;
  invited_at: string | null;
  invite_expires_at: string | null;
  created_at: string;
};

function makeExpertise(overrides: Partial<ExpertiseRow & { id: string }> = {}): ExpertiseRow {
  const id = overrides.id ?? `exp-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    slug: 'plumbing',
    display_name: 'Plumbing',
    description: null,
    risk_tier: 'low',
    active: true,
    ...overrides,
  };
}

function makeWaitlistEntry(overrides: Partial<WaitlistRow & { id: string }> = {}): WaitlistRow {
  const id = overrides.id ?? `wl-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    slug: 'plumbing',
    display_name: 'Plumbing',
    geo_zone: 'seattle_metro',
    position: 1,
    requested_weight: '0.7',
    status: 'waiting',
    invited_at: null,
    invite_expires_at: null,
    created_at: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeUserCaller(userId = 'user-abc') {
  const fakeUser = {
    id: userId,
    email: 'user@hustlexp.com',
    full_name: 'Test User',
    role: 'hustler',
    trust_tier: 4,
    firebase_uid: 'fb-user',
  };
  return expertiseSupplyRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-user',
  });
}

// ===========================================================================
// expertiseSupply.listExpertise — cursor-based pagination
// ===========================================================================

describe('expertiseSupply.listExpertise — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeExpertise({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeUserCaller().listExpertise({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of expertise objects', async () => {
      const rows = [makeExpertise({ id: 'aaa', display_name: 'Electrical' })];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 } as any);

      const result = await makeUserCaller().listExpertise({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].displayName).toBe('Electrical');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const rows = [makeExpertise(), makeExpertise(), makeExpertise()];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeUserCaller().listExpertise({ limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const rows = [makeExpertise({ id: 'aaa' }), makeExpertise({ id: 'bbb' })];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as any);

      const result = await makeUserCaller().listExpertise({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeUserCaller().listExpertise({ limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. nextCursor: non-null when more results exist (sentinel detected)
  // -------------------------------------------------------------------------

  describe('nextCursor — more pages exist', () => {
    it('is the id of the last visible item when there is a next page', async () => {
      const rows = [
        makeExpertise({ id: 'id-aaa' }),
        makeExpertise({ id: 'id-bbb' }),
        makeExpertise({ id: 'id-ccc' }), // sentinel row
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeUserCaller().listExpertise({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((e: any) => e.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listExpertise({
        cursor: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        limit: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('id >');
      expect(params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('does not add cursor clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listExpertise({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).not.toMatch(/AND\s+id\s*>/);
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listExpertise({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listExpertise({ limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(3);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Existing filters preserved
  // -------------------------------------------------------------------------

  describe('existing filters preserved', () => {
    it('still filters by active = TRUE', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().listExpertise({ limit: 20 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('active');
    });
  });
});

// ===========================================================================
// expertiseSupply.getMyWaitlist — cursor-based pagination
// ===========================================================================

describe('expertiseSupply.getMyWaitlist — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeWaitlistEntry({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeUserCaller().getMyWaitlist({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of waitlist entries', async () => {
      const rows = [makeWaitlistEntry({ id: 'aaa', display_name: 'Electrical' })];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 1 } as any);

      const result = await makeUserCaller().getMyWaitlist({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].expertiseDisplayName).toBe('Electrical');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const rows = [makeWaitlistEntry(), makeWaitlistEntry()];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as any);

      const result = await makeUserCaller().getMyWaitlist({ limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const rows = [makeWaitlistEntry({ id: 'aaa' }), makeWaitlistEntry({ id: 'bbb' })];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as any);

      const result = await makeUserCaller().getMyWaitlist({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeUserCaller().getMyWaitlist({ limit: 20 });

      expect(result.items).toHaveLength(0);
      expect(result.nextCursor).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 3. nextCursor: non-null when more results exist (sentinel detected)
  // -------------------------------------------------------------------------

  describe('nextCursor — more pages exist', () => {
    it('is the id of the last visible item when there is a next page', async () => {
      const rows = [
        makeWaitlistEntry({ id: 'id-aaa' }),
        makeWaitlistEntry({ id: 'id-bbb' }),
        makeWaitlistEntry({ id: 'id-ccc' }), // sentinel row
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeUserCaller().getMyWaitlist({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((w: any) => w.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getMyWaitlist({
        cursor: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
        limit: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('ew.id >');
      expect(params).toContain('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');
    });

    it('does not add cursor clause when cursor is absent', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getMyWaitlist({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[0];
      expect(sql).not.toMatch(/AND\s+ew\.id\s*>/);
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getMyWaitlist({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller().getMyWaitlist({ limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[0];
      expect(params).toContain(3);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Existing filters preserved
  // -------------------------------------------------------------------------

  describe('existing filters preserved', () => {
    it('still filters by user_id', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeUserCaller('my-user-id').getMyWaitlist({ limit: 20 });

      const [sql, params] = (mockDb.query as any).mock.calls[0];
      expect(sql).toContain('user_id');
      expect(params).toContain('my-user-id');
    });
  });
});
