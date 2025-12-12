import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';
import { r2 } from '@/backend/storage/r2';

export const tasksCompleteProcedure = protectedProcedure
  .input(
    z.object({
      taskId: z.string(),
      proofPhotos: z.array(z.string()),
      notes: z.string().optional(),
    })
  )
  .mutation(async ({ input }: { input: { taskId: string; proofPhotos: string[]; notes?: string } }) => {
    console.log('📋 tRPC: tasks.complete called', input.taskId);
    console.log(`   Proof photos: ${input.proofPhotos.length}`);
    console.log('🔄 Using mock data - real DB & R2 integration pending');

    for (let i = 0; i < input.proofPhotos.length; i++) {
      const key = r2.generateTaskProofKey(input.taskId, Date.now());
      console.log(`   Would upload photo to: ${key}`);
    }

    return {
      success: true,
      taskId: input.taskId,
      status: 'pending_review' as const,
    };
  });
