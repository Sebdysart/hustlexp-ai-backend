import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc.js';
import {
  BUSINESS_QUOTE_STATUSES,
  decodeBusinessQuoteCursor,
  listBusinessQuotes,
  normalizeBusinessQuoteStatuses,
} from '../services/BusinessQuoteReadService.js';

const listInput = z
  .object({
    organizationId: z.string().uuid(),
    openOnly: z.boolean().default(false),
    statuses: z
      .array(z.enum(BUSINESS_QUOTE_STATUSES))
      .min(1)
      .max(BUSINESS_QUOTE_STATUSES.length)
      .optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().min(1).max(2048).nullish(),
  })
  .strict();

export const businessQuoteRouter = router({
  listForOrganization: protectedProcedure.input(listInput).query(async ({ ctx, input }) => {
    const statuses = normalizeBusinessQuoteStatuses(input.statuses);
    let cursor: ReturnType<typeof decodeBusinessQuoteCursor> | null = null;
    if (input.cursor) {
      try {
        cursor = decodeBusinessQuoteCursor(
          input.cursor,
          input.organizationId,
          input.openOnly,
          statuses
        );
      } catch {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Invalid business quote cursor.',
        });
      }
    }

    try {
      return await listBusinessQuotes({
        actorId: ctx.user.id,
        organizationId: input.organizationId,
        openOnly: input.openOnly,
        statuses,
        limit: input.limit,
        cursor,
      });
    } catch (error) {
      if (error instanceof Error && error.message === 'BUSINESS_QUOTE_ACCESS_DENIED') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Business workspace access required.',
        });
      }
      throw error;
    }
  }),
});
