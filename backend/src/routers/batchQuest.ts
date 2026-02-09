/**
 * Batch Questing Router v1.0.0
 *
 * tRPC router for nearby task suggestions and route optimization.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { BatchQuestingService } from '../services/BatchQuestingService';

export const batchQuestRouter = router({
  getSuggestions: protectedProcedure
    .input(z.object({
      currentTaskId: z.string().uuid(),
      maxResults: z.number().int().min(1).max(10).optional(),
      maxDistanceMeters: z.number().int().min(500).max(50000).optional(),
    }))
    .query(async ({ ctx, input }) => {
      return BatchQuestingService.getSuggestions({
        currentTaskId: input.currentTaskId,
        workerId: ctx.user.id,
        maxResults: input.maxResults,
        maxDistanceMeters: input.maxDistanceMeters,
      });
    }),

  buildRoute: protectedProcedure
    .input(z.object({
      taskIds: z.array(z.string().uuid()).min(1).max(10),
    }))
    .query(async ({ input }) => {
      return BatchQuestingService.buildRoute(input.taskIds);
    }),
});
