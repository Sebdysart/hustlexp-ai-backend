import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { isBusinessQuoteProviderVerified } from '../services/BusinessQuoteActivationService.js';
import { protectedProcedure, router } from '../trpc.js';
import {
  newPaymentCreationFailure,
  paymentCreationErrorCause,
} from '../services/NewPaymentCreationGuard.js';
import { finalizePaidQuote } from '../services/QuotePaymentFinalizationService.js';
import { lockQuoteAddressForPayment } from '../services/QuoteServiceAddressService.js';
import {
  evaluateTaskAgainstRegionPolicy,
  resolveRegionPolicy,
} from '../services/RegionPolicyService.js';
import { buildManualTaskPolicyInput } from '../services/ManualTaskPolicy.js';
import {
  controlledTestQuotePaymentEnabled,
  controlledTestQuotePaymentReference,
} from '../services/ControlledTestQuotePaymentService.js';
import { configuredQuotePaymentProvider, TilledConfigurationError } from '../services/payment/TilledConfig.js';
import { TilledApiError } from '../services/payment/TilledClient.js';
import { createOrResumeTilledCheckout, finalizeTilledCheckout } from '../services/payment/TilledQuoteCheckoutService.js';
import { logger } from '../logger.js';

export function mapTilledCheckoutError(error: unknown): TRPCError | null {
  if (error instanceof TilledConfigurationError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Tilled checkout is not configured.' });
  }
  if (!(error instanceof TilledApiError)) return null;
  if (error.code === 'PROVIDER_TIMEOUT' || error.code === 'PROVIDER_UNAVAILABLE'
    || error.httpStatus === 429 || (error.httpStatus !== undefined && error.httpStatus >= 500)) {
    return new TRPCError({ code: 'SERVICE_UNAVAILABLE',
      message: 'Payment provider is temporarily unavailable. Please retry this checkout shortly.' });
  }
  if (error.code === 'INVALID_PROVIDER_RESPONSE') {
    return new TRPCError({ code: 'BAD_GATEWAY',
      message: 'Payment provider returned an invalid response. Please retry later.' });
  }
  if (error.httpStatus === 401) {
    return new TRPCError({ code: 'SERVICE_UNAVAILABLE',
      message: 'Payment service authorization is unavailable. Please contact support.' });
  }
  if (error.httpStatus === 403 || error.httpStatus === 404 || error.code === 'INVALID_ACCOUNT') {
    return new TRPCError({ code: 'PRECONDITION_FAILED',
      message: 'Business payment account cannot accept this payment. Please contact support.' });
  }
  return new TRPCError({ code: 'PRECONDITION_FAILED',
    message: 'Payment provider rejected checkout setup. Please contact support before retrying.' });
}

async function finalizeControlledTestQuote(input: {
  quoteId: string;
  quoteVersionId: string;
  posterId: string;
  paymentIntentId: string;
}) {
  const result = await finalizePaidQuote({
    ...input,
    paymentMode: 'controlled_test',
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
}

export const quotePaymentRouter = router({
  createTilledCheckout: protectedProcedure
    .input(z.object({ quoteId: z.string().uuid(), quoteVersionId: z.string().uuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      try {
        logger.info({ operation: 'tilled_create_checkout', stage: 'validate_input', provider: 'tilled',
          quote_id: input.quoteId, quote_version_id: input.quoteVersionId }, 'Tilled checkout requested');
        if (configuredQuotePaymentProvider() !== 'tilled') {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Tilled quote checkout is unavailable.' });
        }
        return await createOrResumeTilledCheckout({ ...input, posterId: ctx.user.id });
      } catch (error) {
        const mapped = mapTilledCheckoutError(error);
        if (mapped) {
          if (error instanceof TilledConfigurationError) {
            logger.warn({ operation: 'tilled_create_checkout', stage: 'load_tilled_config',
              quote_id: input.quoteId, quote_version_id: input.quoteVersionId,
              error_name: error.name, error_message: error.message }, 'Tilled configuration unavailable');
          }
          throw mapped;
        }
        throw error;
      }
    }),

  finalizeTilledCheckout: protectedProcedure
    .input(z.object({ quoteId: z.string().uuid(), quoteVersionId: z.string().uuid() }).strict())
    .mutation(async ({ ctx, input }) => {
      if (configuredQuotePaymentProvider() !== 'tilled') {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Tilled quote checkout is unavailable.' });
      }
      try {
        return await finalizeTilledCheckout({ ...input, posterId: ctx.user.id });
      } catch (error) {
        if (error instanceof TilledConfigurationError) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Tilled checkout is not configured.' });
        }
        throw error;
      }
    }),

  completeControlledTestPayment: protectedProcedure
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

      if (
        configuredQuotePaymentProvider() !== 'local_test'
        || !controlledTestQuotePaymentEnabled()
        || quote.quote_environment !== 'TEST'
        || quote.quote_is_test !== true
      ) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Controlled-test quote payment is not authorized.',
        });
      }

      const existingPayment = await db.query<{
        provider: string;
        provider_payment_id: string;
        amount_cents: number;
        platform_fee_cents: number | null;
        status: string;
      }>(
        `
        SELECT
          provider,
          provider_payment_id,
          amount_cents,
          platform_fee_cents,
          status
        FROM quote_payments
        WHERE quote_id = $1
          AND quote_version_id = $2
        LIMIT 1
        `,
        [input.quoteId, input.quoteVersionId],
      );

      if (quote.quote_status === 'paid') {
        const payment = existingPayment.rows[0];

        if (
          !payment
          || payment.provider !== 'local_test'
          || payment.status !== 'SUCCEEDED'
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'This quote payment cannot be replayed.',
          });
        }

        return finalizeControlledTestQuote({
          quoteId: input.quoteId,
          quoteVersionId: input.quoteVersionId,
          posterId: ctx.user.id,
          paymentIntentId: payment.provider_payment_id,
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
      if (quote.business_organization_id && !await isBusinessQuoteProviderVerified(db.query.bind(db), quote.business_organization_id)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This business is not currently eligible to accept payment.',
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
      const assessmentCreditResult = await db.query<{ amount_cents: number }>(
        `SELECT payment.amount_cents
         FROM business_assessment_requests assessment
         JOIN assessment_payments payment ON payment.assessment_request_id = assessment.id
         LEFT JOIN ops_business_claim_links claim ON claim.id = assessment.claim_link_id
         WHERE (assessment.quote_id = $1 OR (assessment.quote_id IS NULL AND claim.quote_id = $1))
           AND assessment.business_organization_id = $2
           AND assessment.quote_is_net_of_credit = FALSE
           AND assessment.status = 'COMPLETED' AND payment.status = 'SUCCEEDED' LIMIT 1`,
        [input.quoteId, quote.business_organization_id],
      );
      const assessmentCreditCents = assessmentCreditResult.rows[0]?.amount_cents ?? 0;

      if (assessmentCreditCents !== 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Controlled-test quote payment does not support assessment credits.',
        });
      }
      const remainingChargeCents = totalCents - assessmentCreditCents;
      const marketplaceFeeCents = marginCents;
      if (remainingChargeCents <= 0) throw new TRPCError({ code:'PRECONDITION_FAILED', message:'The remaining quote balance is invalid.' });
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
        {
          evaluateEconomics: true,
          evaluateProductionGates: false,
        },
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

      if (existingPayment.rows[0]) {
        await lockQuoteAddressForPayment(input.quoteId, input.quoteVersionId, ctx.user.id);
        const payment = existingPayment.rows[0];

        if (
          payment.provider !== 'local_test'
          || payment.amount_cents !== remainingChargeCents
          || payment.platform_fee_cents !== marketplaceFeeCents
          || !['PENDING', 'SUCCEEDED'].includes(payment.status)
        ) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'This quote is already bound to a different payment.',
          });
        }

        return finalizeControlledTestQuote({
          quoteId: input.quoteId,
          quoteVersionId: input.quoteVersionId,
          posterId: ctx.user.id,
          paymentIntentId: payment.provider_payment_id,
        });
      }

      if (!quote.business_organization_id) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'The selected quote is not associated with a Business.' });

      const frozen = newPaymentCreationFailure('escrow_funding');

      if (frozen) {
        const cause = paymentCreationErrorCause(frozen.error.code);

        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: frozen.error.message,
          ...(cause ? { cause } : {}),
        });
      }

      const paymentReference = controlledTestQuotePaymentReference(
        input.quoteId,
        input.quoteVersionId,
      );

      await lockQuoteAddressForPayment(input.quoteId, input.quoteVersionId, ctx.user.id);

      await db.query(
        `
        INSERT INTO quote_payments (
          quote_id,
          quote_version_id,
          provider,
          provider_payment_id,
          amount_cents,
          status,
          platform_fee_cents
        )
        VALUES ($1, $2, 'local_test', $3, $4, 'PENDING', $5)
        ON CONFLICT (quote_id, quote_version_id)
        DO NOTHING
        `,
        [
          input.quoteId,
          input.quoteVersionId,
          paymentReference,
          remainingChargeCents,
          marketplaceFeeCents,
        ],
      );

      const boundPayment = await db.query<{
        provider: string;
        provider_payment_id: string;
        amount_cents: number;
        platform_fee_cents: number | null;
        status: string;
      }>(
        `
        SELECT
          provider,
          provider_payment_id,
          amount_cents,
          platform_fee_cents,
          status
        FROM quote_payments
        WHERE quote_id = $1
          AND quote_version_id = $2
        LIMIT 1
        `,
        [input.quoteId, input.quoteVersionId],
      );

      const payment = boundPayment.rows[0];

      if (
        !payment
        || payment.provider !== 'local_test'
        || payment.amount_cents !== remainingChargeCents
        || payment.platform_fee_cents !== marketplaceFeeCents
        || !['PENDING', 'SUCCEEDED'].includes(payment.status)
      ) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'This quote is already bound to a different payment.',
        });
      }

      return finalizeControlledTestQuote({
        quoteId: input.quoteId,
        quoteVersionId: input.quoteVersionId,
        posterId: ctx.user.id,
        paymentIntentId: payment.provider_payment_id,
      });
    }),

  finalize: protectedProcedure
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
        paymentMode: 'stax',
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
});

export type QuotePaymentRouter = typeof quotePaymentRouter;




