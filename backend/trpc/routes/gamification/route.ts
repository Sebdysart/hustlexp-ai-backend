import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';

export const xpAddXPProcedure = protectedProcedure
  .input(z.object({ amount: z.number().positive(), reason: z.string() }))
  .mutation(async ({ input }: { input: { amount: number; reason: string } }) => {
    console.log('⭐ tRPC: xp.addXP called', input);
    return { success: true, newXP: 0, newLevel: 1, leveledUp: false };
  });

export const badgesAwardProcedure = protectedProcedure
  .input(z.object({ badgeType: z.string() }))
  .mutation(async ({ input }: { input: { badgeType: string } }) => {
    console.log('🏆 tRPC: badges.award called', input);
    return { success: true };
  });

export const questsListProcedure = protectedProcedure
  .query(async () => {
    console.log('🎯 tRPC: quests.list called');
    return { quests: [] };
  });

export const questsClaimProcedure = protectedProcedure
  .input(z.object({ questId: z.string() }))
  .mutation(async ({ input }: { input: { questId: string } }) => {
    console.log('🎯 tRPC: quests.claim called', input);
    return { success: true, xpAwarded: 0, cashAwarded: 0 };
  });
