import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  createInTransaction: vi.fn(),
  encryptTaskLocation: vi.fn((id: string, value: string) => ({
    ciphertext: `cipher:${id}`,
    nonce: `nonce:${id}`,
    authTag: `tag:${id}`,
    keyId: 'key-v1',
    fingerprint: `finger:${id}:${value.length}`,
  })),
  decryptTaskLocation: vi.fn((id: string) => id.endsWith(':access') ? 'Use the rear gate' : '42 Private Lane'),
}));
const { query, createInTransaction, encryptTaskLocation, decryptTaskLocation } = mocks;
vi.mock('../../src/db.js', () => ({
  db: {
    query: mocks.query,
    transaction: vi.fn(async (fn: (q: typeof mocks.query) => Promise<unknown>) => fn(mocks.query)),
  },
}));

vi.mock('../../src/services/TaskCreateService.js', () => ({
  TaskCreateService: { createInTransaction: mocks.createInTransaction },
}));

vi.mock('../../src/services/TaskLocationCrypto.js', () => ({
  encryptTaskLocation: mocks.encryptTaskLocation,
  decryptTaskLocation: mocks.decryptTaskLocation,
}));

vi.mock('../../src/logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

import {
  createControlledRecurringTemplate,
  advanceControlledReservationWaves,
  listControlledRecurringTemplates,
  generateControlledRecurringOccurrence,
  type ControlledRecurringTemplateInput,
} from '../../src/services/RecurringWorkService.js';

const POSTER = '00000000-0000-0000-0000-000000000001';
const WORKER = '00000000-0000-0000-0000-000000000002';
const SERIES = '10000000-0000-0000-0000-000000000001';
const REVISION = '12000000-0000-0000-0000-000000000001';
const TASK = '20000000-0000-0000-0000-000000000001';

const COMPLETE: ControlledRecurringTemplateInput = {
  posterId: POSTER,
  clientPrincipalType: 'HOUSEHOLD',
  clientPrincipalId: POSTER,
  title: 'Weekly common-area clean',
  description: 'Complete the approved common-area cleaning recipe.',
  category: 'cleaning',
  taskRecipe: { recipe: 'common-area-v1' },
  exactLocation: '42 Private Lane',
  roughLocation: 'Bellevue',
  accessProcedure: 'Use the rear gate',
  regionCode: 'US-WA',
  pattern: 'weekly',
  dayOfWeek: 6,
  dayOfMonth: null,
  timeOfDay: '09:00',
  startDate: '2026-07-25',
  endDate: null,
  timezone: 'America/Los_Angeles',
  serviceWindowStart: '09:00',
  serviceWindowEnd: '11:00',
  expectedDurationMinutes: 120,
  customerTotalCents: 10_000,
  providerPayoutCents: 8_000,
  platformMarginCents: 2_000,
  corridorMinimumCents: 9_000,
  corridorMaximumCents: 12_000,
  maximumAdjustmentCents: 3_000,
  requiredTrustTier: 3,
  licenseRequirements: {},
  insuranceRequirements: {},
  credentialsValidUntil: '2026-08-31T00:00:00.000Z',
  requiredTools: ['vacuum'],
  requiredVehicle: null,
  completionChecklist: ['Complete checklist', 'Upload completion proof'],
  preferredWorkerId: WORKER,
  backupWorkerIds: ['00000000-0000-0000-0000-000000000003'],
  cancellationRules: { noticeHours: 24 },
  holidayRules: { skipPublicHolidays: true },
  budgetCapCents: 50_000,
  approverId: POSTER,
  escalationRules: { onException: 'pause' },
  invoiceGrouping: { groupBy: 'monthly' },
  nextReviewDate: '2026-08-18',
  riskLevel: 'LOW',
};

function controlledRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SERIES,
    poster_id: POSTER,
    status: 'active',
    current_revision_id: REVISION,
    next_occurrence_at: '2026-07-25T16:00:00.000Z',
    end_date: null,
    title: COMPLETE.title,
    description: COMPLETE.description,
    category: COMPLETE.category,
    region_code: COMPLETE.regionCode,
    rough_location: COMPLETE.roughLocation,
    payment_cents: COMPLETE.customerTotalCents,
    provider_payout_cents: COMPLETE.providerPayoutCents,
    platform_margin_cents: COMPLETE.platformMarginCents,
    expected_duration_minutes: COMPLETE.expectedDurationMinutes,
    required_tools: COMPLETE.requiredTools,
    completion_checklist: COMPLETE.completionChecklist,
    preferred_worker_id: WORKER,
    backup_worker_ids: COMPLETE.backupWorkerIds,
    pattern: 'weekly',
    occurrence_count: 0,
    service_window_start: '09:00:00',
    service_window_end: '11:00:00',
    timezone: COMPLETE.timezone,
    location_ciphertext: 'cipher:location', location_nonce: 'n', location_auth_tag: 't', location_key_id: 'key-v1',
    access_ciphertext: 'cipher:access', access_nonce: 'n', access_auth_tag: 't', access_key_id: 'key-v1',
    client_principal_type: 'HOUSEHOLD', business_organization_id: null,
    business_location_id: null, recurring_po_number: null, recurring_cost_center: null,
    holiday_rules: {},
    ...overrides,
  };
}

describe('controlled recurring work orchestration', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates an encrypted versioned template and activates only after its revision exists', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: SERIES }] })
      .mockResolvedValueOnce({ rows: [{ id: REVISION }] })
      .mockResolvedValueOnce({ rows: [{ id: SERIES, status: 'active', current_revision_id: REVISION }] });

    const result = await createControlledRecurringTemplate(COMPLETE);

    expect(result).toMatchObject({
      success: true,
      data: { id: expect.any(String), status: 'active', revisionId: expect.any(String) },
    });
    expect(encryptTaskLocation).toHaveBeenCalledWith(expect.any(String), COMPLETE.exactLocation);
    expect(encryptTaskLocation).toHaveBeenCalledWith(expect.stringMatching(/:access$/), COMPLETE.accessProcedure);
    const allParams = JSON.stringify(query.mock.calls.map((call) => call[1]));
    expect(allParams).not.toContain(COMPLETE.exactLocation);
    expect(allParams).not.toContain(COMPLETE.accessProcedure);
    expect(query.mock.calls[0][0]).toContain("'paused'");
    expect(query.mock.calls[1][0]).toContain('recurring_task_template_revisions');
    expect(query.mock.calls[2][0]).toContain("status='active'");
  });

  it('fails closed for an organization until membership-backed business roles exist', async () => {
    const result = await createControlledRecurringTemplate({
      ...COMPLETE,
      clientPrincipalType: 'ORGANIZATION',
      clientPrincipalId: '30000000-0000-0000-0000-000000000001',
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: 'ORGANIZATION_WORKSPACE_REQUIRED' },
    });
    expect(query).not.toHaveBeenCalled();
  });

  it('lists only the authenticated Poster safe recurring projection', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: SERIES, title: COMPLETE.title, category: COMPLETE.category, rough_location: 'Bellevue',
      status: 'active', pause_code: null, current_revision_id: REVISION,
      next_occurrence_at: '2026-07-25T16:00:00.000Z', pattern: 'weekly',
      service_window_start: '09:00:00', service_window_end: '11:00:00',
      timezone: COMPLETE.timezone, budget_cap_cents: 50000, budget_spend_cents: 10000,
      preferred_worker_id: WORKER, backup_provider_count: 1, occurrence_count: 2,
      completed_count: 1, automation_mode: 'SUPERVISED',
    }] });

    const result = await listControlledRecurringTemplates(POSTER);

    expect(result).toMatchObject({ success: true, data: [{ id: SERIES, roughLocation: 'Bellevue' }] });
    expect(query.mock.calls[0][1]).toEqual([POSTER]);
    const sql = String(query.mock.calls[0][0]);
    expect(sql).toContain('poster_id=$1');
    expect(sql).not.toMatch(/location_ciphertext|access_ciphertext|nonce|auth_tag|fingerprint|SELECT \*/i);
  });

  it('pauses and creates no task when the database safeguard gate returns a reason', async () => {
    query
      .mockResolvedValueOnce({ rows: [controlledRow()] })
      .mockResolvedValueOnce({ rows: [{ reason: 'BUDGET_WOULD_EXCEED' }] })
      .mockResolvedValueOnce({ rows: [{ paused: true }] });

    const result = await generateControlledRecurringOccurrence({
      seriesId: SERIES,
      actorId: POSTER,
      evaluateAt: new Date('2026-07-25T15:00:00.000Z'),
    });

    expect(result).toEqual({ success: true, data: { outcome: 'paused', pauseCode: 'BUDGET_WOULD_EXCEED' } });
    expect(createInTransaction).not.toHaveBeenCalled();
  });

  it('atomically creates one canonical task, occurrence witness, and preferred reservation', async () => {
    query
      .mockResolvedValueOnce({ rows: [controlledRow()] })
      .mockResolvedValueOnce({ rows: [{ reason: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: '21000000-0000-0000-0000-000000000001' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    createInTransaction.mockResolvedValueOnce({ success: true, data: { id: TASK } });

    const result = await generateControlledRecurringOccurrence({
      seriesId: SERIES,
      actorId: POSTER,
      evaluateAt: new Date('2026-07-25T15:00:00.000Z'),
    });

    expect(result).toMatchObject({
      success: true,
      data: { outcome: 'generated', taskId: TASK, occurrenceNumber: 1 },
    });
    expect(createInTransaction).toHaveBeenCalledWith(query, expect.objectContaining({
      posterId: POSTER,
      location: '42 Private Lane\nAccess procedure: Use the rear gate',
      regionCode: 'US-WA',
      price: 10_000,
      hustlerPayoutCents: 8_000,
      platformMarginCents: 2_000,
      preferredWorkerId: WORKER,
      clientIdempotencyKey: expect.stringMatching(/^recurring:/),
    }));
    expect(query.mock.calls.some((call) => String(call[0]).includes('recurring_task_occurrences'))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[0]).includes('recurring_provider_reservations'))).toBe(true);
    expect(query.mock.calls.some((call) => String(call[0]).includes('budget_spend_cents=budget_spend_cents+payment_cents'))).toBe(true);
  });

  it('holds an organization occurrence for approval without creating a task or advancing schedule', async () => {
    const approvalId = '50000000-0000-0000-0000-000000000001';
    query
      .mockResolvedValueOnce({ rows: [controlledRow({
        client_principal_type: 'ORGANIZATION', business_organization_id: '60000000-0000-0000-0000-000000000001',
        business_location_id: '70000000-0000-0000-0000-000000000001', recurring_po_number: 'PO-1',
        recurring_cost_center: 'OPS',
      })] })
      .mockResolvedValueOnce({ rows: [{ reason: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        approval_request_id: approvalId, approval_status: 'PENDING_APPROVAL', approval_blockers: [],
      }] });

    const result = await generateControlledRecurringOccurrence({
      seriesId: SERIES, actorId: null, evaluateAt: new Date('2026-07-25T15:00:00.000Z'),
    });

    expect(result).toEqual({
      success: true, data: { outcome: 'approval_required', approvalRequestId: approvalId },
    });
    expect(createInTransaction).not.toHaveBeenCalled();
    expect(query.mock.calls.some((call) => String(call[0]).includes('UPDATE recurring_task_series SET occurrence_count'))).toBe(false);
  });

  it('records and advances an explicit blackout date without task or spend creation', async () => {
    query
      .mockResolvedValueOnce({ rows: [controlledRow({
        holiday_rules: { blackoutDates: ['2026-07-25'] },
      })] })
      .mockResolvedValueOnce({ rows: [{ reason: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: '80000000-0000-0000-0000-000000000001' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await generateControlledRecurringOccurrence({
      seriesId: SERIES, actorId: null, evaluateAt: new Date('2026-07-25T15:00:00.000Z'),
    });

    expect(result).toEqual({
      success: true,
      data: { outcome: 'skipped', scheduleExceptionId: '80000000-0000-0000-0000-000000000001' },
    });
    expect(createInTransaction).not.toHaveBeenCalled();
    expect(query.mock.calls.some((call) => String(call[0]).includes('budget_spend_cents'))).toBe(false);
  });

  it('completes at the contractual end date without creating another occurrence', async () => {
    query
      .mockResolvedValueOnce({ rows: [controlledRow({ end_date: '2026-07-24' })] })
      .mockResolvedValueOnce({ rows: [{ reason: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: '80000000-0000-0000-0000-000000000002' }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await generateControlledRecurringOccurrence({
      seriesId: SERIES, actorId: null, evaluateAt: new Date('2026-07-25T15:00:00.000Z'),
    });

    expect(result).toEqual({
      success: true,
      data: { outcome: 'completed', scheduleExceptionId: '80000000-0000-0000-0000-000000000002' },
    });
    expect(createInTransaction).not.toHaveBeenCalled();
    expect(query.mock.calls.some((call) => String(call[0]).includes("status='completed'"))).toBe(true);
  });

  it('binds approved organization demand before inserting the recurring occurrence witness', async () => {
    const approvalId = '50000000-0000-0000-0000-000000000001';
    query
      .mockResolvedValueOnce({ rows: [controlledRow({
        client_principal_type: 'ORGANIZATION', business_organization_id: '60000000-0000-0000-0000-000000000001',
        business_location_id: '70000000-0000-0000-0000-000000000001', recurring_po_number: 'PO-1',
        recurring_cost_center: 'OPS',
      })] })
      .mockResolvedValueOnce({ rows: [{ reason: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        approval_request_id: approvalId, approval_status: 'APPROVED', approval_blockers: [],
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ canonical_task_id: TASK, idempotency_replayed: false }] })
      .mockResolvedValueOnce({ rows: [{ id: '21000000-0000-0000-0000-000000000001' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    createInTransaction.mockResolvedValueOnce({ success: true, data: { id: TASK } });

    const result = await generateControlledRecurringOccurrence({
      seriesId: SERIES, actorId: null, evaluateAt: new Date('2026-07-25T15:00:00.000Z'),
    });

    expect(result).toMatchObject({ success: true, data: { outcome: 'generated', taskId: TASK } });
    const bindIndex = query.mock.calls.findIndex((call) => String(call[0]).includes('bind_business_work_order'));
    const occurrenceIndex = query.mock.calls.findIndex((call) => String(call[0]).includes('INSERT INTO recurring_task_occurrences'));
    expect(bindIndex).toBeGreaterThan(-1);
    expect(occurrenceIndex).toBeGreaterThan(bindIndex);
    expect(query.mock.calls[occurrenceIndex][1]).toContain(approvalId);
  });

  it('returns the existing task without creating another on an idempotent replay', async () => {
    query
      .mockResolvedValueOnce({ rows: [controlledRow()] })
      .mockResolvedValueOnce({ rows: [{ reason: null }] })
      .mockResolvedValueOnce({ rows: [{ task_id: TASK, occurrence_number: 1 }] });

    const result = await generateControlledRecurringOccurrence({
      seriesId: SERIES,
      actorId: POSTER,
      evaluateAt: new Date('2026-07-25T15:00:00.000Z'),
    });

    expect(result).toMatchObject({ success: true, data: { outcome: 'replayed', taskId: TASK } });
    expect(createInTransaction).not.toHaveBeenCalled();
  });

  it('writes no occurrence when canonical task creation fails', async () => {
    query
      .mockResolvedValueOnce({ rows: [controlledRow()] })
      .mockResolvedValueOnce({ rows: [{ reason: null }] })
      .mockResolvedValueOnce({ rows: [] });
    createInTransaction.mockResolvedValueOnce({
      success: false,
      error: { code: 'REGION_POLICY_DENIED', message: 'blocked' },
    });

    const result = await generateControlledRecurringOccurrence({
      seriesId: SERIES,
      actorId: POSTER,
      evaluateAt: new Date('2026-07-25T15:00:00.000Z'),
    });

    expect(result).toMatchObject({ success: false, error: { code: 'REGION_POLICY_DENIED' } });
    expect(query.mock.calls.some((call) => String(call[0]).includes('INSERT INTO recurring_task_occurrences'))).toBe(false);
  });

  it('times out an expired preferred reservation and opens exactly one backup wave', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        reservation_id: '40000000-0000-0000-0000-000000000001',
        occurrence_id: '21000000-0000-0000-0000-000000000001',
        series_id: SERIES,
        backup_worker_ids: ['00000000-0000-0000-0000-000000000003'],
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ worker_id: '00000000-0000-0000-0000-000000000003', wave_rank: 1 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await advanceControlledReservationWaves(10);

    expect(result).toEqual({ processed: 1, backupsOpened: 1, exhausted: 0 });
    expect(query.mock.calls.filter((call) => String(call[0]).includes('INSERT INTO recurring_provider_reservations'))).toHaveLength(1);
    expect(query.mock.calls.some((call) => String(call[0]).includes("status='TIMED_OUT'"))).toBe(true);
  });

  it('marks an exhausted provider pool and records a fulfillment failure once', async () => {
    query
      .mockResolvedValueOnce({ rows: [{
        reservation_id: '40000000-0000-0000-0000-000000000001',
        occurrence_id: '21000000-0000-0000-0000-000000000001',
        series_id: SERIES,
        backup_worker_ids: [],
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ reason: null }] })
      .mockResolvedValueOnce({ rows: [] });

    const result = await advanceControlledReservationWaves(10);

    expect(result).toEqual({ processed: 1, backupsOpened: 0, exhausted: 1 });
    expect(query.mock.calls.filter((call) => String(call[0]).includes('record_recurring_safeguard_signal'))).toHaveLength(1);
    expect(query.mock.calls.some((call) => String(call[0]).includes("reservation_state='EXHAUSTED'"))).toBe(true);
  });
});
