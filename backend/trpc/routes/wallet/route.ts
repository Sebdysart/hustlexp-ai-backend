import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';

export const walletBalanceProcedure = protectedProcedure
  .query(async () => {
    console.log('💰 tRPC: wallet.balance called');
    return { balance: 0, pending: 0, available: 0 };
  });

export const walletTransactionsProcedure = protectedProcedure
  .input(z.object({ limit: z.number().default(20), offset: z.number().default(0) }))
  .query(async ({ input }: { input: { limit: number; offset: number } }) => {
    console.log('💰 tRPC: wallet.transactions called', input);
    return { transactions: [], total: 0 };
  });

export const boostsListProcedure = protectedProcedure
  .query(async () => {
    console.log('🚀 tRPC: boosts.list called');
    return { boosts: [] };
  });

export const boostsActivateProcedure = protectedProcedure
  .input(z.object({ boostId: z.string() }))
  .mutation(async ({ input }: { input: { boostId: string } }) => {
    console.log('🚀 tRPC: boosts.activate called', input);
    return { success: true };
  });
