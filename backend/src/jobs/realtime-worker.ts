/**
 * Realtime Worker v1.0.0
 * 
 * Pillar A - Realtime Tracking: Processes task.progress_updated events
 * 
 * Consumes: task.progress_updated events from user_notifications queue
 * 
 * Responsibility:
 * - Resolve authorized task.progress_updated recipients
 * - Publish canonical personal-user envelopes through Redis
 * - API instances fan out Redis messages to their process-local SSE connections
 * - Fan out to authorized recipients (poster + worker)
 * 
 * Hard rules:
 * - No state mutation
 * - Authorization at fanout
 * - No retries that change meaning
 * 
 * @see Step 10 - Realtime Transport Implementation
 */

import type { Job } from 'bullmq';
import { dispatchTaskProgress } from '../realtime/realtime-dispatcher.js';

// ============================================================================
// TYPES
// ============================================================================

interface TaskProgressJobData {
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  payload: {
    taskId: string;
    from: string;
    to: string;
    actor: {
      type: 'worker' | 'system';
      userId: string | null;
    };
    occurredAt: string;
  };
}

// ============================================================================
// REALTIME WORKER
// ============================================================================

/**
 * Process task.progress_updated job
 * 
 * Publishes the event for API-instance SSE fanout to authorized recipients
 */
export async function processRealtimeJob(job: Job<TaskProgressJobData>): Promise<void> {
  const { payload } = job.data;
  
  // Construct outbox event structure for dispatcher
  const outboxEvent = {
    event_type: 'task.progress_updated',
    aggregate_type: job.data.aggregate_type,
    aggregate_id: job.data.aggregate_id,
    payload: payload,
  };

  // Dispatch through canonical personal Redis rooms. Dedicated workers have no
  // process-local API connections, so direct in-memory fanout would drop this.
  await dispatchTaskProgress(outboxEvent);
}
