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

import { createHash, randomUUID } from 'crypto';
import { db } from '../db.js';
import { enqueueJob, signJobPayload, QUEUE_CONFIGS, type QueueName } from './queues.js';
import { getClient as getRedisClient } from '../cache/redis.js';
import { workerLogger } from '../logger.js';
import { config } from '../config.js';
import { AnalyticsService } from '../services/AnalyticsService.js';
import { buildIdentity } from '../buildIdentity.js';
const log = workerLogger.child({ worker: 'outbox' });

// Maximum delivery attempts before an outbox event is permanently failed.
// Single source of truth — used by both processOutboxEvents and markOutboxEventFailed.
const MAX_OUTBOX_ATTEMPTS = 5;
const TRANSPORT_ERROR_PREFIX = 'transport_enqueue_failed:';

function validOutboxEvent(event: OutboxEvent): boolean {
  return Object.prototype.hasOwnProperty.call(QUEUE_CONFIGS, event.queue_name)
    && typeof event.event_type === 'string' && event.event_type.length > 0
    && typeof event.idempotency_key === 'string' && event.idempotency_key.length > 0
    && typeof event.payload === 'object' && event.payload !== null && !Array.isArray(event.payload);
}

function bullMqJobId(idempotencyKey: string): string {
  return `outbox-${createHash('sha256')
    .update(idempotencyKey)
    .digest('hex')}`;
}

// Financial event types that require HMAC payload signing
// Exported for test assertion (membership is financial-critical).
export const FINANCIAL_EVENT_TYPES = new Set([
  'escrow.release_requested',
  'escrow.released',
  'escrow.completion_release_requested',
  'escrow.refund_requested',
  'escrow.partial_refund_requested',
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
           AND available_at <= NOW()
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
      void AnalyticsService.observeOutbox(event);
      let enqueueDiagnostic: {
        eventId: string;
        eventType: string;
        queueName: QueueName;
        jobId: string;
        jobIdContainsColon: boolean;
        buildRevision: string;
        pid: number;
      } | undefined;
      try {
        if (!validOutboxEvent(event)) {
          await db.query(`UPDATE outbox_events SET status = 'failed', error_message = 'poison:invalid_outbox_event',
            updated_at = NOW() WHERE id = $1 AND status = 'enqueued'`, [event.id]);
          failed++;
          continue;
        }
        // Sign financial job payloads to prevent Redis injection (Attack 12)
        let jobPayload: Record<string, unknown> = event.payload;
        if (FINANCIAL_EVENT_TYPES.has(event.event_type)) {
          const signature = signJobPayload(event.payload);
          jobPayload = { ...event.payload, _sig: signature };
        }

        // Enqueue job with idempotency key (outside the transaction — no DB lock held)
        const jobId = bullMqJobId(event.idempotency_key);
        enqueueDiagnostic = {
          eventId: event.id,
          eventType: event.event_type,
          queueName: event.queue_name,
          jobId,
          jobIdContainsColon: jobId.includes(':'),
          buildRevision: buildIdentity.revision,
          pid: process.pid,
        };
        log.info(enqueueDiagnostic, 'Outbox BullMQ enqueue starting');
        const job = await enqueueJob(
          event.queue_name,
          event.event_type,
          {
            aggregate_type: event.aggregate_type,
            aggregate_id: event.aggregate_id,
            event_version: event.event_version,
            outbox_idempotency_key: event.idempotency_key,
            payload: jobPayload,
          },
          { jobId, retryTerminal: true,
            ...(event.idempotency_key.startsWith('provider_os:v2:') || event.event_type === 'notification.create_requested'
              ? { removeOnComplete: true, removeOnFail: true } : {}),
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
        if (enqueueDiagnostic) {
          log.error({
            ...enqueueDiagnostic,
            errorMessage,
            errorStack: error instanceof Error ? error.stack : undefined,
          }, 'Outbox BullMQ enqueue failed');
        }
        errors.push({ eventId: event.id, error: errorMessage });

        // Queue transport failure is not poison work. Store a bounded failure
        // count in the tagged error field, without consuming delivery attempts.
        await db.query(
          `UPDATE outbox_events
           SET status = 'pending',
               attempts = GREATEST(attempts - 1, 0),
               error_message = $1 || LEAST(8, CASE WHEN error_message ~ '^transport_enqueue_failed:[0-9]{1,2}$'
                 THEN split_part(error_message, ':', 2)::integer + 1 ELSE 1 END)::text,
               available_at = NOW() + LEAST(300, POWER(2, LEAST(8, CASE
                 WHEN error_message ~ '^transport_enqueue_failed:[0-9]{1,2}$'
                 THEN split_part(error_message, ':', 2)::integer + 1 ELSE 1 END)) * 5) * INTERVAL '1 second',
               updated_at = NOW()
           WHERE id = $2 AND status = 'enqueued'`,
          [TRANSPORT_ERROR_PREFIX, event.id]
        );
        log.warn({ eventId: event.id, eventType: event.event_type }, 'Outbox queue transport failed; will retry');
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
         available_at = NOW() + LEAST(300, POWER(2, attempts) * 5) * INTERVAL '1 second',
         updated_at = NOW()
     WHERE idempotency_key = $2 AND status IN ('enqueued', 'processing')`,
    [errorMessage, idempotencyKey, MAX_OUTBOX_ATTEMPTS]
  );
}

export interface OutboxWorkerHandles {
  outboxInterval: NodeJS.Timeout;
  surgeInterval: NodeJS.Timeout;
  trustTierInterval: NodeJS.Timeout;
}

/** Explicit operator recovery for a known historical transport failure. The
 * expected stored error must match exactly; this never scans all failed rows. */
export async function recoverKnownTransportFailedOutboxEvent(
  idempotencyKey: string, expectedError: string,
): Promise<boolean> {
  // Historical free-text failures have no reliable universal classifier.
  // Require both an exact row match and a conservative transport signature.
  const knownTransportError = /^(?:transport_enqueue_failed:\d{1,2}|connect ECONNREFUSED\b|connect ETIMEDOUT\b|read ECONNRESET\b|Connection is closed\.?$|Socket closed unexpectedly\.?$|MaxRetriesPerRequestError\b)/i;
  if (!idempotencyKey || !knownTransportError.test(expectedError)) return false;
  const result = await db.query(`UPDATE outbox_events SET status = 'pending', attempts = 0,
    available_at = NOW(), error_message = 'transport_recovered_manually', updated_at = NOW()
    WHERE idempotency_key = $1 AND status = 'failed' AND error_message = $2
    RETURNING id`, [idempotencyKey, expectedError]);
  return (result.rowCount ?? 0) > 0;
}

/** Recover the DB-commit/queue-add crash window for every outbox event.
 * Logical identity remains the original idempotency key; consumers must commit
 * their own durable result before acknowledging this at-least-once delivery. */
export async function recoverExpiredOutboxLeases(batchSize = 100): Promise<void> {
  await db.query(`WITH expired AS (
    SELECT id FROM outbox_events
    WHERE (status = 'enqueued' AND COALESCE(enqueued_at, created_at) < NOW() - INTERVAL '10 minutes')
       OR (status = 'processing' AND queue_name = 'user_notifications'
           AND event_type LIKE 'push.%' AND updated_at < NOW() - INTERVAL '10 minutes')
    ORDER BY COALESCE(enqueued_at, created_at), id LIMIT $1 FOR UPDATE SKIP LOCKED
  ) UPDATE outbox_events event SET
    status = 'pending',
    attempts = GREATEST(event.attempts - 1, 0),
    available_at = NOW() + LEAST(300, POWER(2, event.attempts) * 5) * INTERVAL '1 second',
    error_message = 'outbox_dispatch_lease_expired',
    updated_at = NOW()
    FROM expired WHERE event.id = expired.id`, [batchSize]);
}

async function pollOutbox() {
  try {
    await recoverExpiredOutboxLeases();
  } catch (error) {
    log.error({ err: error }, 'Outbox dispatch recovery failed; ordinary outbox continues');
  }
  return processOutboxEvents(100);
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
  pollOutbox().catch(error => {
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
      const result = await pollOutbox();
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

