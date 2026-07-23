import { db } from '../db.js';
import { taskLogger } from '../logger.js';
import type { ServiceResult, Task } from '../types.js';
import { ErrorCodes } from '../types.js';
import { TaskCompletionService } from './TaskCompletionService.js';
const log = taskLogger.child({ service: 'TaskService' });

export const TaskExecutionService = {
startWork: async (taskId: string, workerId: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        const lock = await query<{
          state: string;
          worker_id: string | null;
          progress_state: string;
          started_at: Date | null;
          active_reservation: boolean;
        }>(
          `SELECT t.state, t.worker_id, t.progress_state, t.started_at,
                  EXISTS (
                    SELECT 1 FROM task_reservations r
                    WHERE r.task_id = t.id AND r.hustler_id = $2 AND r.status = 'ACTIVE'
                  ) AS active_reservation
           FROM tasks t
           WHERE t.id = $1
           FOR UPDATE OF t`,
          [taskId, workerId]
        );
        const task = lock.rows[0];
        if (!task) return { success: false, error: { code: ErrorCodes.NOT_FOUND, message: `Task ${taskId} not found` } };
        if (task.worker_id !== workerId) {
          return { success: false, error: { code: ErrorCodes.FORBIDDEN, message: 'Only the engine-reserved hustler can start this task' } };
        }
        if (task.started_at && task.progress_state === 'WORKING') {
          const existing = await query<Task>('SELECT * FROM tasks WHERE id = $1', [taskId]);
          return { success: true, data: existing.rows[0] };
        }
        if (task.state !== 'ACCEPTED' || !task.active_reservation) {
          return {
            success: false,
            error: { code: ErrorCodes.INVALID_STATE, message: 'Task must have an active engine reservation before work starts' },
          };
        }

        const update = await query<Task>(
          `UPDATE tasks
           SET progress_state = 'WORKING',
               progress_updated_at = NOW(),
               progress_by = $2,
               started_at = COALESCE(started_at, NOW()),
               updated_at = NOW()
           WHERE id = $1 AND state = 'ACCEPTED' AND worker_id = $2
           RETURNING *`,
          [taskId, workerId]
        );
        if ((update.rowCount ?? 0) === 0) {
          return { success: false, error: { code: ErrorCodes.INVALID_STATE, message: 'Task changed before start could be committed' } };
        }
        await query(
          `INSERT INTO engine_automation_events (task_id, event_type, idempotency_key, payload)
           VALUES ($1, 'TASK_IN_PROGRESS', $2, $3::jsonb)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [taskId, `task-started:${taskId}`, JSON.stringify({ workerId })]
        );
        return { success: true, data: update.rows[0] };
      });
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Task start failed');
      return { success: false, error: { code: 'DB_ERROR', message: 'A database error occurred. Please try again.' } };
    }
  },
submitProof: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        // Acquire row-level lock before reading state
        const lockResult = await query<{ state: string; started_at: Date | null; progress_state: string }>(
          `SELECT state, started_at, progress_state FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }

        const currentState = lockResult.rows[0].state;

        // Idempotent recovery: if the task is already in PROOF_SUBMITTED, the proof INSERT
        // already committed (ProofService.submit ran) but the task UPDATE failed or timed out.
        // Treat this as success — return the current task so the router can respond correctly.
        if (currentState === 'PROOF_SUBMITTED') {
          const existingTask = await query<Task>(
            `SELECT * FROM tasks WHERE id = $1`,
            [taskId]
          );
          return { success: true, data: existingTask.rows[0] };
        }

        if (currentState !== 'ACCEPTED') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot submit proof: current state is ${currentState}, expected ACCEPTED`,
            },
          };
        }

        if (!lockResult.rows[0].started_at || lockResult.rows[0].progress_state !== 'WORKING') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: 'Cannot submit proof before the reserved task is in progress',
            },
          };
        }

        const result = await query<Task>(
          `UPDATE tasks
           SET state = 'PROOF_SUBMITTED',
               proof_submitted_at = NOW()
           WHERE id = $1
             AND state = 'ACCEPTED'
           RETURNING *`,
          [taskId]
        );

        if (result.rowCount === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot submit proof: state changed unexpectedly`,
            },
          };
        }

        return { success: true, data: result.rows[0] };
      });
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'TaskService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
rejectProof: async (taskId: string, _reason: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        // Acquire row-level lock before reading state
        const lockResult = await query<{ state: string }>(
          `SELECT state FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }

        const currentState = lockResult.rows[0].state;

        if (currentState !== 'PROOF_SUBMITTED') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot reject proof: current state is ${currentState}, expected PROOF_SUBMITTED`,
            },
          };
        }

        // Note: In a full implementation, we'd update the proof record too
        const result = await query<Task>(
          `UPDATE tasks
           SET state = 'ACCEPTED',
               proof_submitted_at = NULL
           WHERE id = $1
             AND state = 'PROOF_SUBMITTED'
           RETURNING *`,
          [taskId]
        );

        if (result.rowCount === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot reject proof: state changed unexpectedly`,
            },
          };
        }

        return { success: true, data: result.rows[0] };
      });
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'TaskService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
openDispute: async (taskId: string): Promise<ServiceResult<Task>> => {
    try {
      return await db.transaction(async (query) => {
        // Acquire row-level lock before reading state
        const lockResult = await query<{ state: string }>(
          `SELECT state FROM tasks WHERE id = $1 FOR UPDATE`,
          [taskId]
        );

        if (lockResult.rows.length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.NOT_FOUND,
              message: `Task ${taskId} not found`,
            },
          };
        }

        const currentState = lockResult.rows[0].state;

        if (currentState !== 'PROOF_SUBMITTED') {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot open dispute: current state is ${currentState}, expected PROOF_SUBMITTED`,
            },
          };
        }

        const result = await query<Task>(
          `UPDATE tasks
           SET state = 'DISPUTED'
           WHERE id = $1
             AND state = 'PROOF_SUBMITTED'
           RETURNING *`,
          [taskId]
        );

        if (result.rowCount === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_STATE,
              message: `Cannot open dispute: state changed unexpectedly`,
            },
          };
        }

        return { success: true, data: result.rows[0] };
      });
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'TaskService DB error');
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: 'A database error occurred. Please try again.',
        },
      };
    }
  },
complete: TaskCompletionService.complete,
recordCompletionDelivery: TaskCompletionService.recordDelivery
};
