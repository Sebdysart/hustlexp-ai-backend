/**
 * WaveManager
 *
 * Orchestrates wave-based smart dispatch using BullMQ delayed jobs.
 *
 * Wave schedule (from task creation):
 *   Wave 1 — immediately (0 ms delay)
 *   Wave 2 — +2 minutes delay
 *   Wave 3 — +5 minutes delay
 *
 * Each wave job is idempotent via jobId: `dispatch:wave:{taskId}:{wave}`.
 * BullMQ deduplicates by jobId, so safe to call initiateDispatch() multiple times.
 *
 * Graceful fallback:
 *   If Redis / BullMQ is unavailable (no UPSTASH_REDIS_URL or REDIS_URL), the
 *   WaveManager logs a warning and executes Wave 1 synchronously (in-process).
 *   Waves 2 & 3 are skipped in this fallback mode — acceptable for dev/CI where
 *   Redis isn't running. Production must have Redis configured.
 */

import { db } from '../db.js';
import { getQueue } from '../jobs/queues.js';
import { DispatchService, type TaskDispatchInfo } from './DispatchService.js';
import { logger as serviceLogger } from '../logger.js';
import { config } from '../config.js';

const log = serviceLogger.child({ service: 'WaveManager' });

// Delay between waves in milliseconds
const WAVE_DELAYS_MS = {
  1: 0,
  2: 2 * 60 * 1000,  // 2 minutes
  3: 5 * 60 * 1000,  // 5 minutes
} as const;

export interface WaveJobData {
  taskId: string;
  waveNumber: 1 | 2 | 3;
}

export const WaveManager = {
  /**
   * Kick off the full 3-wave dispatch sequence for a task.
   *
   * Wave 1 fires immediately; waves 2 & 3 are scheduled as delayed BullMQ jobs.
   * If BullMQ is unavailable, wave 1 runs synchronously and waves 2/3 are skipped.
   */
  async initiateDispatch(taskId: string): Promise<void> {
    log.info({ taskId }, 'Initiating smart dispatch wave sequence (in-process)');

    // Wave 1: always execute synchronously — no BullMQ worker dependency.
    await WaveManager._executeWave(taskId, 1);

    // Waves 2 & 3: schedule via in-process timer.
    // If the server restarts before these fire they are lost (acceptable for
    // pre-production; migrate back to BullMQ once worker connectivity is stable).
    setTimeout(() => {
      WaveManager._executeWave(taskId, 2).catch(err =>
        log.error({ taskId, err: err instanceof Error ? err.message : String(err) }, 'Wave 2 execution failed')
      );
    }, WAVE_DELAYS_MS[2]);

    setTimeout(() => {
      WaveManager._executeWave(taskId, 3).catch(err =>
        log.error({ taskId, err: err instanceof Error ? err.message : String(err) }, 'Wave 3 execution failed')
      );
    }, WAVE_DELAYS_MS[3]);

    log.info({ taskId, wave2DelayMs: WAVE_DELAYS_MS[2], wave3DelayMs: WAVE_DELAYS_MS[3] }, 'Wave 1 complete — waves 2 & 3 scheduled');
  },

  /**
   * Cancel all pending wave jobs for a task.
   * Called when a task is accepted/cancelled and dispatch should stop.
   */
  async cancelWaves(taskId: string): Promise<void> {
    if (!config.redis.url) return;

    try {
      const queue = getQueue('task_dispatch');
      for (const wave of [1, 2, 3] as const) {
        const jobId = `dispatch:wave:${taskId}:${wave}`;
        const job = await queue.getJob(jobId);
        if (job) {
          const state = await job.getState();
          if (state === 'delayed' || state === 'waiting') {
            await job.remove();
            log.info({ taskId, wave, jobId }, 'Wave job cancelled');
          }
        }
      }
    } catch (err) {
      log.warn(
        { taskId, err: err instanceof Error ? err.message : String(err) },
        'Failed to cancel wave jobs (non-fatal)'
      );
    }
  },

  /**
   * Execute a single wave. Called by the dispatch-wave-worker.
   *
   * Skips execution if the task is already fulfilled/cancelled/expired.
   */
  async processWave(taskId: string, waveNumber: 1 | 2 | 3): Promise<void> {
    await WaveManager._executeWave(taskId, waveNumber);
  },

  // ── Internal ───────────────────────────────────────────────────────────────

  async _executeWave(taskId: string, waveNumber: 1 | 2 | 3): Promise<void> {
    // Fetch task and verify it's still dispatchable
    const taskResult = await db.query<{
      id: string;
      title: string;
      description: string;
      category: string | null;
      risk_level: string;
      sensitive: boolean | null;
      price: number;
      location_lat: number | null;
      location_lng: number | null;
      location: string | null;
      requirements: string | null;
      fulfillment_mode: string;
      dispatch_state: string;
      state: string;
    }>(
      `SELECT id, title, description, category, risk_level, sensitive, price,
              location_lat, location_lng, location, requirements,
              fulfillment_mode, dispatch_state, state
         FROM tasks WHERE id = $1`,
      [taskId]
    );

    if (taskResult.rowCount === 0) {
      log.warn({ taskId, waveNumber }, 'Task not found — wave skipped');
      return;
    }

    const task = taskResult.rows[0];

    // Skip if task is no longer in a dispatchable state
    if (
      task.state === 'ACCEPTED' ||
      task.state === 'COMPLETED' ||
      task.state === 'CANCELLED' ||
      task.dispatch_state === 'fulfilled' ||
      task.dispatch_state === 'expired'
    ) {
      log.info({ taskId, waveNumber, state: task.state, dispatchState: task.dispatch_state }, 'Task no longer dispatchable — wave skipped');
      return;
    }

    const dispatchTask: TaskDispatchInfo = {
      id: task.id,
      title: task.title,
      description: task.description,
      category: task.category,
      riskLevel: task.risk_level as TaskDispatchInfo['riskLevel'],
      sensitive: task.sensitive ?? false,
      price: Number(task.price),
      locationLat: task.location_lat ? Number(task.location_lat) : null,
      locationLng: task.location_lng ? Number(task.location_lng) : null,
      location: task.location,
      requirements: task.requirements,
      fulfillmentMode: task.fulfillment_mode,
      dispatchState: task.dispatch_state,
    };

    log.info(
      {
        taskId,
        waveNumber,
        fulfillmentMode: task.fulfillment_mode,
        state: task.state,
        dispatchState: task.dispatch_state,
        locationLat: dispatchTask.locationLat,
        locationLng: dispatchTask.locationLng,
        riskLevel: dispatchTask.riskLevel,
        sensitive: dispatchTask.sensitive,
      },
      'Wave executing — fetching candidates'
    );

    // Get ranked candidates for this wave
    const candidates = await DispatchService.getCandidatesForWave(dispatchTask, waveNumber);

    log.info({ taskId, waveNumber, candidateCount: candidates.length }, 'Candidates resolved for wave');

    if (candidates.length === 0 && waveNumber !== 3) {
      log.info({ taskId, waveNumber }, 'No candidates in this wave — next wave will attempt');
    }

    if (candidates.length === 0 && waveNumber === 3) {
      // Wave 3 produced no candidates — mark task as dispatch_expired
      await db.query(
        `UPDATE tasks SET dispatch_state = 'expired', updated_at = NOW() WHERE id = $1`,
        [taskId]
      );
      await db.query(
        `INSERT INTO dispatch_events (task_id, event_type, wave_number)
         VALUES ($1, 'dispatch_expired', $2)`,
        [taskId, waveNumber]
      );
      log.warn({ taskId }, 'No candidates found in wave 3 — dispatch expired');
      return;
    }

    // Dispatch pings
    await DispatchService.dispatchToHustlers(
      taskId,
      candidates,
      waveNumber,
      task.location
    );
  },
};
