/**
 * Task Arrived Handler (Phase N2.2 - Execution-Critical Writes)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: POST /trpc/tasks.arrived
 * Purpose: Task lifecycle state write - EN_ROUTE → WORKING
 * Phase: N2.2 (Execution-Critical Writes - Task Lifecycle Only)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. STATE MACHINE:
 *    - EN_ROUTE (ACCEPTED) → WORKING
 *    - Illegal transitions rejected at backend
 * 
 * 2. PRECONDITIONS (ALL required):
 *    ✅ task.state === EN_ROUTE (ACCEPTED)
 *    ✅ Caller is the assigned HUSTLER
 * 
 * 3. EFFECTS (ONLY these):
 *    ✅ Transition state → WORKING
 *    ✅ Persist timestamp: arrived_at (or en_route_at if schema uses it)
 * 
 * 4. FORBIDDEN:
 *    ❌ Location writes beyond execution telemetry
 *    ❌ Eligibility checks beyond assignment verification
 * 
 * 5. TRANSACTION & IDEMPOTENCY:
 *    ✅ Transaction wraps state change
 *    ✅ Repeat calls must not advance state twice
 *    ✅ Audit logging on state write
 * 
 * Reference: Phase N2.2 Execution-Critical Writes Checklist
 * 
 * NOTE: Schema may not have WORKING state or arrived_at field - see ambiguity notes
 */

import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';
import { assertTransition } from './state-machine';

interface TaskRow {
  id: string;
  state: string; // ACCEPTED, WORKING, etc.
  worker_id: string | null;
  assigned_hustler_id: string | null;
}

interface UserRow {
  id: string;
  firebase_uid: string;
}

export const tasksArrivedProcedure = protectedProcedure
  .input(z.object({ taskId: z.string().uuid() }))
  .mutation(async ({ ctx, input }) => {
    const firebaseUid = ctx.user?.uid;

    if (!firebaseUid) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'User ID not found in context',
      });
    }

    // PHASE N2.2: Task lifecycle state write only
    // No eligibility writes, no verification writes, no capability writes

    // Step 0: Get database user_id from Firebase UID
    const userResult = await db.query<UserRow>(
      `
      SELECT id, firebase_uid
      FROM users
      WHERE firebase_uid = $1
      LIMIT 1
      `,
      [firebaseUid]
    );

    if (userResult.rows.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'User not found in database',
      });
    }

    const userId = userResult.rows[0].id;

    // Step 1: Get task with lock (for transaction)
    const taskResult = await db.query<TaskRow>(
      `
      SELECT id, state, worker_id, assigned_hustler_id
      FROM tasks
      WHERE id = $1
      FOR UPDATE
      LIMIT 1
      `,
      [input.taskId]
    );

    if (taskResult.rows.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Task not found',
      });
    }

    const task = taskResult.rows[0];

    // Precondition: Task state must be EN_ROUTE (ACCEPTED in schema)
    // N2.2 CLEANUP: EN_ROUTE maps to ACCEPTED state in schema
    if (task.state !== 'ACCEPTED') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Task is not in EN_ROUTE state. Current state: ${task.state}`,
      });
    }

    // Assert legal transition: ACCEPTED (EN_ROUTE) → WORKING
    assertTransition('ACCEPTED', 'WORKING');

    // Precondition: Caller must be the assigned hustler
    // N2.2 CLEANUP: Check only assigned_hustler_id (canonical field)
    if (task.assigned_hustler_id !== userId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only the assigned hustler can mark task as arrived',
      });
    }

    // Step 2: Update task state to WORKING
    // N2.2 CLEANUP: EN_ROUTE (ACCEPTED) → WORKING
    // Timestamp: arrived_at (arrival onsite)
    const updateResult = await db.query(
      `
      UPDATE tasks
      SET 
        state = 'WORKING',
        arrived_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND state = 'ACCEPTED'
        AND assigned_hustler_id = $2
      RETURNING id, state, arrived_at
      `,
      [input.taskId, userId]
    );

    // Idempotency check: If update affected 0 rows, check current state
    if (updateResult.rowCount === 0) {
      // Double-check current state
      const currentTask = await db.query<TaskRow>(
        `SELECT id, state, worker_id, assigned_hustler_id FROM tasks WHERE id = $1 LIMIT 1`,
        [input.taskId]
      );

      const currentState = currentTask.rows[0]?.state;
      const currentAssigned = currentTask.rows[0]?.assigned_hustler_id;

      if (currentState === 'WORKING' && currentAssigned === userId) {
        // Already in WORKING state - idempotent success
        return {
          taskId: input.taskId,
          state: 'WORKING' as const,
        };
      }

      if (currentAssigned !== userId) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Not assigned to this task',
        });
      }

      throw new TRPCError({
        code: 'CONFLICT',
        message: `Task state changed during arrived operation. Current state: ${currentState}`,
      });
    }

    const updatedTask = updateResult.rows[0];

    // Audit logging
    console.log('[Task Arrived] State transition:', {
      taskId: input.taskId,
      userId,
      previousState: 'ACCEPTED', // Maps to EN_ROUTE conceptually
      newState: 'WORKING',
      arrivedAt: updatedTask.arrived_at,
    });

    return {
      taskId: input.taskId,
      state: 'WORKING' as const,
    };
  });
