import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';
import { stripe } from '@/backend/payments/stripe';

export const tasksAcceptProcedure = protectedProcedure
  .input(z.object({ taskId: z.string() }))
  .mutation(async ({ input }: { input: { taskId: string } }) => {
    console.log('📋 tRPC: tasks.accept called', input.taskId);
    console.log('🔄 Using mock data - real DB & Stripe integration pending');

    const paymentIntent = await stripe.createPaymentIntent({
      amount: 2500,
      currency: 'usd',
      taskId: input.taskId,
      posterId: 'stub_poster',
      workerId: 'stub_worker',
    });

    console.log(`   Created payment intent: ${paymentIntent.paymentIntentId}`);

    return {
      success: true,
      taskId: input.taskId,
      assignmentId: 'stub_assignment_' + Date.now(),
    };
  });
