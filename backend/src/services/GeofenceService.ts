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

import { createHash } from 'node:crypto';
import { db } from '../db.js';
import type { ServiceResult } from '../types.js';

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

export interface GeofenceClientEvidence {
  clientEventId: string;
  clientSequence: number;
  priorTaskVersion: number;
  localOccurredAt: string;
  deviceVersion: string;
  appVersion: string;
  payloadHash?: string;
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
    workerLng: number,
    evidence: GeofenceClientEvidence,
  ): Promise<ServiceResult<GeofenceCheckResult>> => {
    try {
      // Get task location
      const taskResult = await db.query<{
        location_lat: number;
        location_lng: number;
        state: string;
        worker_id: string;
        progress_state: string;
        version: number;
      }>(
        `SELECT location_lat, location_lng, state, worker_id, progress_state, version
         FROM tasks WHERE id = $1`,
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return { success: false, error: { code: 'NOT_FOUND', message: 'Task not found' } };
      }

      const task = taskResult.rows[0];

      if (task.location_lat == null || task.location_lng == null) {
        return { success: false, error: { code: 'NO_LOCATION', message: 'Task has no location data' } };
      }

      // Verify this is the assigned worker
      if (task.worker_id !== userId) {
        return { success: false, error: { code: 'NOT_ASSIGNED', message: 'You are not assigned to this task' } };
      }

      // Maps & location: only when task is en-route or at location (REQUIREMENTS: EN_ROUTE only)
      const allowedProgressStates = ['ACCEPTED', 'TRAVELING', 'WORKING'];
      if (!allowedProgressStates.includes(task.progress_state)) {
        return {
          success: false,
          error: {
            code: 'INVALID_STATE',
            message: `Proximity check only allowed when task is in progress (ACCEPTED/TRAVELING/WORKING). Current: ${task.progress_state}`,
          },
        };
      }

      if (evidence.priorTaskVersion !== task.version) {
        return {
          success: false,
          error: {
            code: 'SYNC_CONFLICT',
            message: 'The task changed on the server. Refresh the task before recording presence.',
          },
        };
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

      const replayResult = await db.query<{ event_type: 'enter' | 'exit' | 'checkin'; request_hash: string }>(
        `SELECT event_type,request_hash FROM task_geofence_events
         WHERE user_id=$1 AND client_event_id=$2`,
        [userId,evidence.clientEventId],
      );
      const replay = replayResult.rows[0];
      if (replay) {
        const replayHash = createHash('sha256').update(JSON.stringify({
          taskId,
          userId,
          eventType: replay.event_type,
          distanceMeters: Math.round(distance),
          ...evidence,
        })).digest('hex');
        if (replay.request_hash !== replayHash) {
          return {
            success: false,
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'That device event was already used for different presence evidence.',
            },
          };
        }
        return {
          success: true,
          data: {
            within_geofence: withinGeofence,
            distance_meters: Math.round(distance),
            event_logged: true,
            auto_checkin_triggered: replay.event_type === 'checkin',
          },
        };
      }

      // Get last geofence event for this task/user
      const lastEventResult = await db.query<{
        event_type: string;
        client_event_id: string;
        client_sequence: number;
      }>(
        `SELECT event_type,client_event_id,client_sequence FROM task_geofence_events
         WHERE task_id = $1 AND user_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [taskId, userId]
      );

      const lastEventType = lastEventResult.rows[0]?.event_type;
      const lastClientSequence = Number(lastEventResult.rows[0]?.client_sequence ?? 0);
      if (lastEventResult.rows[0]?.client_event_id !== evidence.clientEventId
          && evidence.clientSequence <= lastClientSequence) {
        return {
          success: false,
          error: {
            code: 'SYNC_CONFLICT',
            message: 'This presence update is older than the latest accepted device event.',
          },
        };
      }

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
        const idempotencyKey = `geofence:${userId}:${evidence.clientEventId}`;
        const requestHash = createHash('sha256').update(JSON.stringify({
          taskId,
          userId,
          eventType,
          distanceMeters: Math.round(distance),
          ...evidence,
        })).digest('hex');
        const eventResult = await db.query<{
          id: string;
          request_hash: string;
          inserted: boolean;
        }>(
          `WITH inserted AS (
             INSERT INTO task_geofence_events(
               task_id,user_id,event_type,distance_meters,client_event_id,
               client_sequence,idempotency_key,request_hash,prior_task_version,
               local_occurred_at,device_version,app_version,
               reconciliation_contract_version,offline_payload_hash
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (user_id,idempotency_key) DO NOTHING
             RETURNING id,request_hash,TRUE AS inserted
           )
           SELECT id,request_hash,inserted FROM inserted
           UNION ALL
           SELECT id,request_hash,FALSE AS inserted FROM task_geofence_events
           WHERE user_id=$2 AND idempotency_key=$7
           LIMIT 1`,
          [
            taskId,userId,eventType,distance,evidence.clientEventId,evidence.clientSequence,
            idempotencyKey,requestHash,evidence.priorTaskVersion,evidence.localOccurredAt,
            evidence.deviceVersion,evidence.appVersion,
            evidence.payloadHash ? 1 : 0,evidence.payloadHash ?? null,
          ],
        );
        const storedEvent = eventResult.rows[0];
        if (!storedEvent) throw new Error('GEOFENCE_EVENT_INSERT_FAILED');
        if (!storedEvent.inserted && storedEvent.request_hash !== requestHash) {
          return {
            success: false,
            error: {
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'That device event was already used for different presence evidence.',
            },
          };
        }
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
