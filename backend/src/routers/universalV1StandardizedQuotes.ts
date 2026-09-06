import { TRPCError } from '@trpc/server';

import {
  AcceptUniversalV1StandardizedQuoteSchema,
  GetCurrentUniversalV1StandardizedQuoteSchema,
  PrepareUniversalV1FakePaymentMethodSchema,
  PrepareUniversalV1StandardizedQuoteSchema,
  UniversalV1StandardizedQuoteError,
} from '../services/UniversalV1StandardizedQuoteContracts.js';
import { UniversalV1StandardizedQuoteApplication } from '../services/UniversalV1StandardizedQuoteApplication.js';
import { UniversalV1StandardizedQuotePostgresRepository } from '../services/UniversalV1StandardizedQuotePostgresRepository.js';
import { posterProcedure, router } from '../trpc.js';
import type { User } from '../types.js';

function assertStandardizedQuotePoster(user: User): void {
  if (
    user.default_mode !== 'poster' ||
    user.account_status !== 'ACTIVE' ||
    user.is_minor !== false ||
    user.is_banned === true
  ) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'An active adult Poster account is required.',
    });
  }
}

async function translate<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof TRPCError) throw error;
    if (error instanceof UniversalV1StandardizedQuoteError) {
      throw new TRPCError({ code: error.code, message: error.message });
    }
    throw error;
  }
}

export function createUniversalV1StandardizedQuotesRouter(
  application: UniversalV1StandardizedQuoteApplication
) {
  return router({
    prepare: posterProcedure
      .input(PrepareUniversalV1StandardizedQuoteSchema)
      .mutation(({ ctx, input }) => {
        assertStandardizedQuotePoster(ctx.user);
        return translate(() => application.prepareQuote(ctx.user.id, input));
      }),

    getCurrent: posterProcedure
      .input(GetCurrentUniversalV1StandardizedQuoteSchema)
      .query(({ ctx, input }) => {
        assertStandardizedQuotePoster(ctx.user);
        return translate(() => application.getCurrent(ctx.user.id, input));
      }),

    accept: posterProcedure
      .input(AcceptUniversalV1StandardizedQuoteSchema)
      .mutation(({ ctx, input }) => {
        assertStandardizedQuotePoster(ctx.user);
        return translate(() => application.acceptQuote(ctx.user.id, input));
      }),

    prepareFakePaymentMethod: posterProcedure
      .input(PrepareUniversalV1FakePaymentMethodSchema)
      .mutation(({ ctx, input }) => {
        assertStandardizedQuotePoster(ctx.user);
        return translate(() => application.prepareFakePaymentMethod(ctx.user.id, input));
      }),
  });
}

const universalV1StandardizedQuoteApplication = new UniversalV1StandardizedQuoteApplication(
  new UniversalV1StandardizedQuotePostgresRepository()
);

export const universalV1StandardizedQuotesRouter = createUniversalV1StandardizedQuotesRouter(
  universalV1StandardizedQuoteApplication
);

export type UniversalV1StandardizedQuotesRouter =
  typeof universalV1StandardizedQuotesRouter;
