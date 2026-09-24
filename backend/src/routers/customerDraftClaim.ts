import { z } from 'zod';
import { protectedProcedure, publicProcedure, router } from '../trpc.js';
import {
  claimPendingPhoneDraft,
  previewPendingPhoneClaim,
} from '../services/CustomerDraftClaimService.js';
import { getFirebaseUserRecord } from '../auth/firebase.js';
import { normalizePhoneToE164 } from '../lib/phone.js';
import { TRPCError } from '@trpc/server';

const TokenSchema = z.object({ token: z.string().min(32).max(256) });

export const customerDraftClaimRouter = router({
  preview: publicProcedure.input(TokenSchema).query(({ input }) =>
    previewPendingPhoneClaim(input.token)),
  claim: protectedProcedure.input(TokenSchema).mutation(async ({ ctx, input }) => {
    if (!ctx.firebaseUid) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const firebaseUser = await getFirebaseUserRecord(ctx.firebaseUid);
    if (!firebaseUser.phoneNumber) {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Sign in with the phone number this request was sent to.',
      });
    }
    return claimPendingPhoneDraft({
      rawToken: input.token,
      userId: ctx.user.id,
      verifiedPhone: normalizePhoneToE164(firebaseUser.phoneNumber),
    });
  }),
});
