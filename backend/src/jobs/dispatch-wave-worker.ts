/**
 * Dispatch Wave Worker
 *
 * Processes BullMQ jobs from the `task_dispatch` queue.
 * Each job represents one wave of the smart dispatch sequence.
 *
 * Job name: 'dispatch.wave'
 * Job data: { taskId: string; waveNumber: 1 | 2 | 3 }
 *
 * Idempotent: WaveManager._executeWave() checks task state before acting.
 * If the task was already fulfilled or the job is a duplicate, it exits safely.
 */

import { Job } from 'bullmq';
import { WaveManager, type WaveJobData } from '../services/WaveManager.js';
import { workerLogger } from '../logger.js';

const log = workerLogger.child({ worker: 'dispatch-wave' });

export async function processDispatchWaveJob(job: Job<WaveJobData>): Promise<void> {
  const { taskId, waveNumber } = job.data;

  if (!taskId || !waveNumber) {
    log.error({ jobId: job.id, data: job.data }, 'Invalid dispatch wave job data');
    throw new Error('DISPATCH_WAVE_INVALID_DATA: taskId and waveNumber are required');
  }

  if (waveNumber !== 1 && waveNumber !== 2 && waveNumber !== 3) {
    throw new Error(`DISPATCH_WAVE_INVALID_WAVE: waveNumber must be 1, 2, or 3, got ${waveNumber}`);
  }

  const startTime = Date.now();
  log.info({ taskId, waveNumber, jobId: job.id }, 'Processing dispatch wave');

  try {
    await WaveManager.processWave(taskId, waveNumber);
    const latency = Date.now() - startTime;
    log.info({ taskId, waveNumber, latency }, 'Dispatch wave completed');
  } catch (error) {
    const latency = Date.now() - startTime;
    log.error(
      {
        taskId,
        waveNumber,
        latency,
        err: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      'Dispatch wave failed'
    );
    throw error; // BullMQ handles retry
  }
}
