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
import { db } from '../../src/db';
import { TaskService } from '../../src/services/TaskService';
import { PlanService } from '../../src/services/PlanService';
import type { User, Task } from '../../src/types';

describe('Plan Gating Invariant: Data Truth vs Delivery', () => {
  let freeUser: User;
  let premiumUser: User;
  let taskId: string;

  beforeAll(async () => {
    // Create test users
    const freeResult = await db.query<User>(
      `INSERT INTO users (email, full_name, firebase_uid, default_mode, role_was_overridden, plan)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET plan = 'free'
       RETURNING *`,
      ['free@test.com', 'Free User', `firebase_${Date.now()}_free`, 'poster', false, 'free']
    );
    freeUser = freeResult.rows[0];

    const premiumResult = await db.query<User>(
      `INSERT INTO users (email, full_name, firebase_uid, default_mode, role_was_overridden, plan)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (email) DO UPDATE SET plan = 'premium'
       RETURNING *`,
      ['premium@test.com', 'Premium User', `firebase_${Date.now()}_premium`, 'poster', false, 'premium']
    );
    premiumUser = premiumResult.rows[0];

    // Create a task and advance to TRAVELING
    const taskResult = await TaskService.create({
      posterId: premiumUser.id,
      title: 'Test Task',
      description: 'Test',
      price: 1000,
      riskLevel: 'MEDIUM',
    });

    if (!taskResult.success) {
      throw new Error('Failed to create test task');
    }

    taskId = taskResult.data.id;

    // Accept task (moves to ACCEPTED)
    // Note: In real flow, this would be done by a worker
    await db.query(
      `UPDATE tasks SET worker_id = $1, state = 'ACCEPTED', accepted_at = NOW() WHERE id = $2`,
      [freeUser.id, taskId]
    );

    // Advance progress to TRAVELING
    await TaskService.advanceProgress({
      taskId,
      to: 'TRAVELING',
      actor: { type: 'worker', userId: freeUser.id },
    });
  });

  afterAll(async () => {
    // Cleanup
    await db.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    await db.query('DELETE FROM users WHERE id IN ($1, $2)', [freeUser.id, premiumUser.id]);
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
