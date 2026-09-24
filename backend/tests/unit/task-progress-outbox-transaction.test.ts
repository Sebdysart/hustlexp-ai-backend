import { describe, expect, it, vi } from 'vitest';

const { transaction, writeToOutbox } = vi.hoisted(() => ({ transaction: vi.fn(), writeToOutbox: vi.fn() }));
vi.mock('../../src/db', () => ({ db: { transaction } }));
vi.mock('../../src/lib/outbox-helpers', () => ({ writeToOutbox }));
import { TaskProgressService } from '../../src/services/TaskProgressService';

describe('task progress durability', () => {
  it('writes the lifecycle outbox intent on the same transaction query before commit', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF t')) return { rows: [{
        id: 'task-1', progress_state: 'POSTED', worker_id: 'worker-1', state: 'ACCEPTED', scope_change_pending: false,
      }] };
      if (sql.includes('COUNT(*)')) return { rows: [{ count: '0' }] };
      if (sql.includes('FROM escrows')) return { rows: [{ state: 'FUNDED' }] };
      if (sql.includes('UPDATE tasks')) return { rows: [{ id: 'task-1', progress_updated_at: new Date() }] };
      return { rows: [] };
    });
    transaction.mockImplementation(async (callback) => {
      const result = await callback(query);
      expect(writeToOutbox).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'task.progress_updated', aggregateId: 'task-1',
      }), query);
      return result;
    });
    writeToOutbox.mockResolvedValue({ id: 'event-1' });
    await expect(TaskProgressService.advanceProgress({
      taskId: 'task-1', to: 'ACCEPTED', actor: { type: 'system' },
    })).resolves.toMatchObject({ success: true });
  });
});
