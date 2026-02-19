/**
 * Instant Matching Worker
 * 
 * Handles broadcast of instant tasks to eligible hustlers.
 * 
 * IEM v1: Simple broadcast, no smart routing.
 */

import { Job } from 'bullmq';
import { db } from '../db';
import { writeToOutbox } from './outbox-helpers';
import { PlanService } from '../services/PlanService';
import { MIN_INSTANT_TIER, MIN_SENSITIVE_INSTANT_TIER } from '../services/InstantTrustConfig';

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
  const { taskId, location, riskLevel } = job.data;
  const startTime = Date.now();

  try {
    // Launch Hardening v1: Kill switch check
    const { InstantModeKillSwitch } = await import('../services/InstantModeKillSwitch');
    const flags = InstantModeKillSwitch.checkFlags({ taskId, operation: 'matching_broadcast' });
    
    if (!flags.instantModeEnabled) {
      console.log(`🚫 Instant matching skipped - kill switch active`, { taskId });
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
    console.log(`ℹ️  Task ${taskId} no longer in MATCHING state (state: ${task.state})`);
    return;
  }

  // Determine minimum trust tier for this task
  // Sensitive tasks require higher tier
  const minTrustTier = task.sensitive ? MIN_SENSITIVE_INSTANT_TIER : MIN_INSTANT_TIER;
  
  // Find eligible hustlers
  // Pre-Alpha Prerequisite: Eligibility Guard filters by risk tier requirements
  // Trust tier enforcement: only hustlers with trust_tier >= minTrustTier can accept Instant tasks
  // v1: Broadcast to all eligible hustlers. v2 will add location-based filtering.
  
  // Get task risk level for eligibility filtering
  const taskRiskResult = await db.query<{ risk_level: string }>(
    `SELECT risk_level FROM tasks WHERE id = $1`,
    [taskId]
  );
  const taskRiskLevel = taskRiskResult.rows[0]?.risk_level || 'LOW';
  
  // Map risk level to required trust tier
  // TIER_0/1 → VERIFIED (1), TIER_2 → IN_HOME (3), TIER_3 → BLOCKED
  let requiredTrustTierForRisk = 1; // VERIFIED
  if (taskRiskLevel === 'HIGH') {
    requiredTrustTierForRisk = 3; // IN_HOME
  } else if (taskRiskLevel === 'IN_HOME') {
    // TIER_3 tasks are blocked in alpha - should not reach here
    console.warn(`⚠️  Task ${taskId} has IN_HOME risk level (blocked in alpha)`);
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

  console.log(`📢 Broadcasting instant task ${taskId} to ${eligibleHustlers.rowCount} eligible hustlers`);

  // For each eligible hustler, check plan eligibility and send notification
  for (const hustler of eligibleHustlers.rows) {
    const planCheck = await PlanService.canAcceptTaskWithRisk(hustler.id, riskLevel as any);
    
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
      queueName: 'critical_payments', // High priority for instant tasks
    });
  }

    // Log time-to-accept start (for instrumentation)
    await db.query(
      `UPDATE tasks SET updated_at = NOW() WHERE id = $1`,
      [taskId]
    );

    const latency = Date.now() - startTime;
    console.log(`✅ Instant matching completed for task ${taskId}`, {
      taskId,
      latency,
      stage: 'matching_broadcast',
    });
  } catch (error) {
    // Launch Hardening v1: Error containment - never crash the process
    const latency = Date.now() - startTime;
    console.error(`❌ Instant matching failed for task ${taskId}`, {
      taskId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      latency,
      stage: 'matching_broadcast',
    });
    
    // Re-throw to let BullMQ handle retry (bounded retries configured at queue level)
    throw error;
  }
}
