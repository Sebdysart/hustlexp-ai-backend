/**
 * Recurring Task Spawn Worker
 *
 * BullMQ job that scans for due recurring task occurrences and spawns real
 * HXTask + Escrow instances via the existing TaskService.create pipeline.
 *
 * Scheduled: daily at 6:00 AM UTC + catch-up every 2 hours.
 */

import type { Job } from 'bullmq';
import { logger } from '../logger.js';
import { spawnDueOccurrences } from '../services/RecurringTaskService.js';

const log = logger.child({ worker: 'recurring-task-worker' });

export async function processRecurringTaskSpawnJob(job: Job): Promise<void> {
  log.info({ jobId: job.id, jobName: job.name }, 'Starting recurring task spawn job');

  try {
    const result = await spawnDueOccurrences();

    log.info(
      { jobId: job.id, spawned: result.spawned, failed: result.failed },
      'Recurring task spawn job completed'
    );
  } catch (error) {
    log.error({ jobId: job.id, err: error }, 'Recurring task spawn job failed');
    throw error; // Let BullMQ retry
  }
}
