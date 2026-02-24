/**
 * Task Batching Router v1.0.0
 *
 * tRPC router for AI-powered task batching and route optimization
 *
 * @see TaskBatchingService
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { TaskBatchingService } from '../services/TaskBatchingService';

const TaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  price: z.number(),
  location: z.string(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  estimatedDuration: z.number().optional(),
});

export const batchingRouter = router({
  /**
   * Generate batch recommendation for available tasks
   */
  generateRecommendation: protectedProcedure
    .input(z.object({
      availableTasks: z.array(TaskSchema),
      currentLocation: z.object({
        lat: z.number(),
        lng: z.number(),
      }).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const result = await TaskBatchingService.generateRecommendation(
        ctx.user.id,
        input.availableTasks,
        input.currentLocation
      );

      if (!result.success) {
        throw new Error(result.error.message);
      }

      return result.data;
    }),

  /**
   * Calculate savings for a specific set of tasks
   */
  calculateSavings: protectedProcedure
    .input(z.object({
      tasks: z.array(TaskSchema),
    }))
    .query(({ input }) => {
      return TaskBatchingService.calculateSavings(input.tasks);
    }),
});

export default batchingRouter;
