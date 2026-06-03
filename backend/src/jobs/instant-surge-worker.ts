/**
 * Instant Surge Worker
 * 
 * Evaluates Instant tasks in MATCHING state and applies surge incentives.
 * 
 * Instant Surge Incentives v1:
 * - T+60s: Surge Level 1 (visibility boost - rebroadcast to lower tier)
 * - T+120s: Surge Level 2 (XP bonus increase to 2.0x cap)
 * - T+180s: Surge Level 3 (fail gracefully - transition to OPEN)
 */

import { Job } from 'bullmq';
import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { PlanService } from '../services/PlanService.js';
import { MIN_INSTANT_TIER, MIN_SENSITIVE_INSTANT_TIER } from '../services/InstantTrustConfig.js';
import { verifyJobSignature } from './queues.js';
import { workerLogger } from '../logger.js';
const log = workerLogger.child({ worker: 'instant-surge' });

interface InstantSurgeJobData {
  taskId: string;
  location?: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
  sensitive?: boolean;
}

/**
 * Process instant surge evaluation job
 * 
 * Evaluates elapsed time since matched_at and applies surge levels.
 * 
 * Launch Hardening v1: Error containment, kill switch checks, idempotency
 */
export async function processInstantSurgeJob(
  job: Job<InstantSurgeJobData>
): Promise<void> {
  // HMAC signature verification (Attack 12 — Redis injection defence)
  // task.instant_surge_evaluate jobs dispatched via the outbox MUST carry a _sig field
  // inside job.data.payload. The check is mandatory — jobs without a signature are
  // rejected outright to prevent unsigned payloads injected directly into Redis
  // (bypassing the outbox) from executing with elevated trust.
  const outerPayload = (job.data as unknown as Record<string, unknown>).payload;
  // A50-1 FIX: Fail-closed HMAC guard. Any job that arrives without a valid
  // object payload is rejected immediately — the previous conditional silently
  // skipped the entire HMAC block (including the R49 mandatory-sig throw) when
  // outerPayload was null/undefined/non-object, leaving an unsigned-injection
  // bypass open for malformed jobs.
  if (!outerPayload || typeof outerPayload !== 'object') {
    log.error({ jobId: job.id }, 'Job payload is missing or not an object — rejecting for security');
    throw new Error('Invalid job payload — job rejected for security');
  }
  const p = outerPayload as Record<string, unknown>;
  // A49-3 FIX: Signature is now mandatory. Missing or empty _sig rejects the job.
  if (!('_sig' in p) || !p._sig) {
    log.error({ jobId: job.id }, 'Job is missing required HMAC signature — rejecting for security');
    throw new Error('Missing job signature — job rejected for security');
  }
  const { _sig, ...payloadWithoutSig } = p;
  if (!verifyJobSignature(payloadWithoutSig, _sig as string)) {
    log.error({ jobId: job.id }, 'Job signature verification failed — possible Redis injection attack');
    throw new Error('JOB_SIGNATURE_INVALID: Payload signature verification failed');
  }

  const { taskId, location, riskLevel, sensitive } = (job.data as unknown as Record<string, unknown>).payload as InstantSurgeJobData;
  const startTime = Date.now();

  try {
    // Launch Hardening v1: Kill switch check
    const { InstantModeKillSwitch } = await import('../services/InstantModeKillSwitch.js');
    const flags = InstantModeKillSwitch.checkFlags({ taskId, operation: 'surge_evaluation' });
    
    if (!flags.surgeEnabled) {
      log.info({ taskId }, 'Instant surge skipped - kill switch active');
      return; // Safe exit - no state mutation
    }

  // Get task state and timing
  const taskResult = await db.query<{
    id: string;
    state: string;
    instant_mode: boolean;
    matched_at: Date | null;
    accepted_at: Date | null;
    surge_level: number;
    sensitive: boolean | null;
  }>(
    `SELECT id, state, instant_mode, matched_at, accepted_at, surge_level, sensitive 
     FROM tasks 
     WHERE id = $1`,
    [taskId]
  );

  if (taskResult.rowCount === 0) {
    throw new Error(`Task ${taskId} not found`);
  }

  const task = taskResult.rows[0];

  // Only process Instant tasks in MATCHING state
  if (!task.instant_mode || task.state !== 'MATCHING') {
    log.info({ taskId, state: task.state }, 'Task not in MATCHING state - skipping surge evaluation');
    return;
  }

  // If already accepted, no surge needed
  if (task.accepted_at) {
    log.info({ taskId }, 'Task already accepted - skipping surge evaluation');
    return;
  }

  if (!task.matched_at) {
    log.warn({ taskId }, 'Task in MATCHING state but matched_at is NULL - skipping surge evaluation');
    return;
  }

  // Calculate elapsed time since matched_at
  const matchedAt = new Date(task.matched_at);
  const now = new Date();
  const elapsedSeconds = Math.floor((now.getTime() - matchedAt.getTime()) / 1000);

  log.info({ taskId, elapsedSeconds, currentSurgeLevel: task.surge_level }, 'Task elapsed time evaluated');

  // Determine target surge level based on elapsed time
  let targetSurgeLevel = 0;
  if (elapsedSeconds >= 180) {
    targetSurgeLevel = 3; // Fail gracefully
  } else if (elapsedSeconds >= 120) {
    targetSurgeLevel = 2; // XP boost
  } else if (elapsedSeconds >= 60) {
    targetSurgeLevel = 1; // Visibility boost
  }

  // Only escalate if target level is higher than current
  if (targetSurgeLevel <= task.surge_level) {
    log.info({ taskId, currentSurgeLevel: task.surge_level, targetSurgeLevel }, 'No surge escalation needed');
    return;
  }

  // Bug 3 fix: wrap surge_level UPDATE and the outbox INSERT together in a single
  // transaction so an outbox write failure can never leave surge_level updated
  // without a corresponding event firing (and vice-versa).
  if (targetSurgeLevel === 1) {
    // Surge Level 1: Visibility boost - rebroadcast to lower tier
    await handleSurgeLevel1(taskId, location, riskLevel, sensitive || false);
  } else if (targetSurgeLevel === 2) {
    // Surge Level 2: XP boost (handled in XP calculation, just rebroadcast with urgency)
    await handleSurgeLevel2(taskId, location, riskLevel, sensitive || false);
  } else if (targetSurgeLevel === 3) {
    // Surge Level 3: Fail gracefully - transition to OPEN
    await handleSurgeLevel3(taskId);
  }

  log.info({ taskId, targetSurgeLevel }, 'Task escalated to surge level');

    const latency = Date.now() - startTime;
    log.info({ taskId, targetSurgeLevel, latency, stage: 'surge_evaluation' }, 'Instant surge evaluation completed');
  } catch (error) {
    // Launch Hardening v1: Error containment - never crash the process
    const latency = Date.now() - startTime;
    log.error({ taskId, err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, latency, stage: 'surge_evaluation' }, 'Instant surge evaluation failed');
    
    // Re-throw to let BullMQ handle retry (bounded retries configured at queue level)
    throw error;
  }
}

/**
 * Surge Level 1: Visibility boost
 * Rebroadcast to same tier + next lower tier (if ≥ Tier 1)
 */
async function handleSurgeLevel1(
  taskId: string,
  location: string | undefined,
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME',
  sensitive: boolean
): Promise<void> {
  const minTrustTier = sensitive ? MIN_SENSITIVE_INSTANT_TIER : MIN_INSTANT_TIER;
  const expandedTier = Math.max(1, minTrustTier - 1); // Allow one tier lower

  log.info({ taskId, expandedTier, minTrustTier }, 'Surge Level 1: Expanding visibility to lower tier');

  // Find eligible hustlers (including lower tier) — read outside transaction to
  // avoid holding the lock during the PlanService check loop
  const eligibleHustlers = await db.query<{ id: string; trust_tier: number }>(
    `SELECT u.id, u.trust_tier
     FROM users u
     WHERE u.default_mode = 'worker'
       AND u.trust_hold = FALSE
       AND u.trust_tier >= $1
       AND NOT EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.worker_id = u.id
           AND t.instant_mode = TRUE
           AND t.state IN ('MATCHING', 'ACCEPTED', 'PROOF_SUBMITTED')
       )
     LIMIT 50`,
    [expandedTier]
  );

  log.info({ taskId, eligibleCount: eligibleHustlers.rowCount, expandedTier }, 'Surge Level 1: Rebroadcasting to eligible hustlers');

  // Filter eligible hustlers outside the transaction (plan check hits external service)
  const allowed: Array<{ id: string; trust_tier: number }> = [];
  for (const hustler of eligibleHustlers.rows) {
    const planCheck = await PlanService.canAcceptTaskWithRisk(hustler.id, riskLevel);
    if (planCheck.allowed) allowed.push(hustler);
  }

  // Bug 3 fix: UPDATE surge_level + all outbox INSERTs in a single transaction so
  // they are atomic — if any outbox write fails the surge_level UPDATE is rolled back
  // W-03 fix: CAS guard (AND surge_level < 1) prevents double fan-out when two
  // concurrent workers both pass the pre-transaction surge_level check.
  await db.transaction(async (query) => {
    const updateResult = await query(
      `UPDATE tasks SET surge_level = 1, updated_at = NOW() WHERE id = $1 AND surge_level < 1`,
      [taskId]
    );

    if (updateResult.rowCount === 0) {
      log.info({ taskId }, 'Surge Level 1: another worker already applied this surge level, skipping fan-out');
      return;
    }

    for (const hustler of allowed) {
      await writeToOutbox({
        eventType: 'task.instant_available',
        aggregateType: 'task',
        aggregateId: taskId,
        eventVersion: 1,
        idempotencyKey: `task.instant_available:${taskId}:${hustler.id}:surge1`,
        payload: {
          taskId,
          hustlerId: hustler.id,
          location,
          riskLevel,
          sensitive,
          surgeLevel: 1,
          urgencyCopy: 'Urgent Instant — limited availability',
        },
        queueName: 'user_notifications',
      }, query);
    }
  });
}

/**
 * Surge Level 2: XP boost
 * XP multiplier already handled in XP calculation (2.0x cap)
 * Just rebroadcast with high-priority copy
 */
async function handleSurgeLevel2(
  taskId: string,
  location: string | undefined,
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME',
  sensitive: boolean
): Promise<void> {
  const minTrustTier = sensitive ? MIN_SENSITIVE_INSTANT_TIER : MIN_INSTANT_TIER;
  const expandedTier = Math.max(1, minTrustTier - 1);

  log.info({ taskId }, 'Surge Level 2: XP boost active, rebroadcasting with high-priority copy');

  // Find eligible hustlers — read outside transaction
  const eligibleHustlers = await db.query<{ id: string; trust_tier: number }>(
    `SELECT u.id, u.trust_tier
     FROM users u
     WHERE u.default_mode = 'worker'
       AND u.trust_hold = FALSE
       AND u.trust_tier >= $1
       AND NOT EXISTS (
         SELECT 1 FROM tasks t
         WHERE t.worker_id = u.id
           AND t.instant_mode = TRUE
           AND t.state IN ('MATCHING', 'ACCEPTED', 'PROOF_SUBMITTED')
       )
     LIMIT 50`,
    [expandedTier]
  );

  // Filter eligible hustlers outside the transaction (plan check hits external service)
  const allowed: Array<{ id: string; trust_tier: number }> = [];
  for (const hustler of eligibleHustlers.rows) {
    const planCheck = await PlanService.canAcceptTaskWithRisk(hustler.id, riskLevel);
    if (planCheck.allowed) allowed.push(hustler);
  }

  // Bug 3 fix: UPDATE surge_level + all outbox INSERTs in a single transaction
  // W-03 fix: CAS guard (AND surge_level < 2) prevents double fan-out when two
  // concurrent workers both pass the pre-transaction surge_level check.
  await db.transaction(async (query) => {
    const updateResult = await query(
      `UPDATE tasks SET surge_level = 2, updated_at = NOW() WHERE id = $1 AND surge_level < 2`,
      [taskId]
    );

    if (updateResult.rowCount === 0) {
      log.info({ taskId }, 'Surge Level 2: another worker already applied this surge level, skipping fan-out');
      return;
    }

    for (const hustler of allowed) {
      await writeToOutbox({
        eventType: 'task.instant_available',
        aggregateType: 'task',
        aggregateId: taskId,
        eventVersion: 1,
        idempotencyKey: `task.instant_available:${taskId}:${hustler.id}:surge2`,
        payload: {
          taskId,
          hustlerId: hustler.id,
          location,
          riskLevel,
          sensitive,
          surgeLevel: 2,
          urgencyCopy: 'High-priority Instant — bonus XP',
        },
        queueName: 'user_notifications',
      }, query);
    }
  });
}

/**
 * Surge Level 3: Fail gracefully
 * Transition task from MATCHING to OPEN (non-instant)
 */
async function handleSurgeLevel3(taskId: string): Promise<void> {
  log.info({ taskId }, 'Surge Level 3: Failing gracefully - transitioning to OPEN');

  // Get elapsed time for observability (read-only, outside transaction)
  const taskResult = await db.query<{ matched_at: Date }>(
    `SELECT matched_at FROM tasks WHERE id = $1`,
    [taskId]
  );
  const matchedAt = taskResult.rows[0]?.matched_at;
  const elapsedSeconds = matchedAt
    ? Math.floor((Date.now() - matchedAt.getTime()) / 1000)
    : 0;

  // Bug 3 fix: wrap state transition UPDATE + outbox INSERT in a single transaction
  // so if the outbox write fails the surge_level/state change is also rolled back
  let transitioned = false;
  let posterId: string | null = null;

  await db.transaction(async (query) => {
    // Transition to OPEN state (non-instant)
    // Note: instant_mode = FALSE allows task to be in OPEN state (constraint allows this)
    // W-03 fix: AND surge_level < 3 guards against two concurrent workers both
    // entering handleSurgeLevel3 before either completes the UPDATE.
    const result = await query<{ id: string; poster_id: string }>(
      `UPDATE tasks
       SET state = 'OPEN',
           instant_mode = FALSE,
           surge_level = 3,
           updated_at = NOW()
       WHERE id = $1
         AND state = 'MATCHING'
         AND instant_mode = TRUE
         AND surge_level < 3
       RETURNING id, poster_id`,
      [taskId]
    );

    if (result.rowCount === 0) {
      // Task already accepted/cancelled — nothing to do; transaction will COMMIT with no-op
      return;
    }

    transitioned = true;
    posterId = result.rows[0].poster_id;

    await writeToOutbox({
      eventType: 'task.instant_failed',
      aggregateType: 'task',
      aggregateId: taskId,
      eventVersion: 1,
      idempotencyKey: `task.instant_failed:${taskId}`,
      payload: {
        taskId,
        posterId,
        reason: 'No trusted hustler available right now',
      },
      queueName: 'user_notifications',
    }, query);
  });

  if (!transitioned) {
    log.warn({ taskId }, 'Task could not be transitioned (may have been accepted or cancelled)');
    return;
  }

  log.info({ taskId }, 'Task transitioned to OPEN (Instant Mode failed)');

  // Launch Hardening v1: Observability - log surge fallback (outside transaction — fire-and-forget)
  const { InstantObservability } = await import('../services/InstantObservability.js');
  InstantObservability.logSurgeFallback(taskId, elapsedSeconds);
}
