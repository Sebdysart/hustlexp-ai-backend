/**
 * Task Messages List Handler (Phase V1.2)
 * 
 * ============================================================================
 * AUTHORITY & SPEC COMPLIANCE
 * ============================================================================
 * 
 * Route: GET /trpc/tasks.messages.list
 * Purpose: List all messages in a task conversation
 * Phase: V1.2 (Minimal Task-Scoped Messaging)
 * 
 * ============================================================================
 * CRITICAL CONSTRAINTS
 * ============================================================================
 * 
 * 1. AUTHORITY: Only poster or assigned hustler can read messages
 * 
 * 2. TASK SCOPED: Messages belong to task conversation
 * 
 * 3. READ ONLY: This endpoint does not modify state
 * 
 * Reference: Phase V1.2 — Minimal Task-Scoped Messaging
 */

import { protectedProcedure } from '../../../create-context';
import { z } from 'zod';
import { db } from '@/backend/database/client';
import { TRPCError } from '@trpc/server';

interface TaskConversationRow {
  id: string;
  task_id: string;
  poster_id: string;
  hustler_id: string;
}

interface TaskMessageRow {
  id: string;
  conversation_id: string;
  sender_role: 'POSTER' | 'HUSTLER' | 'SYSTEM';
  sender_id: string | null;
  body: string;
  created_at: Date;
}

export const tasksMessagesListProcedure = protectedProcedure
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

    // Step 1: Get conversation for this task
    const conversationResult = await db.query<TaskConversationRow>(
      `
      SELECT id, task_id, poster_id, hustler_id
      FROM task_conversations
      WHERE task_id = $1
      LIMIT 1
      `,
      [input.taskId]
    );

    if (conversationResult.rows.length === 0) {
      // No conversation exists yet - return empty messages
      // Conversation will be auto-created when first message is sent
      return { messages: [] };
    }

    const conversation = conversationResult.rows[0];

    // Step 2: Authority check - only poster or assigned hustler can read
    if (conversation.poster_id !== userId && conversation.hustler_id !== userId) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'Only the poster or assigned hustler can view messages for this task',
      });
    }

    // Step 3: Get all messages for this conversation
    const messagesResult = await db.query<TaskMessageRow>(
      `
      SELECT id, conversation_id, sender_role, sender_id, body, created_at
      FROM task_messages
      WHERE conversation_id = $1
      ORDER BY created_at ASC
      `,
      [conversation.id]
    );

    return {
      messages: messagesResult.rows.map(msg => ({
        id: msg.id,
        conversationId: msg.conversation_id,
        senderRole: msg.sender_role,
        senderId: msg.sender_id,
        body: msg.body,
        createdAt: msg.created_at,
      })),
    };
  });
