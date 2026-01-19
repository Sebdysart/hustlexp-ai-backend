/**
 * Task Messages Send Handler (Phase V1.2)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: POST /trpc/tasks.messages.send
 * Purpose: Send a message in a task conversation
 * Phase: V1.2 (Minimal Task-Scoped Messaging)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. AUTHORITY: Only poster or assigned hustler can send messages
 * 
 * 2. TASK STATE: Task must be in ACCEPTED or WORKING state (not closed)
 * 
 * 3. AUTO-CREATE: Conversation is created automatically if it doesn't exist
 * 
 * 4. PLAIN TEXT: Only plain text body (no attachments, reactions, read receipts)
 * 
 * Reference: Phase V1.2 — Minimal Task-Scoped Messaging
 */

import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';

interface TaskRow {
  id: string;
  state: string; // OPEN, ACCEPTED, WORKING, etc.
  poster_id: string;
  assigned_hustler_id: string | null;
}

interface TaskConversationRow {
  id: string;
  task_id: string;
  poster_id: string;
  hustler_id: string;
}

export const tasksMessagesSendProcedure = protectedProcedure
  .input(
    z.object({
      taskId: z.string().uuid(),
      body: z.string().min(1).max(5000), // Plain text, reasonable length limit
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

    // Step 1: Get task and verify state (must be ACCEPTED or WORKING)
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

    // Authority check: only poster or assigned hustler can send
    if (task.poster_id !== userId && task.assigned_hustler_id !== userId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only the poster or assigned hustler can send messages for this task',
      });
    }

    // Task state check: must be ACCEPTED or WORKING (conversation is open)
    if (task.state !== 'ACCEPTED' && task.state !== 'WORKING') {
      throw new TRPCError({
        code: 'CONFLICT',
        message: `Cannot send messages for task in state: ${task.state}. Conversation is closed.`,
      });
    }

    // Step 2: Get or create conversation
    let conversationResult = await db.query<TaskConversationRow>(
      `
      SELECT id, task_id, poster_id, hustler_id
      FROM task_conversations
      WHERE task_id = $1
      LIMIT 1
      `,
      [input.taskId]
    );

    let conversation: TaskConversationRow;

    if (conversationResult.rows.length === 0) {
      // Auto-create conversation if it doesn't exist
      if (!task.assigned_hustler_id) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Cannot create conversation: task has no assigned hustler',
        });
      }

      const createResult = await db.query<TaskConversationRow>(
        `
        INSERT INTO task_conversations (task_id, poster_id, hustler_id, opened_at)
        VALUES ($1, $2, $3, NOW())
        RETURNING id, task_id, poster_id, hustler_id
        `,
        [input.taskId, task.poster_id, task.assigned_hustler_id]
      );

      conversation = createResult.rows[0];
    } else {
      conversation = conversationResult.rows[0];
    }

    // Step 3: Determine sender role
    const senderRole: 'POSTER' | 'HUSTLER' = task.poster_id === userId ? 'POSTER' : 'HUSTLER';

    // Step 4: Insert message
    const messageResult = await db.query<{ id: string; created_at: Date }>(
      `
      INSERT INTO task_messages (conversation_id, sender_role, sender_id, body)
      VALUES ($1, $2, $3, $4)
      RETURNING id, created_at
      `,
      [conversation.id, senderRole, userId, input.body]
    );

    const message = messageResult.rows[0];

    return {
      messageId: message.id,
      conversationId: conversation.id,
      senderRole,
      body: input.body,
      createdAt: message.created_at,
    };
  });
