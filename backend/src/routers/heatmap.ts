/**
 * Heat Map Router v1.0.0
 *
 * tRPC router for task heat maps and demand alerts.
 */

import { z } from 'zod';
import { router, hustlerProcedure } from '../trpc.js';
import { HeatMapService } from '../services/HeatMapService.js';

export const heatmapRouter = router({
  getHeatMap: hustlerProcedure
    .input(z.object({
      centerLat: z.number().min(-90).max(90),
      centerLng: z.number().min(-180).max(180),
      radiusMiles: z.number().min(1).max(50).optional(),
      category: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const result = await HeatMapService.getHeatMap(input);
      if (!result.success) {
        return { zones: [], bounds: null, generatedAt: new Date() };
      }
      // Map cells to zones format expected by iOS frontend
      return {
        zones: result.data.cells.map(cell => ({
          id: cell.geohash,
          centerLat: cell.center_lat,
          centerLng: cell.center_lng,
          radiusMeters: 500,
          intensity: cell.intensity,
          taskCount: cell.task_count,
          averagePaymentCents: cell.avg_price_cents,
          cityName: (cell as any).city_name ?? null,
          stateCode: (cell as any).state_code ?? null,
        })),
        bounds: result.data.bounds,
        generatedAt: result.data.generated_at,
      };
    }),

  getDemandAlerts: hustlerProcedure
    .input(z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }))
    .query(async ({ ctx, input }) => {
      return HeatMapService.getDemandAlerts(ctx.user.id, input.lat, input.lng);
    }),
});
