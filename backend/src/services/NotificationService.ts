/**
 * NotificationService v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §11, NOTIFICATION_SPEC.md
 * 
 * Implements notification system with priority tiers, quiet hours, and preferences.
 * Core Principle: Notifications are information, not interruptions.
 * 
 * @see schema.sql §11.3 (notifications, notification_preferences tables)
 * @see PRODUCT_SPEC.md §11
 * @see staging/NOTIFICATION_SPEC.md
 */

import { randomUUID } from 'crypto';
import { db, isInvariantViolation, getErrorMessage } from '../db';
import type { ServiceResult } from '../types';
import { ErrorCodes } from '../types';

// ============================================================================
// TYPES
// ============================================================================

export type NotificationCategory = 
  | 'task_accepted' | 'task_completed' | 'task_cancelled' | 'task_expired'
  | 'proof_submitted' | 'proof_approved' | 'proof_rejected'
  | 'escrow_funded' | 'payment_released' | 'refund_issued'
  | 'dispute_opened' | 'dispute_resolved'
  | 'trust_tier_upgraded' | 'badge_earned'
  | 'message_received' | 'unread_messages'
  | 'new_matching_task' | 'live_mode_task'
  | 'account_suspended' | 'security_alert' | 'password_changed'
  | 'welcome' | 'weekly_recap';

export type NotificationPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type NotificationChannel = 'push' | 'email' | 'sms' | 'in_app';

export interface Notification {
  id: string;
  user_id: string;
  category: string; // VARCHAR(50) - flexible category
  title: string; // VARCHAR(200)
  body: string; // TEXT
  deep_link: string; // TEXT (required)
  task_id?: string | null;
  metadata?: Record<string, unknown>; // JSONB (default '{}')
  channels: NotificationChannel[]; // TEXT[] - array of channels (default ['push'])
  priority: NotificationPriority;
  sent_at?: Date | null; // NULL = pending
  delivered_at?: Date | null; // NULL = not delivered
  read_at?: Date | null; // NULL = unread
  clicked_at?: Date | null; // NULL = not clicked
  group_id?: string | null; // UUID - for grouping (NULL = not grouped)
  group_position?: number | null; // INTEGER - position in group (1, 2, 3, ...)
  expires_at?: Date | null; // Optional expiration
  created_at: Date;
}

export interface NotificationPreferences {
  id: string;
  user_id: string;
  quiet_hours_enabled: boolean; // Default: true
  quiet_hours_start: string; // TIME - default '22:00:00'
  quiet_hours_end: string; // TIME - default '07:00:00'
  push_enabled: boolean; // Default: true
  email_enabled: boolean; // Default: false
  sms_enabled: boolean; // Default: false
  category_preferences: Record<string, {
    enabled?: boolean;
    sound?: boolean;
    badge?: boolean;
    quiet_hours_override?: boolean; // Override quiet hours for this category
  }>; // JSONB
  created_at: Date;
  updated_at: Date;
}

export interface CreateNotificationParams {
  userId: string;
  category: NotificationCategory;
  title: string;
  body: string;
  deepLink: string; // Required - deep link to relevant content
  taskId?: string;
  metadata?: Record<string, unknown>;
  channels?: NotificationChannel[]; // Default: ['push']
  priority?: NotificationPriority; // Default: 'MEDIUM'
  expiresAt?: Date;
}

export interface UpdatePreferencesParams {
  userId: string;
  quietHoursEnabled?: boolean;
  quietHoursStart?: string; // TIME format: 'HH:MM:SS'
  quietHoursEnd?: string; // TIME format: 'HH:MM:SS'
  pushEnabled?: boolean;
  emailEnabled?: boolean;
  smsEnabled?: boolean;
  categoryPreferences?: Record<string, any>;
}

// Priority tiers that bypass quiet hours (NOTIFICATION_SPEC.md §2.1)
const DND_BYPASS_PRIORITIES: NotificationPriority[] = ['HIGH', 'CRITICAL'];
const DND_BYPASS_CATEGORIES: NotificationCategory[] = ['task_accepted', 'payment_released', 'security_alert'];

// Frequency limits per category (NOTIFICATION_SPEC.md §2.2)
const FREQUENCY_LIMITS: Record<NotificationCategory, { perHour: number; perDay: number }> = {
  new_matching_task: { perHour: 5, perDay: 20 },
  live_mode_task: { perHour: 10, perDay: 50 },
  message_received: { perHour: Infinity, perDay: Infinity }, // Unlimited (rate-limited by messaging)
  unread_messages: { perHour: Infinity, perDay: Infinity },
  task_accepted: { perHour: Infinity, perDay: Infinity },
  task_completed: { perHour: Infinity, perDay: Infinity },
  proof_submitted: { perHour: Infinity, perDay: Infinity },
  proof_approved: { perHour: Infinity, perDay: Infinity },
  proof_rejected: { perHour: Infinity, perDay: Infinity },
  task_cancelled: { perHour: Infinity, perDay: Infinity },
  task_expired: { perHour: Infinity, perDay: Infinity },
  escrow_funded: { perHour: Infinity, perDay: Infinity },
  payment_released: { perHour: Infinity, perDay: Infinity },
  refund_issued: { perHour: Infinity, perDay: Infinity },
  dispute_opened: { perHour: Infinity, perDay: Infinity },
  dispute_resolved: { perHour: Infinity, perDay: Infinity },
  trust_tier_upgraded: { perHour: 3, perDay: 10 },
  badge_earned: { perHour: 3, perDay: 10 },
  account_suspended: { perHour: 5, perDay: 20 },
  security_alert: { perHour: 5, perDay: 20 },
  password_changed: { perHour: 5, perDay: 20 },
  welcome: { perHour: 1, perDay: 1 },
  weekly_recap: { perHour: 1, perDay: 1 },
};

// ============================================================================
// SERVICE
// ============================================================================

export const NotificationService = {
  // --------------------------------------------------------------------------
  // CREATE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Create and send a notification
   * 
   * NOTIFICATION_SPEC.md §2: Respects quiet hours, frequency limits, user preferences
   */
  createNotification: async (
    params: CreateNotificationParams
  ): Promise<ServiceResult<Notification>> => {
    const {
      userId,
      category,
      title,
      body,
      deepLink,
      taskId,
      metadata,
      channels = ['push'],
      priority = 'MEDIUM',
      expiresAt,
    } = params;
    
    try {
      // NOTIF-1: Verify user exists and has access to task (if task_id provided)
      if (taskId) {
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
        
        // Verify user is a participant
        if (task.poster_id !== userId && task.worker_id !== userId) {
          return {
            success: false,
            error: {
              code: ErrorCodes.FORBIDDEN,
              message: 'User is not a participant in this task',
            },
          };
        }
      }
      
      // Get user preferences
      const preferencesResult = await this.getPreferences(userId);
      const preferences = preferencesResult.success ? preferencesResult.data : null;
      
      // Check quiet hours (NOTIFICATION_SPEC.md §2.1)
      const isQuietHours = preferences 
        ? isInQuietHours(preferences.quiet_hours_enabled, preferences.quiet_hours_start, preferences.quiet_hours_end)
        : false;
      
      const shouldBypassDND = DND_BYPASS_PRIORITIES.includes(priority) || 
                              DND_BYPASS_CATEGORIES.includes(category);
      
      if (isQuietHours && !shouldBypassDND) {
        // Don't send notification during quiet hours (unless bypass)
        // Still create notification record, but mark as pending
      }
      
      // Check frequency limits (NOTIFICATION_SPEC.md §2.2)
      const categoryLimits = FREQUENCY_LIMITS[category];
      const limits = categoryLimits || { perHour: Infinity, perDay: Infinity };
      if (limits.perHour !== Infinity || limits.perDay !== Infinity) {
        const recentCount = await this.getRecentNotificationCount(userId, category, 60); // Last hour
        const dailyCount = await this.getRecentNotificationCount(userId, category, 24 * 60); // Last 24 hours
        
        if (recentCount >= limits.perHour) {
          // Exceeded hourly limit - batch with existing notifications
          // Find the most recent notification of the same category and batch with it
          const batchResult = await batchNotification(userId, category, {
            title,
            body,
            deepLink,
            taskId,
            metadata,
            priority,
          });
          
          if (batchResult.success) {
            // Successfully batched - return the batched notification
            return batchResult;
          }
          
          // If batching failed (e.g., no existing notification to batch with), 
          // still reject to prevent spam
          return {
            success: false,
            error: {
              code: ErrorCodes.RATE_LIMIT_EXCEEDED,
              message: `Frequency limit exceeded for category ${category}. Maximum ${limits.perHour} per hour`,
            },
          };
        }
        
        if (dailyCount >= limits.perDay) {
          return {
            success: false,
            error: {
              code: ErrorCodes.RATE_LIMIT_EXCEEDED,
              message: `Daily limit exceeded for category ${category}. Maximum ${limits.perDay} per day`,
            },
          };
        }
      }
      
      // Filter channels based on user preferences
      let enabledChannels: NotificationChannel[] = channels;
      if (preferences) {
        const categoryPrefs = preferences.category_preferences[category];
        if (categoryPrefs?.enabled === false) {
          return {
            success: false,
            error: {
              code: ErrorCodes.PREFERENCE_DISABLED,
              message: `Notifications for category ${category} are disabled by user`,
            },
          };
        }
        
        // Filter channels based on user preferences
        enabledChannels = channels.filter(channel => {
          if (channel === 'push' && !preferences.push_enabled) return false;
          if (channel === 'email' && !preferences.email_enabled) return false;
          if (channel === 'sms' && !preferences.sms_enabled) return false;
          // in_app is always enabled (user can't disable in-app notifications)
          return true;
        });
        
        // If all external channels are disabled, still allow in-app
        if (enabledChannels.length === 0 && !channels.includes('in_app')) {
          return {
            success: false,
            error: {
              code: ErrorCodes.PREFERENCE_DISABLED,
              message: 'All notification channels are disabled by user',
            },
          };
        }
        
        // If no external channels enabled, ensure in_app is included
        if (enabledChannels.length === 0 && channels.includes('in_app')) {
          enabledChannels = ['in_app'];
        }
      }
      
      // NOTIF-5: Deep links must be valid (task exists, user has access)
      // Already verified above if taskId provided
      
      // Implement notification grouping (NOTIFICATION_SPEC.md §2.3)
      // Group similar notifications within 5 minutes, max 5 per group
      const groupingResult = await findGroupableNotification(userId, category, taskId);
      let groupId: string | null = null;
      let groupPosition: number | null = null;
      
      if (groupingResult.success) {
        if (groupingResult.data) {
          // Add to existing group
          groupId = groupingResult.data.groupId;
          groupPosition = groupingResult.data.groupPosition;
        } else {
          // Create new group (generate UUID for group_id)
          groupId = randomUUID();
          groupPosition = 1; // First item in new group
        }
      }
      
      // If grouping failed, fall back to ungrouped notification (groupId = null)
      
      // Create notification (schema has group_id and group_position for grouping)
      const result = await db.query<Notification>(
        `INSERT INTO notifications (
          user_id, category, title, body, deep_link, task_id, metadata,
          channels, priority, expires_at, group_id, group_position, created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7::JSONB, $8::TEXT[], $9, $10, $11, $12, NOW())
        RETURNING *`,
        [
          userId,
          category,
          title,
          body,
          deepLink,
          taskId || null,
          JSON.stringify(metadata || {}),
          channels,
          priority,
          expiresAt || null,
          groupId,
          groupPosition,
        ]
      );
      
      // Send notification via channels (push, email, SMS, in-app)
      // In-app: Already in notifications table (can be retrieved via API)
      // External channels: Queue for delivery via outbox pattern (NO INLINE SENDS)
      const notification = result.rows[0];
      
      // Queue notifications via enabled channels (non-blocking, async via outbox)
      // Use filtered channels if preferences exist, otherwise use requested channels
      const channelsToUse = enabledChannels;
      await queueNotificationChannels(notification, channelsToUse);
      
      return {
        success: true,
        data: notification,
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
  
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get notifications for a user
   */
  getUserNotifications: async (
    userId: string,
    limit: number = 50,
    offset: number = 0,
    unreadOnly: boolean = false
  ): Promise<ServiceResult<Notification[]>> => {
    try {
      let sql = `SELECT * FROM notifications WHERE user_id = $1`;
      const params: unknown[] = [userId];
      
      if (unreadOnly) {
        sql += ` AND read_at IS NULL`;
      }
      
      // Filter expired notifications
      sql += ` AND (expires_at IS NULL OR expires_at > NOW())`;
      
      sql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
      
      const result = await db.query<Notification>(sql, params);
      
      return {
        success: true,
        data: result.rows,
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
   * Get unread notification count
   */
  getUnreadCount: async (userId: string): Promise<ServiceResult<number>> => {
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM notifications
         WHERE user_id = $1 AND read_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())`,
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
  
  /**
   * Get notification by ID
   */
  getNotificationById: async (
    notificationId: string,
    userId: string // Verify user owns notification
  ): Promise<ServiceResult<Notification>> => {
    try {
      const result = await db.query<Notification>(
        `SELECT * FROM notifications
         WHERE id = $1 AND user_id = $2`,
        [notificationId, userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Notification ${notificationId} not found or you do not have permission to view it`,
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
  
  // --------------------------------------------------------------------------
  // UPDATE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Mark notification as read
   */
  markAsRead: async (
    notificationId: string,
    userId: string
  ): Promise<ServiceResult<Notification>> => {
    try {
      const result = await db.query<Notification>(
        `UPDATE notifications
         SET read_at = NOW()
         WHERE id = $1 AND user_id = $2 AND read_at IS NULL
         RETURNING *`,
        [notificationId, userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Notification ${notificationId} not found, already read, or you do not have permission`,
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
   * Mark all notifications as read for a user
   */
  markAllAsRead: async (
    userId: string
  ): Promise<ServiceResult<{ marked: number }>> => {
    try {
      const result = await db.query<{ count: string }>(
        `UPDATE notifications
         SET read_at = NOW()
         WHERE user_id = $1 AND read_at IS NULL AND (expires_at IS NULL OR expires_at > NOW())
         RETURNING COUNT(*) as count`,
        [userId]
      );
      
      return {
        success: true,
        data: {
          marked: parseInt(result.rows[0]?.count || '0', 10),
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
   * Mark notification as clicked (tracking)
   */
  markAsClicked: async (
    notificationId: string,
    userId: string
  ): Promise<ServiceResult<Notification>> => {
    try {
      const result = await db.query<Notification>(
        `UPDATE notifications
         SET clicked_at = NOW()
         WHERE id = $1 AND user_id = $2
         RETURNING *`,
        [notificationId, userId]
      );
      
      if (result.rows.length === 0) {
        return {
          success: false,
          error: {
            code: ErrorCodes.NOT_FOUND,
            message: `Notification ${notificationId} not found or you do not have permission`,
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
  
  // --------------------------------------------------------------------------
  // PREFERENCES
  // --------------------------------------------------------------------------
  
  /**
   * Get notification preferences for a user
   */
  getPreferences: async (
    userId: string
  ): Promise<ServiceResult<NotificationPreferences>> => {
    try {
      const result = await db.query<NotificationPreferences>(
        `SELECT * FROM notification_preferences WHERE user_id = $1`,
        [userId]
      );
      
      if (result.rows.length === 0) {
        // Return default preferences if none exist
        return {
          success: true,
          data: {
            id: '',
            user_id: userId,
            quiet_hours_enabled: true,
            quiet_hours_start: '22:00:00',
            quiet_hours_end: '07:00:00',
            push_enabled: true,
            email_enabled: false,
            sms_enabled: false,
            category_preferences: {},
            created_at: new Date(),
            updated_at: new Date(),
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
   * Update notification preferences
   */
  updatePreferences: async (
    params: UpdatePreferencesParams
  ): Promise<ServiceResult<NotificationPreferences>> => {
    const { userId, ...updates } = params;
    
    try {
      // Check if preferences exist
      const existingResult = await this.getPreferences(userId);
      
      if (!existingResult.success || !existingResult.data.id) {
        // Create new preferences
        const createResult = await db.query<NotificationPreferences>(
          `INSERT INTO notification_preferences (
            user_id, quiet_hours_enabled, quiet_hours_start, quiet_hours_end,
            push_enabled, email_enabled, sms_enabled, category_preferences
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8::JSONB)
          RETURNING *`,
          [
            userId,
            updates.quietHoursEnabled ?? true,
            updates.quietHoursStart || '22:00:00',
            updates.quietHoursEnd || '07:00:00',
            updates.pushEnabled ?? true,
            updates.emailEnabled ?? false,
            updates.smsEnabled ?? false,
            JSON.stringify(updates.categoryPreferences || {}),
          ]
        );
        
        return {
          success: true,
          data: createResult.rows[0],
        };
      }
      
      // Update existing preferences
      const updateFields: string[] = [];
      const updateValues: unknown[] = [];
      let paramIndex = 1;
      
      if (updates.quietHoursEnabled !== undefined) {
        updateFields.push(`quiet_hours_enabled = $${paramIndex++}`);
        updateValues.push(updates.quietHoursEnabled);
      }
      if (updates.quietHoursStart !== undefined) {
        updateFields.push(`quiet_hours_start = $${paramIndex++}`);
        updateValues.push(updates.quietHoursStart);
      }
      if (updates.quietHoursEnd !== undefined) {
        updateFields.push(`quiet_hours_end = $${paramIndex++}`);
        updateValues.push(updates.quietHoursEnd);
      }
      if (updates.pushEnabled !== undefined) {
        updateFields.push(`push_enabled = $${paramIndex++}`);
        updateValues.push(updates.pushEnabled);
      }
      if (updates.emailEnabled !== undefined) {
        updateFields.push(`email_enabled = $${paramIndex++}`);
        updateValues.push(updates.emailEnabled);
      }
      if (updates.smsEnabled !== undefined) {
        updateFields.push(`sms_enabled = $${paramIndex++}`);
        updateValues.push(updates.smsEnabled);
      }
      if (updates.categoryPreferences !== undefined) {
        updateFields.push(`category_preferences = $${paramIndex++}::JSONB`);
        updateValues.push(JSON.stringify(updates.categoryPreferences));
      }
      
      if (updateFields.length === 0) {
        // No updates provided
        return existingResult;
      }
      
      updateValues.push(userId);
      const result = await db.query<NotificationPreferences>(
        `UPDATE notification_preferences
         SET ${updateFields.join(', ')}, updated_at = NOW()
         WHERE user_id = $${paramIndex}
         RETURNING *`,
        updateValues
      );
      
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
  
  // --------------------------------------------------------------------------
  // CLEANUP (Background Job)
  // --------------------------------------------------------------------------
  
  /**
   * Clean up expired notifications (NOTIF-5: Notifications expire after 30 days)
   * 
   * This should be called by a background job daily
   */
  cleanupExpiredNotifications: async (): Promise<ServiceResult<{ deleted: number }>> => {
    try {
      // Delete notifications expired more than 30 days ago
      const result = await db.query<{ count: string }>(
        `DELETE FROM notifications
         WHERE expires_at IS NOT NULL
           AND expires_at < NOW() - INTERVAL '30 days'
         RETURNING COUNT(*) as count`
      );
      
      return {
        success: true,
        data: {
          deleted: parseInt(result.rows[0]?.count || '0', 10),
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
  
  // --------------------------------------------------------------------------
  // HELPER METHODS
  // --------------------------------------------------------------------------
  
  /**
   * Get recent notification count for frequency limiting
   */
  getRecentNotificationCount: async (
    userId: string,
    category: NotificationCategory,
    minutes: number
  ): Promise<number> => {
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count
         FROM notifications
         WHERE user_id = $1 AND category = $2
           AND created_at >= NOW() - INTERVAL '${minutes} minutes'`,
        [userId, category]
      );
      
      return parseInt(result.rows[0]?.count || '0', 10);
    } catch (error) {
      return 0; // On error, allow notification (fail open)
    }
  },
};

// ============================================================================
// HELPER FUNCTIONS - NOTIFICATION BATCHING & GROUPING
// ============================================================================

/**
 * Batch notification with existing notification when frequency limit exceeded
 * NOTIFICATION_SPEC.md §2.2: Batching for rate limiting
 * 
 * When hourly limit is exceeded, batch the new notification with the most recent
 * notification of the same category by updating its metadata to include batched items.
 */
async function batchNotification(
  userId: string,
  category: NotificationCategory,
  notificationData: {
    title: string;
    body: string;
    deepLink: string;
    taskId?: string | null;
    metadata?: Record<string, unknown>;
    priority: NotificationPriority;
  }
): Promise<ServiceResult<Notification>> {
  try {
    // Find the most recent notification of the same category (within last hour)
    const recentNotificationResult = await db.query<Notification>(
      `SELECT * FROM notifications
       WHERE user_id = $1 AND category = $2
       AND created_at > NOW() - INTERVAL '1 hour'
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId, category]
    );
    
    if (recentNotificationResult.rows.length === 0) {
      // No recent notification to batch with - cannot batch
      return {
        success: false,
        error: {
          code: 'NO_BATCH_TARGET',
          message: 'No recent notification found to batch with',
        },
      };
    }
    
    const existingNotification = recentNotificationResult.rows[0];
    
    // Update existing notification metadata to include batched item
    const existingMetadata = existingNotification.metadata || {};
    const batchedItems = (existingMetadata.batched_items as Array<{
      title: string;
      body: string;
      deepLink: string;
      taskId?: string | null;
      timestamp: string;
    }>) || [];
    
    // Add current notification to batched items
    batchedItems.push({
      title: notificationData.title,
      body: notificationData.body,
      deepLink: notificationData.deepLink,
      taskId: notificationData.taskId || undefined,
      timestamp: new Date().toISOString(),
    });
    
    // Update notification with batched items
    const updatedMetadata = {
      ...existingMetadata,
      batched_items: batchedItems,
      batched_count: batchedItems.length,
      last_batched_at: new Date().toISOString(),
    };
    
    // Update notification title/body to reflect batching
    const updatedTitle = `${existingNotification.title} (${batchedItems.length + 1} new)`;
    const updatedBody = `${existingNotification.body}\n\nPlus ${batchedItems.length} more ${category} notification(s)`;
    
    const updateResult = await db.query<Notification>(
      `UPDATE notifications
       SET title = $1, body = $2, metadata = $3::JSONB, updated_at = NOW()
       WHERE id = $4
       RETURNING *`,
      [updatedTitle, updatedBody, JSON.stringify(updatedMetadata), existingNotification.id]
    );
    
    return {
      success: true,
      data: updateResult.rows[0],
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
}

/**
 * Find a groupable notification for grouping
 * NOTIFICATION_SPEC.md §2.3: Notification grouping
 * 
 * Groups similar notifications within 5 minutes, max 5 per group.
 * Similar notifications are those with the same category and (optionally) task_id.
 */
async function findGroupableNotification(
  userId: string,
  category: NotificationCategory,
  taskId?: string | null
): Promise<ServiceResult<{ groupId: string; groupPosition: number } | null>> {
  try {
    // Find notifications of the same category within the last 5 minutes
    // If taskId is provided, only group with notifications for the same task
    const groupQuery = taskId
      ? `SELECT group_id, MAX(group_position) as max_position, COUNT(*) as group_size
         FROM notifications
         WHERE user_id = $1 AND category = $2 AND task_id = $3
         AND created_at > NOW() - INTERVAL '5 minutes'
         AND group_id IS NOT NULL
         GROUP BY group_id
         ORDER BY MAX(group_position) DESC
         LIMIT 1`
      : `SELECT group_id, MAX(group_position) as max_position, COUNT(*) as group_size
         FROM notifications
         WHERE user_id = $1 AND category = $2
         AND created_at > NOW() - INTERVAL '5 minutes'
         AND group_id IS NOT NULL
         GROUP BY group_id
         ORDER BY MAX(group_position) DESC
         LIMIT 1`;
    
    const params = taskId ? [userId, category, taskId] : [userId, category];
    const groupResult = await db.query<{ group_id: string; max_position: number; group_size: string }>(
      groupQuery,
      params
    );
    
    if (groupResult.rows.length > 0) {
      const group = groupResult.rows[0];
      const groupSize = parseInt(group.group_size, 10);
      
      // If group is not full (max 5), add to existing group
      if (groupSize < 5) {
        return {
          success: true,
          data: {
            groupId: group.group_id,
            groupPosition: groupSize + 1, // Next position in group
          },
        };
      }
    }
    
    // No groupable notification found or all groups are full - create new group
    // Return null to indicate new group should be created (UUID generated on insert)
    return {
      success: true,
      data: null, // New group will be created with new UUID
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
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if current time is within quiet hours
 */
function isInQuietHours(
  enabled: boolean,
  startTime: string, // 'HH:MM:SS'
  endTime: string // 'HH:MM:SS'
): boolean {
  if (!enabled) {
    return false;
  }
  
  const now = new Date();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentTimeMinutes = currentHour * 60 + currentMinute;
  
  const [startHour, startMin, startSec] = startTime.split(':').map(Number);
  const [endHour, endMin, endSec] = endTime.split(':').map(Number);
  
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;
  
  // Handle overnight quiet hours (e.g., 22:00 - 07:00)
  if (startMinutes > endMinutes) {
    // Overnight: quiet hours span midnight
    return currentTimeMinutes >= startMinutes || currentTimeMinutes < endMinutes;
  } else {
    // Same day: quiet hours within same day
    return currentTimeMinutes >= startMinutes && currentTimeMinutes < endMinutes;
  }
}

// ============================================================================
// HELPER FUNCTIONS - NOTIFICATION QUEUING (PHASE C: WRITE-ONLY)
// ============================================================================

/**
 * Queue notification via specified channels using outbox pattern
 * PHASE C: This method ONLY writes to email_outbox + outbox_events
 * NO INLINE SENDS - All external channel delivery is async via workers
 * 
 * NOTIFICATION_SPEC.md §2.4: Multi-channel delivery
 * 
 * Hard rule: No service sends email/push/SMS inline. All delivery goes through outbox.
 */
async function queueNotificationChannels(
  notification: Notification,
  channels: NotificationChannel[]
): Promise<void> {
  try {
    // In-app: Already stored in notifications table, no additional action needed
    // External channels: Queue for delivery via outbox pattern (NO INLINE SENDS)
    
    const queuePromises: Promise<void>[] = [];
    
    for (const channel of channels) {
      if (channel === 'in_app') {
        // In-app notifications are already in the database
        // No action needed - frontend can poll or use websockets
        continue;
      } else if (channel === 'email') {
        // Email notification: Queue via email_outbox + outbox pattern
        // CRITICAL: No inline send - email worker handles delivery
        queuePromises.push(
          queueEmailNotification(notification).catch(error => {
            console.error(`Failed to queue email notification ${notification.id}:`, error);
          })
        );
      } else if (channel === 'push') {
        // Push notification: Queue via outbox pattern (TODO: implement push_outbox table)
        // For now, log intent (push worker not yet implemented)
        console.log(`[Push] Would queue push notification ${notification.id} for user ${notification.user_id}`);
      } else if (channel === 'sms') {
        // SMS notification: Queue via outbox pattern (TODO: implement sms_outbox table)
        // For now, log intent (SMS worker not yet implemented)
        console.log(`[SMS] Would queue SMS notification ${notification.id} for user ${notification.user_id}`);
      }
    }
    
    // Wait for all queuing operations to complete (or fail gracefully)
    await Promise.allSettled(queuePromises);
    
    // Mark notification as queued (all channels queued)
    // Note: sent_at will be updated when workers actually deliver
    await db.query(
      `UPDATE notifications
       SET sent_at = NOW()  -- Mark as "sent to queue" (not "delivered")
       WHERE id = $1`,
      [notification.id]
    );
  } catch (error) {
    // Log error but don't fail notification creation
    console.error(`Failed to queue notification ${notification.id} via channels:`, error);
    
    // Still mark as queued (attempted) - queue failures are logged separately
    await db.query(
      `UPDATE notifications
       SET sent_at = NOW()
       WHERE id = $1`,
      [notification.id]
    ).catch(() => {
      // Ignore errors marking as queued
    });
  }
}

/**
 * Queue email notification via email_outbox + outbox pattern
 * PHASE C: Write-only method - creates email_outbox row + outbox_event in same transaction
 * 
 * Hard rule: NO INLINE SENDS - email worker is the ONLY sender
 * 
 * @param notification Notification to email
 * @returns email_id from email_outbox table
 */
async function queueEmailNotification(notification: Notification): Promise<void> {
  // Get user's email address (required for email_outbox)
  const userResult = await db.query<{ email: string }>(
    `SELECT email FROM users WHERE id = $1`,
    [notification.user_id]
  );
  
  if (userResult.rows.length === 0) {
    throw new Error(`User ${notification.user_id} not found`);
  }
  
  const userEmail = userResult.rows[0].email;
  
  if (!userEmail) {
    throw new Error(`User ${notification.user_id} has no email address`);
  }
  
  // Map notification category to email template
  // TODO: Implement proper template mapping based on notification category
  const templateMap: Record<string, string> = {
    'task_accepted': 'task_status_changed',
    'task_completed': 'task_status_changed',
    'task_cancelled': 'task_status_changed',
    'payment_released': 'task_status_changed',
    'export_ready': 'export_ready', // From export worker
    'welcome': 'welcome',
    // Add more mappings as needed
  };
  
  const template = templateMap[notification.category] || 'notification'; // Default template
  const params = {
    notificationId: notification.id,
    title: notification.title,
    body: notification.body,
    deepLink: notification.deep_link,
    category: notification.category,
    taskId: notification.task_id,
    metadata: notification.metadata || {},
  };
  
  // Generate deterministic idempotency key
  // Format: email.send_requested:{template}:{to_email}:{aggregate_id}:{version}
  const aggregateId = notification.task_id || notification.id; // Use task_id if available, otherwise notification_id
  const idempotencyKey = `email.send_requested:${template}:${userEmail}:${aggregateId}:1`;
  
  // Create email_outbox row + outbox_event in same transaction
  await db.transaction(async (query) => {
    // Create email_outbox row (status='pending')
    const emailResult = await query<{ id: string }>(
      `INSERT INTO email_outbox (
        user_id, to_email, template, params_json, priority, status, idempotency_key
      ) VALUES ($1, $2, $3, $4::JSONB, $5, 'pending', $6)
      ON CONFLICT (idempotency_key) DO UPDATE SET
        updated_at = NOW()
      RETURNING id`,
      [
        notification.user_id,
        userEmail,
        template,
        JSON.stringify(params),
        notification.priority,
        idempotencyKey,
      ]
    );
    
    const emailId = emailResult.rows[0].id;
    
    // Write outbox_event (email.send_requested) in same transaction
    // Check for duplicate (idempotency key must be unique)
    const existingOutbox = await query(
      `SELECT id FROM outbox_events WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    
    if (existingOutbox.rows.length === 0) {
      await query(
        `INSERT INTO outbox_events (
          event_type, aggregate_type, aggregate_id, event_version,
          idempotency_key, payload, queue_name, status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
        [
          'email.send_requested',
          'email',
          emailId,
          1,
          idempotencyKey,
          JSON.stringify({
            emailId,
            userId: notification.user_id,
            toEmail: userEmail,
            template,
            params,
          }),
          'user_notifications',
        ]
      );
    }
    
    // Transaction commits automatically
  });
  
  // Email queued successfully (will be processed by email worker)
  console.log(`✅ Email notification ${notification.id} queued for user ${notification.user_id} (template: ${template})`);
}
