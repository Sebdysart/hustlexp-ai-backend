import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { protectedProcedure, router } from '../trpc.js';

const DraftIdSchema = z.object({
  taskDraftId: z.string().uuid(),
});

const QuoteDecisionSchema = z.object({
  taskDraftId: z.string().uuid(),
  quoteId: z.string().uuid(),
});

const AcceptQuoteDecisionSchema =
  QuoteDecisionSchema.extend({
    scheduledServiceDate: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}$/,
        'scheduledServiceDate must be YYYY-MM-DD.',
      ),
  });

export const quoteDecisionRouter = router({
  listForDraft: protectedProcedure
    .input(DraftIdSchema)
    .query(async ({ ctx, input }) => {
      const draft = await db.query<{ id: string }>(
        `
        SELECT id
        FROM task_drafts
        WHERE id = $1
          AND poster_user_id = $2
        LIMIT 1
        `,
        [input.taskDraftId, ctx.user.id],
      );

      if (!draft.rows[0]) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task draft not found.',
        });
      }

      const result = await db.query<{
        quote_id: string;
        quote_version_id: string;
        quote_status: string;
        business_organization_id: string;
        business_name: string;
        customer_description: string;
        total_cents: number;
        arrival_window_start: Date | null;
        arrival_window_end: Date | null;
        expires_at: Date | null;
        created_at: Date;
      }>(
        `
        SELECT
          q.id AS quote_id,
          q.active_version_id AS quote_version_id,
          q.status AS quote_status,
          q.business_organization_id,
          org.display_name AS business_name,
          qv.customer_description,
          qv.total_cents,
          qv.arrival_window_start,
          qv.arrival_window_end,
          qv.expires_at,
          q.created_at
        FROM quotes q
        JOIN quote_versions qv
          ON qv.id = q.active_version_id
         AND qv.quote_id = q.id
        JOIN business_organizations org
          ON org.id = q.business_organization_id
        WHERE q.task_draft_id = $1
        ORDER BY q.created_at ASC
        `,
        [input.taskDraftId],
      );

      return result.rows.map((row) => ({
        quoteId: row.quote_id,
        quoteVersionId: row.quote_version_id,
        status: row.quote_status,
        businessOrganizationId: row.business_organization_id,
        businessName: row.business_name,
        customerDescription: row.customer_description,
        totalCents: Number(row.total_cents),
        arrivalWindowStart:
          row.arrival_window_start?.toISOString() ?? null,
        arrivalWindowEnd:
          row.arrival_window_end?.toISOString() ?? null,
        expiresAt:
          row.expires_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      }));
    }),

  accept: protectedProcedure
    .input(AcceptQuoteDecisionSchema)
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (query) => {
        const draftResult = await query<{
          id: string;
          quote_id: string | null;
          scheduled_service_date:
            | string
            | null;
        }>(
          `
          SELECT
            id,
            quote_id,
            scheduled_service_date::text
              AS scheduled_service_date
          FROM task_drafts
          WHERE id = $1
            AND poster_user_id = $2
          FOR UPDATE
          `,
          [input.taskDraftId, ctx.user.id],
        );

        const draft = draftResult.rows[0];

        if (!draft) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Task draft not found.',
          });
        }
        
        if (draft.quote_id) {
          if (
            draft.quote_id ===
              input.quoteId &&
            draft.scheduled_service_date ===
              input.scheduledServiceDate
          ) {
            return {
              ok: true,
              quoteId:
                input.quoteId,
              replayed: true,
            };
          }

          if (
            draft.quote_id ===
            input.quoteId
          ) {
            throw new TRPCError({
              code: 'CONFLICT',
              message:
                'This quote has already been accepted for a different service date.',
            });
          }

          throw new TRPCError({
            code: 'CONFLICT',
            message:
              'Another quote has already been accepted for this task.',
          });
        }

        const quoteResult = await query<{
          id: string;
          active_version_id: string | null;
          status: string;
          arrival_window_start: Date | null;
          arrival_window_end: Date | null;
        }>(
          `
          SELECT
            q.id,
            q.active_version_id,
            q.status,
            qv.arrival_window_start,
            qv.arrival_window_end
          FROM quotes q
          LEFT JOIN quote_versions qv
            ON qv.id = q.active_version_id
          WHERE q.id = $1
            AND q.task_draft_id = $2
          FOR UPDATE OF q
          `,
          [input.quoteId, input.taskDraftId],
        );

        const quote = quoteResult.rows[0];

        if (!quote) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Quote not found.',
          });
        }

        if (!quote.active_version_id) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Quote has no active version.',
          });
        }

        if (quote.status !== 'submitted') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `Quote cannot be accepted in status ${quote.status}.`,
          });
        }

        if (
          !quote.arrival_window_start ||
          !quote.arrival_window_end
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'Quote does not have an arrival window.',
          });
        }

        const windowResult = await query<{
          start_date: string;
          end_date: string;
        }>(
          `
          SELECT
            ($1::timestamptz AT TIME ZONE 'America/Los_Angeles')::date::text
              AS start_date,
            ($2::timestamptz AT TIME ZONE 'America/Los_Angeles')::date::text
              AS end_date
          `,
          [
            quote.arrival_window_start,
            quote.arrival_window_end,
          ],
        );

        const window =
          windowResult.rows[0];

        const todayResult = await query<{
          today: string;
        }>(
          `
          SELECT
            (NOW() AT TIME ZONE 'America/Los_Angeles')::date::text
              AS today
          `,
        );

        const today =
          todayResult.rows[0]?.today;

        if (
          !today ||
          input.scheduledServiceDate < today
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'Selected service date cannot be in the past.',
          });
        }
        if (
          !window ||
          input.scheduledServiceDate <
            window.start_date ||
          input.scheduledServiceDate >
            window.end_date
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message:
              'Selected service date must fall within the business availability window.',
          });
        }

       
        await query(
          `
          UPDATE quotes
          SET status = 'superseded',
              updated_at = NOW()
          WHERE task_draft_id = $1
            AND id <> $2
            AND status = 'submitted'
          `,
          [input.taskDraftId, input.quoteId],
        );

        await query(
          `
          UPDATE quotes
          SET status = 'quote_send_ready',
              updated_at = NOW()
          WHERE id = $1
          `,
          [input.quoteId],
        );

        await query(
          `
          UPDATE task_drafts
          SET quote_id = $1,
              scheduled_service_date = $2::date,
              quote_send_ready_at = NOW(),
              updated_at = NOW()
          WHERE id = $3
          `,
          [input.quoteId,  input.scheduledServiceDate, input.taskDraftId],
        );

        return {
          ok: true,
          quoteId: input.quoteId,
          quoteVersionId: quote.active_version_id,
          replayed: false,
        };
      });
    }),

  reject: protectedProcedure
    .input(QuoteDecisionSchema)
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (query) => {
        const draft = await query<{ id: string; quote_id: string | null }>(
          `
          SELECT id, quote_id
          FROM task_drafts
          WHERE id = $1
            AND poster_user_id = $2
          FOR UPDATE
          `,
          [input.taskDraftId, ctx.user.id],
        );

        if (!draft.rows[0]) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Task draft not found.',
          });
        }

        if (draft.rows[0].quote_id === input.quoteId) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'An accepted quote cannot be rejected.',
          });
        }

        const updated = await query<{ id: string }>(
          `
          UPDATE quotes
          SET status = 'rejected',
              updated_at = NOW()
          WHERE id = $1
            AND task_draft_id = $2
            AND status = 'submitted'
          RETURNING id
          `,
          [input.quoteId, input.taskDraftId],
        );

        if (!updated.rows[0]) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Quote is not currently rejectable.',
          });
        }

        return {
          ok: true,
          quoteId: input.quoteId,
        };
      });
    }),
});
