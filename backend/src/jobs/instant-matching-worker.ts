/**
 * Instant Matching Worker
 * 
 * Handles broadcast of instant tasks to eligible hustlers.
 * 
 * IEM v1: Simple broadcast, no smart routing.
 */

import { Job } from 'bullmq';
import { db } from '../db.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';
import { PlanService } from '../services/PlanService.js';
import { MIN_INSTANT_TIER, MIN_SENSITIVE_INSTANT_TIER } from '../services/InstantTrustConfig.js';
import { verifyJobSignature } from './queues.js';
import { workerLogger } from '../logger.js';
const log = workerLogger.child({ worker: 'instant-matching' });

interface InstantMatchingJobData {
  taskId: string;
  location?: string;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME';
}

/**
 * Process instant matching job
 * 
 * Eligibility criteria (implemented):
 * - Trust tier ≥ task risk-level requirement
 * - No active Instant task already in progress
 * - Plan tier allows the task's risk level
 * - Not on trust hold
 *
 * Nice-to-have (post-launch):
 * - Online status tracking (requires WebSocket presence)
 * - Location radius matching (requires lat/lng on tasks table)
 * - Cooldown restriction between instant accepts
 * 
 * Launch Hardening v1: Error containment, kill switch checks, idempotency
 */
export async function processInstantMatchingJob(
  job: Job<InstantMatchingJobData>
): Promise<void> {
  // HMAC signature verification (Attack 12 — Redis injection defence)
  // task.instant_matching_started jobs dispatched via the outbox MUST carry a _sig field
  // inside job.data.payload. The check is mandatory — jobs without a signature are
  // rejected outright to prevent unsigned payloads injected directly into Redis
  // (bypassing the outbox) from executing with elevated trust.
  const outerPayload = (job.data as Record<string, unknown>).payload;
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

  const { taskId, location, riskLevel } = (job.data as Record<string, unknown>).payload as InstantMatchingJobData;
  const startTime = Date.now();

  try {
    // Launch Hardening v1: Kill switch check
    const { InstantModeKillSwitch } = await import('../services/InstantModeKillSwitch.js');
    const flags = InstantModeKillSwitch.checkFlags({ taskId, operation: 'matching_broadcast' });
    
    if (!flags.instantModeEnabled) {
      log.info({ taskId }, 'Instant matching skipped - kill switch active');
      return; // Safe exit - no state mutation
    }

  // Verify task is still in MATCHING state
  const taskResult = await db.query<{
    id: string;
    state: string;
    instant_mode: boolean;
    risk_level: string;
    sensitive: boolean | null;
  }>(
    `SELECT id, state, instant_mode, risk_level, sensitive FROM tasks WHERE id = $1`,
    [taskId]
  );

  if (taskResult.rowCount === 0) {
    throw new Error(`Task ${taskId} not found`);
  }

  const task = taskResult.rows[0];

  if (!task.instant_mode || task.state !== 'MATCHING') {
    // Task already accepted or cancelled
    log.info({ taskId, state: task.state }, 'Task no longer in MATCHING state');
    return;
  }

  // Determine minimum trust tier for this task
  // Sensitive tasks require higher tier
  const minTrustTier = task.sensitive ? MIN_SENSITIVE_INSTANT_TIER : MIN_INSTANT_TIER;
  
  // Find eligible hustlers
  // Pre-Alpha Prerequisite: Eligibility Guard filters by risk tier requirements
  // Trust tier enforcement: only hustlers with trust_tier >= minTrustTier can accept Instant tasks
  // v1: Broadcast to all eligible hustlers. v2 will add location-based filtering.
  
  // Get task risk level for eligibility filtering (already fetched above)
  const taskRiskLevel = task.risk_level || 'LOW';
  
  // Map risk level to required trust tier
  // TIER_0/1 → VERIFIED (1), TIER_2 → IN_HOME (3), TIER_3 → BLOCKED
  let requiredTrustTierForRisk = 1; // VERIFIED
  if (taskRiskLevel === 'HIGH') {
    requiredTrustTierForRisk = 3; // IN_HOME
  } else if (taskRiskLevel === 'IN_HOME') {
    // TIER_3 tasks are blocked in alpha - should not reach here
    log.warn({ taskId }, 'Task has IN_HOME risk level (blocked in alpha)');
    return;
  }
  
  // Use the higher of: Instant Mode min tier OR risk tier requirement
  const effectiveMinTier = Math.max(minTrustTier, requiredTrustTierForRisk);
  
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
    [effectiveMinTier]
  );

  log.info({ taskId, eligibleCount: eligibleHustlers.rowCount }, 'Broadcasting instant task to eligible hustlers');

  // For each eligible hustler, check plan eligibility and send notification
  for (const hustler of eligibleHustlers.rows) {
    const planCheck = await PlanService.canAcceptTaskWithRisk(hustler.id, riskLevel as 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME');
    
    if (!planCheck.allowed) {
      // Skip hustlers without required plan
      continue;
    }

    // Enqueue notification (push notification, in-feed interrupt)
    await writeToOutbox({
      eventType: 'task.instant_available',
      aggregateType: 'task',
      aggregateId: taskId,
      eventVersion: 1,
      idempotencyKey: `task.instant_available:${taskId}:${hustler.id}`,
      payload: {
        taskId,
        hustlerId: hustler.id,
        location,
        riskLevel,
      },
      queueName: 'user_notifications', // Notifications are not financial — must not block critical_payments (concurrency:1)
    });
  }

    // Log time-to-accept start (for instrumentation)
    await db.query(
      `UPDATE tasks SET updated_at = NOW() WHERE id = $1`,
      [taskId]
    );

    const latency = Date.now() - startTime;
    log.info({ taskId, latency, stage: 'matching_broadcast' }, 'Instant matching completed');
  } catch (error) {
    // Launch Hardening v1: Error containment - never crash the process
    const latency = Date.now() - startTime;
    log.error({ taskId, err: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined, latency, stage: 'matching_broadcast' }, 'Instant matching failed');
    
    // Re-throw to let BullMQ handle retry (bounded retries configured at queue level)
    throw error;
  }
}
