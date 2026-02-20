/**
 * Outbox Worker v1.0.0
 * 
 * SYSTEM GUARANTEES: Outbox Pattern Implementation
 * 
 * Reads outbox_events from Postgres → enqueues BullMQ jobs
 * Ensures at-least-once delivery without losing events.
 * 
 * Pattern:
 * 1. API writes domain event + outbox row in same transaction
 * 2. This worker reads outbox (status='pending')
 * 3. Enqueues job to appropriate BullMQ queue
 * 4. Marks outbox row as 'enqueued'
 * 
 * Hard rule: Worker must be idempotent (can process same outbox row twice)
 * 
 * @see ARCHITECTURE.md §2.4 (Outbox pattern)
 */

import { db } from '../db';
import { getQueue, generateIdempotencyKey, type QueueName } from './queues';
import { workerLogger } from '../logger';
const log = workerLogger.child({ worker: 'outbox' });

// ============================================================================
// TYPES
// ============================================================================

interface OutboxEvent {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  event_version: number;
  idempotency_key: string;
  payload: Record<string, unknown>;
  queue_name: QueueName;
  status: 'pending' | 'enqueued' | 'processed' | 'failed';
  enqueued_at: Date | null;
  processed_at: Date | null;
  error_message: string | null;
  attempts: number;
  bullmq_job_id: string | null; // BullMQ job ID (for tracking and idempotency)
  created_at: Date;
}

// ============================================================================
// OUTBOX WORKER
// ============================================================================

/**
 * Process pending outbox events
 * Should be called periodically (via cron or worker process)
 * 
 * Hard rule: Must be idempotent - can be called multiple times safely
 */
export async function processOutboxEvents(batchSize: number = 100): Promise<{
  processed: number;
  failed: number;
  errors: Array<{ eventId: string; error: string }>;
}> {
  const errors: Array<{ eventId: string; error: string }> = [];
  let processed = 0;
  let failed = 0;
  
  try {
    // Fetch pending outbox events (ordered by creation time for FIFO)
    const result = await db.query<OutboxEvent>(
      `SELECT * FROM outbox_events
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`, // Skip locked rows (parallel worker safety)
      [batchSize]
    );
    
    for (const event of result.rows) {
      try {
        // Get the appropriate queue
        const queue = getQueue(event.queue_name);
        
        // Enqueue job with idempotency key
        const job = await queue.add(
          event.event_type,
          {
            aggregate_type: event.aggregate_type,
            aggregate_id: event.aggregate_id,
            event_version: event.event_version,
            payload: event.payload,
          },
          {
            jobId: event.idempotency_key, // Use idempotency key as job ID (prevents duplicates)
            attempts: 3, // Default attempts (queue config may override)
          }
        );
        
        // Mark outbox event as enqueued (with WHERE status = 'pending' to prevent double-enqueue)
        // Only update if still pending (prevents race condition if two workers both locked the same row)
        const updateResult = await db.query(
          `UPDATE outbox_events
           SET status = 'enqueued',
               enqueued_at = NOW(),
               bullmq_job_id = $1,
               attempts = attempts + 1
           WHERE id = $2
             AND status = 'pending'`, // CRITICAL: Only update if still pending (prevents double-enqueue)
          [job.id || event.idempotency_key, event.id]
        );
        
        // If update affected 0 rows, another worker already processed this event
        if (updateResult.rowCount === 0) {
          log.warn({ eventId: event.id }, 'Outbox event already processed by another worker, skipping');
          continue; // Skip to next event
        }
        
        processed++;
      } catch (error) {
        failed++;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push({ eventId: event.id, error: errorMessage });
        
        // Mark outbox event as failed (but keep for retry)
        await db.query(
          `UPDATE outbox_events
           SET status = 'failed',
               error_message = $1,
               attempts = attempts + 1
           WHERE id = $2`,
          [errorMessage, event.id]
        );
      }
    }
    
    return { processed, failed, errors };
  } catch (error) {
    log.error({ err: error }, 'Outbox worker fatal error');
    return { processed, failed, errors };
  }
}

/**
 * Mark outbox event as processed (called by job processor after successful execution)
 */
export async function markOutboxEventProcessed(
  idempotencyKey: string
): Promise<void> {
  await db.query(
    `UPDATE outbox_events
     SET status = 'processed',
         processed_at = NOW()
     WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
}

/**
 * Mark outbox event as failed (called by job processor after failed execution)
 */
export async function markOutboxEventFailed(
  idempotencyKey: string,
  errorMessage: string
): Promise<void> {
  await db.query(
    `UPDATE outbox_events
     SET status = 'failed',
         error_message = $1,
         attempts = attempts + 1
     WHERE idempotency_key = $2`,
    [errorMessage, idempotencyKey]
  );
}

/**
 * Start outbox worker loop
 * Continuously polls outbox_events table and enqueues BullMQ jobs
 * 
 * Hard rule: Must run continuously to ensure no events are lost
 * 
 * @param intervalMs Polling interval in milliseconds (default: 5000ms)
 */
export function startOutboxWorker(intervalMs: number = 5000): NodeJS.Timeout {
  log.info({ intervalMs }, 'Starting outbox worker loop');
  
  // Initial poll (immediate)
  processOutboxEvents(100).catch(error => {
    log.error({ err: error }, 'Outbox worker initial poll error');
  });
  
  // Set up polling interval
  // Start periodic surge evaluator (every 10 seconds)
  const surgeEvaluatorInterval = setInterval(async () => {
    try {
      const { evaluateInstantSurges } = await import('./instant-surge-evaluator');
      await evaluateInstantSurges();
    } catch (error) {
      log.error({ err: error }, 'Surge evaluator error');
    }
  }, 10 * 1000); // Every 10 seconds

  // Pre-Alpha Prerequisite: Trust tier promotion worker (hourly)
  const trustPromotionInterval = setInterval(async () => {
    try {
      const { processTrustTierPromotionJob } = await import('./trust-tier-promotion-worker');
      await processTrustTierPromotionJob();
    } catch (error) {
      log.error({ err: error }, 'Trust tier promotion error');
    }
  }, 60 * 60 * 1000); // Every hour

  const interval = setInterval(async () => {
    try {
      const result = await processOutboxEvents(100);
      if (result.processed > 0 || result.failed > 0) {
        log.info({ processed: result.processed, failed: result.failed }, 'Outbox poll complete');
      }
      if (result.errors.length > 0) {
        log.error({ errors: result.errors }, 'Outbox poll errors');
      }
    } catch (error) {
      log.error({ err: error }, 'Outbox worker fatal error');
    }
  }, intervalMs);
  
  return interval;
}
