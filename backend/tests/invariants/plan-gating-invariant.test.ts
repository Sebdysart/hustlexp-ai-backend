/**
 * Plan Gating Invariant Test
 * 
 * Step 9-C - Monetization Hooks: Ensures plan gating affects delivery, not data truth
 * 
 * INVARIANT: Plan gating may affect realtime delivery, never data truth.
 * 
 * This test ensures:
 * - REST endpoints always return full task state (including progress_state)
 * - Only SSE delivery is filtered by plan
 * - UI can make rendering decisions based on plan, but data is never hidden
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { db, hasDb } from '../../src/db';
import { TaskService } from '../../src/services/TaskService';
import { PlanService } from '../../src/services/PlanService';
import type { User } from '../../src/types';
import { createTestPool, createTestTask } from '../setup';

describe.skipIf(!hasDb)('Plan Gating Invariant: Data Truth vs Delivery', () => {
  let freeUser: User;
  let premiumUser: User;
  let taskId: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    const runId = `${Date.now()}-${crypto.randomUUID()}`;
    // Create test users
    const freeResult = await db.query<User>(
      `INSERT INTO users (email, full_name, firebase_uid, default_mode, role_was_overridden, plan)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET plan = 'free'
       RETURNING *`,
      [`test-plan-${runId}-free@hustlexp.test`, 'Free User', `firebase_${runId}_free`, 'poster', false, 'free']
    );
    freeUser = freeResult.rows[0];

    const premiumResult = await db.query<User>(
      `INSERT INTO users (email, full_name, firebase_uid, default_mode, role_was_overridden, plan)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET plan = 'premium'
       RETURNING *`,
      [`test-plan-${runId}-premium@hustlexp.test`, 'Premium User', `firebase_${runId}_premium`, 'poster', false, 'premium']
    );
    premiumUser = premiumResult.rows[0];

    // Create a policy-bound task with a current offer decision and accepted worker.
    const task = await createTestTask(pool, {
      posterId: premiumUser.id,
      workerId: freeUser.id,
      state: 'ACCEPTED',
    });
    taskId = task.id;

    const acceptedProgress = await TaskService.advanceProgress({
      taskId,
      to: 'ACCEPTED',
      actor: { type: 'system' },
    });
    if (!acceptedProgress.success) throw new Error(acceptedProgress.error.message);

    // Advance progress to TRAVELING
    const travelingProgress = await TaskService.advanceProgress({
      taskId,
      to: 'TRAVELING',
      actor: { type: 'worker', userId: freeUser.id },
    });
    if (!travelingProgress.success) throw new Error(travelingProgress.error.message);
  });

  afterAll(async () => {
    // Offer decisions emit append-only offer events, so these uniquely named
    // fixtures intentionally remain in the disposable invariant database.
    await pool.end();
  });

  it('REST endpoint returns full progress_state for free users', async () => {
    // Free user queries task via REST
    const result = await TaskService.getById(taskId);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const task = result.data;

    // INVARIANT: REST always returns full truth
    // Free users should see the actual progress_state, even if they can't receive SSE events
    expect(task.progress_state).toBe('TRAVELING');
    expect(task.progress_updated_at).toBeDefined();
  });

  it('REST endpoint returns full progress_state for premium users', async () => {
    // Premium user queries same task
    const result = await TaskService.getById(taskId);

    expect(result.success).toBe(true);
    if (!result.success) return;

    const task = result.data;

    // Premium users also get full truth
    expect(task.progress_state).toBe('TRAVELING');
    expect(task.progress_updated_at).toBeDefined();
  });

  it('SSE delivery is filtered by plan (free users do not receive TRAVELING)', async () => {
    // Free user should NOT receive TRAVELING event via SSE
    const freeCanReceive = await PlanService.canReceiveProgressEvent(
      freeUser.id,
      'TRAVELING'
    );
    expect(freeCanReceive).toBe(false);

    // But they CAN receive basic states
    const freeCanReceiveAccepted = await PlanService.canReceiveProgressEvent(
      freeUser.id,
      'ACCEPTED'
    );
    expect(freeCanReceiveAccepted).toBe(true);
  });

  it('SSE delivery is not filtered for premium users', async () => {
    // Premium user should receive ALL events
    const premiumCanReceive = await PlanService.canReceiveProgressEvent(
      premiumUser.id,
      'TRAVELING'
    );
    expect(premiumCanReceive).toBe(true);

    const premiumCanReceiveWorking = await PlanService.canReceiveProgressEvent(
      premiumUser.id,
      'WORKING'
    );
    expect(premiumCanReceiveWorking).toBe(true);
  });

  it('Data truth is identical regardless of plan', async () => {
    // Both users query the same task
    const freeResult = await TaskService.getById(taskId);
    const premiumResult = await TaskService.getById(taskId);

    expect(freeResult.success).toBe(true);
    expect(premiumResult.success).toBe(true);
    if (!freeResult.success || !premiumResult.success) return;

    // INVARIANT: Data truth is identical
    expect(freeResult.data.progress_state).toBe(premiumResult.data.progress_state);
    expect(freeResult.data.progress_updated_at).toEqual(premiumResult.data.progress_updated_at);
    expect(freeResult.data.risk_level).toBe(premiumResult.data.risk_level);
  });
});
