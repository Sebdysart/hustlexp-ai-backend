import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/db', () => ({ db: { query: vi.fn() } }));
vi.mock('../../src/services/TaskCompletionService', () => ({
  TaskCompletionService: { complete: vi.fn() },
}));

import { db } from '../../src/db';
import { TaskCompletionService } from '../../src/services/TaskCompletionService';
import { UnattendedCompletionSweepService } from '../../src/services/UnattendedCompletionSweepService';

const query = vi.mocked(db.query);
const complete = vi.mocked(TaskCompletionService.complete);

beforeEach(() => vi.clearAllMocks());

describe('UnattendedCompletionSweepService', () => {
  it('selects only policy-due, accepted-proof, funded, undisputed tasks with a bounded batch', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);

    await expect(UnattendedCompletionSweepService.completeDue(10_000)).resolves.toMatchObject({
      inspected: 0, completed: 0, blocked: 0,
    });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain("t.state = 'PROOF_SUBMITTED'");
    expect(sql).toContain("INTERVAL '24 hours'");
    expect(sql).toContain('t.price <= 50000');
    expect(sql).toContain("p.state FROM proofs");
    expect(sql).toContain("e.state = 'FUNDED'");
    expect(sql).toContain("d.state IN ('OPEN', 'EVIDENCE_REQUESTED', 'ESCALATED')");
    expect(params).toEqual([100]);
  });

  it('completes each due task with a deterministic idempotency key', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'task-a' }, { id: 'task-b' }], rowCount: 2 } as never);
    complete.mockResolvedValue({ success: true, data: { id: 'task-a' } } as never);

    await expect(UnattendedCompletionSweepService.completeDue(50)).resolves.toMatchObject({
      inspected: 2, completed: 2, blocked: 0,
    });
    expect(complete).toHaveBeenNthCalledWith(1, 'task-a', undefined, {
      mode: 'UNATTENDED', idempotencyKey: 'unattended-complete:task-a',
    });
    expect(complete).toHaveBeenNthCalledWith(2, 'task-b', undefined, {
      mode: 'UNATTENDED', idempotencyKey: 'unattended-complete:task-b',
    });
  });

  it('records policy races as blocked and retries infrastructure failures', async () => {
    query.mockResolvedValueOnce({ rows: [{ id: 'task-race' }], rowCount: 1 } as never);
    complete.mockResolvedValueOnce({
      success: false, error: { code: 'INVALID_STATE', message: 'changed' },
    });
    await expect(UnattendedCompletionSweepService.completeDue()).resolves.toMatchObject({
      inspected: 1, completed: 0, blocked: 1,
      results: [{ taskId: 'task-race', status: 'blocked', code: 'INVALID_STATE' }],
    });

    vi.clearAllMocks();
    query.mockResolvedValueOnce({ rows: [{ id: 'task-db' }], rowCount: 1 } as never);
    complete.mockResolvedValueOnce({
      success: false, error: { code: 'DB_ERROR', message: 'down' },
    });
    await expect(UnattendedCompletionSweepService.completeDue()).rejects.toThrow('DB_ERROR');
  });
});
