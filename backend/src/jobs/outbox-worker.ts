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

import { randomUUID } from 'crypto';
import { db } from '../db.js';
import { getQueue, signJobPayload, type QueueName } from './queues.js';
import { getClient as getRedisClient } from '../cache/redis.js';
import { workerLogger } from '../logger.js';
import { config } from '../config.js';
const log = workerLogger.child({ worker: 'outbox' });

// Maximum delivery attempts before an outbox event is permanently failed.
// Single source of truth — used by both processOutboxEvents and markOutboxEventFailed.
const MAX_OUTBOX_ATTEMPTS = 5;

// Financial event types that require HMAC payload signing
// Exported for test assertion (membership is financial-critical).
export const FINANCIAL_EVENT_TYPES = new Set([
  'escrow.release_requested',
  'escrow.completion_release_requested',
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
    // Fetch pending outbox events and mark them as 'enqueued' inside a single
    // transaction so that the FOR UPDATE SKIP LOCKED lock is held for the
    // entire SELECT + UPDATE pair.  Without this, the lock is released
    // immediately after the SELECT, leaving a window where two workers can read
    // the same rows, both call queue.add(), and both see rowCount=0 on the
    // subsequent CAS UPDATE — permanently stranding the event in 'pending'.
    //
    // Strategy:
    //   1. SELECT … FOR UPDATE SKIP LOCKED  — lock the batch
    //   2. For each event: UPDATE status='enqueued' (CAS on status='pending')
    //      inside the same transaction so the lock covers both statements.
    //   3. COMMIT — release the locks.
    //   4. Enqueue to BullMQ outside the transaction (network I/O must not
    //      hold a DB lock — that would risk long-held locks and deadlocks).
    //
    // The CAS WHERE clause remains as a belt-and-suspenders guard for workers
    // that crashed mid-flight between SELECT and UPDATE on a prior cycle.
    const claimedEvents = await db.transaction(async (txQuery) => {
      const selectResult = await txQuery<OutboxEvent>(
        `SELECT * FROM outbox_events
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize]
      );

      const claimed: OutboxEvent[] = [];
      for (const event of selectResult.rows) {
        const updateResult = await txQuery(
          `UPDATE outbox_events
           SET status = 'enqueued',
               enqueued_at = NOW(),
               attempts = attempts + 1
           WHERE id = $1
             AND status = 'pending'`, // CAS guard (belt-and-suspenders)
          [event.id]
        );
        if (updateResult.rowCount > 0) {
          claimed.push(event);
        } else {
          log.warn({ eventId: event.id }, 'Outbox event already processed by another worker, skipping');
        }
      }
      return claimed;
    });

    for (const event of claimedEvents) {
      try {
        // Get the appropriate queue
        const queue = getQueue(event.queue_name);

        // Sign financial job payloads to prevent Redis injection (Attack 12)
        let jobPayload: Record<string, unknown> = event.payload;
        if (FINANCIAL_EVENT_TYPES.has(event.event_type)) {
          const signature = signJobPayload(event.payload);
          jobPayload = { ...event.payload, _sig: signature };
        }

        // Enqueue job with idempotency key (outside the transaction — no DB lock held)
        const job = await queue.add(
          event.event_type,
          {
            aggregate_type: event.aggregate_type,
            aggregate_id: event.aggregate_id,
            event_version: event.event_version,
            payload: jobPayload,
          },
          {
            jobId: event.idempotency_key, // Use idempotency key as job ID (prevents duplicates)
          }
        );

        // Persist the BullMQ job ID now that we have it (row already 'enqueued').
        // BUG 6 FIX: Wrap in try/catch — bullmq_job_id is an audit field, not a
        // control field. If this write fails (transient DB error, connection blip),
        // the BullMQ job is already enqueued and will process normally. Blocking
        // event processing on an audit-field write would silently strand events.
        try {
          await db.query(
            `UPDATE outbox_events
             SET bullmq_job_id = $1
             WHERE id = $2`,
            [job.id || event.idempotency_key, event.id]
          );
        } catch (err) {
          log.warn({ err, eventId: event.id }, '[outbox-worker] Failed to record bullmq_job_id — event processing continues');
        }

        processed++;
      } catch (error) {
        failed++;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push({ eventId: event.id, error: errorMessage });

        // The transaction already incremented attempts and set status='enqueued'.
        // queue.add() failed, so roll back the status: if still below the max,
        // reset to 'pending' so the next poll will retry; otherwise mark 'failed'.
        // Note: `event.attempts` reflects the value at SELECT time (before the +1
        // the transaction applied), so after the transaction attempts = event.attempts + 1.
        await db.query(
          `UPDATE outbox_events
           SET status = CASE WHEN attempts < $1 THEN 'pending' ELSE 'failed' END,
               error_message = $2
           WHERE id = $3`,
          [MAX_OUTBOX_ATTEMPTS, errorMessage, event.id]
        );

        if (event.attempts + 1 >= MAX_OUTBOX_ATTEMPTS) {
          log.error(
            { eventId: event.id, eventType: event.event_type, attempts: event.attempts + 1 },
            'Outbox event permanently failed after max attempts — requires ops intervention'
          );
        } else {
          log.warn(
            { eventId: event.id, eventType: event.event_type, attempts: event.attempts + 1 },
            'Outbox event queuing failed, will retry'
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
 *
 * Uses the same CASE WHEN attempts < MAX guard as the inline recovery path so
 * the event is reset to 'pending' (for retry) until it has exhausted MAX attempts,
 * at which point it is permanently set to 'failed'.
 *
 * Note: do NOT increment `attempts` here. The claim transaction in
 * processOutboxEvents already incremented attempts when it set status='enqueued'.
 * Double-incrementing on the failure path would exhaust MAX_OUTBOX_ATTEMPTS at
 * half the expected retries.
 */
export async function markOutboxEventFailed(
  idempotencyKey: string,
  errorMessage: string
): Promise<void> {
  await db.query(
    `UPDATE outbox_events
     SET status = CASE WHEN attempts < $3 THEN 'pending' ELSE 'failed' END,
         error_message = $1,
         updated_at = NOW()
     WHERE idempotency_key = $2`,
    [errorMessage, idempotencyKey, MAX_OUTBOX_ATTEMPTS]
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

  // Initial poll (immediate)
  processOutboxEvents(100).catch(error => {
    log.error({ err: error }, 'Outbox worker initial poll error');
  });

  // Start periodic surge evaluator (every 10 seconds)
  // AUDIT FIX M12 (2026-06-11): the in-process `surgeRunning` flag only
  // prevented overlap within ONE pod — in multi-pod deployments every pod ran
  // the evaluation each tick. Now guarded by the same Redis NX lock + Lua
  // CAS-delete pattern as the trust-tier job below (in-process flag kept as a
  // cheap first gate). Lock TTL 30s covers a slow evaluation; surge enqueues
  // remain idempotency-keyed as defense-in-depth.
  const SURGE_LOCK_KEY = `lock:${config.app.env ?? 'production'}:surge_evaluation`;
  const SURGE_LOCK_TTL_MS = 30 * 1000;
  const SURGE_LOCK_HOLDER_ID = randomUUID();
  let surgeRunning = false;
  const surgeInterval = setInterval(async () => {
    if (surgeRunning) {
      log.warn('Surge evaluation already running, skipping');
      return;
    }
    surgeRunning = true;
    try {
      const redisClient = getRedisClient();
      if (!redisClient) {
        // Without Redis there is no distributed lock — skip (matches W48-1
        // trust-tier behavior) rather than risk every pod evaluating at once.
        log.warn('[outbox-worker] Redis unavailable — skipping surge evaluation to avoid multi-pod duplication');
        return;
      }
      const acquired = await redisClient.set(SURGE_LOCK_KEY, SURGE_LOCK_HOLDER_ID, {
        nx: true,
        px: SURGE_LOCK_TTL_MS,
      });
      if (!acquired) {
        return; // another pod holds the lock this tick
      }
      try {
        const { evaluateInstantSurges } = await import('./instant-surge-evaluator.js');
        await evaluateInstantSurges();
      } finally {
        // Lua CAS-delete: only the holder may release (W-02 pattern)
        try {
          await redisClient.eval(
            `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
            [SURGE_LOCK_KEY],
            [SURGE_LOCK_HOLDER_ID]
          );
        } catch (unlockErr) {
          log.warn({ err: unlockErr }, '[outbox-worker] surge lock release failed (TTL will expire it)');
        }
      }
    } catch (err) {
      log.error({ err }, '[outbox-worker] surgeInterval error');
    } finally {
      surgeRunning = false;
    }
  }, 10 * 1000); // Every 10 seconds

  // Pre-Alpha Prerequisite: Trust tier promotion worker (hourly)
  // W-15 FIX: Use a Redis distributed lock instead of an in-process flag so that
  // multiple pods cannot run concurrent promotions and double-award tier upgrades.
  // The in-process `trustTierRunning` flag only protected against overlap within a
  // single process; in a multi-pod deployment both pods could enter simultaneously.
  const TRUST_TIER_LOCK_KEY = `lock:${config.app.env ?? 'production'}:trust_tier_promotion`;
  const TRUST_TIER_LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes in ms
  // W-02 fix: Use a unique instance ID as the lock value so a pod that crashed and
  // recovered cannot accidentally delete a fresh lock acquired by another pod after
  // the original TTL expired. The Lua CAS-delete in the finally block ensures only
  // the lock owner can release it.
  // W46-2 FIX: Use randomUUID() instead of `${process.pid}:${Date.now()}`.
  // In containerized environments PID is always 1; two pods restarting within
  // the same millisecond produce identical LOCK_HOLDER_IDs, allowing Pod A
  // (recovering after a crash) to delete Pod B's freshly-acquired lock.
  // randomUUID() guarantees global uniqueness per pod instance.
  const LOCK_HOLDER_ID = randomUUID();
  const trustTierInterval = setInterval(async () => {
    try {
      const redisClient = getRedisClient();
      let lockAcquired = false;
      if (redisClient) {
        // Attempt to acquire distributed lock (NX = only set if not exists, PX = TTL in ms)
        const acquired = await redisClient.set(TRUST_TIER_LOCK_KEY, LOCK_HOLDER_ID, {
          nx: true,
          px: TRUST_TIER_LOCK_TTL_MS,
        });
        if (!acquired) {
          log.info('Trust tier promotion already running on another pod, skipping');
          return;
        }
        lockAcquired = true;
      } else {
        // W48-1 FIX: Redis unavailable — SKIP this run entirely instead of proceeding
        // without a distributed lock. In multi-pod deployments, all pods would run
        // processTrustTierPromotionJob() simultaneously without the lock, causing
        // duplicate tier promotions and double XP awards. Skipping is safe: the job
        // will retry on the next hourly tick once Redis is available again.
        log.warn({ err: null }, '[trust-tier-worker] Redis unavailable — skipping trust tier promotion to avoid duplicate processing in multi-pod deployment');
        return; // Skip this run entirely — will retry on next interval tick
      }
      try {
        const { processTrustTierPromotionJob } = await import('./trust-tier-promotion-worker.js');
        await processTrustTierPromotionJob();
      } catch (error) {
        log.error({ err: error }, 'Trust tier promotion error');
      } finally {
        if (lockAcquired && redisClient) {
          // W-02 fix: Lua CAS-delete — only delete the key when its value still
          // matches this pod's LOCK_HOLDER_ID. Prevents Pod A (recovering after a
          // crash past the TTL) from deleting Pod B's freshly-acquired lock.
          const luaScript = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
          await redisClient.eval(luaScript, [TRUST_TIER_LOCK_KEY], [LOCK_HOLDER_ID]).catch(err => {
            log.warn({ err }, 'Failed to release trust tier promotion lock');
          });
        }
      }
    } catch (err) {
      log.error({ err }, 'trustTierInterval: unhandled error in callback');
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
