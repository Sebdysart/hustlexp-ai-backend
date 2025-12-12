import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';

export const tasksGetProcedure = protectedProcedure
  .input(z.object({ id: z.string() }))
  .query(async ({ input }: { input: { id: string } }) => {
    console.log('📋 tRPC: tasks.get called', input.id);
    console.log('🔄 Using mock data - real DB integration pending');
    
    return null;
  });
