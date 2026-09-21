import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
  TilledConfigurationError,
} from '../services/payment/TilledConfig.js';
import { TilledApiError } from '../services/payment/TilledClient.js';
import {
  getBusinessPaymentOnboardingStatus,
  refreshBusinessPaymentOnboarding,
  startBusinessPaymentOnboarding,
} from '../services/payment/TilledMerchantOnboardingService.js';
import { protectedProcedure, router } from '../trpc.js';

export const BusinessPaymentOrganizationInput = z.object({
  organizationId: z.string().uuid(),
}).strict();

function mapOnboardingError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (error instanceof TilledConfigurationError) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Business payment setup is not configured.',
    });
  }
  if (error instanceof TilledApiError) {
    const unavailable = error.code === 'PROVIDER_TIMEOUT'
      || error.code === 'PROVIDER_UNAVAILABLE'
      || error.httpStatus === 429
      || (error.httpStatus !== undefined && error.httpStatus >= 500);
    throw new TRPCError({
      code: unavailable ? 'SERVICE_UNAVAILABLE' : 'PRECONDITION_FAILED',
      message: unavailable
        ? 'Payment setup is temporarily unavailable. Please try again shortly.'
        : 'Tilled could not start payment setup. Please review the business details or contact support.',
    });
  }
  throw error;
}

export const businessPaymentRouter = router({
  getStatus: protectedProcedure
    .input(BusinessPaymentOrganizationInput)
    .query(async ({ ctx, input }) => {
      try {
        return await getBusinessPaymentOnboardingStatus({
          ...input,
          actorId: ctx.user.id,
        });
      } catch (error) {
        return mapOnboardingError(error);
      }
    }),

  startTilledOnboarding: protectedProcedure
    .input(BusinessPaymentOrganizationInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await startBusinessPaymentOnboarding({
          ...input,
          actorId: ctx.user.id,
        });
      } catch (error) {
        return mapOnboardingError(error);
      }
    }),

  refreshTilledOnboarding: protectedProcedure
    .input(BusinessPaymentOrganizationInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await refreshBusinessPaymentOnboarding({
          ...input,
          actorId: ctx.user.id,
        });
      } catch (error) {
        return mapOnboardingError(error);
      }
    }),
});

export type BusinessPaymentRouter = typeof businessPaymentRouter;
