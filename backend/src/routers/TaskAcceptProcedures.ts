import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { invalidateTask } from '../cache/db-cache.js';
import { db } from '../db.js';
import { notifyTaskAccepted } from '../lib/task-lifecycle-notifications.js';
import { TaskService } from '../services/TaskService.js';
import { getManifest, getTemplate } from '../services/TaskTemplateRegistry.js';
import { hustlerProcedure, protectedProcedure, publicProcedure, Schemas } from '../trpc.js';

export const TaskAcceptProcedures = {
acceptWithConsent: hustlerProcedure
    .input(Schemas.acceptWithConsent)
    .mutation(async ({ ctx, input }) => {
      // MM6 FIX: All reads (template_slug, poster_id) moved INSIDE the transaction,
      // AFTER the SELECT FOR UPDATE lock, to eliminate the TOCTOU window where a
      // concurrent actor could change poster_id or template_slug between the pre-lock
      // read and the locked update.
      await db.transaction(async (query) => {
        // FOR UPDATE acquires a row-level lock held until COMMIT.
        // Fetch template_slug and poster_id from the locked row — values are
        // authoritative because no other writer can modify this row until we commit.
        const lockResult = await query<{ state: string; template_slug: string; poster_id: string }>(
          `SELECT state, template_slug, poster_id FROM tasks WHERE id = $1 FOR UPDATE`,
          [input.taskId]
        );
        // BUG 6 FIX: Collapse NOT_FOUND and self-dealing (poster == caller) into a
        // single NOT_FOUND response. Returning FORBIDDEN for poster-own tasks leaks
        // task existence to callers who are also posters (UUID enumeration vector).
        // This matches the assignWorker pattern fixed the same way.
        if (!lockResult.rows[0] || lockResult.rows[0].poster_id === ctx.user.id) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found or unavailable' });
        }

        const template = getTemplate(lockResult.rows[0].template_slug) ?? (() => {
          throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Unknown template on task' });
        })();
        if (!template.requiresMutualConsent) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'This template does not require consent checklist',
          });
        }

        if (lockResult.rows[0].state !== 'OPEN') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Task is no longer available for claiming',
          });
        }

        // T63-4: Enforce application workflow — hustler must have a pending
        // application before they can claim a task via mutual consent.
        const appResult = await query<{ id: string }>(
          `SELECT id FROM task_applications WHERE task_id = $1 AND hustler_id = $2 AND status = 'pending'`,
          [input.taskId, ctx.user.id]
        );
        if (!appResult.rows[0]) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'You must apply for this task before accepting it',
          });
        }

        const updateResult = await query(
          `UPDATE tasks
           SET mutual_consent_accepted = TRUE,
               worker_id = $2,
               state = 'ACCEPTED',
               accepted_at = NOW()
           WHERE id = $1 AND state = 'OPEN'`,
          [input.taskId, ctx.user.id]
        );

        if ((updateResult.rowCount ?? 0) === 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Task is no longer available for claiming',
          });
        }
      });

      return { accepted: true };
    }),
getTemplateManifest: publicProcedure
    .query(async () => {
      return getManifest();
    }),
getComplianceStatus: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const result = await db.query<{
        poster_id: string;
        worker_id: string | null;
        illegal_risk_score: number;
        compliance_guardian_notes: object;
      }>(
        `SELECT poster_id, worker_id, illegal_risk_score, compliance_guardian_notes FROM tasks WHERE id = $1`,
        [input.taskId]
      );

      if (!result.rows[0]) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      const task = result.rows[0];
      if (task.poster_id !== ctx.user.id && task.worker_id !== ctx.user.id && !ctx.user.is_admin) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'You do not have access to this task\'s compliance data' });
      }

      return {
        score: task.illegal_risk_score,
        notes: task.compliance_guardian_notes,
      };
    }),
accept: hustlerProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.accept({
        taskId: input.taskId,
        workerId: ctx.user.id,
      });

      if (!result.success) {
        const code = result.error.code === 'HX002' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      await invalidateTask(input.taskId);

      // Lifecycle notification (post-commit): instant-accept → tell the poster
      const acceptedTask = result.data as { poster_id?: string | null; title?: string | null };
      if (acceptedTask.poster_id) {
        await notifyTaskAccepted(acceptedTask.poster_id, input.taskId, acceptedTask.title ?? 'your task');
      }

      return result.data;
    })
};
