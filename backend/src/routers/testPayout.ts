import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure } from '../trpc.js';
import { LocalCertificationPayoutProvider } from '../services/LocalCertificationPayoutProvider.js';
import { HustlerIdentityLinkService } from '../services/HustlerIdentityLinkService.js';

export const testPayoutRouter = router({
  activateDestination: protectedProcedure
    .input(
      z.object({
        workerId: z.string().uuid(),
      }).strict(),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await LocalCertificationPayoutProvider.activateDestination(
        input.workerId,
        ctx.user.id,
      );

      if (!result.success) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: result.error.message,
        });
      }

      return result.data;
    }),

  createPaidTransfer: protectedProcedure
    .input(
      z.object({
        taskId: z.string().uuid(),
        escrowId: z.string().uuid(),
        workerId: z.string().uuid(),
        idempotencyKey: z.string().min(8).max(200),
      }).strict(),
    )
    .mutation(async ({ input }) => {
      const result = await LocalCertificationPayoutProvider.createPaidTransfer({
        taskId: input.taskId,
        escrowId: input.escrowId,
        workerId: input.workerId,
        idempotencyKey: input.idempotencyKey,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: result.error.message,
        });
      }

      return result.data;
    }),
    linkHustlerIdentity: protectedProcedure
    .input(
      z.object({
        workerId: z.string().uuid(),
        phoneE164: z.string().min(8).max(30),
        providerClaimId: z.string().uuid(),
      }).strict(),
    )
    .mutation(async ({ input }) => {
      if (process.env.NODE_ENV === 'production') {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Controlled-test identity linking is disabled in production.',
        });
      }

      const result = await HustlerIdentityLinkService.link({
        engineHustlerRef: input.workerId,
        phoneE164: input.phoneE164,
        providerClaimId: input.providerClaimId,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: result.error.message,
        });
      }

      return result.data;
    }),
});