/**
 * Payment Methods Router v1.0.0
 *
 * CRUD for saved payment methods (cards) via Stripe.
 * Uses SetupIntent flow for saving cards without charging.
 */

import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, protectedProcedure } from '../trpc.js';
import { StripeService } from '../services/StripeService.js';
import { logger } from '../logger.js';

const log = logger.child({ router: 'paymentMethods' });

export const paymentMethodsRouter = router({
  /**
   * List saved payment methods for the current user.
   */
  list: protectedProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      if (!StripeService.isConfigured()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Stripe not configured' });
      }

      // Ensure customer exists
      const customerResult = await StripeService.ensureCustomer(
        ctx.user.id,
        ctx.user.email,
        ctx.user.full_name
      );
      if (!customerResult.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: customerResult.error.message });
      }

      const result = await StripeService.listPaymentMethods(customerResult.data);
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }

      return { methods: result.data };
    }),

  /**
   * Create a SetupIntent for adding a new payment method.
   * Returns a clientSecret for the Stripe PaymentSheet.
   */
  createSetupIntent: protectedProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      if (!StripeService.isConfigured()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Stripe not configured' });
      }

      const customerResult = await StripeService.ensureCustomer(
        ctx.user.id,
        ctx.user.email,
        ctx.user.full_name
      );
      if (!customerResult.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: customerResult.error.message });
      }

      const result = await StripeService.createSetupIntent(customerResult.data);
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }

      log.info({ userId: ctx.user.id }, 'SetupIntent created for adding payment method');

      return {
        clientSecret: result.data.clientSecret,
        customerId: customerResult.data,
      };
    }),

  /**
   * Remove a saved payment method.
   */
  remove: protectedProcedure
    .input(z.object({
      paymentMethodId: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!StripeService.isConfigured()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Stripe not configured' });
      }

      const result = await StripeService.detachPaymentMethod(input.paymentMethodId);
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }

      log.info({ userId: ctx.user.id, paymentMethodId: input.paymentMethodId }, 'Payment method removed');

      return { success: true };
    }),

  /**
   * Set a payment method as the default.
   */
  setDefault: protectedProcedure
    .input(z.object({
      paymentMethodId: z.string().min(1),
    }))
    .mutation(async ({ ctx, input }) => {
      if (!StripeService.isConfigured()) {
        throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Stripe not configured' });
      }

      const customerResult = await StripeService.ensureCustomer(
        ctx.user.id,
        ctx.user.email,
        ctx.user.full_name
      );
      if (!customerResult.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: customerResult.error.message });
      }

      const result = await StripeService.setDefaultPaymentMethod(
        customerResult.data,
        input.paymentMethodId
      );
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }

      log.info({ userId: ctx.user.id, paymentMethodId: input.paymentMethodId }, 'Default payment method set');

      return { success: true };
    }),
});

export type PaymentMethodsRouter = typeof paymentMethodsRouter;
