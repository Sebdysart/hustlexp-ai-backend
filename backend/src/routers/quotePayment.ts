import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { posterProcedure, router } from '../trpc.js';
import {
  newPaymentCreationFailure,
  paymentCreationErrorCause,
} from '../services/NewPaymentCreationGuard.js';
import { StripeQuotePaymentProvider } from '../services/payment/StripeQuotePaymentProvider.js';
import { finalizePaidQuote } from '../services/QuotePaymentFinalizationService.js';
import { recoverOrphanQuotePayment } from '../services/QuotePaymentRecoveryService.js';
import { StripeService } from "../services/StripeService.js"

export const quotePaymentRouter = router({
  createPaymentIntent: posterProcedure
    .input(
      z.object({
        quoteId: z.string().uuid(),
        quoteVersionId: z.string().uuid(),
      }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const frozen = newPaymentCreationFailure('quote_payment');
      if (frozen) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: frozen.error.message,
          cause: paymentCreationErrorCause(frozen.error.code),
        });
      }

      const result = await db.query<{
        quote_id: string;
        task_draft_id: string;
        active_version_id: string;
        quote_status: string;
        quote_environment: string | null;
        quote_is_test: boolean;
        total_cents: number;
        expires_at: Date;
        draft_poster_id: string | null;
        lead_user_id: string | null;
      }>(
        `
        SELECT
          q.id AS quote_id,
          q.task_draft_id,
          q.active_version_id,
          q.status AS quote_status,
          q.environment AS quote_environment,
          q.is_test AS quote_is_test,
          qv.total_cents,
          qv.expires_at,
          d.poster_user_id AS draft_poster_id,
          l.user_id AS lead_user_id
        FROM quotes q
        JOIN quote_versions qv
          ON qv.id = q.active_version_id
         AND qv.quote_id = q.id
        JOIN task_drafts d
          ON d.id = q.task_draft_id
        JOIN leads l
          ON l.id = d.lead_id
        WHERE q.id = $1
          AND q.active_version_id = $2
        LIMIT 1
        `,
        [input.quoteId, input.quoteVersionId],
      );

      const quote = result.rows[0];

      if (!quote) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Quote not found.',
        });
      }

      if (
        !quote.draft_poster_id
        || !quote.lead_user_id
        || quote.draft_poster_id !== quote.lead_user_id
        || quote.draft_poster_id !== ctx.user.id
      ) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'This quote does not belong to the authenticated poster.',
        });
      }

      if (quote.expires_at <= new Date()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This quote has expired.',
        });
      }

      if (
        quote.quote_status !== 'quote_ready'
        && quote.quote_status !== 'quote_send_ready'
      ) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Quote cannot currently be paid (status: ${quote.quote_status}).`,
        });
      }

      const existingPayment = await db.query<{
        provider_payment_id: string;
        amount_cents: number;
        status: string;
      }>(
        `
        SELECT
          provider_payment_id,
          amount_cents,
          status
        FROM quote_payments
        WHERE quote_id = $1
          AND quote_version_id = $2
        LIMIT 1
        `,
        [input.quoteId, input.quoteVersionId],
      );

      if (existingPayment.rows[0]) {
        const payment = existingPayment.rows[0];

        if (payment.status === 'PENDING') {
          return {
            quoteId: input.quoteId,
            quoteVersionId: input.quoteVersionId,
            paymentIntentId: payment.provider_payment_id,
            clientSecret: null,
            amountCents: payment.amount_cents,
            replayed: true,
          };
        }

        if (payment.status === 'SUCCEEDED') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'This quote has already been paid.',
          });
        }
      }

      const payment = await StripeQuotePaymentProvider.createPaymentIntent({
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        posterId: ctx.user.id,
        amountCents: Number(quote.total_cents),
      });

      if (!payment.success) {
        const cause = paymentCreationErrorCause(payment.error.code);

        throw new TRPCError({
          code: cause ? 'PRECONDITION_FAILED' : 'INTERNAL_SERVER_ERROR',
          message: payment.error.message,
          ...(cause ? { cause } : {}),
        });
      }

      await db.query(
        `
        INSERT INTO quote_payments (
          quote_id,
          quote_version_id,
          provider,
          provider_payment_id,
          amount_cents,
          status
        )
        VALUES ($1, $2, 'stripe', $3, $4, 'PENDING')
        ON CONFLICT (quote_id, quote_version_id)
        DO UPDATE SET
          provider_payment_id = EXCLUDED.provider_payment_id,
          amount_cents = EXCLUDED.amount_cents,
          status = 'PENDING',
          updated_at = NOW()
        `,
        [
          input.quoteId,
          input.quoteVersionId,
          payment.data.paymentIntentId,
          payment.data.amountCents,
        ],
      );

      return {
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        paymentIntentId: payment.data.paymentIntentId,
        clientSecret: payment.data.clientSecret,
        amountCents: payment.data.amountCents,
        replayed: false,
      };
    }),

  finalize: posterProcedure
    .input(
      z.object({
        quoteId: z.string().uuid(),
        quoteVersionId: z.string().uuid(),
        paymentIntentId: z.string().min(10).max(255),
      }).strict(),
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
        });
      }

      return result.data;
    }),
  recoverOrphanPayment: posterProcedure
    .input(
      z.object({
        quoteId: z.string().uuid(),
        quoteVersionId: z.string().uuid(),
        paymentIntentId: z.string().min(10).max(255),
      }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await recoverOrphanQuotePayment({
        ...input,
        posterId: ctx.user.id,
        reasonCode: 'POSTER_REQUESTED_CANCELLATION',
      });
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'QUOTE_PAYMENT_NOT_FOUND'
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
    z.object({
      paymentIntentId: z.string().min(10).max(255),
    }).strict(),
  )
  .mutation(async ({ input }) => {
    const result = await StripeService.confirmTestPaymentIntent(
      input.paymentIntentId,
    );

    if (!result.success) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: result.error.message,
      });
    }

    return result.data;
  }),
});

export type QuotePaymentRouter = typeof quotePaymentRouter;
