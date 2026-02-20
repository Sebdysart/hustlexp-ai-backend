/**
 * Expertise Supply Recalculation Worker v1.0.0
 *
 * Daily cron job that recalculates supply/demand metrics for all expertise
 * categories in all zones.
 *
 * Runs at 03:00 AM daily (off-peak for Seattle beta).
 *
 * What it does:
 *   1. Applies activity decay to inactive hustlers
 *   2. Counts open tasks per expertise (7-day window)
 *   3. Computes effective supply weight per expertise
 *   4. Updates liquidity ratios
 *   5. Checks P95 acceptance time for auto-expansion
 *   6. Processes waitlist invitations (FIFO) when capacity opens
 *   7. Expires stale waitlist invitations (>48h)
 *
 * @see ExpertiseSupplyService.recalculateAllCapacity()
 * @see expertise_supply_control.sql
 */

import type { Job } from 'bullmq';
import { ExpertiseSupplyService } from '../services/ExpertiseSupplyService';
import { workerLogger } from '../logger';

const log = workerLogger.child({ worker: 'expertise-recalc' });

export const processExpertiseRecalcJob = async (job: Job): Promise<void> => {
  const startTime = Date.now();
  log.info('Starting daily supply recalculation');

  try {
    const result = await ExpertiseSupplyService.recalculateAllCapacity();

    if (!result.success) {
      log.error({ err: result.error.message }, 'Expertise recalculation failed');
      throw new Error(result.error.message);
    }

    const duration = Date.now() - startTime;
    log.info({ processed: result.data.processed, expanded: result.data.expanded, invitesSent: result.data.invitesSent, durationMs: duration }, 'Expertise recalculation complete');
  } catch (error) {
    log.error({ err: error }, 'Expertise recalc job failed');
    throw error; // BullMQ will retry
  }
};

export const expertiseRecalcQueueConfig = {
  name: 'expertise-recalc',
  processor: processExpertiseRecalcJob,
  options: {
    repeat: {
      pattern: '0 3 * * *', // Daily at 3:00 AM
    },
    attempts: 3,
    backoff: {
      type: 'exponential' as const,
      delay: 30000, // 30s, 60s, 120s
    },
  },
};
