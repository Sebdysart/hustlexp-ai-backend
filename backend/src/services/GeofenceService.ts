/**
 * GeofenceService v1.0.0
 *
 * CONSTITUTIONAL: Geofenced auto check-in/check-out (Gap 8 fix)
 *
 * Uses PostGIS ST_DWithin to detect when workers enter/exit task geofences.
 * Auto-starts "work clock" when worker is at task location. Provides fraud
 * signal if worker claims completion without being physically present.
 *
 * @see PostGIS documentation for spatial queries
 */

import { db } from '../db';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface GeofenceCheckResult {
  within_geofence: boolean;
  distance_meters: number;
  event_logged: boolean;
  auto_checkin_triggered: boolean;
}

interface GeofenceEvent {
  id: string;
  task_id: string;
  user_id: string;
  event_type: 'enter' | 'exit' | 'checkin' | 'checkout';
  distance_meters: number;
  created_at: Date;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const GEOFENCE_RADIUS_METERS = 150; // 150m radius = "at the task location"
const CHECKIN_RADIUS_METERS = 50; // 50m radius = precise check-in
const EXIT_RADIUS_METERS = 300; // 300m = considered "left the area"

// ============================================================================
// SERVICE
// ============================================================================

export const GeofenceService = {
  /**
   * Check worker's proximity to task and auto-trigger events
   * Called when worker's GPS updates (via mobile app background location)
   */
  checkProximity: async (
    taskId: string,
    userId: string,
    workerLat: number,
    workerLng: number
  ): Promise<ServiceResult<GeofenceCheckResult>> => {
    try {
      // Get task location
      const taskResult = await db.query<{
        location_lat: number;
        location_lng: number;
        state: string;
        worker_id: string;
        progress_state: string;
      }>(
        `SELECT location_lat, location_lng, state, worker_id, progress_state
         FROM tasks WHERE id = $1`,
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found' } };
      }

      const task = taskResult.rows[0];

      if (!task.location_lat || !task.location_lng) {
        return { success: false, error: { code: 'NO_LOCATION', message: 'Task has no location data' } };
      }

      // Verify this is the assigned worker
      if (task.worker_id !== userId) {
        return { success: false, error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this task' } };
      }

      // Calculate distance using PostGIS
      const distResult = await db.query<{ distance_meters: number }>(
        `SELECT ST_Distance(
           ST_MakePoint($1, $2)::geography,
           ST_MakePoint($3, $4)::geography
         ) AS distance_meters`,
        [workerLng, workerLat, task.location_lng, task.location_lat]
      );

      const distance = distResult.rows[0]?.distance_meters || 99999;
      const withinGeofence = distance <= GEOFENCE_RADIUS_METERS;
      let autoCheckinTriggered = false;

      // Get last geofence event for this task/user
      const lastEventResult = await db.query<{ event_type: string }>(
        `SELECT event_type FROM task_geofence_events
         WHERE task_id = $1 AND user_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [taskId, userId]
      );

      const lastEventType = lastEventResult.rows[0]?.event_type;

      // Determine what event to log
      let eventType: 'enter' | 'exit' | 'checkin' | null = null;

      if (withinGeofence && lastEventType !== 'enter' && lastEventType !== 'checkin') {
        eventType = 'enter';

        // Auto check-in if within precise radius and task is ACCEPTED
        if (distance <= CHECKIN_RADIUS_METERS && task.state === 'ACCEPTED') {
          eventType = 'checkin';
          autoCheckinTriggered = true;
        }
      } else if (!withinGeofence && distance > EXIT_RADIUS_METERS && (lastEventType === 'enter' || lastEventType === 'checkin')) {
        eventType = 'exit';
      }

      // Log event
      let eventLogged = false;
      if (eventType) {
        await db.query(
          `INSERT INTO task_geofence_events (task_id, user_id, event_type, location_lat, location_lng, distance_meters)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [taskId, userId, eventType, workerLat, workerLng, distance]
        );
        eventLogged = true;
      }

      return {
        success: true,
        data: {
          within_geofence: withinGeofence,
          distance_meters: Math.round(distance),
          event_logged: eventLogged,
          auto_checkin_triggered: autoCheckinTriggered,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'GEOFENCE_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },

  /**
   * Get geofence event history for a task
   */
  getTaskEvents: async (taskId: string): Promise<ServiceResult<GeofenceEvent[]>> => {
    try {
      const result = await db.query<GeofenceEvent>(
        `SELECT * FROM task_geofence_events
         WHERE task_id = $1
         ORDER BY created_at ASC`,
        [taskId]
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
   * Verify worker was physically present during task completion
   * Used by proof verification to add confidence to completion claims
   */
  verifyPresenceDuringTask: async (taskId: string, userId: string): Promise<ServiceResult<{
    was_present: boolean;
    checkin_count: number;
    total_time_at_location_minutes: number;
  }>> => {
    try {
      const events = await db.query<GeofenceEvent>(
        `SELECT * FROM task_geofence_events
         WHERE task_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [taskId, userId]
      );

      let checkinCount = 0;
      let totalTimeMs = 0;
      let lastEnterTime: Date | null = null;

      for (const event of events.rows) {
        if (event.event_type === 'enter' || event.event_type === 'checkin') {
          lastEnterTime = new Date(event.created_at);
          if (event.event_type === 'checkin') checkinCount++;
        } else if (event.event_type === 'exit' && lastEnterTime) {
          totalTimeMs += new Date(event.created_at).getTime() - lastEnterTime.getTime();
          lastEnterTime = null;
        }
      }

      // If still at location (no exit event), count until now
      if (lastEnterTime) {
        totalTimeMs += Date.now() - lastEnterTime.getTime();
      }

      return {
        success: true,
        data: {
          was_present: checkinCount > 0 || events.rows.length > 0,
          checkin_count: checkinCount,
          total_time_at_location_minutes: Math.round(totalTimeMs / 60000),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: 'DB_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  },
};

export default GeofenceService;
