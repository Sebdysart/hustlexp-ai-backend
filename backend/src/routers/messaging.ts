/**
 * Messaging Router v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §10, MESSAGING_SPEC.md
 * 
 * Endpoints for task-scoped messaging (text, auto-messages, photos, location).
 * 
 * @see backend/src/services/MessagingService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, Schemas } from '../trpc';
import { MessagingService } from '../services/MessagingService';
import { db } from '../db';

export const messagingRouter = router({
  // --------------------------------------------------------------------------
  // SEND MESSAGES
  // --------------------------------------------------------------------------
  
  /**
   * Send a message in a task thread
   * 
   * PRODUCT_SPEC §10: Task-scoped messaging
   * MSG-1: Only allowed during ACCEPTED/PROOF_SUBMITTED/DISPUTED states
   * MSG-2: Sender must be task participant
   */
  sendMessage: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      messageType: z.enum(['TEXT', 'AUTO']),
      content: z.string().max(500).optional(), // Required for TEXT
      autoMessageTemplate: z.enum(['on_my_way', 'running_late', 'completed', 'question']).optional(), // Required for AUTO
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      // Validate input based on message type
      if (input.messageType === 'TEXT' && !input.content) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Content is required for TEXT messages',
        });
      }
      
      if (input.messageType === 'AUTO' && !input.autoMessageTemplate) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'autoMessageTemplate is required for AUTO messages',
        });
      }
      
      const result = await MessagingService.sendMessage({
        taskId: input.taskId,
        senderId: ctx.user.id,
        messageType: input.messageType,
        content: input.content,
        autoMessageTemplate: input.autoMessageTemplate,
      });
      
      if (!result.success) {
        // Map service errors to tRPC errors
        let code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'PRECONDITION_FAILED' = 'BAD_REQUEST';
        if (result.error.code === 'FORBIDDEN' || result.error.code === 'INVALID_STATE') {
          code = result.error.code === 'FORBIDDEN' ? 'FORBIDDEN' : 'PRECONDITION_FAILED';
        } else if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Send a photo message (separate endpoint for photos)
   */
  sendPhotoMessage: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      photoUrls: z.array(z.string().url()).min(1).max(3), // 1-3 photos required
      caption: z.string().max(200).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await MessagingService.sendPhotoMessage({
        taskId: input.taskId,
        senderId: ctx.user.id,
        photoUrls: input.photoUrls,
        caption: input.caption,
      });
      
      if (!result.success) {
        let code: 'BAD_REQUEST' | 'FORBIDDEN' | 'NOT_FOUND' | 'PRECONDITION_FAILED' = 'BAD_REQUEST';
        if (result.error.code === 'FORBIDDEN' || result.error.code === 'INVALID_STATE') {
          code = result.error.code === 'FORBIDDEN' ? 'FORBIDDEN' : 'PRECONDITION_FAILED';
        } else if (result.error.code === 'NOT_FOUND') {
          code = 'NOT_FOUND';
        }
        
        throw new TRPCError({
          code,
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get messages for a task
   */
  getTaskMessages: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await MessagingService.getMessagesForTask(
        input.taskId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' || result.error.code === 'FORBIDDEN'
            ? result.error.code
            : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Mark message as read
   */
  markAsRead: protectedProcedure
    .input(z.object({
      messageId: Schemas.uuid,
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await MessagingService.markAsRead(
        input.messageId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' || result.error.code === 'FORBIDDEN'
            ? result.error.code
            : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Mark all messages for a task as read
   */
  markAllAsRead: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await MessagingService.markAllAsRead(
        input.taskId,
        ctx.user.id
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' || result.error.code === 'FORBIDDEN'
            ? result.error.code
            : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get unread message count (global, not task-specific)
   */
  getUnreadCount: protectedProcedure
    .query(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await MessagingService.getUnreadCount(ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      // Return both field names for frontend compat
      return { unreadCount: result.data, count: result.data };
    }),

  /**
   * Get conversation summaries for current user
   * Returns one entry per task with latest message and unread count
   */
  getConversations: protectedProcedure
    .query(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }

      const result = await db.query(
        `SELECT DISTINCT ON (t.id)
          t.id as "taskId",
          t.id as id,
          t.title as "taskTitle",
          CASE WHEN t.poster_id = $1 THEN t.worker_id ELSE t.poster_id END as "otherUserId",
          CASE WHEN t.poster_id = $1 THEN wu.full_name ELSE pu.full_name END as "otherUserName",
          CASE WHEN t.poster_id = $1 THEN 'worker' ELSE 'poster' END as "otherUserRole",
          m.content as "lastMessage",
          m.created_at as "lastMessageAt",
          COALESCE(unread.cnt, 0)::int as "unreadCount"
        FROM tasks t
        LEFT JOIN users wu ON wu.id = t.worker_id
        LEFT JOIN users pu ON pu.id = t.poster_id
        LEFT JOIN LATERAL (
          SELECT content, created_at FROM task_messages
          WHERE task_id = t.id ORDER BY created_at DESC LIMIT 1
        ) m ON true
        LEFT JOIN LATERAL (
          SELECT COUNT(*)::int as cnt FROM task_messages
          WHERE task_id = t.id AND sender_id != $1 AND read_at IS NULL
        ) unread ON true
        WHERE (t.poster_id = $1 OR t.worker_id = $1)
          AND t.state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED')
        ORDER BY t.id, m.created_at DESC NULLS LAST`,
        [ctx.user.id]
      );

      return result.rows;
    }),
});
