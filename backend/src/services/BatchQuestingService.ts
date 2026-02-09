/**
 * BatchQuestingService v1.0.0
 *
 * CONSTITUTIONAL: Batch questing / route optimization (Gap 10 fix)
 *
 * Suggests nearby tasks to workers after they accept a task:
 * "If you take this Leaf Raking job, there is a Grocery Haul
 * quest right next door that starts in 45 minutes."
 *
 * Uses PostGIS for proximity queries and time-window matching.
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface NearbyTaskSuggestion {
  task_id: string;
  title: string;
  price_cents: number;
  distance_meters: number;
  estimated_travel_minutes: number;
  category: string;
  deadline: Date | null;
  match_reason: string;
}

interface BatchRoute {
  tasks: NearbyTaskSuggestion[];
  total_earnings_cents: number;
  total_distance_meters: number;
  estimated_total_hours: number;
}

// ============================================================================
// SERVICE
// ============================================================================

export const BatchQuestingService = {
  /**
   * Get nearby task suggestions for a worker who just accepted a task
   * "Take this one next — it's right around the corner"
   */
  getSuggestions: async (params: {
    currentTaskId: string;
    workerId: string;
    maxResults?: number;
    maxDistanceMeters?: number;
  }): Promise<ServiceResult<NearbyTaskSuggestion[]>> => {
    try {
      const { currentTaskId, workerId, maxResults = 5, maxDistanceMeters = 3000 } = params;

      // Get current task location and worker's skills
      const taskResult = await db.query<{
        location_lat: number;
        location_lng: number;
        category: string;
      }>(
        `SELECT location_lat, location_lng, category FROM tasks WHERE id = $1`,
        [currentTaskId]
      );

      if (taskResult.rows.length === 0 || !taskResult.rows[0].location_lat) {
        return { success: true, data: [] }; // No location = no suggestions
      }

      const currentTask = taskResult.rows[0];

      // Get worker's skills for matching
      const workerSkills = await db.query<{ skill_id: string }>(
        `SELECT skill_id FROM worker_skills WHERE user_id = $1 AND (verified = TRUE OR EXISTS (
           SELECT 1 FROM skills s WHERE s.id = worker_skills.skill_id AND s.gate_type = 'soft'
         ))`,
        [workerId]
      );

      const skillIds = workerSkills.rows.map(r => r.skill_id);

      // Find nearby open tasks that the worker is eligible for
      const result = await db.query<NearbyTaskSuggestion>(
        `SELECT
           t.id AS task_id,
           t.title,
           t.price AS price_cents,
           ST_Distance(
             ST_MakePoint(t.location_lng, t.location_lat)::geography,
             ST_MakePoint($1, $2)::geography
           ) AS distance_meters,
           -- Rough travel estimate: walking at 5km/h
           ROUND(ST_Distance(
             ST_MakePoint(t.location_lng, t.location_lat)::geography,
             ST_MakePoint($1, $2)::geography
           ) / 83.33) AS estimated_travel_minutes,
           t.category,
           t.deadline,
           CASE
             WHEN t.category = $4 THEN 'Same category as current task'
             ELSE 'Nearby task'
           END AS match_reason
         FROM tasks t
         WHERE t.state = 'OPEN'
           AND t.id != $3
           AND t.poster_id != $5
           AND t.location_lat IS NOT NULL
           AND ST_DWithin(
             ST_MakePoint(t.location_lng, t.location_lat)::geography,
             ST_MakePoint($1, $2)::geography,
             $6
           )
           -- Skill eligibility check
           AND (
             NOT EXISTS (SELECT 1 FROM task_skills ts WHERE ts.task_id = t.id)
             OR NOT EXISTS (
               SELECT 1 FROM task_skills ts
               JOIN skills s ON s.id = ts.skill_id
               WHERE ts.task_id = t.id
               AND ts.skill_id NOT IN (SELECT unnest($7::uuid[]))
             )
           )
         ORDER BY distance_meters ASC
         LIMIT $8`,
        [
          currentTask.location_lng,
          currentTask.location_lat,
          currentTaskId,
          currentTask.category,
          workerId,
          maxDistanceMeters,
          skillIds,
          maxResults,
        ]
      );

      return { success: true, data: result.rows };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Build an optimized route for multiple tasks
   * Returns tasks in optimal completion order
   */
  buildRoute: async (taskIds: string[]): Promise<ServiceResult<BatchRoute>> => {
    try {
      if (taskIds.length === 0) {
        return {
          success: true,
          data: { tasks: [], total_earnings_cents: 0, total_distance_meters: 0, estimated_total_hours: 0 },
        };
      }

      // Get all task details
      const result = await db.query<{
        id: string;
        title: string;
        price: number;
        location_lat: number;
        location_lng: number;
        category: string;
        deadline: Date | null;
      }>(
        `SELECT id, title, price, location_lat, location_lng, category, deadline
         FROM tasks WHERE id = ANY($1) AND location_lat IS NOT NULL
         ORDER BY deadline ASC NULLS LAST`,
        [taskIds]
      );

      // Simple nearest-neighbor routing
      const tasks: NearbyTaskSuggestion[] = [];
      let totalDistance = 0;
      let totalEarnings = 0;
      const remaining = [...result.rows];

      // Start from first task
      let current = remaining.shift();
      if (!current) {
        return {
          success: true,
          data: { tasks: [], total_earnings_cents: 0, total_distance_meters: 0, estimated_total_hours: 0 },
        };
      }

      tasks.push({
        task_id: current.id,
        title: current.title,
        price_cents: current.price,
        distance_meters: 0,
        estimated_travel_minutes: 0,
        category: current.category,
        deadline: current.deadline,
        match_reason: 'Starting task',
      });
      totalEarnings += current.price;

      // Greedy nearest-neighbor for remaining tasks
      while (remaining.length > 0) {
        let nearestIdx = 0;
        let nearestDist = Infinity;

        for (let i = 0; i < remaining.length; i++) {
          const dist = haversineDistance(
            current!.location_lat, current!.location_lng,
            remaining[i].location_lat, remaining[i].location_lng
          );
          if (dist < nearestDist) {
            nearestDist = dist;
            nearestIdx = i;
          }
        }

        current = remaining.splice(nearestIdx, 1)[0];
        totalDistance += nearestDist;
        totalEarnings += current.price;

        tasks.push({
          task_id: current.id,
          title: current.title,
          price_cents: current.price,
          distance_meters: Math.round(nearestDist),
          estimated_travel_minutes: Math.round(nearestDist / 83.33), // walking 5km/h
          category: current.category,
          deadline: current.deadline,
          match_reason: 'Route optimized',
        });
      }

      return {
        success: true,
        data: {
          tasks,
          total_earnings_cents: totalEarnings,
          total_distance_meters: Math.round(totalDistance),
          estimated_total_hours: Math.round((totalDistance / 5000) * 10) / 10, // 5km/h walking
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'ROUTE_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },
};

function haversineDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default BatchQuestingService;
