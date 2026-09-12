import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CACHE_KEYS, CACHE_TAGS, CACHE_TTL, cachedDbQuery } from '../cache/db-cache.js';
import { db } from '../db.js';
import { TaskService } from '../services/TaskService.js';
import { getTaskFactsForDisplay } from '../services/taskIntake/getTaskFactsForDisplay.js';
import { hustlerProcedure, posterProcedure, protectedProcedure, Schemas } from '../trpc.js';

type TaskViewerRole =
  | 'poster'
  | 'hustler'
  | 'business'
  | null;

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
      const businessMembership =
        task.business_fulfiller_organization_id
          ? await db.query<{ id: string }>(
              `
              SELECT id
              FROM business_memberships
              WHERE organization_id = $1
                AND user_id = $2
                AND status = 'ACTIVE'
                AND role = 'OWNER'
              LIMIT 1
              `,
              [
                task.business_fulfiller_organization_id,
                ctx.user.id,
              ],
            )
          : { rows: [] as Array<{ id: string }> };

      const isBusinessFulfiller = Boolean(businessMembership.rows[0]);
      const viewerRole: TaskViewerRole =
        task.poster_id === ctx.user.id
          ? 'poster'
          : task.worker_id === ctx.user.id
            ? 'hustler'
            : isBusinessFulfiller
              ? 'business'
              : null;
      const isParticipant = viewerRole !== null;
      // Tasks in OPEN/MATCHING state are discoverable (hustler feed)
      const isDiscoverable = ['OPEN', 'MATCHING'].includes(task.state);
      const shortlist = isDiscoverable
        ? await db.query<{ worker_id: string }>(
          `SELECT worker_id FROM task_quote_shortlists
            WHERE task_id=$1 AND status='ACTIVE' LIMIT 1`,
          [input.taskId],
        )
        : { rows: [] as Array<{ worker_id: string }> };
      const quoteWorkerId = shortlist.rows[0]?.worker_id ?? null;
      const quoteChatRole = task.poster_id === ctx.user.id
        ? (quoteWorkerId ? 'poster' as const : null)
        : quoteWorkerId === ctx.user.id
          ? 'hustler' as const
          : null;

      if (!isParticipant && !isDiscoverable) {
        // Last resort: check admin role before throwing.
        // A63-3 FIX: Use consequence-scoped Operations capabilities — a bare
        // SELECT without a role filter would grant admin access to any row in
        // admin_roles regardless of role value, allowing privilege escalation.
        const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'];
        const adminResult = await db.query(
          `SELECT 1 FROM admin_roles
           WHERE user_id = $1
             AND role = ANY($2::text[])
             AND (
               role IN ('admin', 'founder')
               OR COALESCE(can_resolve_disputes, false)
               OR COALESCE(can_manage_incidents, false)
             )
           LIMIT 1`,
          [ctx.user.id, VALID_ADMIN_ROLES]
        );
        if (adminResult.rows.length === 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Access denied' });
        }
        // Admin: full access
        const adminRaw = await db.query<{ raw_input: string | null; category: string | null; structured: unknown }>(
          'SELECT raw_input, category, structured FROM task_drafts WHERE task_id = $1 LIMIT 1',
          [input.taskId],
        );
        return { ...task, viewer_role: 'admin' as const, taskFacts: getTaskFactsForDisplay({ rawInput: adminRaw.rows[0]?.raw_input, category: adminRaw.rows[0]?.category ?? undefined, structured: adminRaw.rows[0]?.structured }) };
      }

      // Strip sensitive identity fields for non-participants browsing the feed
      if (!isParticipant && isDiscoverable) {
        return {
          ...task,
          poster_id: undefined,
          worker_id: undefined,
          viewer_role: 'observer' as const,
          quote_chat_role: quoteChatRole,
          quote_shortlisted_worker_id: quoteChatRole ? quoteWorkerId : null,
        };
      }

      const participantDetailResult = await db.query<{
        originating_draft_id: string | null;
        request_scope_summary: string | null;
        request_raw_input: string | null;
        request_category: string | null;
        request_structured: unknown;
        request_zip: string | null;
        request_region: string | null;
        accepted_quote_id: string | null;
        accepted_quote_status: string | null;
        accepted_quote_total_cents: number | null;
        accepted_quote_provider_payout_cents: number | null;
        accepted_quote_description: string | null;
        accepted_quote_arrival_window_start: Date | null;
        accepted_quote_arrival_window_end: Date | null;
        accepted_business_name: string | null;
        poster_name: string | null;
      }>(
        `SELECT
          draft.id AS originating_draft_id,
          draft.scope_summary AS request_scope_summary,
          draft.raw_input AS request_raw_input,
          draft.category AS request_category,
          draft.structured AS request_structured,
          draft.zip AS request_zip,
          draft.region AS request_region,
          quote.id AS accepted_quote_id,
          quote.status AS accepted_quote_status,
          quote_version.total_cents AS accepted_quote_total_cents,
          quote_version.hustler_payout_cents AS accepted_quote_provider_payout_cents,
          quote_version.customer_description AS accepted_quote_description,
          quote_version.arrival_window_start AS accepted_quote_arrival_window_start,
          quote_version.arrival_window_end AS accepted_quote_arrival_window_end,
          business.display_name AS accepted_business_name,
          poster.full_name AS poster_name
        FROM tasks task
        LEFT JOIN task_drafts draft ON draft.task_id = task.id
        LEFT JOIN quotes quote ON quote.id = draft.quote_id
        LEFT JOIN quote_versions quote_version
          ON quote_version.id = quote.active_version_id
        LEFT JOIN business_organizations business
          ON business.id = quote.business_organization_id
        LEFT JOIN users poster ON poster.id = task.poster_id
        WHERE task.id = $1
        LIMIT 1`,
        [input.taskId],
      );

      const participantDetail = participantDetailResult.rows[0] ?? null;

      return {
        ...task,
        taskFacts: getTaskFactsForDisplay({ rawInput: participantDetail?.request_raw_input, category: participantDetail?.request_category ?? undefined, structured: participantDetail?.request_structured }),
        viewer_role: viewerRole,
        quote_chat_role: quoteChatRole,
        quote_shortlisted_worker_id: quoteChatRole ? quoteWorkerId : null,
        originating_draft_id: participantDetail?.originating_draft_id ?? null,
        request_scope_summary: participantDetail?.request_scope_summary ?? null,
        request_raw_input: participantDetail?.request_raw_input ?? null,
        request_zip: participantDetail?.request_zip ?? null,
        request_region: participantDetail?.request_region ?? null,
        accepted_quote_id: participantDetail?.accepted_quote_id ?? null,
        accepted_quote_status: participantDetail?.accepted_quote_status ?? null,
        accepted_quote_total_cents: participantDetail?.accepted_quote_total_cents ?? null,
        accepted_quote_description: participantDetail?.accepted_quote_description ?? null,
        accepted_quote_arrival_window_start: participantDetail?.accepted_quote_arrival_window_start ?? null,
        accepted_quote_arrival_window_end: participantDetail?.accepted_quote_arrival_window_end ?? null,
        accepted_business_name: participantDetail?.accepted_business_name ?? null,
        poster_name: viewerRole === 'business' || viewerRole === 'hustler' ? participantDetail?.poster_name ?? null : undefined,
        accepted_quote_provider_payout_cents: viewerRole === 'business' || viewerRole === 'hustler' ? participantDetail?.accepted_quote_provider_payout_cents ?? null : undefined,
      };
    }),
getDraftById: posterProcedure
  .input(
    z.object({
      draftId: Schemas.uuid,
    }),
  )
  .query(async ({ ctx, input }) => {
    const result = await db.query(
      `SELECT *
         FROM task_drafts
        WHERE id = $1
          AND poster_user_id = $2
        LIMIT 1`,
      [input.draftId, ctx.user.id],
    );

    if (result.rows.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Task request not found',
      });
    }

    const draft = result.rows[0];
    return {
      ...draft,
      taskFacts: getTaskFactsForDisplay({ rawInput: draft.raw_input, category: draft.category, structured: draft.structured }),
    };
  }),
getQuoteVersionByQuoteId: posterProcedure
  .input(
    z.object({
      quoteId: Schemas.uuid,
    }),
  )
  .query(async ({ ctx, input }) => {
    const result = await db.query(
      `SELECT
         qv.total_cents,
         qv.id,
         qv.quote_id,
         qv.status
       FROM quote_versions qv
       JOIN task_drafts td
         ON td.quote_id = qv.quote_id
       WHERE qv.quote_id = $1
         AND td.poster_user_id = $2
       ORDER BY
         qv.expires_at DESC NULLS LAST,
         qv.updated_at DESC
       LIMIT 1`,
      [input.quoteId, ctx.user.id],
    );

    if (result.rows.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Quote version not found',
      });
    }

    return result.rows[0];
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
        // A63-3 FIX: Use consequence-scoped Operations capabilities.
        const VALID_ADMIN_ROLES = ['admin', 'support', 'finance', 'moderator', 'founder'];
        const adminResult = await db.query(
          `SELECT 1 FROM admin_roles
           WHERE user_id = $1
             AND role = ANY($2::text[])
             AND (
               role IN ('admin', 'founder')
               OR COALESCE(can_resolve_disputes, false)
               OR COALESCE(can_manage_incidents, false)
             )
           LIMIT 1`,
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
listDraftsByPoster: posterProcedure
  .input(
    Schemas.cursorPagination.optional()
  )
  .query(async ({ ctx, input }) => {
    const result = await db.query(
      `SELECT
         id,
         title,
         category,
         created_at,
         updated_at,
         quote_id
       FROM task_drafts
       WHERE poster_user_id = $1
         AND task_id IS NULL
       ORDER BY created_at DESC
       LIMIT $2`,
      [
        ctx.user.id,
        input?.limit ?? 20,
      ],
    );

    return {
      drafts: result.rows,
      nextCursor: null,
    };
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
