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
import { enqueueJob, signJobPayload, type QueueName } from './queues.js';
import { outboxTransportJobId } from './OutboxIdentity.js';
import { getClient as getRedisClient } from '../cache/redis.js';
import { workerLogger } from '../logger.js';
import { config } from '../config.js';
const log = workerLogger.child({ worker: 'outbox' });

// Maximum delivery attempts before an outbox event is permanently failed.
// Single source of truth — used by both processOutboxEvents and markOutboxEventFailed.
const MAX_OUTBOX_ATTEMPTS = 5;
// A process can die after the database claim commits but before queue.add().
// Reclaim only after this lease expires; BullMQ's deterministic jobId makes the
// resulting at-least-once enqueue safe while avoiding a permanent `enqueued`
// tombstone.
const OUTBOX_CLAIM_LEASE = "INTERVAL '2 minutes'";

// Financial event types that require HMAC payload signing
// Exported for test assertion (membership is financial-critical).
export const FINANCIAL_EVENT_TYPES = new Set([
  'escrow.release_requested',
  'escrow.released',
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
    const claimBatch = await db.transaction(async (txQuery) => {
      const selectResult = await txQuery<OutboxEvent>(
        `SELECT * FROM outbox_events
         WHERE (
           (status = 'pending' AND available_at <= NOW())
           OR (
             status = 'enqueued'
             AND processed_at IS NULL
             AND enqueued_at IS NOT NULL
             AND enqueued_at <= NOW() - ${OUTBOX_CLAIM_LEASE}
           )
         )
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize]
      );

      const claimed: OutboxEvent[] = [];
      const exhausted: Array<{ event: OutboxEvent; error: string }> = [];
      for (const event of selectResult.rows) {
        if (event.attempts >= MAX_OUTBOX_ATTEMPTS) {
          const errorMessage = 'Outbox claim lease expired after maximum attempts';
          const acknowledgement = await txQuery<OutboxAcknowledgement>(
            `UPDATE outbox_events
             SET status = 'failed',
                 error_message = COALESCE(error_message, $3),
                 updated_at = NOW()
             WHERE id = $1
               AND attempts >= $2
               AND (
                 (status = 'pending' AND available_at <= NOW())
                 OR (
                   status = 'enqueued'
                   AND processed_at IS NULL
                   AND enqueued_at IS NOT NULL
                   AND enqueued_at <= NOW() - ${OUTBOX_CLAIM_LEASE}
                 )
               )
             RETURNING idempotency_key,status,attempts`,
            [event.id, MAX_OUTBOX_ATTEMPTS, errorMessage],
          );
          const row = acknowledgement.rows[0];
          if (
            acknowledgement.rows.length !== 1
            || row.idempotency_key !== event.idempotency_key
            || row.status !== 'failed'
            || Number(row.attempts) !== event.attempts
          ) {
            throw new Error(`OUTBOX_ACK_MISSING: exhausted claim ${event.id} was not failed exactly`);
          }
          exhausted.push({ event, error: errorMessage });
          continue;
        }
        const updateResult = await txQuery(
          `UPDATE outbox_events
           SET status = 'enqueued',
               enqueued_at = NOW(),
               attempts = attempts + 1,
               error_message = NULL,
               updated_at = NOW()
           WHERE id = $1
             AND attempts < $2
             AND (
               (status = 'pending' AND available_at <= NOW())
               OR (
                 status = 'enqueued'
                 AND processed_at IS NULL
                 AND enqueued_at IS NOT NULL
                 AND enqueued_at <= NOW() - ${OUTBOX_CLAIM_LEASE}
               )
             )`, // CAS guard for both first delivery and expired claims
          [event.id, MAX_OUTBOX_ATTEMPTS]
        );
        if (updateResult.rowCount > 0) {
          // Keep the exact claim generation locally. A stale worker from an
          // earlier lease must never be able to reset a newer claim or a
          // consumer-completed row after an ambiguous enqueue failure.
          claimed.push({ ...event, attempts: event.attempts + 1 });
        } else {
          log.warn({ eventId: event.id }, 'Outbox event already processed by another worker, skipping');
        }
      }
      return { claimed, exhausted };
    });

    for (const exhaustion of claimBatch.exhausted) {
      failed++;
      errors.push({ eventId: exhaustion.event.id, error: exhaustion.error });
      log.error(
        {
          eventId: exhaustion.event.id,
          eventType: exhaustion.event.event_type,
          attempts: exhaustion.event.attempts,
        },
        'Outbox event exhausted its claim-recovery budget — requires ops intervention',
      );
    }

    for (const event of claimBatch.claimed) {
      try {
        const transportJobId = outboxTransportJobId(event.idempotency_key);
        // Every consumer needs the durable database identity because the
        // BullMQ transport ID is intentionally a one-way hash. Financial
        // consumers additionally authenticate this field with HMAC before use.
        const boundPayload = {
          ...event.payload,
          _outbox_key: event.idempotency_key,
        };
        let jobPayload: Record<string, unknown> = boundPayload;
        if (FINANCIAL_EVENT_TYPES.has(event.event_type)) {
          // Bind the deterministic durable outbox identity into the signed
          // financial envelope. Consumers can now reject a valid payload
          // replayed under a forged BullMQ job ID without synthesizing keys or
          // excluding legitimate custom producer identities.
          const signature = signJobPayload(boundPayload);
          jobPayload = { ...boundPayload, _sig: signature };
        }

        // Durable outbox keys intentionally contain contract separators (`:`),
        // which BullMQ rejects in custom job IDs. Keep the durable key signed in
        // `_outbox_key`, but use its full SHA-256 transport mapping for queue
        // deduplication and audit persistence.
        const job = await enqueueJob(
          event.queue_name,
          event.event_type,
          {
            aggregate_type: event.aggregate_type,
            aggregate_id: event.aggregate_id,
            event_version: event.event_version,
            payload: jobPayload,
          },
          { jobId: transportJobId }
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
            [job.id || transportJobId, event.id]
          );
        } catch (err) {
          log.warn({ err, eventId: event.id }, '[outbox-worker] Failed to record bullmq_job_id — event processing continues');
        }

        processed++;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';

        // Reset only the exact claim generation owned by this process. The
        // enqueue failure can be ambiguous: the deterministic BullMQ job may
        // already exist and its consumer may have marked the row processed.
        // In that race, status/attempt fencing preserves the processed ACK.
        const recovered = await db.query<OutboxAcknowledgement>(
          `UPDATE outbox_events
           SET status = CASE WHEN attempts < $1 THEN 'pending' ELSE 'failed' END,
               error_message = $2,
               updated_at = NOW()
           WHERE id = $3
             AND status = 'enqueued'
             AND attempts = $4
           RETURNING idempotency_key,status,attempts`,
          [MAX_OUTBOX_ATTEMPTS, errorMessage, event.id, event.attempts]
        );
        const recovery = recovered.rows[0];
        if (
          recovered.rows.length === 1
          && recovery.idempotency_key === event.idempotency_key
          && Number(recovery.attempts) === event.attempts
          && recovery.status === (event.attempts < MAX_OUTBOX_ATTEMPTS ? 'pending' : 'failed')
        ) {
          failed++;
          errors.push({ eventId: event.id, error: errorMessage });
        } else {
          const authoritative = await db.query<OutboxAcknowledgement & { error_message: string | null }>(
            `SELECT idempotency_key,status,attempts,error_message
               FROM outbox_events
              WHERE id = $1`,
            [event.id],
          );
          const row = authoritative.rows[0];
          if (
            authoritative.rows.length === 1
            && row.idempotency_key === event.idempotency_key
            && row.status === 'processed'
          ) {
            processed++;
            log.info(
              { eventId: event.id, eventType: event.event_type, attempts: row.attempts },
              'Outbox consumer acknowledgement won the ambiguous enqueue-failure race',
            );
            continue;
          }
          failed++;
          const claimError = `OUTBOX_CLAIM_LOST: ${event.id} enqueue failed without an exact recoverable claim`;
          errors.push({ eventId: event.id, error: claimError });
          log.error(
            { eventId: event.id, eventType: event.event_type, attempts: event.attempts },
            claimError,
          );
          continue;
        }

        if (event.attempts >= MAX_OUTBOX_ATTEMPTS) {
          log.error(
            { eventId: event.id, eventType: event.event_type, attempts: event.attempts },
            'Outbox event permanently failed after max attempts — requires ops intervention'
          );
        } else {
          log.warn(
            { eventId: event.id, eventType: event.event_type, attempts: event.attempts },
            'Outbox event queuing failed, will retry'
          );
        }
      }
    }

    return { processed, failed, errors };
  } catch (error) {
    log.error({ err: error }, 'Outbox worker fatal error');
    throw error;
  }
}

/**
 * Mark outbox event as processed (called by job processor after successful execution)
 */
export interface OutboxAcknowledgement {
  idempotency_key: string;
  status: 'pending' | 'processed' | 'failed';
  attempts: number;
}

export interface MarkOutboxFailureOptions {
  /** BullMQ exhausted its own retry budget; do not create a second retry loop. */
  terminal?: boolean;
  /** Reject an unsigned/injected job unless the outbox row was already claimed. */
  requireClaimed?: boolean;
}

export async function markOutboxEventProcessed(
  idempotencyKey: string
): Promise<OutboxAcknowledgement> {
  const result = await db.query<OutboxAcknowledgement>(
    `UPDATE outbox_events
     SET status = 'processed',
         processed_at = COALESCE(processed_at, NOW()),
         error_message = NULL,
         updated_at = NOW()
     WHERE idempotency_key = $1
     RETURNING idempotency_key,status,attempts`,
    [idempotencyKey]
  );
  const acknowledgement = result.rows[0];
  if (
    result.rows.length !== 1
    || acknowledgement.idempotency_key !== idempotencyKey
    || acknowledgement.status !== 'processed'
    || !Number.isInteger(Number(acknowledgement.attempts))
  ) {
    throw new Error(`OUTBOX_ACK_MISSING: processed acknowledgement ${idempotencyKey} is not exact`);
  }
  return { ...acknowledgement, attempts: Number(acknowledgement.attempts) };
}

interface StripeEventOutboxRow {
  idempotency_key: string;
  status: 'pending' | 'enqueued' | 'processing' | 'processed' | 'failed';
  attempts: number;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  queue_name: string;
}

export interface StripeEventOutboxAcknowledgement {
  signed: OutboxAcknowledgement;
  acknowledgedKeys: string[];
}

/**
 * Acknowledge one exact signed Stripe-event delivery and every durable sibling
 * for the same immutable provider event (the canonical ingress row plus any
 * hard-crash recovery rows).
 *
 * The signed row must already be claimed by the outbox worker. Locking and
 * validating it before the sibling update prevents a forged/pending key from
 * acknowledging unrelated work, while sibling convergence prevents a
 * successful recovery job from leaving the abandoned canonical row to exhaust
 * its delivery budget falsely.
 */
export async function markStripeEventOutboxesProcessed(input: {
  idempotencyKey: string;
  stripeEventId: string;
}): Promise<StripeEventOutboxAcknowledgement> {
  return db.transaction(async (query) => {
    const authority = await query<StripeEventOutboxRow>(
      `SELECT idempotency_key,status,attempts,event_type,aggregate_type,aggregate_id,queue_name
         FROM outbox_events
        WHERE idempotency_key=$1
        FOR UPDATE`,
      [input.idempotencyKey],
    );
    const signed = authority.rows[0];
    if (
      authority.rows.length !== 1
      || signed.idempotency_key !== input.idempotencyKey
      || signed.event_type !== 'stripe.event_received'
      || signed.aggregate_type !== 'stripe_event'
      || signed.aggregate_id !== input.stripeEventId
      || signed.queue_name !== 'critical_payments'
      || !['enqueued', 'processing', 'processed'].includes(signed.status)
      || !Number.isInteger(Number(signed.attempts))
    ) {
      throw new Error(
        `OUTBOX_ACK_MISSING: Stripe event acknowledgement authority ${input.idempotencyKey} is not exact`,
      );
    }

    const acknowledged = await query<OutboxAcknowledgement>(
      `UPDATE outbox_events
          SET status='processed',
              processed_at=COALESCE(processed_at,NOW()),
              error_message=NULL,
              updated_at=NOW()
        WHERE event_type='stripe.event_received'
          AND aggregate_type='stripe_event'
          AND aggregate_id=$1
          AND queue_name='critical_payments'
          AND status IN ('pending','enqueued','processing','processed','failed')
        RETURNING idempotency_key,status,attempts`,
      [input.stripeEventId],
    );
    const exactSignedAck = acknowledged.rows.find(
      (row) => row.idempotency_key === input.idempotencyKey,
    );
    if (
      !exactSignedAck
      || exactSignedAck.status !== 'processed'
      || !Number.isInteger(Number(exactSignedAck.attempts))
      || acknowledged.rows.some((row) => row.status !== 'processed')
    ) {
      throw new Error(
        `OUTBOX_ACK_MISSING: Stripe event acknowledgement ${input.idempotencyKey} did not converge`,
      );
    }
    return {
      signed: { ...exactSignedAck, attempts: Number(exactSignedAck.attempts) },
      acknowledgedKeys: acknowledged.rows.map((row) => row.idempotency_key).sort(),
    };
  });
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
  errorMessage: string,
  options: MarkOutboxFailureOptions = {},
): Promise<OutboxAcknowledgement> {
  if (options.terminal) {
    const terminalResult = await db.query<OutboxAcknowledgement>(
      `UPDATE outbox_events
       SET status = CASE WHEN status = 'processed' THEN 'processed' ELSE 'failed' END,
           error_message = CASE WHEN status = 'processed' THEN error_message ELSE $1 END,
           updated_at = CASE WHEN status = 'processed' THEN updated_at ELSE NOW() END
       WHERE idempotency_key = $2
         AND (
           $3::boolean = FALSE
           OR status IN ('enqueued','processing','failed','processed')
         )
       RETURNING idempotency_key,status,attempts`,
      [errorMessage, idempotencyKey, options.requireClaimed === true],
    );
    const acknowledgement = terminalResult.rows[0];
    const attempts = Number(acknowledgement?.attempts);
    if (
      terminalResult.rows.length !== 1
      || acknowledgement.idempotency_key !== idempotencyKey
      || !Number.isInteger(attempts)
      || !['failed', 'processed'].includes(acknowledgement.status)
    ) {
      throw new Error(`OUTBOX_ACK_MISSING: terminal failure acknowledgement ${idempotencyKey} is not exact`);
    }
    return { ...acknowledgement, attempts };
  }

  const result = await db.query<OutboxAcknowledgement>(
    `UPDATE outbox_events
     SET status = CASE
           WHEN status = 'processed' THEN 'processed'
           WHEN attempts < $3 THEN 'pending'
           ELSE 'failed'
         END,
         error_message = CASE WHEN status = 'processed' THEN error_message ELSE $1 END,
         updated_at = CASE WHEN status = 'processed' THEN updated_at ELSE NOW() END
     WHERE idempotency_key = $2
     RETURNING idempotency_key,status,attempts`,
    [errorMessage, idempotencyKey, MAX_OUTBOX_ATTEMPTS]
  );
  const acknowledgement = result.rows[0];
  const attempts = Number(acknowledgement?.attempts);
  const expectedFailureStatus = attempts < MAX_OUTBOX_ATTEMPTS ? 'pending' : 'failed';
  if (
    result.rows.length !== 1
    || acknowledgement.idempotency_key !== idempotencyKey
    || !Number.isInteger(attempts)
    || (
      acknowledgement.status !== 'processed'
      && acknowledgement.status !== expectedFailureStatus
    )
  ) {
    throw new Error(`OUTBOX_ACK_MISSING: failure acknowledgement ${idempotencyKey} is not exact`);
  }
  return { ...acknowledgement, attempts };
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
