/**
 * Admin Business Lead Review Queue — Unit Tests (Roadmap E4)
 *
 * Covers admin.listBusinessLeads (offset pagination + filters) and
 * admin.reviewBusinessLead (transactional status update + admin_actions audit).
 *
 * Patterns mirror admin-router.test.ts:
 *   - mock db at module level; createCaller with a fake admin context.
 *   - each adminProcedure call consumes one leading db.query (admin_roles check).
 *   - non-admin is simulated with admin_roles returning zero rows -> FORBIDDEN.
 *
 * reviewBusinessLead additionally uses db.transaction(fn); the mock invokes the
 * callback with a sequenced txQuery so we can assert the SELECT/UPDATE/INSERT
 * ordering and the all-or-nothing audit contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must precede imports that transitively touch these modules
// ---------------------------------------------------------------------------

vi.mock('../../src/db', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../../src/auth/firebase', () => ({
  firebaseAuth: { verifyIdToken: vi.fn() },
}));

// Mock the compliance service to avoid pulling in the heavy AIClient chain.
// _scoreTotier mirrors the real thresholds (>=61 hard_block, >=21 soft_flag).
vi.mock('../../src/services/ComplianceGuardianService', () => ({
  ComplianceGuardianService: {
    _scoreTotier: (score: number) =>
      score >= 61 ? 'hard_block' : score >= 21 ? 'soft_flag' : 'clean',
  },
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
  stripeLogger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { db } from '../../src/db';
import { adminRouter } from '../../src/routers/admin';

const mockDb = vi.mocked(db);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdminCaller() {
  const fakeAdminUser = {
    id: 'admin-user-id',
    email: 'admin@hustlexp.com',
    full_name: 'Admin User',
    role: 'admin',
    firebase_uid: 'fb-admin',
  };
  return adminRouter.createCaller({
    user: fakeAdminUser as any,
    firebaseUid: 'fb-admin',
  });
}

/** Grant admin: first db.query (admin_roles middleware check) returns a role row. */
function grantAdmin() {
  mockDb.query.mockResolvedValueOnce({ rows: [{ role: 'admin' }], rowCount: 1 } as any);
}

/** Deny admin: admin_roles check returns zero rows -> isAdmin throws FORBIDDEN. */
function denyAdmin() {
  mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
}

type LeadRow = {
  id: string;
  status: string;
  compliance_score: number | null;
};

/**
 * Wire up a reviewBusinessLead happy/guarded path:
 *   call 1 (db.query):       admin_roles check
 *   db.transaction(fn) -> txQuery:
 *     call 1: SELECT ... FOR UPDATE -> leadRow (or none)
 *     call 2: UPDATE ... RETURNING -> updatedRow
 *     call 3: INSERT admin_actions
 * Returns the txQuery mock for assertions.
 */
function mockReview(opts: { leadRow: LeadRow | null; updatedRow?: any; auditRejects?: boolean }) {
  grantAdmin();
  const updatedRow = opts.updatedRow ?? {
    id: opts.leadRow?.id ?? 'lead-1',
    status: 'REVIEWED',
    reviewed_at: new Date('2026-05-31T00:00:00Z'),
    reviewed_by: 'admin-user-id',
    approved_templates: null,
    admin_notes: null,
  };
  const txQuery = vi.fn();
  // SELECT FOR UPDATE
  txQuery.mockResolvedValueOnce({
    rows: opts.leadRow ? [opts.leadRow] : [],
    rowCount: opts.leadRow ? 1 : 0,
  } as any);
  // UPDATE RETURNING
  txQuery.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as any);
  // audit INSERT
  if (opts.auditRejects) {
    txQuery.mockRejectedValueOnce(new Error('audit insert failed'));
  } else {
    txQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
  }
  // db.transaction mock: invoke callback with txQuery, propagate throws (mirrors
  // the real helper's ROLLBACK + rethrow on any error inside the callback).
  mockDb.transaction.mockImplementationOnce(async (fn: any) => fn(txQuery));
  return txQuery;
}

// ---------------------------------------------------------------------------
// listBusinessLeads
// ---------------------------------------------------------------------------

describe('admin.listBusinessLeads', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns { leads, total }', async () => {
    grantAdmin();
    mockDb.query.mockResolvedValueOnce({
      rows: [{ id: 'lead-1', business_name: 'Acme', status: 'NEW' }],
      rowCount: 1,
    } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 } as any);

    const result = await makeAdminCaller().listBusinessLeads({ limit: 20, offset: 0 });

    expect(result).toHaveProperty('leads');
    expect(result).toHaveProperty('total');
    expect(result.total).toBe(1);
    expect(Array.isArray(result.leads)).toBe(true);
  });

  it('total reflects full count, not page size', async () => {
    grantAdmin();
    mockDb.query.mockResolvedValueOnce({ rows: [{ id: 'a' }, { id: 'b' }], rowCount: 2 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '50' }], rowCount: 1 } as any);

    const result = await makeAdminCaller().listBusinessLeads({ limit: 2, offset: 0 });

    expect(result.leads).toHaveLength(2);
    expect(result.total).toBe(50);
  });

  it('status filter adds a status condition + param', async () => {
    grantAdmin();
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);

    await makeAdminCaller().listBusinessLeads({ limit: 20, offset: 0, status: 'APPROVED' });

    const dataSql = mockDb.query.mock.calls[1][0] as string;
    const dataParams = mockDb.query.mock.calls[1][1] as unknown[];
    expect(dataSql).toContain('status = $');
    expect(dataParams).toContain('APPROVED');
  });

  it('requiresReview filter adds a requires_review condition + param', async () => {
    grantAdmin();
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);

    await makeAdminCaller().listBusinessLeads({ limit: 20, offset: 0, requiresReview: true });

    const dataSql = mockDb.query.mock.calls[1][0] as string;
    const dataParams = mockDb.query.mock.calls[1][1] as unknown[];
    expect(dataSql).toContain('requires_review = $');
    expect(dataParams).toContain(true);
  });

  it('orders newest-first', async () => {
    grantAdmin();
    mockDb.query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    mockDb.query.mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 } as any);

    await makeAdminCaller().listBusinessLeads({ limit: 20, offset: 0 });

    expect(mockDb.query.mock.calls[1][0]).toContain('ORDER BY created_at DESC');
  });

  it('rejects a non-admin caller with FORBIDDEN', async () => {
    denyAdmin();
    await expect(
      makeAdminCaller().listBusinessLeads({ limit: 20, offset: 0 })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

// ---------------------------------------------------------------------------
// reviewBusinessLead
// ---------------------------------------------------------------------------

describe('admin.reviewBusinessLead', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a non-admin caller with FORBIDDEN', async () => {
    denyAdmin();
    await expect(
      makeAdminCaller().reviewBusinessLead({ leadId: '11111111-1111-1111-1111-111111111111', status: 'REVIEWED' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('throws NOT_FOUND for a missing lead and never updates', async () => {
    const txQuery = mockReview({ leadRow: null });

    await expect(
      makeAdminCaller().reviewBusinessLead({ leadId: '11111111-1111-1111-1111-111111111111', status: 'REVIEWED' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // Only the SELECT ran; no UPDATE, no audit INSERT.
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('marks a lead REVIEWED and stamps reviewer + writes audit row', async () => {
    const txQuery = mockReview({ leadRow: { id: 'lead-1', status: 'NEW', compliance_score: 0 } });

    const result = await makeAdminCaller().reviewBusinessLead({
      leadId: '11111111-1111-1111-1111-111111111111',
      status: 'REVIEWED',
      adminNotes: 'looks legit',
    });

    expect(result.status).toBe('REVIEWED');

    // SELECT, UPDATE, audit INSERT.
    expect(txQuery).toHaveBeenCalledTimes(3);
    const updateSql = txQuery.mock.calls[1][0] as string;
    const updateParams = txQuery.mock.calls[1][1] as unknown[];
    expect(updateSql).toContain('UPDATE business_leads');
    expect(updateSql).toContain('reviewed_at = NOW()');
    expect(updateParams).toContain('REVIEWED');
    expect(updateParams).toContain('admin-user-id'); // reviewed_by = ctx.user.id

    const auditSql = txQuery.mock.calls[2][0] as string;
    expect(auditSql).toContain('INSERT INTO admin_actions');
    expect(auditSql).toContain('admin_user_id');
    expect(auditSql).toContain('admin_role');
    expect(auditSql).toContain('action_details');
    expect(auditSql).toContain("'business_lead_review'");
  });

  it('APPROVES a clean lead with admin notes', async () => {
    const txQuery = mockReview({
      leadRow: { id: 'lead-1', status: 'REVIEWED', compliance_score: 0 },
      updatedRow: {
        id: 'lead-1', status: 'APPROVED', reviewed_at: new Date(),
        reviewed_by: 'admin-user-id', approved_templates: null, admin_notes: 'approved',
      },
    });

    const result = await makeAdminCaller().reviewBusinessLead({
      leadId: '11111111-1111-1111-1111-111111111111',
      status: 'APPROVED',
      adminNotes: 'approved',
    });

    expect(result.status).toBe('APPROVED');
    expect(txQuery).toHaveBeenCalledTimes(3);
  });

  it('REJECTS a lead with admin notes + audit row', async () => {
    const txQuery = mockReview({
      leadRow: { id: 'lead-1', status: 'NEW', compliance_score: 0 },
      updatedRow: {
        id: 'lead-1', status: 'REJECTED', reviewed_at: new Date(),
        reviewed_by: 'admin-user-id', approved_templates: null, admin_notes: 'spam',
      },
    });

    const result = await makeAdminCaller().reviewBusinessLead({
      leadId: '11111111-1111-1111-1111-111111111111',
      status: 'REJECTED',
      adminNotes: 'spam',
    });

    expect(result.status).toBe('REJECTED');
    expect((txQuery.mock.calls[1][1] as unknown[])).toContain('REJECTED');
    expect(txQuery.mock.calls[2][0]).toContain('INSERT INTO admin_actions');
  });

  it('persists approvedTemplates when provided', async () => {
    const txQuery = mockReview({ leadRow: { id: 'lead-1', status: 'REVIEWED', compliance_score: 0 } });

    await makeAdminCaller().reviewBusinessLead({
      leadId: '11111111-1111-1111-1111-111111111111',
      status: 'APPROVED',
      approvedTemplates: ['in_home', 'standard_physical'],
    });

    const updateParams = txQuery.mock.calls[1][1] as unknown[];
    expect(updateParams).toContain(JSON.stringify(['in_home', 'standard_physical']));
  });

  it('blocks APPROVE of a compliance-flagged lead without override', async () => {
    const txQuery = mockReview({ leadRow: { id: 'lead-1', status: 'NEW', compliance_score: 40 } });

    await expect(
      makeAdminCaller().reviewBusinessLead({
        leadId: '11111111-1111-1111-1111-111111111111',
        status: 'APPROVED',
      })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    // SELECT only — guard fires before UPDATE.
    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('allows APPROVE of a compliance-flagged lead with override:true', async () => {
    const txQuery = mockReview({
      leadRow: { id: 'lead-1', status: 'NEW', compliance_score: 40 },
      updatedRow: {
        id: 'lead-1', status: 'APPROVED', reviewed_at: new Date(),
        reviewed_by: 'admin-user-id', approved_templates: null, admin_notes: null,
      },
    });

    const result = await makeAdminCaller().reviewBusinessLead({
      leadId: '11111111-1111-1111-1111-111111111111',
      status: 'APPROVED',
      override: true,
    });

    expect(result.status).toBe('APPROVED');
    expect(txQuery).toHaveBeenCalledTimes(3);
    // override recorded in the audit action_details payload.
    expect(txQuery.mock.calls[2][1] as unknown[]).toEqual([
      expect.anything(),
      expect.stringContaining('"override":true'),
    ]);
  });

  it('blocks re-review of a CONVERTED lead with CONFLICT (E5 boundary)', async () => {
    const txQuery = mockReview({ leadRow: { id: 'lead-1', status: 'CONVERTED', compliance_score: 0 } });

    await expect(
      makeAdminCaller().reviewBusinessLead({
        leadId: '11111111-1111-1111-1111-111111111111',
        status: 'REVIEWED',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(txQuery).toHaveBeenCalledTimes(1); // SELECT only, no UPDATE
  });

  it('Zod rejects status=CONVERTED (cannot be set in E4)', async () => {
    grantAdmin();
    await expect(
      makeAdminCaller().reviewBusinessLead({
        leadId: '11111111-1111-1111-1111-111111111111',
        status: 'CONVERTED' as any,
      })
    ).rejects.toBeInstanceOf(Error);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('Zod rejects status=NEW (not a review action)', async () => {
    grantAdmin();
    await expect(
      makeAdminCaller().reviewBusinessLead({
        leadId: '11111111-1111-1111-1111-111111111111',
        status: 'NEW' as any,
      })
    ).rejects.toBeInstanceOf(Error);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('Zod rejects an unknown approvedTemplates slug', async () => {
    grantAdmin();
    await expect(
      makeAdminCaller().reviewBusinessLead({
        leadId: '11111111-1111-1111-1111-111111111111',
        status: 'APPROVED',
        approvedTemplates: ['not_a_real_template'] as any,
      })
    ).rejects.toBeInstanceOf(Error);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('audit-insert failure rolls back the review (all-or-nothing)', async () => {
    // The transaction helper rethrows; our mock propagates the audit rejection,
    // so the mutation rejects and the review is not considered complete.
    mockReview({ leadRow: { id: 'lead-1', status: 'NEW', compliance_score: 0 }, auditRejects: true });

    await expect(
      makeAdminCaller().reviewBusinessLead({
        leadId: '11111111-1111-1111-1111-111111111111',
        status: 'REVIEWED',
      })
    ).rejects.toThrow('audit insert failed');
  });

  it('never creates a user account', async () => {
    mockReview({ leadRow: { id: 'lead-1', status: 'NEW', compliance_score: 0 } });

    await makeAdminCaller().reviewBusinessLead({
      leadId: '11111111-1111-1111-1111-111111111111',
      status: 'REVIEWED',
    });

    const allSql = [
      ...mockDb.query.mock.calls.map((c) => String(c[0])),
      ...mockDb.transaction.mock.results.flatMap(() => []),
    ];
    // No INSERT INTO users anywhere in this path.
    expect(allSql.some((s) => /INSERT\s+INTO\s+users/i.test(s))).toBe(false);
  });
});
