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
import { spawnDueOccurrences, replenishAllSeriesOccurrences } from '../services/RecurringTaskService.js';

const log = logger.child({ worker: 'recurring-task-worker' });

export async function processRecurringTaskSpawnJob(job: Job): Promise<void> {
  log.info({ jobId: job.id, jobName: job.name }, 'Starting recurring task job');

  try {
    if (job.name === 'recurring.replenish_occurrences') {
      // Rolling generation: ensure 8 weeks of occurrences ahead for all active series
      const result = await replenishAllSeriesOccurrences();
      log.info({ jobId: job.id, series: result.series, generated: result.generated }, 'Rolling generation completed');
    } else {
      // Default: spawn due occurrences
      const result = await spawnDueOccurrences();
      log.info({ jobId: job.id, spawned: result.spawned, failed: result.failed }, 'Spawn job completed');
    }
  } catch (error) {
    log.error({ jobId: job.id, err: error }, 'Recurring task job failed');
    throw error; // Let BullMQ retry
  }
}
