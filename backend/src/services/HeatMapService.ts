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

import { db } from '../db';
import type { ServiceResult } from '../types';

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
      const radiusMeters = radiusMiles * 1609.34;

      // Aggregate open tasks by approximate area (0.01 degree grid ≈ 1km)
      let sql = `
        SELECT
          ROUND(location_lat::numeric, 2) AS center_lat,
          ROUND(location_lng::numeric, 2) AS center_lng,
          CONCAT(ROUND(location_lat::numeric, 2)::text, ',', ROUND(location_lng::numeric, 2)::text) AS geohash,
          COUNT(*) AS task_count,
          ROUND(AVG(price)) AS avg_price_cents
        FROM tasks
        WHERE state = 'OPEN'
          AND location_lat IS NOT NULL
          AND location_lng IS NOT NULL
          AND ST_DWithin(
            ST_MakePoint(location_lng, location_lat)::geography,
            ST_MakePoint($1, $2)::geography,
            $3
          )
      `;
      const queryParams: unknown[] = [centerLng, centerLat, radiusMeters];

      if (category) {
        queryParams.push(category);
        sql += ` AND category = $${queryParams.length}`;
      }

      sql += `
        GROUP BY center_lat, center_lng, geohash
        ORDER BY task_count DESC
        LIMIT 200
      `;

      const result = await db.query<{
        center_lat: number;
        center_lng: number;
        geohash: string;
        task_count: number;
        avg_price_cents: number;
      }>(sql, queryParams);

      // Normalize intensity (0-1 based on max task count)
      const maxCount = Math.max(...result.rows.map(r => r.task_count), 1);

      const cells: HeatMapCell[] = result.rows.map(row => ({
        geohash: row.geohash,
        center_lat: row.center_lat,
        center_lng: row.center_lng,
        task_count: row.task_count,
        avg_price_cents: row.avg_price_cents,
        intensity: row.task_count / maxCount,
      }));

      // Calculate bounds
      const lats = cells.map(c => c.center_lat);
      const lngs = cells.map(c => c.center_lng);

      return {
        success: true,
        data: {
          cells,
          bounds: {
            min_lat: lats.length ? Math.min(...lats) : centerLat - 0.1,
            max_lat: lats.length ? Math.max(...lats) : centerLat + 0.1,
            min_lng: lngs.length ? Math.min(...lngs) : centerLng - 0.1,
            max_lng: lngs.length ? Math.max(...lngs) : centerLng + 0.1,
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
      const result = await db.query<{
        skill_name: string;
        task_count: number;
        avg_price_cents: number;
        worker_count: number;
      }>(
        `SELECT
           s.display_name AS skill_name,
           COUNT(t.id) AS task_count,
           ROUND(AVG(t.price)) AS avg_price_cents,
           (SELECT COUNT(*) FROM worker_skills ws2
            WHERE ws2.skill_id = s.id AND ws2.verified = TRUE) AS worker_count
         FROM tasks t
         JOIN task_skills ts ON ts.task_id = t.id
         JOIN skills s ON s.id = ts.skill_id
         WHERE t.state = 'OPEN'
           AND t.location_lat IS NOT NULL
           AND ST_DWithin(
             ST_MakePoint(t.location_lng, t.location_lat)::geography,
             ST_MakePoint($1, $2)::geography,
             16094  -- 10 miles
           )
         GROUP BY s.id, s.display_name
         HAVING COUNT(t.id) >= 3
         ORDER BY COUNT(t.id) DESC
         LIMIT 5`,
        [lng, lat]
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
