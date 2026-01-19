/**
 * Instant Surge Evaluator
 * 
 * Periodic worker that evaluates Instant tasks in MATCHING state
 * and enqueues surge evaluation jobs.
 * 
 * Runs every 10 seconds to check for surge triggers.
 * 
 * Launch Hardening v1: Error containment, observability
 */

import { db } from '../db';
import { writeToOutbox } from './outbox-helpers';
import { InstantObservability } from '../services/InstantObservability';

/**
 * Evaluate all Instant tasks in MATCHING state and enqueue surge jobs
 * 
 * This should be called periodically (e.g., every 10 seconds)
 * 
 * Launch Hardening v1: Error containment, observability
 */
export async function evaluateInstantSurges(): Promise<void> {
  try {
    // Launch Hardening v1: Check for stuck tasks (observability)
    const stuckCheck = await InstantObservability.checkStuckTasks();
    if (stuckCheck.stuckCount > 0) {
      // Alert already logged by checkStuckTasks
    }
  // Find all Instant tasks in MATCHING state that need surge evaluation
  const tasksResult = await db.query<{
    id: string;
    matched_at: Date;
    surge_level: number;
    location: string | null;
    risk_level: string;
    sensitive: boolean | null;
  }>(
    `SELECT id, matched_at, surge_level, location, risk_level, sensitive
     FROM tasks
     WHERE instant_mode = TRUE
       AND state = 'MATCHING'
       AND matched_at IS NOT NULL
       AND accepted_at IS NULL
     ORDER BY matched_at ASC
     LIMIT 50`,
    []
  );

  if (tasksResult.rowCount === 0) {
    return; // No tasks to evaluate
  }

  const now = new Date();
  let evaluatedCount = 0;

  for (const task of tasksResult.rows) {
    const matchedAt = new Date(task.matched_at);
    const elapsedSeconds = Math.floor((now.getTime() - matchedAt.getTime()) / 1000);

    // Determine if surge evaluation is needed
    let needsEvaluation = false;
    let targetSurgeLevel = 0;

    if (elapsedSeconds >= 180 && task.surge_level < 3) {
      targetSurgeLevel = 3;
      needsEvaluation = true;
    } else if (elapsedSeconds >= 120 && task.surge_level < 2) {
      targetSurgeLevel = 2;
      needsEvaluation = true;
    } else if (elapsedSeconds >= 60 && task.surge_level < 1) {
      targetSurgeLevel = 1;
      needsEvaluation = true;
    }

    if (needsEvaluation) {
      // Enqueue surge evaluation job
      await writeToOutbox({
        eventType: 'task.instant_surge_evaluate',
        aggregateType: 'task',
        aggregateId: task.id,
        eventVersion: 1,
        idempotencyKey: `task.instant_surge_evaluate:${task.id}:${targetSurgeLevel}`,
        payload: {
          taskId: task.id,
          location: task.location || undefined,
          riskLevel: task.risk_level as 'LOW' | 'MEDIUM' | 'HIGH' | 'IN_HOME',
          sensitive: task.sensitive || false,
        },
        queueName: 'critical_payments',
      });

      evaluatedCount++;
    }
  }

    if (evaluatedCount > 0) {
      console.log(`📊 Evaluated ${evaluatedCount} Instant tasks for surge escalation`);
    }
  } catch (error) {
    // Launch Hardening v1: Error containment - never crash the process
    console.error(`❌ Instant surge evaluator failed`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      stage: 'surge_evaluator',
      timestamp: new Date().toISOString(),
    });
    // Don't re-throw - evaluator runs on interval, will retry next cycle
  }
}
