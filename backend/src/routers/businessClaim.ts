// backend/src/routers/businessClaim.ts
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router, publicProcedure } from '../trpc.js';
import { claimBusinessTask } from '../services/BusinessClaimService.js';
import { createHash } from 'node:crypto';
import { db } from '../db.js';

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
      };
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
