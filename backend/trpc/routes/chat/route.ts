import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';

export const chatListProcedure = protectedProcedure
  .input(z.object({ taskId: z.string() }))
  .query(async ({ input }: { input: { taskId: string } }) => {
    console.log('💬 tRPC: chat.list called', input.taskId);
    return { messages: [] };
  });

export const chatSendProcedure = protectedProcedure
  .input(z.object({ taskId: z.string(), content: z.string(), imageUrl: z.string().optional() }))
  .mutation(async ({ input }: { input: { taskId: string; content: string; imageUrl?: string } }) => {
    console.log('💬 tRPC: chat.send called', input.taskId);
    return { success: true, messageId: 'stub_msg_' + Date.now() };
  });
