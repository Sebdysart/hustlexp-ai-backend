import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { HustlerWalletService } from '../services/HustlerWalletService.js';
import { LocalCertificationPayoutProvider } from '../services/LocalCertificationPayoutProvider.js';
import { hustlerProcedure, router } from '../trpc.js';

const amountSchema = z.number().int().positive().max(100_000_000);
const PRECONDITION_CODES = new Set([
  'SETUP_REQUIRED',
  'PROVIDER_UNAVAILABLE',
  'PAYOUTS_RESTRICTED',
  'DESTINATION_REQUIRED',
  'DESTINATION_RESTRICTED',
  'ACTIVE_CASH_OUT',
  'BELOW_MINIMUM',
  'INSUFFICIENT_AVAILABLE_BALANCE',
  'IDEMPOTENCY_CONFLICT',
]);

export const hustlerWalletRouter = router({
  activateLocalTestPayoutDestination: hustlerProcedure
    .input(z.object({}).optional())
    .mutation(async ({ ctx }) => {
      const result = await LocalCertificationPayoutProvider.activateDestination(
        ctx.user.id,
        ctx.user.id,
      );
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'LOCAL_TEST_PAYOUT_DISABLED'
            ? 'PRECONDITION_FAILED'
            : 'BAD_REQUEST',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  getOverview: hustlerProcedure
    .input(z.void())
    .query(async ({ ctx }) => {
      const result = await HustlerWalletService.getOverview(ctx.user.id);
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }
      return result.data;
    }),

  reviewCashOut: hustlerProcedure
    .input(z.object({ amountCents: amountSchema }))
    .query(async ({ ctx, input }) => {
      const result = await HustlerWalletService.reviewCashOut(ctx.user.id, input.amountCents);
      if (!result.success) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: result.error.message });
      }
      return result.data;
    }),

  requestCashOut: hustlerProcedure
    .input(z.object({
      amountCents: amountSchema,
      idempotencyKey: z.string().min(8).max(200),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await HustlerWalletService.requestCashOut({
        workerId: ctx.user.id,
        amountCents: input.amountCents,
        idempotencyKey: input.idempotencyKey,
      });
      if (!result.success) {
        throw new TRPCError({
          code: PRECONDITION_CODES.has(result.error.code)
            ? 'PRECONDITION_FAILED'
            : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),
});

export type HustlerWalletRouter = typeof hustlerWalletRouter;
