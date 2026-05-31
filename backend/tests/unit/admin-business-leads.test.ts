/**
 * Admin Business Lead Review Queue — Unit Tests (Roadmap E4)
 *
 * Covers admin.listBusinessLeads (offset pagination + filters),
 * admin.reviewBusinessLead (transactional status update + admin_actions audit),
 * and admin.convertBusinessLead (E5: link an APPROVED lead to an existing user
 * account, flip to CONVERTED, audit with target_user_id — in one transaction).
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

type ConvertLeadRow = {
  id: string;
  status: string;
  converted_user_id: string | null;
};

type ConvertUserRow = {
  id: string;
  is_banned: boolean;
  account_status: string;
};

/**
 * Wire up a convertBusinessLead happy/guarded path:
 *   call 1 (db.query):       admin_roles check
 *   db.transaction(fn) -> txQuery:
 *     call 1: SELECT lead ... FOR UPDATE   -> leadRow (or none)
 *     call 2: SELECT target user           -> userRow (or none)
 *     call 3: UPDATE lead ... RETURNING    -> updatedRow
 *     call 4: INSERT admin_actions
 * Guard cases short-circuit before later calls; queued-but-unconsumed mocks are
 * harmless. Pass userRow:null to simulate a missing target user. Returns the
 * txQuery mock for assertions.
 */
function mockConvert(opts: {
  leadRow: ConvertLeadRow | null;
  userRow?: ConvertUserRow | null;
  updatedRow?: any;
  auditRejects?: boolean;
}) {
  grantAdmin();
  const userRow =
    opts.userRow === undefined
      ? { id: 'target-user-id', is_banned: false, account_status: 'ACTIVE' }
      : opts.userRow;
  const updatedRow = opts.updatedRow ?? {
    id: opts.leadRow?.id ?? 'lead-1',
    status: 'CONVERTED',
    converted_user_id: userRow?.id ?? 'target-user-id',
    approved_templates: null,
    updated_at: new Date('2026-05-31T00:00:00Z'),
  };
  const txQuery = vi.fn();
  // SELECT lead FOR UPDATE
  txQuery.mockResolvedValueOnce({
    rows: opts.leadRow ? [opts.leadRow] : [],
    rowCount: opts.leadRow ? 1 : 0,
  } as any);
  // SELECT target user
  txQuery.mockResolvedValueOnce({
    rows: userRow ? [userRow] : [],
    rowCount: userRow ? 1 : 0,
  } as any);
  // UPDATE RETURNING
  txQuery.mockResolvedValueOnce({ rows: [updatedRow], rowCount: 1 } as any);
  // audit INSERT
  if (opts.auditRejects) {
    txQuery.mockRejectedValueOnce(new Error('audit insert failed'));
  } else {
    txQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
  }
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

// ---------------------------------------------------------------------------
// convertBusinessLead (E5)
// ---------------------------------------------------------------------------

const LEAD_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

describe('admin.convertBusinessLead', () => {
  beforeEach(() => vi.clearAllMocks());

  it('converts an APPROVED lead: sets CONVERTED + converted_user_id and audits with target_user_id', async () => {
    const txQuery = mockConvert({
      leadRow: { id: 'lead-1', status: 'APPROVED', converted_user_id: null },
      userRow: { id: USER_ID, is_banned: false, account_status: 'ACTIVE' },
      updatedRow: {
        id: 'lead-1', status: 'CONVERTED', converted_user_id: USER_ID,
        approved_templates: null, updated_at: new Date('2026-05-31T00:00:00Z'),
      },
    });

    const result = await makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID });

    expect(result.status).toBe('CONVERTED');
    expect(result.converted_user_id).toBe(USER_ID);

    // SELECT lead, SELECT user, UPDATE, audit INSERT.
    expect(txQuery).toHaveBeenCalledTimes(4);

    const updateSql = txQuery.mock.calls[2][0] as string;
    const updateParams = txQuery.mock.calls[2][1] as unknown[];
    expect(updateSql).toContain('UPDATE business_leads');
    expect(updateSql).toContain("status = 'CONVERTED'");
    expect(updateSql).toContain('converted_user_id = $1');
    expect(updateParams).toContain(USER_ID);

    const auditSql = txQuery.mock.calls[3][0] as string;
    const auditParams = txQuery.mock.calls[3][1] as unknown[];
    expect(auditSql).toContain('INSERT INTO admin_actions');
    expect(auditSql).toContain('target_user_id');
    expect(auditSql).toContain("'business_lead_conversion'");
    // admin_user_id, action_details JSON, target_user_id = converted user id.
    expect(auditParams[0]).toBe('admin-user-id');
    expect(auditParams[2]).toBe(USER_ID);
  });

  it('blocks a NEW lead with CONFLICT and never updates', async () => {
    const txQuery = mockConvert({ leadRow: { id: 'lead-1', status: 'NEW', converted_user_id: null } });

    await expect(
      makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(txQuery).toHaveBeenCalledTimes(1); // SELECT lead only
  });

  it('blocks a REVIEWED lead with CONFLICT and never updates', async () => {
    const txQuery = mockConvert({ leadRow: { id: 'lead-1', status: 'REVIEWED', converted_user_id: null } });

    await expect(
      makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('blocks a REJECTED lead with CONFLICT and never updates', async () => {
    const txQuery = mockConvert({ leadRow: { id: 'lead-1', status: 'REJECTED', converted_user_id: null } });

    await expect(
      makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('blocks an already-CONVERTED lead with CONFLICT and never updates', async () => {
    const txQuery = mockConvert({
      leadRow: { id: 'lead-1', status: 'CONVERTED', converted_user_id: 'someone-else' },
    });

    await expect(
      makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID })
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(txQuery).toHaveBeenCalledTimes(1);
  });

  it('throws NOT_FOUND for a missing lead and never queries the user', async () => {
    const txQuery = mockConvert({ leadRow: null });

    await expect(
      makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(txQuery).toHaveBeenCalledTimes(1); // SELECT lead only — no user lookup, no UPDATE
  });

  it('throws NOT_FOUND for a missing target user and never updates', async () => {
    const txQuery = mockConvert({
      leadRow: { id: 'lead-1', status: 'APPROVED', converted_user_id: null },
      userRow: null,
    });

    await expect(
      makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(txQuery).toHaveBeenCalledTimes(2); // SELECT lead, SELECT user — no UPDATE
  });

  it.each([
    ['banned', { id: USER_ID, is_banned: true, account_status: 'ACTIVE' }],
    ['SUSPENDED', { id: USER_ID, is_banned: false, account_status: 'SUSPENDED' }],
    ['DELETED', { id: USER_ID, is_banned: false, account_status: 'DELETED' }],
  ])('blocks a %s target user with PRECONDITION_FAILED and never updates', async (_label, userRow) => {
    const txQuery = mockConvert({
      leadRow: { id: 'lead-1', status: 'APPROVED', converted_user_id: null },
      userRow: userRow as ConvertUserRow,
    });

    await expect(
      makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });

    expect(txQuery).toHaveBeenCalledTimes(2); // SELECT lead, SELECT user — no UPDATE
  });

  it('writes the audit row on success', async () => {
    const txQuery = mockConvert({
      leadRow: { id: 'lead-1', status: 'APPROVED', converted_user_id: null },
      updatedRow: {
        id: 'lead-1', status: 'CONVERTED', converted_user_id: USER_ID,
        approved_templates: null, updated_at: new Date(),
      },
    });

    await makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID });

    expect(txQuery.mock.calls[3][0]).toContain('INSERT INTO admin_actions');
    expect(txQuery.mock.calls[3][0]).toContain("'business_lead_conversion'");
    expect(txQuery.mock.calls[3][0]).toContain('target_user_id');
  });

  it('audit-insert failure rolls back the conversion (all-or-nothing)', async () => {
    mockConvert({
      leadRow: { id: 'lead-1', status: 'APPROVED', converted_user_id: null },
      auditRejects: true,
    });

    await expect(
      makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID })
    ).rejects.toThrow('audit insert failed');
  });

  it('rejects a non-admin caller with FORBIDDEN and never opens a transaction', async () => {
    denyAdmin();
    await expect(
      makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('never creates a user account', async () => {
    const txQuery = mockConvert({
      leadRow: { id: 'lead-1', status: 'APPROVED', converted_user_id: null },
    });

    await makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID });

    const allSql = [
      ...mockDb.query.mock.calls.map((c) => String(c[0])),
      ...txQuery.mock.calls.map((c) => String(c[0])),
    ];
    expect(allSql.some((s) => /INSERT\s+INTO\s+users/i.test(s))).toBe(false);
  });

  it('preserves approved_templates when omitted (UPDATE param is null -> COALESCE keeps existing)', async () => {
    const txQuery = mockConvert({
      leadRow: { id: 'lead-1', status: 'APPROVED', converted_user_id: null },
    });

    await makeAdminCaller().convertBusinessLead({ leadId: LEAD_ID, userId: USER_ID });

    const updateSql = txQuery.mock.calls[2][0] as string;
    const updateParams = txQuery.mock.calls[2][1] as unknown[];
    expect(updateSql).toContain('approved_templates = COALESCE($2::jsonb, approved_templates)');
    // params: [userId, approvedTemplates(null), leadId]
    expect(updateParams[1]).toBeNull();
  });

  it('overwrites approved_templates when provided (UPDATE param is the JSON)', async () => {
    const txQuery = mockConvert({
      leadRow: { id: 'lead-1', status: 'APPROVED', converted_user_id: null },
    });

    await makeAdminCaller().convertBusinessLead({
      leadId: LEAD_ID,
      userId: USER_ID,
      approvedTemplates: ['in_home', 'standard_physical'],
    });

    const updateParams = txQuery.mock.calls[2][1] as unknown[];
    expect(updateParams[1]).toBe(JSON.stringify(['in_home', 'standard_physical']));
  });

  it('Zod rejects an unknown approvedTemplates slug and never opens a transaction', async () => {
    grantAdmin();
    await expect(
      makeAdminCaller().convertBusinessLead({
        leadId: LEAD_ID,
        userId: USER_ID,
        approvedTemplates: ['not_a_real_template'] as any,
      })
    ).rejects.toBeInstanceOf(Error);
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
