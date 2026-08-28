/**
 * Incidents Router Unit Tests — offset-based pagination for incidents.list
 *
 * Tests that incidents.list returns result.rows directly as a plain array
 * with offset-based pagination (LIMIT/OFFSET) and dynamic filter conditions.
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
import { IncidentDiagnosisService } from '../../src/services/IncidentDiagnosisService';
import incidentsRouter from '../../src/routers/incidents';

const mockDb = vi.mocked(db);
const mockDiagnosis = vi.mocked(IncidentDiagnosisService);

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

function makeNonAdminCaller() {
  return incidentsRouter.createCaller({
    user: {
      id: 'ordinary-user', email: 'user@hustlexp.com', full_name: 'Ordinary User',
      role: 'worker', default_mode: 'worker', firebase_uid: 'fb-user', is_admin: false,
    } as any,
    firebaseUid: 'fb-user',
  });
}

/** Seed admin_roles mock so adminProcedure passes. */
function seedAdminCheck() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
}

describe('incident management authority', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['list', () => makeNonAdminCaller().list({ limit: 20, offset: 0 })],
    ['get', () => makeNonAdminCaller().get({ id: '550e8400-e29b-41d4-a716-446655440000' })],
    ['resolve', () => makeNonAdminCaller().resolve({ id: '550e8400-e29b-41d4-a716-446655440000' })],
    ['diagnose', () => makeNonAdminCaller().diagnose({ id: '550e8400-e29b-41d4-a716-446655440000' })],
    ['stats', () => makeNonAdminCaller().stats({ timeRange: '24h' })],
  ])('denies an ordinary authenticated user before %s executes', async (_name, invoke) => {
    await expect(invoke()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDiagnosis.diagnoseIncident).not.toHaveBeenCalled();
  });

  it('refuses to close a canonical safety mirror through the generic incident endpoint', async () => {
    seedAdminCheck();
    mockDb.query.mockResolvedValueOnce({
      rows: [{
        event_type: 'manual_report',
        service: 'trust_safety',
        safety_incident_id: '44444444-4444-4444-8444-444444444444',
      }],
      rowCount: 1,
    } as any);

    await expect(makeCaller().resolve({
      id: '550e8400-e29b-41d4-a716-446655440000',
      notes: 'This must resolve through the canonical task safety case.',
    })).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
      message: expect.stringContaining('canonical safety case'),
    });
    expect(mockDb.query.mock.calls.some(([sql]) => String(sql).includes('SET resolved_at = NOW()')))
      .toBe(false);
  });
});

// ===========================================================================
// incidents.list — offset-based pagination (returns array)
// ===========================================================================

describe('incidents.list — offset-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedAdminCheck();
  });

  // -------------------------------------------------------------------------
  // 1. Return shape — plain array (result.rows)
  // -------------------------------------------------------------------------

  describe('return shape', () => {
    it('returns an array (not { items, nextCursor })', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [makeIncident({ id: 'aaa' })], rowCount: 1 } as any);

      const result = await makeCaller().list({ limit: 20, offset: 0 });

      expect(Array.isArray(result)).toBe(true);
    });

    it('returns incident row objects directly', async () => {
      const incidents = [makeIncident({ id: 'aaa', severity: 'critical' })];
      mockDb.query.mockResolvedValueOnce({ rows: incidents, rowCount: 1 } as any);

      const result = await makeCaller().list({ limit: 20, offset: 0 });

      expect(result).toHaveLength(1);
      expect(result[0].severity).toBe('critical');
      expect(result[0].id).toBe('aaa');
    });
  });

  // -------------------------------------------------------------------------
  // 2. Pagination — limit/offset passed to query
  // -------------------------------------------------------------------------

  describe('pagination', () => {
    it('passes limit and offset to db.query', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ limit: 25, offset: 10 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(25);
      expect(params).toContain(10);
    });

    it('uses default limit=50 and offset=0 when not explicitly provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({});

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('LIMIT');
      expect(sql).toContain('OFFSET');
      expect(params).toContain(50);
      expect(params).toContain(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Empty result
  // -------------------------------------------------------------------------

  describe('empty result', () => {
    it('returns empty array when no results', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      const result = await makeCaller().list({ limit: 20, offset: 0 });

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Multiple items
  // -------------------------------------------------------------------------

  describe('multiple items', () => {
    it('returns multiple incidents in the array', async () => {
      const rows = [
        makeIncident({ id: 'aaa' }),
        makeIncident({ id: 'bbb' }),
        makeIncident({ id: 'ccc' }),
      ];
      mockDb.query.mockResolvedValueOnce({ rows, rowCount: 3 } as any);

      const result = await makeCaller().list({ limit: 50, offset: 0 });

      expect(result).toHaveLength(3);
      expect(result.map((i: any) => i.id)).toEqual(['aaa', 'bbb', 'ccc']);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Filter tests
  // -------------------------------------------------------------------------

  describe('filters', () => {
    it('filters by eventType when provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ eventType: 'error_spike', limit: 20, offset: 0 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('event_type');
      expect(params).toContain('error_spike');
    });

    it('filters by severity when provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ severity: 'critical', limit: 20, offset: 0 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('severity');
      expect(params).toContain('critical');
    });

    it('filters by service when provided', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ service: 'auth', limit: 20, offset: 0 });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('service');
      expect(params).toContain('auth');
    });

    it('filters by resolved=false adds resolved_at IS NULL', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ resolved: false, limit: 20, offset: 0 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('resolved_at IS NULL');
    });

    it('filters by resolved=true adds resolved_at IS NOT NULL', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({ resolved: true, limit: 20, offset: 0 });

      const [sql] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('resolved_at IS NOT NULL');
    });

    it('combines multiple filters', async () => {
      mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);

      await makeCaller().list({
        eventType: 'error_spike',
        severity: 'critical',
        resolved: false,
        limit: 20,
        offset: 0,
      });

      const [sql, params] = (mockDb.query as any).mock.calls[1];
      expect(sql).toContain('event_type');
      expect(sql).toContain('severity');
      expect(sql).toContain('resolved_at IS NULL');
      expect(params).toContain('error_spike');
      expect(params).toContain('critical');
    });
  });
});
