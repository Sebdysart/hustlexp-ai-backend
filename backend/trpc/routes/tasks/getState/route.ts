/**
 * Task State Handler (Phase N2.1 - Read-Only)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: GET /trpc/tasks.getState
 * Purpose: Single gate for task-state-gated routes (maps, execution UI)
 * Phase: N2.1 (Read-Only Backend Handlers)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. PURPOSE:
 *    - Gates EN_ROUTE screens
 *    - Gates map screens
 *    - Gates execution UI
 * 
 * 2. MINIMAL METADATA ONLY:
 *    ✅ Returns: task_id, state, timestamps
 *    ❌ NEVER returns full task payload
 *    ❌ NEVER returns location before EN_ROUTE
 *    ❌ NEVER grants implicit permissions
 * 
 * 3. READ-ONLY (NO SIDE EFFECTS):
 *    ✅ Query task state only
 *    ❌ NO writes, NO state changes
 * 
 * 4. AUTHORITY ENFORCEMENT:
 *    - If this endpoint is wrong, maps will leak authority
 *    - State transitions are validated elsewhere (not here)
 * 
 * Reference: NAVIGATION_ARCHITECTURE.md §Task-State Guards
 */

import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';

interface TaskStateRow {
  id: string;
  status: string;
  accepted_at: string | null;
  en_route_at: string | null;
  working_at: string | null;
  completed_at: string | null;
}

export const tasksGetStateProcedure = protectedProcedure
  .input(
    z.object({
      taskId: z.string().uuid(),
    })
  )
  .query(async ({ ctx, input }) => {
    const firebaseUid = ctx.user?.uid;

    if (!firebaseUid) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'User ID not found in context',
      });
    }

    // PHASE N2.1: Read-only query for task state (minimal metadata)
    // No side effects, no location data before EN_ROUTE

    // Step 0: Get database user_id from Firebase UID (read-only lookup)
    const userResult = await db.query<{ id: string }>(
      `
      SELECT id
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

    const userId = userResult.rows[0].id; // Database UUID

    // Step 1: Get task state (minimal query - no location, no full payload)
    const taskResult = await db.query<TaskStateRow>(
      `
      SELECT 
        id,
        status,
        accepted_at,
        en_route_at,
        working_at,
        completed_at
      FROM tasks
      WHERE id = $1
        AND (assigned_hustler_id = $2 OR client_id = $2)
      LIMIT 1
      `,
      [input.taskId, userId]
    );

    if (taskResult.rows.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Task not found or access denied',
      });
    }

    const task = taskResult.rows[0];

    // Step 2: Return minimal state (no location, no full payload)
    // Location will be returned separately in N2.2 when EN_ROUTE
    return {
      taskId: task.id,
      status: task.status.toUpperCase() as 'ACCEPTED' | 'EN_ROUTE' | 'WORKING' | 'COMPLETED' | 'OPEN' | 'CANCELLED' | 'EXPIRED',
      acceptedAt: task.accepted_at || null,
      enRouteAt: task.en_route_at || null,
      workingAt: task.working_at || null,
      completedAt: task.completed_at || null,
    };
  });
