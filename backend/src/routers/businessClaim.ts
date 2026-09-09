// backend/src/routers/businessClaim.ts
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router, publicProcedure } from '../trpc.js';
import { claimBusinessTask } from '../services/BusinessClaimService.js';
import { requestBusinessAssessment } from '../services/BusinessAssessmentService.js';
import { createHash } from 'node:crypto';
import { db } from '../db.js';
import {
  computePreferredArrivalWindow,
} from '../services/QuoteTiming.js';

export const businessClaimRouter = router({
  preview: publicProcedure
    .input(
      z.object({
        token: z.string().regex(/^[0-9a-f]{64}$/i),
      }).strict(),
    )
    .query(async ({ input }) => {
      const tokenHash = createHash('sha256')
        .update(input.token)
        .digest('hex');

      const result = await db.query<{
        task_draft_id: string;
        status: string;
        expires_at: Date;

        title: string | null;
        category: string;
        scope_summary: string | null;
        zip: string | null;
        region: string | null;

        est_price_min_cents: number | null;
        est_price_max_cents: number | null;

        quote_id: string | null;
        structured: unknown;
      }>(
        `
        SELECT
          link.task_draft_id,
          link.status,
          link.expires_at,

          draft.title,
          draft.category,
          draft.scope_summary,
          draft.zip,
          draft.region,
          draft.structured,


          draft.est_price_min_cents,
          draft.est_price_max_cents,

          draft.quote_id

        FROM ops_business_claim_links link

        JOIN task_drafts draft
          ON draft.id = link.task_draft_id

        WHERE link.token_hash = $1

        LIMIT 1
        `,
        [tokenHash],
      );

      const row = result.rows[0];

      if (
        !row ||
        row.status !== 'OPEN' ||
        row.expires_at <= new Date() ||
        row.quote_id
      ) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'This claim link is no longer available.',
        });
      }
      const structured =
        row.structured;

      const answers =
        structured &&
        typeof structured === 'object' &&
        !Array.isArray(structured) &&
        'answers' in structured &&
        structured.answers &&
        typeof structured.answers === 'object' &&
        !Array.isArray(structured.answers)
          ? structured.answers as Record<string, unknown>
          : {};

      const preferredWindow =
        String(
          answers.preferred_window ??
            'flexible',
        );
      const customerWindow =
        computePreferredArrivalWindow(
          preferredWindow,
        );

      return {
        taskDraftId: row.task_draft_id,

        title: row.title,
        category: row.category,
        scopeSummary: row.scope_summary,

        zip: row.zip,
        region: row.region,

        estimatedMinimumCents:
          row.est_price_min_cents,

        estimatedMaximumCents:
          row.est_price_max_cents,

        expiresAt:
          row.expires_at.toISOString(),
        preferredWindow,

        preferredArrivalWindowStart:
          customerWindow.arrivalStart.toISOString(),

        preferredArrivalWindowEnd:
          customerWindow.arrivalEnd.toISOString(),
      };
    }),

  requestAssessment: protectedProcedure
    .input(
      z.object({
        token: z.string(),
        organizationId: z.string().uuid(),
        businessMessage: z.string().trim().min(1).max(4000),
        proposedWindowStart: z.string(),
        proposedWindowEnd: z.string(),
      }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await requestBusinessAssessment({
        ...input,
        actorId: ctx.user.id,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: result.error.message,
        });
      }

      return result.data;
    }),

listClaimedDrafts: protectedProcedure
  .input(
    z.object({
      organizationId: z.string().uuid(),
    }).strict(),
  )
  .query(async ({ ctx, input }) => {
    await db.query(
      `SELECT business_require_action($1, $2, 'READ_WORKSPACE')`,
      [input.organizationId, ctx.user.id],
    );

    const result = await db.query<{
      task_draft_id: string;
      title: string | null;
      category: string;
      scope_summary: string | null;
      raw_input: string | null;
      customer_name: string | null;
      zip: string | null;
      region: string | null;

      quote_id: string | null;
      quote_version_id: string | null;
      quote_status: string | null;
      customer_description: string | null;
      arrival_window_start: Date | null;
      arrival_window_end: Date | null;
      quote_expires_at: Date | null;

      customer_total_cents: number | null;
      payout_cents: number | null;

      claim_status: string;
      draft_status: string;

      claimed_at: Date | null;
      created_at: Date;

      task_id: string | null;
      scheduled_service_date: string | null;
    }>(
      `
      SELECT
        draft.id AS task_draft_id,
        draft.title,
        draft.category,
        draft.scope_summary,
        draft.raw_input,
        poster.full_name AS customer_name,
        draft.zip,
        draft.region,

        link.quote_id,
        quote.active_version_id AS quote_version_id,
        quote.status AS quote_status,
        quote_version.customer_description,
        quote_version.arrival_window_start,
        quote_version.arrival_window_end,
        quote_version.expires_at AS quote_expires_at,

        link.proposed_customer_total_cents AS customer_total_cents,
        link.proposed_payout_cents AS payout_cents,

        link.status AS claim_status,
        draft.status AS draft_status,

        link.claimed_at,
        draft.created_at,

        draft.task_id,

        COALESCE(
          task.scheduled_service_date,
          draft.scheduled_service_date
        )::text AS scheduled_service_date

      FROM ops_business_claim_links link

      JOIN task_drafts draft
        ON draft.id = link.task_draft_id

      LEFT JOIN quotes quote
        ON quote.id = link.quote_id

      LEFT JOIN quote_versions quote_version
        ON quote_version.id = quote.active_version_id

      LEFT JOIN users poster
        ON poster.id = draft.poster_user_id

      LEFT JOIN tasks task
        ON task.id = draft.task_id

      WHERE link.claimed_by_organization_id = $1
        AND link.status = 'CLAIMED'

      ORDER BY
        link.claimed_at DESC NULLS LAST,
        draft.created_at DESC
      `,
      [input.organizationId],
    );

    return result.rows.map((row) => ({
      taskDraftId: row.task_draft_id,

      title: row.title,
      category: row.category,
      scopeSummary: row.scope_summary,
      rawInput: row.raw_input,
      customerName: row.customer_name,
      customerDescription: row.customer_description,
      arrivalWindowStart: row.arrival_window_start?.toISOString() ?? null,
      arrivalWindowEnd: row.arrival_window_end?.toISOString() ?? null,
      quoteExpiresAt: row.quote_expires_at?.toISOString() ?? null,

      zip: row.zip,
      region: row.region,

      quoteId: row.quote_id,
      quoteVersionId: row.quote_version_id,
      quoteStatus: row.quote_status,

      customerTotalCents:
        row.customer_total_cents,

      payoutCents:
        row.payout_cents,

      claimStatus:
        row.claim_status,

      draftStatus:
        row.draft_status,

      claimedAt:
        row.claimed_at
          ? row.claimed_at.toISOString()
          : null,

      createdAt:
        row.created_at.toISOString(),

      taskId:
        row.task_id,

      scheduledServiceDate:
        row.scheduled_service_date,
    }));
  }),
  claim: protectedProcedure
    .input(
      z.object({
        token: z.string().regex(/^[0-9a-f]{64}$/i),
        organizationId: z.string().uuid(),
        serviceProfileId: z.string().uuid(),
        businessLocationId: z.string().uuid(),
        proposedCustomerTotalCents: z.number().int().positive(),
        proposedPayoutCents: z.number().int().positive(),

        arrivalWindowStart: z.string().datetime(),
        arrivalWindowEnd: z.string().datetime(),
      }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await claimBusinessTask({
        ...input,
        actorId: ctx.user.id,
      });

      if (!result.success) {
        const code =
          result.error.code === 'NOT_FOUND'
            ? 'NOT_FOUND'
            : result.error.code.includes('CONFLICT')
              ? 'CONFLICT'
              : 'PRECONDITION_FAILED';

        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }

      return result.data;
    }),
});
