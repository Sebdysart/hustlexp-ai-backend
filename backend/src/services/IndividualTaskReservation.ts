import { TRPCError } from '@trpc/server';
import type { QueryFn } from '../db.js';

/** Call after locking the task, inside the same assignment transaction. */
export async function reserveIndividualTask(
  query: QueryFn,
  input: { taskId: string; workerId: string; actorId: string },
): Promise<void> {
  // Every supported reservation writer locks the worker row after the task.
  // This serializes commitments to distinct tasks for the same worker.
  const worker = await query<{ id: string }>('SELECT id FROM users WHERE id=$1 FOR UPDATE', [input.workerId]);
  if (!worker.rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Worker not found' });
  const committed = await query<{ id: string }>(
    `SELECT id FROM tasks WHERE worker_id=$1 AND id<>$2
       AND state IN ('ACCEPTED','PROOF_SUBMITTED','DISPUTED') LIMIT 1`,
    [input.workerId, input.taskId],
  );
  if (committed.rows[0]) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Worker already has an active task' });
  }
  const reservation = await query<{ id: string }>(
    `INSERT INTO task_reservations(task_id,hustler_id,status,reserved_by)
     VALUES ($1,$2,'ACTIVE',$3) ON CONFLICT (task_id) DO NOTHING RETURNING id`,
    [input.taskId, input.workerId, input.actorId],
  );
  if (!reservation.rows[0]) {
    throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Task reservation already exists' });
  }
}
