import { TRPCError } from '@trpc/server';
import { hustlerProcedure, router } from '../trpc.js';
import { getPrivateIdentityVerificationStatus } from '../services/PrivateIdentityVerificationService.js';

export const identityVerificationRouter = router({
  getMyStatus: hustlerProcedure.query(async ({ ctx }) => {
    const status = await getPrivateIdentityVerificationStatus(ctx.user.id);
    if (!status.success) {
      throw new TRPCError({
        code: status.error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_SERVER_ERROR',
        message: status.error.message,
      });
    }
    return status.data;
  }),
});
