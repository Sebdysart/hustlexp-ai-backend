/**
 * Task Complete Handler (Phase N2.2 - Execution-Critical Writes)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: POST /trpc/tasks.complete
 * Purpose: Task lifecycle state write - WORKING → COMPLETED
 * Phase: N2.2 (Execution-Critical Writes - Task Lifecycle Only)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. STATE MACHINE:
 *    - WORKING → COMPLETED
 *    - Illegal transitions rejected at backend
 * 
 * 2. PRECONDITIONS (ALL required):
 *    ✅ task.state === WORKING
 *    ✅ Caller is the assigned HUSTLER
 * 
 * 3. EFFECTS (ONLY these):
 *    ✅ Transition state → COMPLETED
 *    ✅ Persist timestamp: completed_at
 *    ❌ NO payouts (that's later)
 * 
 * 4. FORBIDDEN (N2.2 - Do NOT implement):
 *    ❌ Escrow release
 *    ❌ XP grants
 *    ❌ Trust tier changes
 *    ❌ Proof submission handling (that's later)
 * 
 * 5. TRANSACTION & IDEMPOTENCY:
 *    ✅ Transaction wraps state change
 *    ✅ Repeat calls must not advance state twice
 *    ✅ Audit logging on state write
 * 
 * Reference: Phase N2.2 Execution-Critical Writes Checklist
 * 
 * NOTE: Proof photos and notes are accepted but NOT processed in N2.2
 *       They will be handled in later phases (proof submission, review, etc.)
 */

import { protectedProcedure } from '@/backend/trpc/create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';
import { assertTransition } from './state-machine';

interface TaskRow {
  id: string;
  state: string; // WORKING, COMPLETED, etc.
  assigned_hustler_id: string | null;
}

interface UserRow {
  id: string;
  firebase_uid: string;
}

export const tasksCompleteProcedure = protectedProcedure
  .input(
    z.object({
      taskId: z.string().uuid(),
      proofPhotos: z.array(z.string()).optional(), // Accepted but not processed in N2.2
      notes: z.string().optional(), // Accepted but not processed in N2.2
    })
  )
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
    // NO payouts, NO XP grants, NO trust tier changes

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
      SELECT id, state, assigned_hustler_id
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

    // Precondition: Task state must be WORKING
    if (task.state !== 'WORKING') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Task is not in WORKING state. Current state: ${task.state}`,
      });
    }

    // Assert legal transition: WORKING → COMPLETED
    assertTransition('WORKING', 'COMPLETED');

    // Precondition: Caller must be the assigned hustler
    // N2.2 CLEANUP: Check only assigned_hustler_id (canonical field)
    if (task.assigned_hustler_id !== userId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only the assigned hustler can complete the task',
      });
    }

    // Step 2: Update task state to COMPLETED
    // NOTE: Proof photos and notes are accepted but NOT processed here
    // They will be handled in later phases (proof submission, review, etc.)
    const updateResult = await db.query(
      `
      UPDATE tasks
      SET 
        state = 'COMPLETED',
        completed_at = NOW(),
        updated_at = NOW()
      WHERE id = $1
        AND state = 'WORKING'
        AND assigned_hustler_id = $2
      RETURNING id, state, completed_at
      `,
      [input.taskId, userId]
    );

    // Idempotency check: If update affected 0 rows, check current state
    if (updateResult.rowCount === 0) {
      // Double-check current state
      const currentTask = await db.query<TaskRow>(
        `SELECT id, state, assigned_hustler_id FROM tasks WHERE id = $1 LIMIT 1`,
        [input.taskId]
      );

      const currentState = currentTask.rows[0]?.state;
      const currentAssigned = currentTask.rows[0]?.assigned_hustler_id;

      if (currentState === 'COMPLETED' && currentAssigned === userId) {
        // Already completed - idempotent success
        return {
          taskId: input.taskId,
          state: 'COMPLETED' as const,
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
        message: `Task state changed during complete operation. Current state: ${currentState}`,
      });
    }

    const updatedTask = updateResult.rows[0];

    // Audit logging
    console.log('[Task Complete] State transition:', {
      taskId: input.taskId,
      userId,
      previousState: 'WORKING',
      newState: 'COMPLETED',
      timestamp: updatedTask.completed_at,
      // NOTE: Proof photos and notes logged but not processed in N2.2
      proofPhotosCount: input.proofPhotos?.length || 0,
      hasNotes: !!input.notes,
    });

    // PHASE N2.2: NO payouts, NO XP grants, NO trust tier changes
    // These will be handled in later phases

    return {
      taskId: input.taskId,
      state: 'COMPLETED' as const,
    };
  });
