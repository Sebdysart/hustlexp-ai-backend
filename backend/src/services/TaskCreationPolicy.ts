import { TRPCError } from '@trpc/server';

export interface ImplementedTaskFields {
  prorate_on_abort?: boolean;
}

export function assertImplementedFields(input: ImplementedTaskFields): void {
  if (input.prorate_on_abort) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'Partial payout features are not yet available.',
    });
  }
}
