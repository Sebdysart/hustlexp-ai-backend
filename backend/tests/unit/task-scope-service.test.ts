import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => {
  const query = vi.fn();
  return {
    db: {
      query,
      transaction: vi.fn((fn: (q: typeof query) => Promise<unknown>) => fn(query)),
    },
  };
});

import { db } from '../../src/db';
import { TaskScopeService } from '../../src/services/TaskScopeService';

const mockDb = vi.mocked(db);

const task = (overrides: Record<string, unknown> = {}) => ({
  id: 'task-1',
  poster_id: 'poster-1',
  worker_id: 'worker-1',
  state: 'ACCEPTED',
  progress_state: 'WORKING',
  active_scope_version_id: 'scope-v1',
  scope_hash: 'a'.repeat(64),
  ...overrides,
});

const version = (overrides: Record<string, unknown> = {}) => ({
  id: 'scope-v1',
  task_id: 'task-1',
  version: 1,
  scope_hash: 'a'.repeat(64),
  title: 'Assemble desk',
  description: 'Assemble one desk',
  requirements: 'Protect the floor',
  checklist: ['Protect the floor', 'Assemble the desk'],
  customer_total_cents: 10_000,
  hustler_payout_cents: 7_500,
  source: 'INITIAL',
  change_summary: 'Initial approved execution scope',
  created_at: new Date(),
  ...overrides,
});

const proposal = (overrides: Record<string, unknown> = {}) => ({
  id: 'proposal-1',
  task_id: 'task-1',
  base_version_id: 'scope-v1',
  proposed_by: 'worker-1',
  proposer_role: 'HUSTLER',
  observed_scope_summary: 'A cable tray is part of the desk.',
  proposed_checklist: ['Protect the floor', 'Assemble the desk', 'Attach the cable tray'],
  status: 'PENDING',
  decision_reason: null,
  approved_version_id: null,
  created_at: new Date(),
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.query.mockReset();
  mockDb.transaction.mockImplementation(async (fn: Parameters<typeof db.transaction>[0]) => fn(mockDb.query));
});

describe('TaskScopeService', () => {
  it('returns the active immutable version, checklist progress, and pending decision', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [version()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ item_index: 0, completed_by: 'worker-1', completed_at: new Date() }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [proposal()], rowCount: 1 } as never);

    const result = await TaskScopeService.getForParticipant('task-1', 'worker-1');

    expect(result).toMatchObject({
      role: 'HUSTLER',
      legacy: false,
      version: { id: 'scope-v1', number: 1, hash: 'a'.repeat(64) },
      checklist: [
        { itemIndex: 0, completed: true },
        { itemIndex: 1, completed: false },
      ],
      pendingChange: { id: 'proposal-1', status: 'PENDING' },
    });
  });

  it('creates a participant proposal against the exact active version and freezes by pending status', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [version()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [proposal()], rowCount: 1 } as never);

    const result = await TaskScopeService.proposeChange({
      taskId: 'task-1',
      userId: 'worker-1',
      observedScopeSummary: 'A cable tray is part of the desk.',
      proposedChecklist: ['Protect the floor', 'Assemble the desk', 'Attach the cable tray'],
    });

    expect(result).toMatchObject({ id: 'proposal-1', base_version_id: 'scope-v1', status: 'PENDING' });
    const insert = mockDb.query.mock.calls[3];
    expect(String(insert[0])).toContain('INSERT INTO task_scope_change_proposals');
    expect(insert[1]).toEqual(expect.arrayContaining(['task-1', 'scope-v1', 'worker-1', 'HUSTLER']));
  });

  it('rejects scope proposals after completion proof exists', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [version()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [{ id: 'proof-1' }], rowCount: 1 } as never);

    await expect(TaskScopeService.proposeChange({
      taskId: 'task-1',
      userId: 'worker-1',
      observedScopeSummary: 'Late scope drift',
      proposedChecklist: ['Protect the floor', 'Assemble the desk', 'Extra work'],
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('allows only the owning Poster to decide a scope change', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as never);

    await expect(TaskScopeService.reviewChange({
      taskId: 'task-1',
      proposalId: 'proposal-1',
      posterId: 'worker-1',
      decision: 'APPROVED',
      reason: 'Self approval attempt',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mockDb.query).toHaveBeenCalledOnce();
  });

  it('rejects approval of a proposal based on a stale scope version', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task({ active_scope_version_id: 'scope-v2' })], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [proposal()], rowCount: 1 } as never);

    await expect(TaskScopeService.reviewChange({
      taskId: 'task-1',
      proposalId: 'proposal-1',
      posterId: 'poster-1',
      decision: 'APPROVED',
      reason: 'Approve',
    })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('approves a checklist-only change as immutable version 2 without altering money', async () => {
    const approvedVersion = version({
      id: 'scope-v2',
      version: 2,
      scope_hash: 'b'.repeat(64),
      checklist: proposal().proposed_checklist,
      source: 'APPROVED_CHANGE',
    });
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [proposal()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [version()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [approvedVersion], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [proposal({ status: 'APPROVED', approved_version_id: 'scope-v2' })], rowCount: 1 } as never);

    const result = await TaskScopeService.reviewChange({
      taskId: 'task-1',
      proposalId: 'proposal-1',
      posterId: 'poster-1',
      decision: 'APPROVED',
      reason: 'Cable tray is part of the original desk.',
    });

    expect(result).toMatchObject({ version: { id: 'scope-v2', version: 2 } });
    const versionInsert = mockDb.query.mock.calls[4];
    expect(versionInsert[1]).toEqual(expect.arrayContaining([10_000, 7_500, 'scope-v1']));
    const taskUpdate = mockDb.query.mock.calls[5];
    expect(taskUpdate[1]).toEqual(['task-1', 'scope-v2', 'b'.repeat(64)]);
  });

  it('allows only the reserved Hustler on the active working version to complete checklist items', async () => {
    mockDb.query
      .mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      .mockResolvedValueOnce({ rows: [version()], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);

    const result = await TaskScopeService.setChecklistItem({
      taskId: 'task-1',
      workerId: 'worker-1',
      versionId: 'scope-v1',
      itemIndex: 1,
      completed: true,
    });

    expect(result).toEqual({ versionId: 'scope-v1', itemIndex: 1, completed: true });
    const completionSql = String(mockDb.query.mock.calls[3][0]);
    expect(completionSql).toContain('INSERT INTO task_scope_checklist_progress');
    expect(completionSql).toContain('ON CONFLICT (version_id, item_index) DO NOTHING');
    expect(completionSql).not.toContain('completed_at = NOW()');
  });

  it('rejects checklist writes against a stale scope version', async () => {
    mockDb.query.mockResolvedValueOnce({ rows: [task()], rowCount: 1 } as never);

    await expect(TaskScopeService.setChecklistItem({
      taskId: 'task-1',
      workerId: 'worker-1',
      versionId: 'scope-v0',
      itemIndex: 0,
      completed: true,
    })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(mockDb.query).toHaveBeenCalledOnce();
  });
});
