import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { posterProcedure, router } from '../trpc.js';
import { paymentCreationErrorCause } from '../services/NewPaymentCreationGuard.js';
import { StripeQuotePaymentProvider } from '../services/payment/StripeQuotePaymentProvider.js';
import { finalizePaidQuote } from '../services/QuotePaymentFinalizationService.js';
import { StripeService } from "../services/StripeService.js"
import {
  evaluateTaskAgainstRegionPolicy,
  resolveRegionPolicy,
} from '../services/RegionPolicyService.js';
import { buildManualTaskPolicyInput } from '../services/ManualTaskPolicy.js';

export const quotePaymentRouter = router({
  createPaymentIntent: posterProcedure
    .input(
      z.object({
        quoteId: z.string().uuid(),
        quoteVersionId: z.string().uuid(),
      }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await db.query<{
        quote_id: string;
        task_draft_id: string;
        active_version_id: string;
        quote_status: string;
        quote_environment: string | null;
        quote_is_test: boolean;
        selected_quote_id: string | null;
        business_organization_id: string | null;
        business_location_id: string | null;
        provider_service_profile_id: string | null;
        total_cents: number;
        hustler_payout_cents: number;
        arrival_window_start: Date | null;
        arrival_window_end: Date | null;
        dispatch_expires_at: Date | null;
        scheduled_service_date: string | null;
        arrival_start_date: string | null;
        arrival_end_date: string | null;
        category: string;
        region_code: string | null;
        region_policy_id: string | null;
        region_policy_version: string | null;
        region_policy_hash: string | null;
        region_policy_snapshot: Record<string, unknown> | null;
        validated_risk_level: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME' | null;
        region: string | null;
        expires_at: Date;
      }>(
        `
        SELECT
          q.id AS quote_id,
          q.task_draft_id,
          q.active_version_id,
          q.status AS quote_status,
          q.environment AS quote_environment,
          q.is_test AS quote_is_test,
          d.quote_id AS selected_quote_id,
          q.business_organization_id,
          q.business_location_id,
          q.provider_service_profile_id,
          d.scheduled_service_date::text AS scheduled_service_date,
          d.category,
          d.region_code,
          d.region_policy_id,
          d.region_policy_version,
          d.region_policy_hash,
          d.region_policy_snapshot,
          d.validated_risk_level,
          d.region,
          qv.total_cents,
          qv.hustler_payout_cents,
          qv.arrival_window_start,
          qv.arrival_window_end,
          qv.dispatch_expires_at,
          (qv.arrival_window_start AT TIME ZONE 'America/Los_Angeles')::date::text
            AS arrival_start_date,
          (qv.arrival_window_end AT TIME ZONE 'America/Los_Angeles')::date::text
            AS arrival_end_date,
          qv.expires_at
        FROM quotes q
        JOIN quote_versions qv
          ON qv.id = q.active_version_id
        AND qv.quote_id = q.id
        JOIN task_drafts d
          ON d.id = q.task_draft_id
        WHERE q.id = $1
          AND q.active_version_id = $2
          AND d.poster_user_id = $3
        LIMIT 1
        `,
        [input.quoteId, input.quoteVersionId, ctx.user.id],
      );

      const quote = result.rows[0];

      if (!quote) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Quote not found.',
        });
      }
      
      if (quote.selected_quote_id !== input.quoteId) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This quote has not been accepted by the poster.',
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

      // Validate before creating OR returning an existing intent. Finalization
      // retains its consistency checks because quote state can change afterward.
      if (quote.business_organization_id && (
        !quote.business_location_id || !quote.provider_service_profile_id
      )) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Business quote is missing its organization, location, or service profile binding.',
        });
      }

      const totalCents = Number(quote.total_cents);
      const payoutCents = Number(quote.hustler_payout_cents);
      const marginCents = totalCents - payoutCents;
      if (!Number.isSafeInteger(totalCents) || totalCents <= 0) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This quote has an invalid total.' });
      }
      if (!Number.isSafeInteger(payoutCents) || payoutCents <= 0) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This quote has an invalid provider payout.' });
      }
      if (!Number.isSafeInteger(marginCents) || marginCents < 0) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This quote has invalid payment economics.' });
      }
      if (
        !quote.region_code ||
        !quote.region_policy_id ||
        !quote.region_policy_version ||
        !quote.region_policy_hash ||
        !quote.region_policy_snapshot ||
        !quote.validated_risk_level
      ) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This task is missing authoritative policy validation and cannot be paid yet.',
        });
      }

      const regionPolicy = await resolveRegionPolicy(quote.region_code);

      if (!regionPolicy) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Payment is temporarily unavailable because the service-region policy is unavailable.',
        });
      }

      const regionEvaluation = evaluateTaskAgainstRegionPolicy(
        regionPolicy,
        buildManualTaskPolicyInput({
          regionCode: quote.region_code,
          category: quote.category,
          riskLevel: quote.validated_risk_level,
          customerTotalCents: totalCents,
          payoutCents,
          platformMarginCents: marginCents,
        }),
      );

      if (!regionEvaluation.allowed) {
        console.warn(
          '[quotePayment] region policy rejected payment',
          {
            quoteId: input.quoteId,
            quoteVersionId: input.quoteVersionId,
            reasons: regionEvaluation.reasons,
          },
        );

        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'This quote cannot currently be paid under HustleXP service policy.',
        });
      }

      if (!quote.scheduled_service_date) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Choose a service date before paying for this quote.',
        });
      }
      const arrivalStart = quote.arrival_window_start?.getTime();
      const arrivalEnd = quote.arrival_window_end?.getTime();
      if (
        arrivalStart === undefined || arrivalEnd === undefined ||
        !Number.isFinite(arrivalStart) || !Number.isFinite(arrivalEnd) ||
        arrivalEnd <= arrivalStart || !quote.arrival_start_date || !quote.arrival_end_date
      ) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This quote has an invalid arrival window.' });
      }
      if (
        quote.scheduled_service_date < quote.arrival_start_date ||
        quote.scheduled_service_date > quote.arrival_end_date
      ) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'The selected service date is outside the provider availability window.',
        });
      }
      const dispatchExpiry = quote.dispatch_expires_at?.getTime();
      // Past dispatch expiry is not a payment policy for manually assigned work.
      if (dispatchExpiry === undefined || !Number.isFinite(dispatchExpiry) || dispatchExpiry > arrivalStart) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'This quote has an invalid dispatch window.' });
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
        amountCents: totalCents,
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
