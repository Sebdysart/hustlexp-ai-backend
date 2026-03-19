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
import { router, protectedProcedure, Schemas } from '../trpc.js';
import { MessagingService } from '../services/MessagingService.js';
import { db } from '../db.js';

// ============================================================================
// SECURITY: Photo URL allowlist (SSRF / tracking-pixel prevention)
// ============================================================================
// Only R2 public URLs are accepted. Cloudflare R2 public bucket hostnames match
// either the custom public domain (R2_PUBLIC_URL env var) or the default
// Cloudflare pattern: <hash>.r2.dev  (pub-*.r2.dev)
// Any URL from a non-approved host is rejected at the Zod layer before the
// service or DB is ever reached.

const R2_PUBLIC_HOSTNAME = (() => {
  const raw = process.env.R2_PUBLIC_URL || '';
  try {
    return raw ? new URL(raw).hostname : null;
  } catch {
    return null;
  }
})();

function isApprovedPhotoHost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    // Custom R2 public domain (configured via R2_PUBLIC_URL env var)
    if (R2_PUBLIC_HOSTNAME && hostname === R2_PUBLIC_HOSTNAME) return true;
    // Default Cloudflare R2 public URL pattern: pub-<hash>.r2.dev
    if (/^pub-[a-f0-9]+\.r2\.dev$/.test(hostname)) return true;
    return false;
  } catch {
    return false;
  }
}

const approvedPhotoUrl = z
  .string()
  .url()
  .refine(isApprovedPhotoHost, {
    message: 'Photo URL must be from an approved storage domain (R2 only)',
  });

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
      content: z.string().trim().min(1).max(500).optional(), // Required for TEXT
      autoMessageTemplate: z.enum(['on_my_way', 'running_late', 'completed', 'need_clarification']).optional(), // Required for AUTO
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
      photoUrls: z.array(approvedPhotoUrl).min(1).max(3), // 1-3 photos — approved storage domain only
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
   * Get messages for a task (paginated, max 100 per page)
   *
   * Returns { messages, hasMore } — clients should request the next page
   * with offset += 100 while hasMore === true.
   */
  getTaskMessages: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      offset: z.number().int().nonnegative().default(0),
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
        ctx.user.id,
        input.offset
      );

      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'NOT_FOUND' || result.error.code === 'FORBIDDEN'
            ? result.error.code
            : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }

      return result.data; // { messages: TaskMessage[], hasMore: boolean }
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
    .input(z.void())
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
    .input(z.void())
    .query(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
      }

      const result = await db.query(
        `SELECT * FROM (
          SELECT DISTINCT ON (t.id)
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
            WHERE task_id = t.id
              AND (moderation_status IS NULL OR moderation_status NOT IN ('quarantined'))
            ORDER BY created_at DESC LIMIT 1
          ) m ON true
          LEFT JOIN LATERAL (
            SELECT COUNT(*)::int as cnt FROM task_messages
            WHERE task_id = t.id
              AND sender_id != $1
              AND read_at IS NULL
              AND (moderation_status IS NULL OR moderation_status != 'quarantined')
          ) unread ON true
          WHERE (t.poster_id = $1 OR t.worker_id = $1)
            AND t.state IN ('ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED', 'COMPLETED', 'CANCELLED')
            AND (t.state NOT IN ('COMPLETED', 'CANCELLED') OR t.updated_at >= NOW() - INTERVAL '7 days')
          ORDER BY t.id, m.created_at DESC NULLS LAST
        ) conversations
        ORDER BY "lastMessageAt" DESC NULLS LAST, "taskId"`,
        [ctx.user.id]
      );

      return result.rows;
    }),
});
