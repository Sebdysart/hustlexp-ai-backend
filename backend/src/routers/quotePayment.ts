import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { posterProcedure, router } from '../trpc.js';
import {
  newPaymentCreationFailure,
  paymentCreationErrorCause,
  type NewPaymentLane,
} from '../services/NewPaymentCreationGuard.js';
import { finalizePaidQuote } from '../services/QuotePaymentFinalizationService.js';
import { recoverOrphanQuotePayment } from '../services/QuotePaymentRecoveryService.js';

function throwLegacyQuotePaymentTombstone(lane: NewPaymentLane): never {
  const held = newPaymentCreationFailure(lane);
  if (!held) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Legacy quote payment containment is unavailable.',
    });
  }
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: held.error.message,
    cause: paymentCreationErrorCause(held.error.code),
  });
}

/**
 * Historical quote-payment compatibility boundary.
 *
 * Positive pay-first operations are permanent tombstones. New local, preview,
 * and staging financial effects use the Universal V1 `finance` router and its
 * deterministic fake provider. Only read-only materialized replay and bounded
 * orphan refund/void recovery remain here.
 */
export const quotePaymentRouter = router({
  createPaymentIntent: posterProcedure
    .input(
      z
        .object({
          quoteId: z.string().uuid(),
          quoteVersionId: z.string().uuid(),
        })
        .strict()
    )
    .mutation(() => throwLegacyQuotePaymentTombstone('quote_payment')),

  finalize: posterProcedure
    .input(
      z
        .object({
          quoteId: z.string().uuid(),
          quoteVersionId: z.string().uuid(),
          // Historical compatibility name. No new PaymentIntent is accepted.
          paymentIntentId: z.string().min(10).max(255),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const result = await finalizePaidQuote({
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        posterId: ctx.user.id,
        paymentIntentId: input.paymentIntentId,
      });

      if (!result.success) {
        throw new TRPCError({
          code:
            result.error.code === 'QUOTE_NOT_FOUND'
              ? 'NOT_FOUND'
              : result.error.code.includes('MISMATCH')
                ? 'FORBIDDEN'
                : 'PRECONDITION_FAILED',
          message: result.error.message,
          cause: paymentCreationErrorCause(result.error.code),
        });
      }

      return result.data;
    }),

  recoverOrphanPayment: posterProcedure
    .input(
      z
        .object({
          quoteId: z.string().uuid(),
          quoteVersionId: z.string().uuid(),
          // Historical compatibility name bound to the persisted provider row.
          paymentIntentId: z.string().min(10).max(255),
        })
        .strict()
    )
    .mutation(async ({ ctx, input }) => {
      const result = await recoverOrphanQuotePayment({
        ...input,
        posterId: ctx.user.id,
        reasonCode: 'POSTER_REQUESTED_CANCELLATION',
      });
      if (!result.success) {
        throw new TRPCError({
          code:
            result.error.code === 'QUOTE_PAYMENT_NOT_FOUND'
              ? 'NOT_FOUND'
              : result.error.code.includes('MISMATCH')
                ? 'FORBIDDEN'
                : 'PRECONDITION_FAILED',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  confirmTestPayment: posterProcedure
    .input(
      z
        .object({
          // Kept only so stale clients receive a stable tombstone instead of 404.
          paymentIntentId: z.string().min(10).max(255),
        })
        .strict()
    )
    .mutation(() => throwLegacyQuotePaymentTombstone('quote_payment')),
});

export type QuotePaymentRouter = typeof quotePaymentRouter;
