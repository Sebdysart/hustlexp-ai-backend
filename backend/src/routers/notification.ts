/**
 * Notification Router v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §11, NOTIFICATION_SPEC.md
 * 
 * Endpoints for notification system (priority tiers, quiet hours, preferences).
 * 
 * @see backend/src/services/NotificationService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, Schemas } from '../trpc';
import { NotificationService } from '../services/NotificationService';
import { db } from '../db';

export const notificationRouter = router({
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get notifications for user (with pagination)
   * 
   * PRODUCT_SPEC §11: Notification System
   */
  getList: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
      offset: z.number().int().min(0).default(0),
      unreadOnly: z.boolean().default(false),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await NotificationService.getUserNotifications(
        ctx.user.id,
        input.limit,
        input.offset,
        input.unreadOnly
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Get unread notification count
   */
  getUnreadCount: protectedProcedure
    .query(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await NotificationService.getUnreadCount(ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return { count: result.data };
    }),
  
  /**
   * Get notification by ID
   */
  getById: protectedProcedure
    .input(z.object({
      notificationId: Schemas.uuid,
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await NotificationService.getNotificationById(
        input.notificationId,
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
  
  // --------------------------------------------------------------------------
  // UPDATE OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Mark notification as read
   */
  markAsRead: protectedProcedure
    .input(z.object({
      notificationId: Schemas.uuid,
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await NotificationService.markAsRead(
        input.notificationId,
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
   * Mark all notifications as read for user
   */
  markAllAsRead: protectedProcedure
    .mutation(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await NotificationService.markAllAsRead(ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Mark notification as clicked (tracking)
   */
  markAsClicked: protectedProcedure
    .input(z.object({
      notificationId: Schemas.uuid,
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await NotificationService.markAsClicked(
        input.notificationId,
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
  
  // --------------------------------------------------------------------------
  // PREFERENCES
  // --------------------------------------------------------------------------
  
  /**
   * Get notification preferences for user
   */
  getPreferences: protectedProcedure
    .query(async ({ ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await NotificationService.getPreferences(ctx.user.id);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Update notification preferences
   */
  updatePreferences: protectedProcedure
    .input(z.object({
      quietHoursEnabled: z.boolean().optional(),
      quietHoursStart: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/).optional(), // TIME format: HH:MM:SS
      quietHoursEnd: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/).optional(), // TIME format: HH:MM:SS
      pushEnabled: z.boolean().optional(),
      emailEnabled: z.boolean().optional(),
      smsEnabled: z.boolean().optional(),
      categoryPreferences: z.record(z.any()).optional(), // JSONB - per-category preferences
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await NotificationService.updatePreferences({
        userId: ctx.user.id,
        ...input,
      });
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),

  // --------------------------------------------------------------------------
  // DEVICE TOKEN MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * Register a device token for push notifications (FCM)
   * Upserts: if the token already exists for this user, reactivates it
   */
  registerDeviceToken: protectedProcedure
    .input(z.object({
      fcmToken: z.string().min(1),
      deviceType: z.enum(['ios', 'android']).default('ios'),
      deviceName: z.string().optional(),
      appVersion: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      try {
        const result = await db.query<{
          id: string;
          user_id: string;
          fcm_token: string;
          device_type: string;
          device_name: string | null;
          app_version: string | null;
          is_active: boolean;
          created_at: Date;
          updated_at: Date;
        }>(
          `INSERT INTO device_tokens (user_id, fcm_token, device_type, device_name, app_version, is_active)
           VALUES ($1, $2, $3, $4, $5, true)
           ON CONFLICT (user_id, fcm_token) DO UPDATE SET
             updated_at = NOW(),
             is_active = true,
             device_type = EXCLUDED.device_type,
             device_name = EXCLUDED.device_name,
             app_version = EXCLUDED.app_version
           RETURNING *`,
          [
            ctx.user.id,
            input.fcmToken,
            input.deviceType,
            input.deviceName || null,
            input.appVersion || null,
          ]
        );

        return result.rows[0];
      } catch (error) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to register device token',
        });
      }
    }),

  /**
   * Unregister a device token (deactivate, not delete)
   */
  unregisterDeviceToken: protectedProcedure
    .input(z.object({
      fcmToken: z.string().min(1),
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }

      try {
        const result = await db.query(
          `UPDATE device_tokens
           SET is_active = false, updated_at = NOW()
           WHERE user_id = $1 AND fcm_token = $2
           RETURNING id`,
          [ctx.user.id, input.fcmToken]
        );

        if (result.rowCount === 0) {
          throw new TRPCError({
            code: 'NOT_FOUND',
            message: 'Device token not found for this user',
          });
        }

        return { success: true };
      } catch (error) {
        if (error instanceof TRPCError) throw error;

        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: error instanceof Error ? error.message : 'Failed to unregister device token',
        });
      }
    }),
});
