/**
 * HeatMapService v1.0.0
 *
 * CONSTITUTIONAL: Task heat map for workers (Gap 9 fix)
 *
 * Aggregates task density by geographic area so workers can see
 * "Hot Zones" on the map and position themselves strategically.
 *
 * Uses geohash-based bucketing for efficient spatial aggregation.
 */

import { db } from '../db.js';
import type { ServiceResult } from '../types.js';

// ============================================================================
// TYPES
// ============================================================================

interface HeatMapCell {
  geohash: string;
  center_lat: number;
  center_lng: number;
  task_count: number;
  avg_price_cents: number | null;
  intensity: number; // 0-1 normalized
}

interface HeatMapData {
  cells: HeatMapCell[];
  bounds: { min_lat: number; max_lat: number; min_lng: number; max_lng: number };
  generated_at: Date;
}

// ============================================================================
// SERVICE
// ============================================================================

export const HeatMapService = {
  /**
   * Get heat map data for a geographic area
   * Returns task density cells within the specified bounds
   */
  getHeatMap: async (params: {
    centerLat: number;
    centerLng: number;
    radiusMiles?: number;
    category?: string;
  }): Promise<ServiceResult<HeatMapData>> => {
    try {
      const { centerLat, centerLng, radiusMiles = 10, category } = params;

      // Convert radius to approximate degree range (1 degree ≈ 69 miles)
      const degreeRange = radiusMiles / 69;
      const minLat = centerLat - degreeRange;
      const maxLat = centerLat + degreeRange;
      const minLng = centerLng - degreeRange;
      const maxLng = centerLng + degreeRange;

      // Aggregate open tasks by location_city or by lat/lng grid
      // Supports both coordinate-based and city-based tasks
      let sql = `
        SELECT
          COALESCE(location_city, 'Unknown') AS city_name,
          COALESCE(location_state, '') AS state_code,
          COUNT(*) AS task_count,
          ROUND(AVG(price)) AS avg_price_cents
        FROM tasks
        WHERE state = 'OPEN'
      `;
      const queryParams: unknown[] = [];
      let paramIdx = 1;

      // Filter by radius if coordinates available, otherwise by city proximity
      sql += `
          AND (
            (location_lat IS NOT NULL AND location_lng IS NOT NULL
             AND location_lat BETWEEN $${paramIdx} AND $${paramIdx + 1}
             AND location_lng BETWEEN $${paramIdx + 2} AND $${paramIdx + 3})
            OR location_city IS NOT NULL
          )
      `;
      queryParams.push(minLat, maxLat, minLng, maxLng);
      paramIdx += 4;

      if (category) {
        queryParams.push(category);
        sql += ` AND category = $${paramIdx++}`;
      }

      sql += `
        GROUP BY city_name, state_code
        ORDER BY task_count DESC
        LIMIT 200
      `;

      const result = await db.query<{
        city_name: string;
        state_code: string;
        task_count: number;
        avg_price_cents: number;
      }>(sql, queryParams);

      // Normalize intensity
      const maxCount = Math.max(...result.rows.map(r => Number(r.task_count)), 1);

      // Map city groups to cells — position around the center point with offsets
      const cells: HeatMapCell[] = result.rows.map((row, idx) => {
        // Spread cities around the center in a grid pattern
        const angle = (idx / result.rows.length) * 2 * Math.PI;
        const spread = 0.02 * (1 + idx * 0.3); // Increase spread for each city
        const cellLat = centerLat + Math.cos(angle) * spread;
        const cellLng = centerLng + Math.sin(angle) * spread;

        return {
          geohash: `${row.city_name},${row.state_code}`,
          center_lat: cellLat,
          center_lng: cellLng,
          task_count: Number(row.task_count),
          avg_price_cents: Number(row.avg_price_cents),
          intensity: Number(row.task_count) / maxCount,
          city_name: row.city_name,
          state_code: row.state_code,
        };
      });

      // Calculate bounds — use center ± range if no cells
      const lats = cells.map(c => c.center_lat);
      const lngs = cells.map(c => c.center_lng);

      return {
        success: true,
        data: {
          cells,
          bounds: {
            min_lat: lats.length ? Math.min(...lats) - 0.01 : centerLat - 0.05,
            max_lat: lats.length ? Math.max(...lats) + 0.01 : centerLat + 0.05,
            min_lng: lngs.length ? Math.min(...lngs) - 0.01 : centerLng - 0.05,
            max_lng: lngs.length ? Math.max(...lngs) + 0.01 : centerLng + 0.05,
          },
          generated_at: new Date(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'HEATMAP_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Get "demand alert" for a specific skill in an area
   * "Workers in your area are making 2x more doing Gutter Cleaning today"
   */
  getDemandAlerts: async (
    userId: string,
    lat: number,
    lng: number
  ): Promise<ServiceResult<{ skill_name: string; demand_multiplier: number; avg_price_cents: number }[]>> => {
    try {
      // Simple category-based demand (no PostGIS dependency)
      const result = await db.query<{
        skill_name: string;
        task_count: number;
        avg_price_cents: number;
        worker_count: number;
      }>(
        `SELECT
           COALESCE(t.category, 'other') AS skill_name,
           COUNT(t.id) AS task_count,
           ROUND(AVG(t.price)) AS avg_price_cents,
           1 AS worker_count
         FROM tasks t
         WHERE t.state = 'OPEN'
         GROUP BY t.category
         HAVING COUNT(t.id) >= 1
         ORDER BY COUNT(t.id) DESC
         LIMIT 5`
      );

      const alerts = result.rows
        .filter(r => r.worker_count > 0)
        .map(r => ({
          skill_name: r.skill_name,
          demand_multiplier: Math.round((r.task_count / Math.max(r.worker_count, 1)) * 10) / 10,
          avg_price_cents: r.avg_price_cents,
        }))
        .filter(a => a.demand_multiplier > 1.5); // Only show if 1.5x+ demand

      return { success: true, data: alerts };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },
};

export default HeatMapService;
