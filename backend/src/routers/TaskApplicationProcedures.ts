import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { invalidateTask } from '../cache/db-cache.js';
import { db } from '../db.js';
import { notifyApplicationReceived } from '../lib/task-lifecycle-notifications.js';
import { TaskService } from '../services/TaskService.js';
import { hustlerProcedure, posterProcedure, Schemas } from '../trpc.js';
import { ErrorCodes } from '../types.js';

export const TaskApplicationProcedures = {
applyForTask: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      message: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      // T60-2 FIX: Wrap the state check and INSERT in a single transaction with a
      // SELECT FOR UPDATE on the task row. Without this, a concurrent assignWorker
      // can transition the task from OPEN to ACCEPTED between the plain SELECT and
      // the INSERT, producing orphaned application rows for a no-longer-open task.
      // The FOR UPDATE lock serializes concurrent callers: the second caller blocks
      // until the first transaction commits, then sees the updated task state.
      const appRow = await db.transaction(async (query) => {
        const taskResult = await query<{ state: string; poster_id: string; trust_tier_required: number | null; title: string }>(
          `SELECT state, poster_id, trust_tier_required, title FROM tasks WHERE id = $1 FOR UPDATE`,
          [input.taskId]
        );
        if (taskResult.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
        }
        const task = taskResult.rows[0];
        if (task.state !== 'OPEN') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `Task must be in OPEN state to apply, current: ${task.state}`,
          });
        }
        if (task.poster_id === ctx.user.id) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Cannot apply for your own task' });
        }
        if (task.trust_tier_required !== null && ctx.user.trust_tier < task.trust_tier_required) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Your trust tier is insufficient for this task' });
        }

        // Use ON CONFLICT DO NOTHING against the partial unique index
        // (idx_task_app_active_per_hustler covers status NOT IN rejected/counter_rejected/withdrawn/expired)
        // to make the duplicate check and insert atomic, eliminating the TOCTOU race.
        const result = await query(
          `INSERT INTO task_applications (id, task_id, hustler_id, message, status, counter_offer_round, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'pending', 0, NOW(), NOW())
           ON CONFLICT (task_id, hustler_id) WHERE status NOT IN ('rejected', 'counter_rejected', 'withdrawn', 'expired') DO NOTHING
           RETURNING *`,
          [input.taskId, ctx.user.id, input.message || null]
        );
        if ((result.rowCount ?? 0) === 0) {
          throw new TRPCError({ code: 'CONFLICT', message: 'You already have an active application for this task' });
        }
        return { app: result.rows[0], posterId: task.poster_id, taskTitle: task.title };
      });

      // Lifecycle notification (post-commit, fire-and-forget — never blocks the response)
      await notifyApplicationReceived(appRow.posterId, input.taskId, appRow.taskTitle);

      return {
        id: appRow.app.id,
        taskId: appRow.app.task_id,
        status: appRow.app.status,
        message: appRow.app.message,
        appliedAt: appRow.app.created_at,
      };
    }),
listApplicants: posterProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ ctx, input }) => {
      const taskResult = await db.query(
        `SELECT poster_id FROM tasks WHERE id = $1`,
        [input.taskId]
      );
      if (taskResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }
      if (taskResult.rows[0].poster_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the task poster can view applicants' });
      }

      const result = await db.query(
        `SELECT
           ta.id,
           ta.hustler_id AS user_id,
           COALESCE(u.full_name, 'Unknown') AS name,
           COALESCE(r.rating, 5.0) AS rating,
           COALESCE(ct.completed_tasks, 0) AS completed_tasks,
           COALESCE(u.trust_tier, 1) AS tier,
           ta.created_at AS applied_at,
           ta.message
         FROM task_applications ta
         LEFT JOIN users u ON u.id = ta.hustler_id
         LEFT JOIN LATERAL (
           SELECT COALESCE(AVG(stars), 5.0) AS rating
           FROM task_ratings WHERE ratee_id = u.id
         ) r ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS completed_tasks
           FROM tasks WHERE worker_id = u.id AND state = 'COMPLETED'
         ) ct ON true
         WHERE ta.task_id = $1 AND ta.status = 'pending'
         ORDER BY ta.created_at ASC
         LIMIT $2 OFFSET $3`,
        [input.taskId, input.limit, input.offset]
      );

      return result.rows;
    }),
workerCancel: hustlerProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      reason: z.string().trim().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.workerAbandon(input.taskId, ctx.user.id, input.reason);

      if (!result.success) {
        const errCode = result.error.code;
        let code: 'NOT_FOUND' | 'FORBIDDEN' | 'PRECONDITION_FAILED' | 'BAD_REQUEST';
        if (errCode === ErrorCodes.NOT_FOUND) {
          code = 'NOT_FOUND';
        } else if (errCode === ErrorCodes.FORBIDDEN) {
          code = 'FORBIDDEN';
        } else if (errCode === ErrorCodes.INVALID_STATE) {
          code = 'PRECONDITION_FAILED';
        } else {
          code = 'BAD_REQUEST';
        }
        throw new TRPCError({ code, message: result.error.message });
      }

      await invalidateTask(input.taskId);
      return result.data;
    })
};
