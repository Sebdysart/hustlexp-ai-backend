/**
 * Task History Handler (Phase N2.1 - Read-Only)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: GET /trpc/tasks.listHistory
 * Purpose: Past tasks only (COMPLETED, CANCELLED, EXPIRED)
 * Phase: N2.1 (Read-Only Backend Handlers)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS (NON-NEGOTIABLE)
 * ============================================================================
 * 
 * 1. HARD FILTER (NO EXCEPTIONS):
 *    ✅ ONLY: COMPLETED, CANCELLED, EXPIRED
 *    ❌ NEVER: OPEN, ACCEPTED, IN_PROGRESS, or any available tasks
 * 
 * 2. ZERO OVERLAP WITH FEED LOGIC:
 *    ❌ NEVER share query logic with tasks.list (feed)
 *    ❌ NEVER reuse feed query functions
 *    ❌ NEVER allow parameter to "include available" tasks
 * 
 * 3. PURPOSE:
 *    - Prevents TasksScreen regression
 *    - Ensures TaskHistoryScreen shows ONLY past tasks
 *    - TaskFeedScreen is the canonical feed (authority)
 * 
 * 4. READ-ONLY (NO SIDE EFFECTS):
 *    ✅ Query past tasks only
 *    ❌ NO writes, NO state changes
 * 
 * Reference: Canonical screen taxonomy (feed authority enforcement)
 * Reference: PRODUCT_SPEC §17, ARCHITECTURE §13
 */

import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';

interface TaskHistoryRow {
  id: string;
  title: string;
  price: number; // in cents
  location_text: string | null;
  status: string;
  completed_at: string | null;
  cancelled_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export const tasksListHistoryProcedure = protectedProcedure
  .input(
    z.object({
      limit: z.number().default(20),
      offset: z.number().default(0),
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

    // PHASE N2.1: Read-only query for past tasks ONLY
    // Hard filter: COMPLETED, CANCELLED, EXPIRED (no exceptions)

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

    // Step 1: Query past tasks ONLY (hard filter - no overlap with feed logic)
    // IMPORTANT: This query is separate from tasks.list (feed) and never shares logic
    const tasksResult = await db.query<TaskHistoryRow>(
      `
      SELECT 
        id,
        title,
        recommended_price as price,
        location_text,
        status,
        completed_at,
        cancelled_at,
        expires_at,
        created_at
      FROM tasks
      WHERE assigned_hustler_id = $1
        AND status IN ('completed', 'cancelled', 'expired')
      ORDER BY created_at DESC
      LIMIT $2
      OFFSET $3
      `,
      [userId, input.limit, input.offset]
    );

    const tasks = tasksResult.rows.map(row => ({
      id: row.id,
      title: row.title,
      price: Math.round(Number(row.price) * 100), // Convert to cents
      location: row.location_text || '',
      status: row.status.toUpperCase() as 'COMPLETED' | 'CANCELLED' | 'EXPIRED',
      resolvedAt: row.completed_at || row.cancelled_at || row.expires_at || row.created_at,
    }));

    return {
      tasks,
      total: tasks.length,
      hasMore: tasks.length === input.limit,
    };
  });
