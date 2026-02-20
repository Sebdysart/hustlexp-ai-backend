/**
 * Instant Mode Observability Service
 * 
 * Launch Hardening v1: Logging and alerting for Instant Mode operations.
 * 
 * Must-have alerts:
 * - Instant tasks stuck > 180s (should be zero)
 * - Accept attempts rejected due to race
 * - Surge fallback rate spikes
 * - XP award failures
 * - Worker crash loops
 */

import { db } from '../db';
import { logger } from '../logger';

const log = logger.child({ service: 'InstantObservability' });

export const InstantObservability = {
  /**
   * Log Instant task lifecycle event
   * Includes all context needed to reconstruct task state
   */
  logTaskEvent: (event: {
    taskId: string;
    event: string;
    state?: string;
    surgeLevel?: number;
    trustTier?: number;
    latency?: number;
    error?: string;
    metadata?: Record<string, unknown>;
  }): void => {
    log.info({
      taskId: event.taskId,
      state: event.state,
      surgeLevel: event.surgeLevel,
      trustTier: event.trustTier,
      latency: event.latency,
      err: event.error,
      ...event.metadata,
    }, event.event);
  },

  /**
   * Check for stuck Instant tasks (> 180s in MATCHING)
   * Should be called periodically (e.g., every minute)
   */
  checkStuckTasks: async (): Promise<{
    stuckCount: number;
    stuckTasks: Array<{ taskId: string; elapsedSeconds: number; surgeLevel: number }>;
  }> => {
    const result = await db.query<{
      id: string;
      matched_at: Date;
      surge_level: number;
      elapsed_seconds: number;
    }>(
      `SELECT 
         id,
         matched_at,
         surge_level,
         EXTRACT(EPOCH FROM (NOW() - matched_at))::INTEGER as elapsed_seconds
       FROM tasks
       WHERE instant_mode = TRUE
         AND state = 'MATCHING'
         AND matched_at IS NOT NULL
         AND accepted_at IS NULL
         AND EXTRACT(EPOCH FROM (NOW() - matched_at)) > 180
       ORDER BY matched_at ASC`,
      []
    );

    const stuckTasks = result.rows.map(row => ({
      taskId: row.id,
      elapsedSeconds: row.elapsed_seconds,
      surgeLevel: row.surge_level,
    }));

    if (stuckTasks.length > 0) {
      log.error({ stuckTasks, alert: 'INSTANT_TASKS_STUCK' }, `${stuckTasks.length} Instant tasks stuck > 180s`);
    }

    return {
      stuckCount: stuckTasks.length,
      stuckTasks,
    };
  },

  /**
   * Track accept race condition (rejected due to already accepted)
   * This indicates high contention
   */
  logAcceptRace: (taskId: string, workerId: string, reason: string): void => {
    log.warn({ taskId, workerId, reason, alert: 'INSTANT_ACCEPT_RACE' }, 'Accept race condition detected');
  },

  /**
   * Track surge fallback rate (tasks that fall back to OPEN)
   * High fallback rate indicates liquidity issues
   */
  logSurgeFallback: (taskId: string, elapsedSeconds: number): void => {
    log.warn({ taskId, elapsedSeconds, alert: 'INSTANT_SURGE_FALLBACK' }, 'Surge fallback to OPEN');
  },

  /**
   * Track XP award failures for Instant tasks
   */
  logXPFailure: (taskId: string, hustlerId: string, error: string): void => {
    log.error({ taskId, hustlerId, err: error, alert: 'INSTANT_XP_AWARD_FAILED' }, 'XP award failed for Instant task');
  },
};
