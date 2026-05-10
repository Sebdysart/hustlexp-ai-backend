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

import { db } from '../db.js';
import { getQueue, signJobPayload, type QueueName } from './queues.js';
import { workerLogger } from '../logger.js';
const log = workerLogger.child({ worker: 'outbox' });

// Financial event types that require HMAC payload signing
const FINANCIAL_EVENT_TYPES = new Set([
  'escrow.release_requested',
  'escrow.refund_requested',
  'escrow.partial_refund_requested',
  // Stripe event forwarding — both job types route through critical_payments and can
  // trigger real escrow state transitions (PENDING→FUNDED, FUNDED→RELEASED, etc.)
  'payment.stripe_event_received',
  'stripe.event_received',
  // Instant task jobs — routed through critical_payments queue; signing prevents
  // a compromised Redis node from injecting fraudulent matching/notification jobs
  'task.instant_matching_started',
  'task.instant_available',
  'task.instant_surge_evaluate',
]);

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
    // Fetch pending outbox events (ordered by creation time for FIFO).
    // No FOR UPDATE SKIP LOCKED here — the actual concurrency guard is the
    // CAS pattern on the UPDATE below (AND status = 'pending' + rowCount check).
    // FOR UPDATE outside an explicit transaction releases the lock immediately
    // after the SELECT, providing zero protection and misleading readers.
    const result = await db.query<OutboxEvent>(
      `SELECT * FROM outbox_events
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT $1`,
      [batchSize]
    );
    
    for (const event of result.rows) {
      try {
        // ── Direct dispatch bypass ────────────────────────────────────────────
        // Process these event types inline without routing through BullMQ workers,
        // which may not be running in a single-process Railway deployment.

        if (event.event_type === 'task.instant_matching_started') {
          const { WaveManager } = await import('../services/WaveManager.js');
          await WaveManager.initiateDispatch(event.aggregate_id);
          const u = await db.query(
            `UPDATE outbox_events SET status = 'processed', processed_at = NOW(), attempts = attempts + 1
             WHERE id = $1 AND status = 'pending'`,
            [event.id]
          );
          if ((u.rowCount ?? 0) > 0) processed++;
          continue;
        }

        if (event.event_type === 'task.dispatch_ping') {
          const { sendDispatchPing } = await import('./dispatch-ping-worker.js');
          const payload = event.payload as { taskId: string; hustlerId: string; waveNumber: number; location?: string | null };
          await sendDispatchPing(payload, event.idempotency_key);
          const u = await db.query(
            `UPDATE outbox_events SET status = 'processed', processed_at = NOW(), attempts = attempts + 1
             WHERE id = $1 AND status = 'pending'`,
            [event.id]
          );
          if ((u.rowCount ?? 0) > 0) processed++;
          continue;
        }

        // ── Standard BullMQ enqueue path (all other event types) ─────────────

        // Get the appropriate queue
        const queue = getQueue(event.queue_name);

        // Sign financial job payloads to prevent Redis injection (Attack 12)
        let jobPayload: Record<string, unknown> = event.payload;
        if (FINANCIAL_EVENT_TYPES.has(event.event_type)) {
          const signature = signJobPayload(event.payload);
          jobPayload = { ...event.payload, _sig: signature };
        }

        // Enqueue job with idempotency key
        const job = await queue.add(
          event.event_type,
          {
            aggregate_type: event.aggregate_type,
            aggregate_id: event.aggregate_id,
            event_version: event.event_version,
            payload: jobPayload,
          },
          {
            jobId: event.idempotency_key.replace(/:/g, '_'), // BullMQ forbids ':' in job IDs (used as Redis key separator)
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

        const MAX_OUTBOX_ATTEMPTS = 5;
        // If below max attempts, reset to pending for retry on next poll.
        // If at max, permanently fail and require ops intervention.
        await db.query(
          `UPDATE outbox_events
           SET status = CASE WHEN attempts + 1 < $1 THEN 'pending' ELSE 'failed' END,
               error_message = $2,
               attempts = attempts + 1
           WHERE id = $3`,
          [MAX_OUTBOX_ATTEMPTS, errorMessage, event.id]
        );

        if (event.attempts + 1 >= MAX_OUTBOX_ATTEMPTS) {
          log.error(
            { eventId: event.id, eventType: event.event_type, attempts: event.attempts + 1 },
            'Outbox event permanently failed after max attempts — requires ops intervention'
          );
        }
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

export interface OutboxWorkerHandles {
  outboxInterval: NodeJS.Timeout;
  surgeInterval: NodeJS.Timeout;
  trustTierInterval: NodeJS.Timeout;
}

/**
 * Start outbox worker loop
 * Continuously polls outbox_events table and enqueues BullMQ jobs
 *
 * Hard rule: Must run continuously to ensure no events are lost
 *
 * Returns all three interval handles so the caller can clearInterval() each
 * one during graceful shutdown, preventing timer leaks on hot-reload.
 *
 * @param intervalMs Polling interval in milliseconds (default: 5000ms)
 */
export function startOutboxWorker(intervalMs: number = 5000): OutboxWorkerHandles {
  log.info({ intervalMs }, 'Starting outbox worker loop');

  // Recovery: reset dispatch events that failed due to the "Custom Id cannot contain :" bug.
  db.query(
    `UPDATE outbox_events
     SET status = 'pending', attempts = 0, error_message = NULL
     WHERE status = 'failed'
       AND event_type IN ('task.instant_matching_started', 'task.dispatch_ping')
       AND error_message = 'Custom Id cannot contain :'`
  ).then(r => {
    if ((r.rowCount ?? 0) > 0) log.info({ count: r.rowCount }, 'Reset colon-failed dispatch outbox events for retry');
  }).catch(err => log.error({ err }, 'Failed to reset colon-failed dispatch events'));

  // Recovery: reset dispatch events that were enqueued to BullMQ but never consumed,
  // OR that were processed but produced 0 candidates (account_status case bug now fixed).
  // Any task.instant_matching_started event whose task dispatch_state is still 'idle'
  // should be retried — the fix to account_status = 'ACTIVE' may now find candidates.
  db.query(
    `UPDATE outbox_events oe
     SET status = 'pending', attempts = 0, error_message = NULL, enqueued_at = NULL, bullmq_job_id = NULL
     FROM tasks t
     WHERE oe.aggregate_id = t.id
       AND oe.event_type = 'task.instant_matching_started'
       AND oe.status IN ('enqueued', 'processed')
       AND t.dispatch_state = 'idle'
       AND t.state NOT IN ('CANCELLED', 'COMPLETED', 'ACCEPTED')`
  ).then(r => {
    if ((r.rowCount ?? 0) > 0) log.info({ count: r.rowCount }, 'Reset dispatch events for idle tasks — will retry with fixed account_status filter');
  }).catch(err => log.error({ err }, 'Failed to reset idle-task dispatch events'));

  // Initial poll (immediate)
  processOutboxEvents(100).catch(error => {
    log.error({ err: error }, 'Outbox worker initial poll error');
  });

  // Start periodic surge evaluator (every 10 seconds)
  const surgeInterval = setInterval(async () => {
    try {
      const { evaluateInstantSurges } = await import('./instant-surge-evaluator');
      await evaluateInstantSurges();
    } catch (error) {
      log.error({ err: error }, 'Surge evaluator error');
    }
  }, 10 * 1000); // Every 10 seconds

  // Pre-Alpha Prerequisite: Trust tier promotion worker (hourly)
  const trustTierInterval = setInterval(async () => {
    try {
      const { processTrustTierPromotionJob } = await import('./trust-tier-promotion-worker');
      await processTrustTierPromotionJob();
    } catch (error) {
      log.error({ err: error }, 'Trust tier promotion error');
    }
  }, 60 * 60 * 1000); // Every hour

  const outboxInterval = setInterval(async () => {
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

  return { outboxInterval, surgeInterval, trustTierInterval };
}
