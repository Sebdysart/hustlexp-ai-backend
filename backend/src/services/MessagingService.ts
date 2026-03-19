/**
 * MessagingService v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §10, MESSAGING_SPEC.md
 * 
 * Implements task-scoped messaging between poster and worker.
 * Core Principle: Messaging exists to coordinate task completion, not to socialize.
 * 
 * @see schema.sql §11.3 (task_messages table)
 * @see PRODUCT_SPEC.md §10
 * @see staging/MESSAGING_SPEC.md
 */

import { db, isInvariantViolation, getErrorMessage } from '../db.js';
import type { ServiceResult, TaskState } from '../types.js';
import { ErrorCodes } from '../types.js';
import { ContentModerationService } from './ContentModerationService.js';
import { NotificationService } from './NotificationService.js';
import { logger } from '../logger.js';
import { incr, expire } from '../cache/redis.js';

const log = logger.child({ service: 'MessagingService' });

// ============================================================================
// TYPES
// ============================================================================

export interface TaskMessage {
  id: string;
  task_id: string;
  sender_id: string;
  receiver_id: string; // Schema uses receiver_id (not recipient_id)
  message_type: 'TEXT' | 'AUTO' | 'PHOTO' | 'LOCATION'; // Schema uses uppercase
  content?: string; // Text content (max 500 chars)
  auto_message_template?: string; // Schema uses auto_message_template (not auto_message_type)
  photo_urls?: string[]; // Array of photo URLs (max 3)
  photo_count?: number; // Schema has photo_count
  location_latitude?: number; // For LOCATION type
  location_longitude?: number; // For LOCATION type
  location_expires_at?: Date; // For LOCATION type
  read_at?: Date | null; // Schema uses read_at (null = unread, not is_read boolean)
  moderation_status?: 'pending' | 'approved' | 'flagged' | 'quarantined';
  moderation_flags?: string[];
  created_at: Date;
  updated_at: Date;
}

export interface CreateMessageParams {
  taskId: string;
  senderId: string;
  messageType: 'TEXT' | 'AUTO'; // Schema uses uppercase
  content?: string;
  autoMessageTemplate?: string; // Schema uses auto_message_template (e.g., "on_my_way", "running_late")
}

export interface CreatePhotoMessageParams {
  taskId: string;
  senderId: string;
  photoUrls: string[]; // 1-3 photos
  caption?: string;
}

// Allowed task states for messaging (MESSAGING_SPEC.md §1.2)
const ALLOWED_MESSAGING_STATES: TaskState[] = ['ACCEPTED', 'PROOF_SUBMITTED', 'DISPUTED'];
const READ_ONLY_STATES: TaskState[] = ['COMPLETED', 'CANCELLED', 'EXPIRED'];

// Auto-message templates (MESSAGING_SPEC.md §2.2)
// Auto-message templates (MESSAGING_SPEC.md §2.2)
// Keys must match auto_message_template values in schema
const AUTO_MESSAGE_TEMPLATES: Record<string, string> = {
  on_my_way: "I'm on my way to the task location. ETA: ~X minutes.",
  running_late: "I'm running about X minutes late. I'll arrive at [time].",
  completed: "I've completed the task. Submitting proof now.",
  need_clarification: "I need clarification on [specific aspect].",
  photo_request: "Could you take a photo of [specific thing]?",
};

// ============================================================================
// SERVICE
// ============================================================================

export const MessagingService = {
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get messages for a task with pagination (max 100 per page)
   *
   * Messages are visible to task participants (poster + worker) and admins (for disputes).
   *
   * @param taskId   - The task whose messages to fetch
   * @param userId   - Requesting user (must be poster or worker)
   * @param offset   - Zero-based offset for pagination (default 0)
   * @returns        - { messages, hasMore } — hasMore=true when there are additional pages
   */
  getMessagesForTask: async (
    taskId: string,
    userId: string,
    offset = 0
  ): Promise<ServiceResult<{ messages: TaskMessage[]; hasMore: boolean }>> => {
    const PAGE_SIZE = 100;

    try {
      // Verify user is a participant in the task
      const taskResult = await db.query<{
        poster_id: string;
        worker_id: string | null;
        state: TaskState;
      }>(
        'SELECT poster_id, worker_id, state FROM tasks WHERE id = $1',
        [taskId]
      );

      if (taskResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${taskId} not found`,
          },
        };
      }

      const task = taskResult.rows[0];

      // Verify user is poster or worker
      if (task.poster_id !== userId && task.worker_id !== userId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.FORBIDDEN,
            message: 'You do not have permission to view messages for this task',
          },
        };
      }

      // Get paginated messages (max PAGE_SIZE rows, ordered by created_at ascending)
      const messagesResult = await db.query<TaskMessage>(
        `SELECT
          id, task_id, sender_id, receiver_id, message_type, content,
          auto_message_template, photo_urls, photo_count,
          location_latitude, location_longitude, location_expires_at,
          read_at, moderation_status, moderation_flags, created_at, updated_at
        FROM task_messages
        WHERE task_id = $1
          AND (moderation_status IS NULL OR moderation_status != 'quarantined')
        ORDER BY created_at ASC
        LIMIT $2 OFFSET $3`,
        [taskId, PAGE_SIZE, offset]
      );

      return {
        success: true,
        data: {
          messages: messagesResult.rows,
          hasMore: messagesResult.rows.length === PAGE_SIZE,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Get unread message count for a user across all tasks
   */
  getUnreadCount: async (userId: string): Promise<ServiceResult<number>> => {
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM task_messages
         WHERE receiver_id = $1 AND read_at IS NULL
           AND (moderation_status IS NULL OR moderation_status NOT IN ('quarantined', 'flagged'))`,
        [userId]
      );
      
      return {
        success: true,
        data: parseInt(result.rows[0]?.count || '0', 10),
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // CREATE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Send a text message or auto-message
   * 
   * MESSAGING_SPEC.md §1.2: Messages only allowed in ACCEPTED, PROOF_SUBMITTED, DISPUTED states
   */
  sendMessage: async (
    params: CreateMessageParams
  ): Promise<ServiceResult<TaskMessage>> => {
    const { taskId, senderId, messageType, autoMessageTemplate } = params;
    let { content } = params;
    
    try {
      // Verify task exists and get participants
      const taskResult = await db.query<{
        id: string;
        poster_id: string;
        worker_id: string | null;
        state: TaskState;
      }>(
        'SELECT id, poster_id, worker_id, state FROM tasks WHERE id = $1',
        [taskId]
      );
      
      if (taskResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${taskId} not found`,
          },
        };
      }
      
      const task = taskResult.rows[0];
      
      // Verify task state allows messaging (MESSAGING_SPEC.md §1.2)
      if (READ_ONLY_STATES.includes(task.state)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot send messages: task is in ${task.state} state (read-only)`,
          },
        };
      }
      
      if (!ALLOWED_MESSAGING_STATES.includes(task.state)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot send messages: task is in ${task.state} state. Messages allowed in: ${ALLOWED_MESSAGING_STATES.join(', ')}`,
          },
        };
      }
      
      // Verify sender is a participant
      if (task.poster_id !== senderId && task.worker_id !== senderId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.FORBIDDEN,
            message: 'You are not a participant in this task',
          },
        };
      }
      
      // Per-sender-per-task rate limit: 30 messages per minute per conversation.
      // Uses Redis INCR + EXPIRE to maintain a sliding counter.
      // If Redis is unavailable the incr() helper returns 1, so the check is
      // always allowed — same fail-open behaviour as the rest of the cache layer.
      const MSG_RATE_LIMIT = 30;
      const MSG_RATE_WINDOW_SECONDS = 60;
      const rateLimitKey = `msg_rate:${senderId}:${taskId}`;
      const msgCount = await incr(rateLimitKey);
      if (msgCount === 1) {
        await expire(rateLimitKey, MSG_RATE_WINDOW_SECONDS);
      }
      if (msgCount > MSG_RATE_LIMIT) {
        return {
          success: false,
          error: {
            code: ErrorCodes.RATE_LIMIT_EXCEEDED,
            message: `Message rate limit exceeded. You can send at most ${MSG_RATE_LIMIT} messages per minute per conversation.`,
          },
        };
      }

      // Determine recipient
      const recipientId = task.poster_id === senderId ? task.worker_id : task.poster_id;
      
      if (!recipientId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Cannot send message: no recipient (worker not assigned)',
          },
        };
      }
      
      // Validate content based on message type
      if (messageType === 'TEXT') {
        if (!content || content.trim().length === 0) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_INPUT,
              message: 'Text message content is required',
            },
          };
        }
        
        // Maximum length: 500 characters (MESSAGING_SPEC.md §2.1)
        if (content.length > 500) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_INPUT,
              message: 'Message content exceeds maximum length of 500 characters',
            },
          };
        }
        
        // Content moderation: Check for links, phone numbers, email addresses (MESSAGING_SPEC.md §2.1)
        // Pattern detection and moderation are handled after message creation (non-blocking)
      } else if (messageType === 'AUTO') {
        if (!autoMessageTemplate || !AUTO_MESSAGE_TEMPLATES[autoMessageTemplate]) {
          return {
            success: false,
            error: {
              code: ErrorCodes.INVALID_INPUT,
              message: `Invalid auto-message template: ${autoMessageTemplate}. Allowed templates: ${Object.keys(AUTO_MESSAGE_TEMPLATES).join(', ')}`,
            },
          };
        }

        // SECURITY: AUTO message content must always come from server-side templates.
        // Discard any client-supplied content to prevent moderation bypass.
        content = AUTO_MESSAGE_TEMPLATES[autoMessageTemplate];
      }
      
      // Create message (moderation_status defaults to 'pending' in schema)
      const messageResult = await db.query<TaskMessage>(
        `INSERT INTO task_messages (
          task_id, sender_id, receiver_id, message_type, content, auto_message_template, read_at, moderation_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, NULL, 'pending')
        RETURNING 
          id, task_id, sender_id, receiver_id, message_type, content,
          auto_message_template, photo_urls, photo_count,
          location_latitude, location_longitude, location_expires_at,
          read_at, moderation_status, moderation_flags, created_at, updated_at`,
        [taskId, senderId, recipientId, messageType, content || null, autoMessageTemplate || null]
      );
      
      const message = messageResult.rows[0];

      // Publish to Redis pub/sub for realtime delivery
      try {
        const { Redis } = await import('@upstash/redis');
        const { config } = await import('../config');
        if (config.redis.restUrl && config.redis.restToken) {
          const redis = new Redis({ url: config.redis.restUrl, token: config.redis.restToken });
          await redis.publish(`realtime:user:${recipientId}`, JSON.stringify({
            event: 'message.new',
            data: { messageId: message.id, taskId, senderId, content: message.content, createdAt: message.created_at },
          }));
        }
      } catch (pubError) {
        log.warn({ err: pubError instanceof Error ? pubError.message : String(pubError) }, 'Failed to publish message to realtime');
      }

      // Content moderation (MESSAGING_SPEC.md §2.1)
      // - Basic pattern detection (links, phone, email) → flag immediately
      // - Full AI moderation will happen asynchronously via ContentModerationService
      if (content && content.trim()) {
        const detectedPatterns = detectForbiddenPatterns(content);
        
        if (detectedPatterns.length > 0) {
          // Flag message for moderation based on detected patterns
          await ContentModerationService.moderateContent({
            contentType: 'message',
            contentId: message.id,
            userId: senderId,
            contentText: content,
            flaggedBy: 'ai', // Automated detection (pattern-based)
            aiConfidence: detectedPatterns.includes('phone') || detectedPatterns.includes('email') ? 0.8 : 0.6,
            aiRecommendation: detectedPatterns.includes('phone') || detectedPatterns.includes('email') ? 'flag' : 'approve',
          });
          
          // Update message moderation status to 'flagged'
          // moderation_flags is TEXT[] in schema, cast array properly
          await db.query(
            `UPDATE task_messages 
             SET moderation_status = 'flagged', moderation_flags = $1::TEXT[]
             WHERE id = $2`,
            [detectedPatterns, message.id]
          );
          
          // Update message object for response
          message.moderation_status = 'flagged';
          message.moderation_flags = detectedPatterns;
        } else {
          // Run full AI moderation (asynchronous, won't block message creation)
          // For now, mark as 'pending' (moderation will happen in background)
          ContentModerationService.moderateContent({
            contentType: 'message',
            contentId: message.id,
            userId: senderId,
            contentText: content,
            flaggedBy: 'ai',
            // No AI confidence/recommendation yet - will be determined by AI service
          }).catch(error => {
            // Log error but don't fail message creation
            log.error({ err: error instanceof Error ? error.message : String(error), messageId: message.id }, 'Content moderation error (non-blocking)');
          });
        }
      }
      
      // Send notification to recipient
      await NotificationService.createNotification({
        userId: recipientId,
        category: 'message_received',
        title: 'New Message',
        body: messageType === 'TEXT' && content 
          ? (content.length > 50 ? content.substring(0, 50) + '...' : content)
          : 'You received a new message',
        deepLink: `app://task/${taskId}/messages`,
        taskId,
        metadata: { messageId: message.id, messageType, senderId },
        channels: ['in_app', 'push'],
        priority: 'MEDIUM',
      }).catch(error => {
        // Log error but don't fail message creation
        log.error({ err: error instanceof Error ? error.message : String(error), recipientId, taskId }, 'Failed to send message notification');
      });
      
      return {
        success: true,
        data: message,
      };
    } catch (error) {
      if (isInvariantViolation(error)) {
        return {
          success: false,
          error: {
            code: error.code || 'INVARIANT_VIOLATION',
            message: getErrorMessage(error.code || ''),
          },
        };
      }
      
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Send a photo message
   * 
   * MESSAGING_SPEC.md §2.3: Maximum 3 photos per message, 5MB per photo
   */
  sendPhotoMessage: async (
    params: CreatePhotoMessageParams
  ): Promise<ServiceResult<TaskMessage>> => {
    const { taskId, senderId, photoUrls, caption } = params;
    
    try {
      // Validate photos
      if (!photoUrls || photoUrls.length === 0 || photoUrls.length > 3) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_INPUT,
            message: 'Photo message must contain 1-3 photos',
          },
        };
      }
      
      // Verify task (same as sendMessage)
      const taskResult = await db.query<{
        id: string;
        poster_id: string;
        worker_id: string | null;
        state: TaskState;
      }>(
        'SELECT id, poster_id, worker_id, state FROM tasks WHERE id = $1',
        [taskId]
      );
      
      if (taskResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${taskId} not found`,
          },
        };
      }
      
      const task = taskResult.rows[0];
      
      // Verify state allows messaging
      if (READ_ONLY_STATES.includes(task.state)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot send messages: task is in ${task.state} state (read-only)`,
          },
        };
      }
      
      if (!ALLOWED_MESSAGING_STATES.includes(task.state)) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: `Cannot send messages: task is in ${task.state} state`,
          },
        };
      }
      
      // Verify sender
      if (task.poster_id !== senderId && task.worker_id !== senderId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.FORBIDDEN,
            message: 'You are not a participant in this task',
          },
        };
      }
      
      const recipientId = task.poster_id === senderId ? task.worker_id : task.poster_id;
      
      if (!recipientId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.INVALID_STATE,
            message: 'Cannot send message: no recipient',
          },
        };
      }
      
      // Photo size validation should happen at upload time (before URLs are generated)
      // MESSAGING_SPEC.md §2.3: Maximum 3 photos per message, 5MB per photo
      // Since this service receives photoUrls (already uploaded), validation must occur
      // in the upload handler (e.g., in the router or upload service)

      // Store photos in evidence table for audit/dispute trail (MESSAGING_SPEC.md §2.3)
      for (const photoUrl of photoUrls) {
        // Extract storage key from URL (R2 URL format: https://.../{bucket}/{key})
        const storageKey = (() => {
          try {
            return new URL(photoUrl).pathname.slice(1); // removes leading '/'
          } catch {
            return photoUrl; // fallback for non-URL values
          }
        })();
        db.query(
          `INSERT INTO evidence (task_id, uploader_user_id, storage_key, content_type, access_scope)
           VALUES ($1, $2, $3, 'image', 'messaging')
           ON CONFLICT DO NOTHING`,
          [taskId, senderId, storageKey]
        ).catch(err => log.error({ err: err instanceof Error ? err.message : String(err), taskId, senderId }, 'Failed to store photo evidence (non-blocking)'));
      }
      
      // Create photo message (moderation_status defaults to 'pending' in schema)
      const messageResult = await db.query<TaskMessage>(
        `INSERT INTO task_messages (
          task_id, sender_id, receiver_id, message_type, content, photo_urls, photo_count, read_at, moderation_status
        )
        VALUES ($1, $2, $3, 'PHOTO', $4, $5::TEXT[], $6, NULL, 'pending')
        RETURNING 
          id, task_id, sender_id, receiver_id, message_type, content,
          auto_message_template, photo_urls, photo_count,
          location_latitude, location_longitude, location_expires_at,
          read_at, moderation_status, moderation_flags, created_at, updated_at`,
        [taskId, senderId, recipientId, caption || null, photoUrls, photoUrls.length]
      );
      
      const message = messageResult.rows[0];
      
      // Content moderation for photos (MESSAGING_SPEC.md §2.3)
      // Photo moderation will be handled asynchronously via ContentModerationService
      // For now, flag photos for moderation (AI will analyze image content)
      for (const photoUrl of photoUrls) {
        ContentModerationService.moderateContent({
          contentType: 'photo',
          contentId: message.id, // Use message ID as content ID
          userId: senderId,
          contentUrl: photoUrl,
          flaggedBy: 'ai',
          // AI will analyze photo content and determine confidence/recommendation
        }).catch(error => {
          // Log error but don't fail message creation
          log.error({ err: error instanceof Error ? error.message : String(error), messageId: message.id }, 'Photo moderation error (non-blocking)');
        });
      }
      
      // If caption provided, moderate it as text content
      if (caption) {
        const detectedPatterns = detectForbiddenPatterns(caption);
        if (detectedPatterns.length > 0) {
          await ContentModerationService.moderateContent({
            contentType: 'message',
            contentId: message.id,
            userId: senderId,
            contentText: caption,
            flaggedBy: 'ai',
            aiConfidence: detectedPatterns.includes('phone') || detectedPatterns.includes('email') ? 0.8 : 0.6,
            aiRecommendation: detectedPatterns.includes('phone') || detectedPatterns.includes('email') ? 'flag' : 'approve',
          });
          
          // moderation_flags is TEXT[] in schema, cast array properly
          await db.query(
            `UPDATE task_messages 
             SET moderation_status = 'flagged', moderation_flags = $1::TEXT[]
             WHERE id = $2`,
            [detectedPatterns, message.id]
          );
          
          message.moderation_status = 'flagged';
          message.moderation_flags = detectedPatterns;
        }
      }
      
      return {
        success: true,
        data: message,
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  // --------------------------------------------------------------------------
  // UPDATE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Mark message as read
   */
  markAsRead: async (
    messageId: string,
    userId: string
  ): Promise<ServiceResult<TaskMessage>> => {
    try {
      // Verify user is the receiver
      const verifyResult = await db.query<{ receiver_id: string }>(
        'SELECT receiver_id FROM task_messages WHERE id = $1',
        [messageId]
      );
      
      if (verifyResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Message ${messageId} not found`,
          },
        };
      }
      
      if (verifyResult.rows[0].receiver_id !== userId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.FORBIDDEN,
            message: 'You are not the receiver of this message',
          },
        };
      }
      
      // Mark as read
      const result = await db.query<TaskMessage>(
        `UPDATE task_messages
         SET read_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND receiver_id = $2 AND read_at IS NULL
         RETURNING 
           id, task_id, sender_id, receiver_id, message_type, content,
           auto_message_template, photo_urls, photo_count,
           location_latitude, location_longitude, location_expires_at,
           read_at, moderation_status, moderation_flags, created_at, updated_at`,
        [messageId, userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Message ${messageId} not found or already read`,
          },
        };
      }
      
      return {
        success: true,
        data: result.rows[0],
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  
  /**
   * Mark all messages for a task as read
   */
  markAllAsRead: async (
    taskId: string,
    userId: string
  ): Promise<ServiceResult<{ marked: number }>> => {
    try {
      // Verify user is a participant
      const taskResult = await db.query<{
        poster_id: string;
        worker_id: string | null;
      }>(
        'SELECT poster_id, worker_id FROM tasks WHERE id = $1',
        [taskId]
      );
      
      if (taskResult.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Task ${taskId} not found`,
          },
        };
      }
      
      const task = taskResult.rows[0];
      
      if (task.poster_id !== userId && task.worker_id !== userId) {
        return {
          success: false,
          error: {
            code: ErrorCodes.FORBIDDEN,
            message: 'You are not a participant in this task',
          },
        };
      }
      
      // Mark all unread messages as read.
      // NOTE: RETURNING COUNT(*) is invalid in PostgreSQL DML — it returns no rows.
      // Use rowCount from the query result instead, which is the actual affected count.
      const result = await db.query(
        `UPDATE task_messages
         SET read_at = NOW(), updated_at = NOW()
         WHERE task_id = $1 AND receiver_id = $2 AND read_at IS NULL`,
        [taskId, userId]
      );

      return {
        success: true,
        data: {
          marked: result.rowCount ?? 0,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'DB_ERROR',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Detect forbidden patterns in message content (links, phone numbers, email addresses)
 * MESSAGING_SPEC.md §2.1: Messages should not contain external links, phone numbers, or email addresses
 * 
 * Returns array of detected pattern types: ['link', 'phone', 'email']
 */
function detectForbiddenPatterns(content: string): string[] {
  const patterns: string[] = [];
  
  // Detect URLs/links (http://, https://, www., etc.)
  const urlPattern = /(https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.[a-zA-Z]{2,}[^\s]*)/gi;
  if (urlPattern.test(content)) {
    patterns.push('link');
  }
  
  // Detect phone numbers (US format: (123) 456-7890, 123-456-7890, 123.456.7890, 1234567890, etc.)
  const phonePattern = /(\+?1[-.\s]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g;
  if (phonePattern.test(content)) {
    patterns.push('phone');
  }
  
  // Detect email addresses
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  if (emailPattern.test(content)) {
    patterns.push('email');
  }
  
  return patterns;
}
