import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CACHE_KEYS, CACHE_TAGS, CACHE_TTL, cachedDbQuery } from '../cache/db-cache.js';
import { db } from '../db.js';
import { TaskService } from '../services/TaskService.js';
import { hustlerProcedure, posterProcedure, protectedProcedure, Schemas } from '../trpc.js';

export const TaskReadProcedures = {
getById: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ input, ctx }) => {
      const task = await cachedDbQuery(
        CACHE_KEYS.taskDetails(input.taskId),
        async () => {
          const result = await TaskService.getById(input.taskId);
          if (!result.success) {
            throw new TRPCError({ code: 'NOT_FOUND', message: result.error.message });
          }
          return result.data;
        },
        { tags: [CACHE_TAGS.TASK(input.taskId)], ttl: CACHE_TTL.taskDetails }
      );

      const isParticipant = task.poster_id === ctx.user.id || task.worker_id === ctx.user.id;
      // Tasks in OPEN/MATCHING state are discoverable (hustler feed)
      const isDiscoverable = ['OPEN', 'MATCHING'].includes(task.state);

      if (!isParticipant && !isDiscoverable) {
        // Last resort: check admin role before throwing.
        // A63-3 FIX: Use the same role allowlist as adminProcedure — a bare
        // SELECT without a role filter would grant admin access to any row in
        // admin_roles regardless of role value, allowing privilege escalation.
        const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'];
        const adminResult = await db.query(
          'SELECT 1 FROM admin_roles WHERE user_id = $1 AND role = ANY($2::text[]) LIMIT 1',
          [ctx.user.id, VALID_ADMIN_ROLES]
        );
        if (adminResult.rows.length === 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
        // Admin: full access
        return task;
      }

      // Strip sensitive identity fields for non-participants browsing the feed
      if (!isParticipant && isDiscoverable) {
        return { ...task, poster_id: undefined, worker_id: undefined };
      }

      return task;
    }),
getState: protectedProcedure
    .input(z.object({ taskId: Schemas.uuid }))
    .query(async ({ input, ctx }) => {
      const result = await db.query<{ state: string; poster_id: string; worker_id: string | null }>(
        `SELECT state, poster_id, worker_id FROM tasks WHERE id = $1`,
        [input.taskId]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }

      const task = result.rows[0];
      const isParticipant = task.poster_id === ctx.user.id || task.worker_id === ctx.user.id;
      if (!isParticipant) {
        // A63-3 FIX: Use role allowlist consistent with adminProcedure.
        const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'];
        const adminResult = await db.query(
          'SELECT 1 FROM admin_roles WHERE user_id = $1 AND role = ANY($2::text[]) LIMIT 1',
          [ctx.user.id, VALID_ADMIN_ROLES]
        );
        if (adminResult.rows.length === 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
      }

      return {
        state: task.state,
      };
    }),
listByPoster: posterProcedure
    .input(
      Schemas.cursorPagination.extend({
        posterId: Schemas.uuid.optional(),
      }).optional()
    )
    .query(async ({ ctx, input }) => {
      const posterId = input?.posterId ?? ctx.user.id;
      if (posterId !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only view your own posted tasks',
        });
      }

      const result = await TaskService.getByPoster(posterId, {
        cursor: input?.cursor ?? null,
        limit: input?.limit ?? 20,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data; // { tasks, nextCursor }
    }),
listByWorker: hustlerProcedure
    .input(
      Schemas.cursorPagination.extend({
        workerId: Schemas.uuid.optional(),
      }).optional()
    )
    .query(async ({ ctx, input }) => {
      const workerId = input?.workerId ?? ctx.user.id;
      if (workerId !== ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'You can only view your own accepted tasks',
        });
      }

      const result = await TaskService.getByWorker(workerId, {
        cursor: input?.cursor ?? null,
        limit: input?.limit ?? 20,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data; // { tasks, nextCursor }
    }),
listOpen: hustlerProcedure
    .input(Schemas.pagination)
    .query(async ({ input }) => {
      const result = await TaskService.listOpen({ limit: input.limit, offset: input.offset });

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data;
    })
};
