import { describe, expect, it, vi } from 'vitest';
import { reserveIndividualTask } from '../../src/services/IndividualTaskReservation';

describe('individual assignment reservation', () => {
  it('serializes on the worker and inserts an active witness in the caller transaction', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'reservation-1' }] });
    await reserveIndividualTask(query, { taskId: 'task-1', workerId: 'worker-1', actorId: 'poster-1' });
    expect(String(query.mock.calls[0][0])).toContain('FOR UPDATE');
    expect(String(query.mock.calls[2][0])).toContain('task_reservations');
    expect(query.mock.calls[2][1]).toEqual(['task-1', 'worker-1', 'poster-1']);
  });

  it('rejects a second active commitment before assignment', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: 'worker-1' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'other-task' }] });
    await expect(reserveIndividualTask(query, {
      taskId: 'task-1', workerId: 'worker-1', actorId: 'poster-1',
    })).rejects.toThrow('already has an active task');
    expect(query).toHaveBeenCalledTimes(2);
  });
});
