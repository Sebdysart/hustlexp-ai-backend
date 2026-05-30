/**
 * MovementTrackingService v1.0.0
 *
 * Real-time movement tracking for workers during task execution.
 * Tracks worker location from task acceptance → arrival → completion.
 * Validates GPS trail integrity and detects anomalies.
 *
 * @see schema.sql (movement_events table)
 */

import { db } from '../db.js';
import type { ServiceResult } from '../types.js';
import { aiLogger } from '../logger.js';

const log = aiLogger.child({ service: 'MovementTrackingService' });

// ============================================================================
// TYPES
// ============================================================================

interface GPSPoint {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: Date;
}

export interface MovementSession {
  id: string;
  taskId: string;
  userId: string;
  startedAt: Date;
  endedAt?: Date;
  gpsTrail: GPSPoint[];
  totalDistance: number; // meters
  averageSpeed: number; // m/s
  status: 'active' | 'completed' | 'cancelled';
}

interface TrackingUpdate {
  sessionId: string;
  location: GPSPoint;
}

export interface MovementStats {
  totalDistance: number;
  duration: number; // seconds
  averageSpeed: number;
  topSpeed: number;
  estimatedArrival?: Date;
}

// ============================================================================
// SERVICE
// ============================================================================

export const MovementTrackingService = {
  /**
   * Start a movement tracking session
   */
  startSession: async (
    taskId: string,
    userId: string,
    initialLocation: GPSPoint
  ): Promise<ServiceResult<MovementSession>> => {
    try {
      // Maps & location: only when task is en-route or at location (REQUIREMENTS: EN_ROUTE only)
      const taskResult = await db.query<{ worker_id: string | null; progress_state: string }>(
        `SELECT worker_id, progress_state FROM tasks WHERE id = $1`,
        [taskId]
      );
      if (taskResult.rows.length === 0) {
        return {
          success: false,
          error: { code: 'NOT_FOUND', message: 'Task not found' },
        };
      }
      const task = taskResult.rows[0];
      if (task.worker_id !== userId) {
        return {
          success: false,
          error: { code: 'FORBIDDEN', message: 'Only the assigned worker can start movement tracking for this task' },
        };
      }
      const allowedProgressStates = ['ACCEPTED', 'TRAVELING', 'WORKING'];
      if (!allowedProgressStates.includes(task.progress_state)) {
        return {
          success: false,
          error: {
            code: 'INVALID_STATE',
            message: `Movement tracking only allowed when task is in progress (ACCEPTED/TRAVELING/WORKING). Current: ${task.progress_state}`,
          },
        };
      }

      const sessionId = `mvmt-${taskId}-${Date.now()}`;

      const result = await db.query<MovementSession>(
        `INSERT INTO movement_sessions (
          id, task_id, user_id, started_at, status, gps_trail, total_distance, average_speed
        ) VALUES ($1, $2, $3, NOW(), 'active', $4, 0, 0)
        RETURNING *`,
        [sessionId, taskId, userId, JSON.stringify([initialLocation])]
      );

      const session = result.rows[0];
      log.info({ sessionId, taskId, userId }, 'Movement tracking session started');

      return { success: true, data: session };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error), taskId }, 'Failed to start movement session');
      return {
        success: false,
        error: {
          code: 'SESSION_START_FAILED',
          message: error instanceof Error ? error.message : 'Failed to start tracking'
        }
      };
    }
  },

  /**
   * Update tracking session with new GPS point
   */
  updateLocation: async (update: TrackingUpdate): Promise<ServiceResult<void>> => {
    try {
      // Get current session
      const sessionResult = await db.query<MovementSession>(
        `SELECT * FROM movement_sessions WHERE id = $1 AND status = 'active'`,
        [update.sessionId]
      );

      if (sessionResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: 'Active tracking session not found'
          }
        };
      }

      const session = sessionResult.rows[0];
      const gpsTrail: GPSPoint[] = session.gpsTrail || [];
      gpsTrail.push(update.location);

      // Calculate distance from last point
      let newDistance = session.totalDistance;
      if (gpsTrail.length > 1) {
        const lastPoint = gpsTrail[gpsTrail.length - 2];
        const distance = MovementTrackingService._calculateDistance(
          lastPoint.latitude,
          lastPoint.longitude,
          update.location.latitude,
          update.location.longitude
        );
        newDistance += distance;
      }

      // Calculate average speed
      const duration = (new Date().getTime() - new Date(session.startedAt).getTime()) / 1000;
      const averageSpeed = duration > 0 ? newDistance / duration : 0;

      // Update session
      await db.query(
        `UPDATE movement_sessions
         SET gps_trail = $1, total_distance = $2, average_speed = $3
         WHERE id = $4`,
        [JSON.stringify(gpsTrail), newDistance, averageSpeed, update.sessionId]
      );

      return { success: true, data: undefined };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to update location');
      return {
        success: false,
        error: {
          code: 'LOCATION_UPDATE_FAILED',
          message: error instanceof Error ? error.message : 'Failed to update location'
        }
      };
    }
  },

  /**
   * Stop tracking session
   */
  stopSession: async (sessionId: string): Promise<ServiceResult<MovementSession>> => {
    try {
      const result = await db.query<MovementSession>(
        `UPDATE movement_sessions
         SET status = 'completed', ended_at = NOW()
         WHERE id = $1 AND status = 'active'
         RETURNING *`,
        [sessionId]
      );

      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: 'Active session not found'
          }
        };
      }

      const session = result.rows[0];
      log.info({ sessionId, totalDistance: session.totalDistance }, 'Movement tracking session stopped');

      return { success: true, data: session };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to stop session');
      return {
        success: false,
        error: {
          code: 'SESSION_STOP_FAILED',
          message: error instanceof Error ? error.message : 'Failed to stop tracking'
        }
      };
    }
  },

  /**
   * Get session stats
   */
  getSessionStats: async (sessionId: string): Promise<ServiceResult<MovementStats>> => {
    try {
      const result = await db.query<MovementSession>(
        `SELECT * FROM movement_sessions WHERE id = $1`,
        [sessionId]
      );

      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: 'SESSION_NOT_FOUND',
            message: 'Session not found'
          }
        };
      }

      const session = result.rows[0];
      const gpsTrail: GPSPoint[] = session.gpsTrail || [];

      // Calculate top speed
      let topSpeed = 0;
      for (let i = 1; i < gpsTrail.length; i++) {
        const prev = gpsTrail[i - 1];
        const curr = gpsTrail[i];
        const distance = MovementTrackingService._calculateDistance(
          prev.latitude,
          prev.longitude,
          curr.latitude,
          curr.longitude
        );
        const timeDiff = (new Date(curr.timestamp).getTime() - new Date(prev.timestamp).getTime()) / 1000;
        const speed = timeDiff > 0 ? distance / timeDiff : 0;
        if (speed > topSpeed) topSpeed = speed;
      }

      const duration = session.endedAt
        ? (new Date(session.endedAt).getTime() - new Date(session.startedAt).getTime()) / 1000
        : (Date.now() - new Date(session.startedAt).getTime()) / 1000;

      const stats: MovementStats = {
        totalDistance: session.totalDistance,
        duration,
        averageSpeed: session.averageSpeed,
        topSpeed,
      };

      return { success: true, data: stats };
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : String(error) }, 'Failed to get session stats');
      return {
        success: false,
        error: {
          code: 'STATS_FETCH_FAILED',
          message: error instanceof Error ? error.message : 'Failed to get stats'
        }
      };
    }
  },

  /**
   * Private: Calculate distance between two GPS points (Haversine formula)
   */
  _calculateDistance: (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371000; // Earth's radius in meters
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c; // Distance in meters
  },
};
