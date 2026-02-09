/**
 * Heat Map Router v1.0.0
 *
 * tRPC router for task heat maps and demand alerts.
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { HeatMapService } from '../services/HeatMapService';

export const heatmapRouter = router({
  getHeatMap: protectedProcedure
    .input(z.object({
      centerLat: z.number().min(-90).max(90),
      centerLng: z.number().min(-180).max(180),
      radiusMiles: z.number().min(1).max(50).optional(),
      category: z.string().optional(),
    }))
    .query(async ({ input }) => {
      return HeatMapService.getHeatMap(input);
    }),

  getDemandAlerts: protectedProcedure
    .input(z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }))
    .query(async ({ ctx, input }) => {
      return HeatMapService.getDemandAlerts(ctx.user.id, input.lat, input.lng);
    }),
});
