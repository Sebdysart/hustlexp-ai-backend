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
import { db, type QueryFn } from '../db.js';
import { enqueueJob, signJobPayload, type QueueName } from './queues.js';
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
  status: 'pending' | 'enqueued' | 'processing' | 'processed' | 'failed';
  enqueued_at: Date | null;
  processed_at: Date | null;
  error_message: string | null;
  attempts: number;
  bullmq_job_id: string | null; // BullMQ job ID (for tracking and idempotency)
  dispatch_attempt_id: string | null;
  dispatch_claimed_at: Date | null;
  dispatch_deadline_at: Date | null;
  pre_provider_claim_id: string | null;
  pre_provider_claim_deadline_at: Date | null;
  provider_io_started_at: Date | null;
  created_at: Date;
}

type ClaimedOutboxEvent = OutboxEvent & {
  dispatch_attempt_id: string;
  bullmq_job_id: string;
  /** True only when this poll re-added the exact ID from an expired enqueued lease. */
  recovered_retained_dispatch: boolean;
};

export interface OutboxDispatchAuthority {
  dispatchAttemptId: string;
  bullmqJobId: string;
}

export interface OutboxTransitionOptions {
  /** Close the outbox row even when its transport-attempt budget is not exhausted. */
  terminal?: boolean;
  /** Participate in the caller's transaction with channel-local ownership checks. */
  query?: QueryFn;
}

const DISPATCH_LEASE_SECONDS = 300;

function deterministicBullMqJobId(idempotencyKey: string, attempt: number): string {
  // BullMQ rejects ':' in custom job IDs while HustleXP's immutable outbox
  // keys intentionally use colon-delimited domain identities. Keep that key in
  // the signed/job payload and derive a compact transport-only identity here.
  const digest = createHash('sha256').update(idempotencyKey).digest('hex');
  return attempt === 1
    ? `outbox-${digest}`
    : `outbox-${digest}-dispatch-${attempt}`;
}

function createJobData(event: ClaimedOutboxEvent): Record<string, unknown> {
  let payload: Record<string, unknown> = event.payload;
  if (FINANCIAL_EVENT_TYPES.has(event.event_type)) {
    payload = { ...event.payload, _sig: signJobPayload(event.payload) };
  }

  return {
    aggregate_type: event.aggregate_type,
    aggregate_id: event.aggregate_id,
    event_version: event.event_version,
    // Immutable provider idempotency and mutable queue-dispatch authority are
    // deliberately separate. Workers must bind callbacks to all three values.
    outbox_idempotency_key: event.idempotency_key,
    outbox_dispatch_attempt_id: event.dispatch_attempt_id,
    outbox_bullmq_job_id: event.bullmq_job_id,
    payload,
  };
}

type RetainedTerminalResolution =
  | { kind: 'rotated'; event: ClaimedOutboxEvent }
  | { kind: 'exhausted' }
  | { kind: 'unsafe' };

/**
 * Rotate a retained completed/failed BullMQ identity only when the database
 * still proves that the exact recovered dispatch owns an enqueued row and no
 * notification channel has acquired local/provider authority or a receipt.
 *
 * This intentionally fails closed for non-notification event types: there is
 * no generic proof here that their worker did not commit an external effect.
 */
async function rotateRetainedTerminalDispatch(
  event: ClaimedOutboxEvent,
): Promise<RetainedTerminalResolution> {
  const nextAttempt = event.attempts + 1;
  const nextDispatchAttemptId = randomUUID();
  const nextBullMqJobId = deterministicBullMqJobId(event.idempotency_key, nextAttempt);

  const result = await db.query<OutboxEvent>(
    `UPDATE outbox_events AS outbox
     SET status = CASE WHEN outbox.attempts < $7 THEN 'enqueued' ELSE 'failed' END,
         attempts = CASE WHEN outbox.attempts < $7 THEN $4 ELSE outbox.attempts END,
         dispatch_attempt_id = CASE WHEN outbox.attempts < $7 THEN $5::UUID ELSE outbox.dispatch_attempt_id END,
         bullmq_job_id = CASE WHEN outbox.attempts < $7 THEN $6 ELSE outbox.bullmq_job_id END,
         dispatch_claimed_at = CASE WHEN outbox.attempts < $7 THEN NOW() ELSE outbox.dispatch_claimed_at END,
         dispatch_deadline_at = CASE
           WHEN outbox.attempts < $7 THEN NOW() + make_interval(secs => $8::INTEGER)
           ELSE NULL
         END,
         error_message = CASE
           WHEN outbox.attempts < $7 THEN NULL
           ELSE 'retained_terminal_dispatch_attempts_exhausted'
         END,
         updated_at = NOW()
     WHERE outbox.id = $1
       AND outbox.status = 'enqueued'
       AND outbox.processed_at IS NULL
       AND outbox.dispatch_attempt_id = $2::UUID
       AND outbox.bullmq_job_id = $3
       AND outbox.attempts = $9
       AND outbox.dispatch_deadline_at > NOW()
       AND outbox.pre_provider_claim_id IS NULL
       AND outbox.provider_io_started_at IS NULL
       AND CASE outbox.event_type
         WHEN 'email.send_requested' THEN EXISTS (
           SELECT 1
           FROM email_outbox AS email
           WHERE email.id::TEXT = COALESCE(
             outbox.payload->>'emailId',
             CASE WHEN outbox.aggregate_type = 'email' THEN outbox.aggregate_id::TEXT END
           )
             AND email.status IN ('pending', 'failed')
             AND email.pre_provider_claim_id IS NULL
             AND email.provider_io_started_at IS NULL
             AND email.notification_provider_attempt_id IS NULL
             AND email.provider_msg_id IS NULL
             AND email.sent_at IS NULL
             AND email.delivered_at IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM notification_deliveries AS delivery
               WHERE delivery.notification_id = email.notification_id
                 AND delivery.channel = 'email'
                 AND (
                   delivery.provider_attempt_id IS NOT NULL
                   OR delivery.provider_message_id IS NOT NULL
                   OR delivery.state NOT IN (
                     'pending','deferred_quiet_hours','deferred_focus','queued','retry_pending'
                   )
                 )
             )
         )
         WHEN 'sms.send_requested' THEN EXISTS (
           SELECT 1
           FROM sms_outbox AS sms
           WHERE sms.id::TEXT = COALESCE(
             outbox.payload->>'smsId',
             CASE WHEN outbox.aggregate_type = 'sms' THEN outbox.aggregate_id::TEXT END
           )
             AND sms.status IN ('pending', 'failed')
             AND sms.pre_provider_claim_id IS NULL
             AND sms.provider_io_started_at IS NULL
             AND sms.notification_provider_attempt_id IS NULL
             AND sms.provider_message_id IS NULL
             AND sms.twilio_sid IS NULL
             AND sms.provider_status IS NULL
             AND sms.sent_at IS NULL
             AND sms.delivered_at IS NULL
             AND NOT EXISTS (
               SELECT 1
               FROM notification_deliveries AS delivery
               WHERE delivery.notification_id = sms.notification_id
                 AND delivery.channel = 'sms'
                 AND (
                   delivery.provider_attempt_id IS NOT NULL
                   OR delivery.provider_message_id IS NOT NULL
                   OR delivery.state NOT IN (
                     'pending','deferred_quiet_hours','deferred_focus','queued','retry_pending'
                   )
                 )
             )
         )
         WHEN 'push.send_requested' THEN EXISTS (
           SELECT 1
           FROM notification_deliveries AS delivery
           WHERE delivery.notification_id::TEXT = COALESCE(
             outbox.payload->>'notificationId',
             CASE WHEN outbox.aggregate_type = 'push' THEN outbox.aggregate_id::TEXT END
           )
             AND delivery.channel = 'push'
             AND delivery.state IN (
               'pending','deferred_quiet_hours','deferred_focus','queued','retry_pending'
             )
             AND delivery.provider_attempt_id IS NULL
             AND delivery.provider_message_id IS NULL
         )
         ELSE FALSE
       END
     RETURNING outbox.*`,
    [
      event.id,
      event.dispatch_attempt_id,
      event.bullmq_job_id,
      nextAttempt,
      nextDispatchAttemptId,
      nextBullMqJobId,
      MAX_OUTBOX_ATTEMPTS,
      DISPATCH_LEASE_SECONDS,
      event.attempts,
    ],
  );

  const resolved = result.rows[0];
  if (!resolved) return { kind: 'unsafe' };
  if (resolved.status === 'failed') return { kind: 'exhausted' };

  return {
    kind: 'rotated',
    event: {
      ...resolved,
      dispatch_attempt_id: nextDispatchAttemptId,
      bullmq_job_id: nextBullMqJobId,
      recovered_retained_dispatch: false,
    },
  };
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
    // Fetch due outbox events and durably claim a deterministic BullMQ dispatch
    // inside a single
    // transaction so that the FOR UPDATE SKIP LOCKED lock is held for the
    // entire SELECT + UPDATE pair.  Without this, the lock is released
    // immediately after the SELECT, leaving a window where two workers can read
    // the same rows, both call queue.add(), and both see rowCount=0 on the
    // subsequent CAS UPDATE — permanently stranding the event in 'pending'.
    //
    // Strategy:
    //   1. SELECT … FOR UPDATE SKIP LOCKED  — lock the batch
    //   2. For each new event, persist status, dispatch token, deadline, attempt,
    //      and the exact BullMQ job ID before queue I/O. For an expired enqueued
    //      lease, retain that exact job ID: queue.add may have succeeded before
    //      the prior process crashed, and BullMQ job-ID deduplication is the
    //      authority that makes the ambiguous retry safe.
    //   3. COMMIT — release the locks.
    //   4. Enqueue to BullMQ outside the transaction (network I/O must not
    //      hold a DB lock — that would risk long-held locks and deadlocks).
    //
    // The CAS WHERE clause remains as a belt-and-suspenders guard for workers
    // that crashed mid-flight between SELECT and UPDATE on a prior cycle.
    const claimedEvents = await db.transaction(async (txQuery) => {
      // A worker that died after acquiring only the bounded pre-provider lease
      // is known not to have started provider I/O. Once that lease expires the
      // old token is barred, so exhausting the durable dispatch budget is a
      // terminal local failure rather than an outcome-unknown provider effect.
      await txQuery(
        `UPDATE outbox_events
         SET status='failed',
             error_message='pre_provider_dispatch_attempts_exhausted',
             pre_provider_claim_id=NULL,
             pre_provider_claimed_at=NULL,
             pre_provider_claim_deadline_at=NULL,
             updated_at=NOW()
         WHERE status='processing'
           AND provider_io_started_at IS NULL
           AND attempts >= $1
           AND (
             pre_provider_claim_deadline_at <= NOW()
             OR (pre_provider_claim_deadline_at IS NULL AND updated_at <= NOW() - INTERVAL '5 minutes')
           )`,
        [MAX_OUTBOX_ATTEMPTS],
      );

      const selectResult = await txQuery<OutboxEvent>(
        `SELECT * FROM outbox_events
         WHERE (
           (status = 'pending' AND available_at <= NOW() AND attempts < $2)
           OR (
             status = 'enqueued'
             AND processed_at IS NULL
             AND pre_provider_claim_id IS NULL
             AND provider_io_started_at IS NULL
             AND (
               dispatch_deadline_at <= NOW()
               OR (dispatch_deadline_at IS NULL AND updated_at <= NOW() - INTERVAL '5 minutes')
             )
           )
           OR (
             status = 'processing'
             AND provider_io_started_at IS NULL
             AND attempts < $2
             AND (
               pre_provider_claim_deadline_at <= NOW()
               OR (pre_provider_claim_deadline_at IS NULL AND updated_at <= NOW() - INTERVAL '5 minutes')
             )
           )
         )
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize, MAX_OUTBOX_ATTEMPTS]
      );

      const claimed: ClaimedOutboxEvent[] = [];
      for (const event of selectResult.rows) {
        const staleDispatch = event.status === 'enqueued';
        const dispatchAttemptId = staleDispatch && event.dispatch_attempt_id
          ? event.dispatch_attempt_id
          : randomUUID();
        const persistedAttempt = staleDispatch
          ? Math.max(1, event.attempts)
          : event.attempts + 1;
        // Preserve a valid ambiguous DB->queue attempt exactly. Legacy rows
        // can contain the colon-delimited idempotency key, which BullMQ rejects
        // before enqueue, so those are safely repaired to the deterministic
        // colon-free transport ID.
        const dispatchJobId = staleDispatch
          && event.bullmq_job_id
          && !event.bullmq_job_id.includes(':')
          ? event.bullmq_job_id
          : deterministicBullMqJobId(event.idempotency_key, persistedAttempt);
        const updateResult = await txQuery<ClaimedOutboxEvent>(
          `UPDATE outbox_events
           SET status = 'enqueued',
               enqueued_at = COALESCE(enqueued_at, NOW()),
               attempts = $2,
               bullmq_job_id = $3,
               dispatch_attempt_id = $4::UUID,
               dispatch_claimed_at = NOW(),
               dispatch_deadline_at = NOW() + make_interval(secs => $5::INTEGER),
               pre_provider_claim_id = NULL,
               pre_provider_claimed_at = NULL,
               pre_provider_claim_deadline_at = NULL,
               provider_io_started_at = NULL,
               updated_at = NOW()
           WHERE id = $1
             AND (
               (status = 'pending' AND available_at <= NOW() AND attempts < $6)
               OR (
                 status = 'enqueued'
                 AND processed_at IS NULL
                 AND pre_provider_claim_id IS NULL
                 AND provider_io_started_at IS NULL
                 AND (
                   dispatch_deadline_at <= NOW()
                   OR (dispatch_deadline_at IS NULL AND updated_at <= NOW() - INTERVAL '5 minutes')
                 )
               )
               OR (
                 status = 'processing'
                 AND provider_io_started_at IS NULL
                 AND attempts < $6
                 AND (
                   pre_provider_claim_deadline_at <= NOW()
                   OR (pre_provider_claim_deadline_at IS NULL AND updated_at <= NOW() - INTERVAL '5 minutes')
                 )
               )
             )
           RETURNING *`,
          [
            event.id,
            persistedAttempt,
            dispatchJobId,
            dispatchAttemptId,
            DISPATCH_LEASE_SECONDS,
            MAX_OUTBOX_ATTEMPTS,
          ]
        );
        if (updateResult.rows[0]) {
          claimed.push({
            ...updateResult.rows[0],
            // Inspect BullMQ state only when queue.add is reconciling the exact
            // valid ID retained from an expired enqueued attempt. A repaired
            // legacy ID and a recovered pre-provider claim are fresh dispatches.
            recovered_retained_dispatch: Boolean(
              staleDispatch
              && event.bullmq_job_id
              && event.bullmq_job_id === dispatchJobId
              && !event.bullmq_job_id.includes(':'),
            ),
          });
        } else {
          log.warn({ eventId: event.id }, 'Outbox event already processed by another worker, skipping');
        }
      }
      return claimed;
    });

    for (const event of claimedEvents) {
      let activeEvent = event;
      try {
        // Enqueue job with idempotency key (outside the transaction — no DB lock held)
        let job = await enqueueJob(
          activeEvent.queue_name,
          activeEvent.event_type,
          createJobData(activeEvent),
          {
            jobId: activeEvent.bullmq_job_id,
          },
        );

        if (job.id && job.id !== activeEvent.bullmq_job_id) {
          throw new Error('BullMQ returned a job ID that does not match durable dispatch authority');
        }

        if (activeEvent.recovered_retained_dispatch) {
          const retainedState = await job.getState();
          if (retainedState === 'completed' || retainedState === 'failed') {
            const resolution = await rotateRetainedTerminalDispatch(activeEvent);
            if (resolution.kind === 'unsafe') {
              failed++;
              const errorMessage = 'retained_terminal_dispatch_not_safely_rotated';
              errors.push({ eventId: activeEvent.id, error: errorMessage });
              log.warn(
                {
                  eventId: activeEvent.id,
                  jobId: activeEvent.bullmq_job_id,
                  retainedState,
                },
                'Retained terminal BullMQ job has local/provider evidence or lost DB ownership; rotation refused',
              );
              continue;
            }
            if (resolution.kind === 'exhausted') {
              failed++;
              errors.push({
                eventId: activeEvent.id,
                error: 'retained_terminal_dispatch_attempts_exhausted',
              });
              continue;
            }

            activeEvent = resolution.event;
            job = await enqueueJob(
              activeEvent.queue_name,
              activeEvent.event_type,
              createJobData(activeEvent),
              { jobId: activeEvent.bullmq_job_id },
            );
            if (job.id && job.id !== activeEvent.bullmq_job_id) {
              throw new Error('BullMQ returned a job ID that does not match rotated dispatch authority');
            }
          }
          // waiting/active/delayed/prioritized/unknown (and any newer
          // nonterminal BullMQ state) retain the exact ambiguous job identity.
        }

        await db.query(
          `UPDATE outbox_events
           SET enqueued_at = COALESCE(enqueued_at, NOW()), updated_at = NOW()
           WHERE id = $1
             AND status = 'enqueued'
             AND dispatch_attempt_id = $2::UUID
             AND bullmq_job_id = $3`,
          [activeEvent.id, activeEvent.dispatch_attempt_id, activeEvent.bullmq_job_id],
        );

        processed++;
      } catch (error) {
        failed++;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        errors.push({ eventId: activeEvent.id, error: errorMessage });

        // Queue I/O is outcome-ambiguous. Keep the same durable dispatch token
        // and BullMQ job ID; after the lease expires the dispatcher re-adds that
        // exact job ID, which is safe whether queue.add committed or not.
        await db.query(
          `UPDATE outbox_events
           SET error_message = $1, updated_at = NOW()
           WHERE id = $2
             AND status = 'enqueued'
             AND dispatch_attempt_id = $3::UUID
             AND bullmq_job_id = $4`,
          [
            errorMessage,
            activeEvent.id,
            activeEvent.dispatch_attempt_id,
            activeEvent.bullmq_job_id,
          ],
        );

        log.warn(
          {
            eventId: activeEvent.id,
            eventType: activeEvent.event_type,
            jobId: activeEvent.bullmq_job_id,
          },
          'Outbox dispatch outcome ambiguous; exact job ID will be reconciled after lease',
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
  idempotencyKey: string,
  authority: OutboxDispatchAuthority,
  options: Pick<OutboxTransitionOptions, 'query'> = {},
): Promise<boolean> {
  const query = options.query ?? db.query;
  const result = await query(
    `UPDATE outbox_events
     SET status = 'processed',
          processed_at = NOW(),
          dispatch_deadline_at = NULL,
          pre_provider_claim_deadline_at = NULL,
          updated_at = NOW()
     WHERE idempotency_key = $1
       AND dispatch_attempt_id = $2::UUID
       AND bullmq_job_id = $3
       AND status IN ('enqueued', 'processing')`,
    [idempotencyKey, authority.dispatchAttemptId, authority.bullmqJobId],
  );
  return result.rowCount === 1;
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
  authority: OutboxDispatchAuthority,
  options: OutboxTransitionOptions = {},
): Promise<boolean> {
  const query = options.query ?? db.query;
  const result = await query(
    `UPDATE outbox_events
     SET status = CASE
           WHEN $4::BOOLEAN OR attempts >= $3 THEN 'failed'
           ELSE 'pending'
         END,
         error_message = $1,
         dispatch_deadline_at = NULL,
         pre_provider_claim_id = NULL,
         pre_provider_claimed_at = NULL,
         pre_provider_claim_deadline_at = NULL,
         updated_at = NOW()
     WHERE idempotency_key = $2
       AND dispatch_attempt_id = $5::UUID
       AND bullmq_job_id = $6
       AND status IN ('enqueued', 'processing')
       AND provider_io_started_at IS NULL`,
    [
      errorMessage,
      idempotencyKey,
      MAX_OUTBOX_ATTEMPTS,
      options.terminal === true,
      authority.dispatchAttemptId,
      authority.bullmqJobId,
    ],
  );
  return result.rowCount === 1;
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
