/**
 * Paid task promotion is outside the Build-Now release. Canonical discovery,
 * eligibility, and ranking remain merit-only; no payment intent, listing, or
 * promoted feed is created or exposed by this router.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { posterProcedure, router } from '../trpc.js';

const BUILD_NOW_PROMOTION_DISABLED =
  'Paid task promotion is not available in the Build-Now release.';

function promotionDisabled(): never {
  throw new TRPCError({
    code: 'PRECONDITION_FAILED',
    message: BUILD_NOW_PROMOTION_DISABLED,
  });
}

export const featuredRouter = router({
  promoteTask: posterProcedure
    .input(z.object({
      taskId: z.string().uuid(),
      featureType: z.enum(['promoted', 'highlighted', 'urgent_boost']),
    }))
    .mutation(() => promotionDisabled()),

  confirmPromotion: posterProcedure
    .input(z.object({
      listingId: z.string().uuid(),
      stripePaymentIntentId: z.string(),
    }))
    .mutation(() => promotionDisabled()),

  getFeaturedTasks: posterProcedure
    .input(z.void())
    .query(() => []),
});
