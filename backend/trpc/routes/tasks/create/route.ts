import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';
import { ai } from '@/backend/ai/router';

export const tasksCreateProcedure = protectedProcedure
  .input(
    z.object({
      title: z.string().min(5).max(200),
      description: z.string().min(10).max(2000),
      category: z.string(),
      xpReward: z.number().positive(),
      price: z.number().nonnegative(),
      city: z.string(),
      deadline: z.date().optional(),
      estimatedDuration: z.string().optional(),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
    })
  )
  .mutation(async ({ input }: { input: { title: string; description: string; category: string; xpReward: number; price: number; city: string; deadline?: Date; estimatedDuration?: string; difficulty?: 'easy' | 'medium' | 'hard' } }) => {
    console.log('📋 tRPC: tasks.create called', input.title);
    console.log('🔄 Using mock data - real DB integration pending');

    const category = await ai.categorizeTask(input.description);
    console.log(`   AI categorized as: ${category}`);

    const priceValidation = await ai.validatePrice(input.description, input.price);
    console.log(`   AI price validation: ${priceValidation.isReasonable}`);

    return {
      id: 'stub_task_' + Date.now(),
      ...input,
      status: 'active' as const,
      createdAt: new Date(),
    };
  });
