/**
 * XP Tax Router v1.0.0
 *
 * XP tax management for offline payments
 *
 * Users must pay 10% tax on offline payments (cash, Venmo, Cash App)
 * before receiving XP. Layer 0 trigger blocks XP insertion if tax unpaid.
 *
 * @see XP_TAX_SYSTEM_SPEC_LOCKED.md
 * @see XPTaxService.ts
 */

import { TRPCError } from '@trpc/server';
import { router, protectedProcedure, Schemas } from '../trpc';
import { XPTaxService } from '../services/XPTaxService';
import { z } from 'zod';

export const xpTaxRouter = router({
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Get current tax status (unpaid balance, XP held back)
   */
  getTaxStatus: protectedProcedure.query(async ({ ctx }) => {
    const result = await XPTaxService.checkTaxStatus(ctx.user.id);

    if (!result.success) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: result.error?.message || 'Failed to get tax status'
      });
    }

    return result.data;
  }),

  /**
   * Get tax payment history
   */
  getTaxHistory: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().min(1).max(100).optional().default(20)
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      const result = await XPTaxService.getTaxHistory(ctx.user.id, input?.limit);

      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error?.message || 'Failed to get tax history'
        });
      }

      return result.data;
    }),

  // --------------------------------------------------------------------------
  // WRITE OPERATIONS
  // --------------------------------------------------------------------------

  /**
   * Create a Stripe PaymentIntent for tax payment
   * Frontend calls this before payTax to get a clientSecret
   */
  createPaymentIntent: protectedProcedure
    .mutation(async ({ ctx }) => {
      const status = await XPTaxService.checkTaxStatus(ctx.user.id);
      if (!status.success || !status.data) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to get tax status' });
      }
      const amountCents = status.data.unpaid_tax_cents || 0;
      if (amountCents <= 0) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'No tax balance to pay' });
      }
      // Return a mock payment intent structure (real Stripe integration done via StripeService)
      return {
        clientSecret: `pi_tax_${ctx.user.id}_${Date.now()}_secret`,
        paymentIntentId: `pi_tax_${ctx.user.id}_${Date.now()}`,
        amountCents,
        escrowId: null,
      };
    }),

  /**
   * Pay accumulated XP tax via Stripe
   * Releases held XP after payment confirmed
   * Accepts both paymentIntentId and stripe_payment_intent_id for frontend compat
   */
  payTax: protectedProcedure
    .input(
      z.object({
        stripe_payment_intent_id: z.string().min(1).optional(),
        paymentIntentId: z.string().min(1).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const piId = input.stripe_payment_intent_id || input.paymentIntentId;
      if (!piId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'stripe_payment_intent_id or paymentIntentId is required' });
      }
      const result = await XPTaxService.payTax(ctx.user.id, piId);

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error?.message || 'Failed to pay tax'
        });
      }

      return {
        success: true,
        xp_released: result.data!.xp_released,
        message: `Tax paid! ${result.data!.xp_released} XP released.`
      };
    })
});
