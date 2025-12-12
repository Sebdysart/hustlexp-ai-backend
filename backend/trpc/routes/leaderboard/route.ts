import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';

export const leaderboardWeeklyProcedure = protectedProcedure
  .input(z.object({ limit: z.number().default(100) }))
  .query(async ({ input }: { input: { limit: number } }) => {
    console.log('🏅 tRPC: leaderboard.weekly called', input);
    return { entries: [], myRank: null };
  });

export const leaderboardAllTimeProcedure = protectedProcedure
  .input(z.object({ limit: z.number().default(100) }))
  .query(async ({ input }: { input: { limit: number } }) => {
    console.log('🏅 tRPC: leaderboard.allTime called', input);
    return { entries: [], myRank: null };
  });
