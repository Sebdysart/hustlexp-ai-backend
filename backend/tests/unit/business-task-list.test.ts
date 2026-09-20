import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db } from '../../src/db.js';
import {
  DEFAULT_BUSINESS_TASK_STATES, decodeBusinessTaskCursor, listBusinessTasks,
} from '../../src/services/BusinessTaskReadService.js';
import { businessTaskOwnershipSql } from '../../src/services/BusinessTaskOwnership.js';
import { REQUIRED_MIGRATION_FILES } from '../../src/jobs/engine-automation-migration-files.js';
import { businessTaskRouter } from '../../src/routers/businessTask.js';

vi.mock('../../src/db.js', () => ({ db: { query: vi.fn() } }));

const org = '11111111-1111-4111-8111-111111111111';
const otherOrg = '22222222-2222-4222-8222-222222222222';
const actor = '33333333-3333-4333-8333-333333333333';
const quoteTask = '44444444-4444-4444-8444-444444444444';
const assignmentTask = '55555555-5555-4555-8555-555555555555';

function row(overrides: Record<string, unknown> = {}) {
  return {
    task_id: quoteTask, title: 'Garden cleanup', category: 'YARD_WORK',
    task_state: 'ACCEPTED', progress_state: 'ACCEPTED', rough_location: 'Seattle, WA',
    scheduled_service_date: '2026-10-10', accepted_at: '2026-09-21T10:00:00Z',
    completed_at: null, gross_payout_cents: 8200, escrow_state: 'FUNDED',
    stripe_transfer_id: null, provider_transfer_status: null, fulfiller_name: null,
    acquisition_origin: 'provider_os', sort_at: '2026-09-21T10:00:00Z',
    ...overrides,
  };
}

const query = vi.mocked(db.query);
beforeEach(() => vi.resetAllMocks());

describe('canonical business task list', () => {
  const caller = () => businessTaskRouter.createCaller({
    user: { id: actor, account_status: 'ACTIVE', is_banned: false } as never,
    firebaseUid: 'test-user',
  });

  it('validates exact organization, canonical state and bounded page size at the router', async () => {
    await expect(caller().listForOrganization({ organizationId: 'wrong' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().listForOrganization({ organizationId: org, limit: 101 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().listForOrganization({ organizationId: org, states: ['ASSIGNED' as never] })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().listForOrganization({ organizationId: org, cursor: 'raw-sql-key' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller().listForOrganization({ organizationId: org, price: 1 } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(query).not.toHaveBeenCalled();
  });

  it('translates missing workspace permission to forbidden', async () => {
    query.mockResolvedValueOnce({ rows: [] } as never);
    await expect(caller().listForOrganization({ organizationId: org })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('binds both ownership paths to the exact organization and task assignment', () => {
    const predicate = businessTaskOwnershipSql('task', '$1');
    for (const token of [
      'task.business_fulfiller_organization_id = $1',
      'task.provider_organization_id = $1',
      'assignment.id = task.provider_assignment_id',
      'assignment.task_id = task.id',
      'assignment.provider_organization_id = $1',
      'assignment.fulfiller_user_id = task.worker_id',
    ]) expect(predicate).toContain(token);
    const detail = readFileSync('backend/src/routers/TaskReadProcedures.ts', 'utf8');
    expect(detail).toContain("businessTaskOwnershipSql('task', 'organization.id')");
    expect(detail).toContain("business_membership_has_action(organization.id,$2,'READ_WORKSPACE')");
  });

  it('requires active workspace access before reading and denies nonmembers', async () => {
    query.mockResolvedValueOnce({ rows: [] } as never);
    await expect(listBusinessTasks({ actorId: actor, organizationId: org,
      states: DEFAULT_BUSINESS_TASK_STATES, limit: 20, cursor: null,
    })).rejects.toThrow('BUSINESS_TASK_ACCESS_DENIED');
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("organization.status='ACTIVE'");
    expect(sql).toContain("business_membership_has_action(organization.id,$2,'READ_WORKSPACE')");
    expect(params).toEqual([org, actor]);
  });

  it('reads quote and service tasks together, one canonical task per ID', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: org }] } as never);
    query.mockResolvedValueOnce({ rows: [
      row(), row({ task_id: assignmentTask, task_state: 'COMPLETED',
        completed_at: '2026-09-22T10:00:00Z', gross_payout_cents: '9100',
        escrow_state: 'RELEASED', provider_transfer_status: 'paid',
        fulfiller_name: 'Crew member', acquisition_origin: 'service_assignment',
      }),
    ] } as never);
    const result = await listBusinessTasks({ actorId: actor, organizationId: org,
      states: DEFAULT_BUSINESS_TASK_STATES, limit: 20, cursor: null,
    });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toMatchObject({ taskId: quoteTask, taskState: 'ACCEPTED',
      grossPayoutCents: 8200, acquisitionOrigin: 'provider_os', fulfillerName: null,
      scheduledServiceDate: '2026-10-10', roughLocation: 'Seattle, WA' });
    expect(result.tasks[1]).toMatchObject({ taskId: assignmentTask,
      completedAt: '2026-09-22T10:00:00.000Z', grossPayoutCents: 9100,
      payoutState: 'CONNECTED_BALANCE_CONFIRMED', fulfillerName: 'Crew member' });
    const [sql, params] = query.mock.calls[1];
    expect(sql).toContain('FROM tasks task');
    expect(sql).toContain('UNION');
    expect(sql).toContain('assignment.id=task.provider_assignment_id');
    expect(sql).toContain('WHEN task.provider_assignment_id IS NOT NULL THEN task.hustler_payout_cents');
    expect(sql).toContain('COALESCE(version.hustler_payout_cents,task.hustler_payout_cents)');
    expect(sql).toContain('task.state=ANY($2::text[])');
    expect(sql).toContain('task.accepted_at IS NOT NULL');
    expect(params).toEqual([org, DEFAULT_BUSINESS_TASK_STATES, null, null, 21]);
    expect(DEFAULT_BUSINESS_TASK_STATES).toEqual([
      'ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED', 'COMPLETED', 'CANCELLED', 'EXPIRED',
    ]);
  });

  it('uses stable timestamp/ID pagination bound to organization and state filter', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: org }] } as never);
    query.mockResolvedValueOnce({ rows: [row(), row({ task_id: assignmentTask })] } as never);
    const result = await listBusinessTasks({ actorId: actor, organizationId: org,
      states: ['ACCEPTED'], limit: 1, cursor: null });
    expect(result.tasks).toHaveLength(1);
    expect(result.nextCursor).toBeTruthy();
    const cursor = decodeBusinessTaskCursor(result.nextCursor!, org, ['ACCEPTED']);
    expect(cursor.id).toBe(quoteTask);
    expect(() => decodeBusinessTaskCursor(result.nextCursor!, otherOrg, ['ACCEPTED'])).toThrow();
    expect(() => decodeBusinessTaskCursor(result.nextCursor!, org, ['COMPLETED'])).toThrow();
    query.mockResolvedValueOnce({ rows: [{ id: org }] } as never);
    query.mockResolvedValueOnce({ rows: [] } as never);
    await listBusinessTasks({ actorId: actor, organizationId: org,
      states: ['ACCEPTED'], limit: 1, cursor });
    expect(query.mock.calls[3][1]).toEqual([org, ['ACCEPTED'], cursor.at, quoteTask, 2]);
    expect(query.mock.calls[3][0]).toContain('ORDER BY sort_at DESC,task.id DESC');
  });

  it('preserves exact completed filtering and only reports authoritative provenance', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: org }] } as never);
    query.mockResolvedValueOnce({ rows: [
      row({ task_state: 'COMPLETED', acquisition_origin: 'claim_link' }),
      row({ task_id: assignmentTask, task_state: 'COMPLETED', acquisition_origin: 'direct_proposal' }),
      row({ task_id: '66666666-6666-4666-8666-666666666666', task_state: 'COMPLETED', acquisition_origin: null }),
    ] } as never);
    const result = await listBusinessTasks({ actorId: actor, organizationId: org,
      states: ['COMPLETED'], limit: 5, cursor: null });
    expect(query.mock.calls[1][1]?.[1]).toEqual(['COMPLETED']);
    expect(result.tasks.map((task) => task.acquisitionOrigin))
      .toEqual(['claim_link', 'direct_proposal', null]);
  });

  it('registers the supporting indexes after the assignment and task-draft schema', () => {
    const names = REQUIRED_MIGRATION_FILES.map((migration) => migration.name);
    expect(names.indexOf('20260927_business_task_list_indexes'))
      .toBeGreaterThan(names.indexOf('20260926_checkr_webhook_ordering'));
  });
});
