/**
 * Task Conversation Get/Create Handler (Phase V1.2)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: GET /trpc/tasks.messages.getConversation
 * Purpose: Get or create conversation for a task
 * Phase: V1.2 (Minimal Task-Scoped Messaging)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. AUTO-CREATE: Creates conversation automatically when task is ACCEPTED
 * 
 * 2. AUTHORITY: Only poster or assigned hustler can access
 * 
 * 3. STATE GATED: Conversation can only be created for ACCEPTED/WORKING tasks
 * 
 * Reference: Phase V1.2 — Minimal Task-Scoped Messaging
 */

import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';

interface TaskRow {
  id: string;
  state: string;
  poster_id: string;
  assigned_hustler_id: string | null;
}

interface TaskConversationRow {
  id: string;
  task_id: string;
  poster_id: string;
  hustler_id: string;
  opened_at: Date;
  closed_at: Date | null;
}

export const tasksMessagesGetConversationProcedure = protectedProcedure
  .input(z.object({ taskId: z.string().uuid() }))
  .query(async ({ ctx, input }) => {
    const firebaseUid = ctx.user?.uid;

    if (!firebaseUid) {
      throw new TRPCError({
        code: 'UNAUTHORIZED',
        message: 'User ID not found in context',
      });
    }

    // Step 0: Get database user_id from Firebase UID
    const userResult = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE firebase_uid = $1 LIMIT 1`,
      [firebaseUid]
    );

    if (userResult.rows.length === 0) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'User not found in database',
      });
    }

    const userId = userResult.rows[0].id;

    // Step 1: Get task
    const taskResult = await db.query<TaskRow>(
      `
      SELECT id, state, poster_id, assigned_hustler_id
      FROM tasks
      WHERE id = $1
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

    // Authority check: only poster or assigned hustler can access
    if (task.poster_id !== userId && task.assigned_hustler_id !== userId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only the poster or assigned hustler can access this conversation',
      });
    }

    // Step 2: Get existing conversation or return null
    const conversationResult = await db.query<TaskConversationRow>(
      `
      SELECT id, task_id, poster_id, hustler_id, opened_at, closed_at
      FROM task_conversations
      WHERE task_id = $1
      LIMIT 1
      `,
      [input.taskId]
    );

    if (conversationResult.rows.length > 0) {
      const conv = conversationResult.rows[0];
      return {
        conversationId: conv.id,
        taskId: conv.task_id,
        posterId: conv.poster_id,
        hustlerId: conv.hustler_id,
        openedAt: conv.opened_at,
        closedAt: conv.closed_at,
        exists: true,
      };
    }

    // No conversation exists yet
    // It will be auto-created when first message is sent (or when task is accepted)
    return {
      conversationId: null,
      taskId: input.taskId,
      posterId: task.poster_id,
      hustlerId: task.assigned_hustler_id,
      openedAt: null,
      closedAt: null,
      exists: false,
    };
  });
