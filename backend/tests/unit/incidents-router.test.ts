/**
 * Incidents Router Unit Tests — cursor-based pagination for incidents.list
 *
 * Tests that incidents.list returns { items, nextCursor } with correct
 * cursor-based pagination semantics, while preserving all existing filters.
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

vi.mock('../../src/services/IncidentDiagnosisService', () => ({
  IncidentDiagnosisService: { diagnoseIncident: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import incidentsRouter from '../../src/routers/incidents';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type IncidentRow = {
  id: string;
  event_type: string;
  severity: string;
  service: string;
  details: object;
  diagnosis: Record<string, unknown> | null;
  resolved_at: Date | null;
  created_at: Date;
};

function makeIncident(overrides: Partial<IncidentRow & { id: string }> = {}): IncidentRow {
  const id = overrides.id ?? `inc-${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    event_type: 'error_spike',
    severity: 'warning',
    service: 'api',
    details: {},
    diagnosis: null,
    resolved_at: null,
    created_at: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeCaller(userId = 'admin-abc') {
  const fakeUser = {
    id: userId,
    email: 'admin@hustlexp.com',
    full_name: 'Admin User',
    role: 'admin',
    trust_tier: 5,
    firebase_uid: 'fb-admin',
  };
  return incidentsRouter.createCaller({
    user: fakeUser as any,
    firebaseUid: 'fb-admin',
  });
}

/** Prime the mock so that adminProcedure's admin_roles check returns a valid admin row. */
function mockAdminCheck() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
}

// ===========================================================================
// incidents.list — cursor-based pagination
// ===========================================================================

describe('incidents.list — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns { items, nextCursor } shape', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [makeIncident({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeCaller().list({ limit: 20 });

      expect(result).toHaveProperty('items');
      expect(result).toHaveProperty('nextCursor');
    });

    it('items is an array of incident objects', async () => {
      const incidents = [makeIncident({ id: 'aaa', severity: 'critical' })];
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: incidents, rowCount: 1 } as any);

      const result = await makeCaller().list({ limit: 20 });

      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].severity).toBe('critical');
    });
  });

  // -------------------------------------------------------------------------
  // 2. nextCursor: null on last page
  // -------------------------------------------------------------------------

  describe('nextCursor — last page', () => {
    it('is null when results < limit (last page)', async () => {
      const rows = [makeIncident(), makeIncident(), makeIncident()];
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeCaller().list({ limit: 50 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(3);
    });

    it('is null when results exactly equal limit (no sentinel)', async () => {
      const rows = [makeIncident({ id: 'aaa' }), makeIncident({ id: 'bbb' })];
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 2 } as any);

      const result = await makeCaller().list({ limit: 2 });

      expect(result.nextCursor).toBeNull();
      expect(result.items).toHaveLength(2);
    });

    it('is null for empty result set', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeCaller().list({ limit: 20 });

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
        makeIncident({ id: 'id-aaa' }),
        makeIncident({ id: 'id-bbb' }),
        makeIncident({ id: 'id-ccc' }), // sentinel row
      ];
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeCaller().list({ limit: 2 });

      expect(result.nextCursor).toBe('id-bbb');
      expect(result.items).toHaveLength(2);
      expect(result.items.map((i: any) => i.id)).toEqual(['id-aaa', 'id-bbb']);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Cursor condition in SQL when cursor provided
  // -------------------------------------------------------------------------

  describe('cursor forwarding', () => {
    it('passes cursor to db.query as a SQL parameter', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({
        cursor: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        limit: 5,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('id >');
      expect(params).toContain('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
    });

    it('does not add cursor clause when cursor is absent', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ limit: 10 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).not.toMatch(/AND\s+id\s*>/);
    });
  });

  // -------------------------------------------------------------------------
  // 5. limit+1 sentinel plumbing
  // -------------------------------------------------------------------------

  describe('limit sentinel', () => {
    it('queries DB for limit+1 rows to detect next page', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ limit: 20 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      expect(params).toContain(21);
    });

    it('queries DB for 3 rows when limit=2', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ limit: 2 });

      const [, params] = (mockDb.query as any).mock.calls[1];
      expect(params).toContain(3);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Existing filters preserved
  // -------------------------------------------------------------------------

  describe('existing filters preserved', () => {
    it('filters by eventType when provided', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ eventType: 'error_spike', limit: 20 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('event_type');
      expect(params).toContain('error_spike');
    });

    it('filters by severity when provided', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ severity: 'critical', limit: 20 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('severity');
      expect(params).toContain('critical');
    });

    it('filters by resolved=false adds resolved_at IS NULL', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ resolved: false, limit: 20 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('resolved_at IS NULL');
    });

    it('filters by resolved=true adds resolved_at IS NOT NULL', async () => {
      mockAdminCheck();
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ resolved: true, limit: 20 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('resolved_at IS NOT NULL');
    });
  });
});
