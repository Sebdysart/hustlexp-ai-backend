import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';

export const usersOnboardProcedure = protectedProcedure
  .input(
    z.object({
      username: z.string(),
      name: z.string(),
      email: z.string().email(),
      zipCode: z.string(),
    })
  )
  .mutation(async ({ ctx, input }) => {
    console.log('👤 tRPC: users.onboard called', { username: input.username, email: input.email });
    console.log('🔄 Using mock data - real DB integration pending');
    
    return {
      userId: `user_${Date.now()}`,
      username: input.username,
      name: input.name,
      email: input.email,
      xp: 0,
      level: 1,
      streak: 0,
    };
  });

export const usersMeProcedure = protectedProcedure
  .query(async () => {
    console.log('👤 tRPC: users.me called');
    console.log('🔄 Using mock data - real DB integration pending');
    return null;
  });

export const usersUpdateProcedure = protectedProcedure
  .input(
    z.object({
      name: z.string().optional(),
      bio: z.string().optional(),
      city: z.string().optional(),
    })
  )
  .mutation(async ({ input }: { input: { name?: string; bio?: string; city?: string } }) => {
    console.log('👤 tRPC: users.update called', input);
    return { success: true };
  });
