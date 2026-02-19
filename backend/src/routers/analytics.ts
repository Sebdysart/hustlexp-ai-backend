/**
 * Analytics Router v1.0.0
 * 
 * CONSTITUTIONAL: PRODUCT_SPEC §13, ANALYTICS_SPEC.md
 * 
 * Endpoints for event tracking, conversion funnels, cohort analysis, and A/B testing.
 * 
 * @see backend/src/services/AnalyticsService.ts
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, publicProcedure, adminProcedure, Schemas } from '../trpc';
import { AnalyticsService, type EventCategory, type EventType } from '../services/AnalyticsService';
import { db } from '../db';

export const analyticsRouter = router({
  // --------------------------------------------------------------------------
  // EVENT TRACKING
  // --------------------------------------------------------------------------
  
  /**
   * Track an analytics event
   * 
   * ANALYTICS_SPEC.md §1: All user actions and system events are tracked
   * Privacy: Respects user consent (only track if user has granted analytics consent)
   * 
   * Note: Can be called publicly for anonymous events, or protected for user events
   */
  trackEvent: publicProcedure
    .input(z.object({
      eventType: z.string().min(1).max(100), // Allow custom event types
      eventCategory: z.enum(['user_action', 'system_event', 'error', 'performance']),
      userId: z.string().uuid().optional(), // Optional - may be anonymous
      sessionId: z.string().uuid(),
      deviceId: z.string().uuid(),
      taskId: Schemas.uuid.optional(),
      taskCategory: z.string().optional(),
      trustTier: z.number().int().min(0).max(10).optional(),
      properties: z.record(z.any()).optional(), // Optional event properties
      platform: z.enum(['ios', 'android', 'web']), // Required in schema
      appVersion: z.string().optional(),
      abTestId: z.string().optional(),
      abVariant: z.string().optional(),
      eventTimestamp: z.string().datetime().optional(), // Optional - defaults to NOW()
    }))
    .mutation(async ({ input, ctx }) => {
      // Security: If authenticated, always use the authenticated user's ID
      // Prevent userId spoofing by ignoring input.userId when user is authenticated
      const userId = ctx.user?.id || input.userId || undefined;
      if (ctx.user && input.userId && input.userId !== ctx.user.id) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Cannot track events for a different user',
        });
      }

      const result = await AnalyticsService.trackEvent({
        eventType: input.eventType,
        eventCategory: input.eventCategory,
        userId,
        sessionId: input.sessionId,
        deviceId: input.deviceId,
        taskId: input.taskId,
        taskCategory: input.taskCategory,
        trustTier: input.trustTier,
        properties: input.properties,
        platform: input.platform,
        appVersion: input.appVersion,
        abTestId: input.abTestId,
        abVariant: input.abVariant,
        eventTimestamp: input.eventTimestamp ? new Date(input.eventTimestamp) : undefined,
      });
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  /**
   * Track multiple events in a batch (for performance)
   */
  trackBatch: publicProcedure
    .input(z.object({
      events: z.array(z.object({
        eventType: z.string().min(1).max(100),
        eventCategory: z.enum(['user_action', 'system_event', 'error', 'performance']),
        userId: z.string().uuid().optional(),
        sessionId: z.string().uuid(),
        deviceId: z.string().uuid(),
        taskId: Schemas.uuid.optional(),
        taskCategory: z.string().optional(),
        trustTier: z.number().int().min(0).max(10).optional(),
        properties: z.record(z.any()).optional(),
        platform: z.enum(['ios', 'android', 'web']),
        appVersion: z.string().optional(),
        abTestId: z.string().optional(),
        abVariant: z.string().optional(),
        eventTimestamp: z.string().datetime().optional(),
      })).min(1).max(100), // Batch limit
    }))
    .mutation(async ({ input, ctx }) => {
      // Security: Prevent userId spoofing in batch events
      if (ctx.user) {
        const spoofedEvent = input.events.find(e => e.userId && e.userId !== ctx.user!.id);
        if (spoofedEvent) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Cannot track events for a different user',
          });
        }
      }

      const events = input.events.map(event => ({
        eventType: event.eventType,
        eventCategory: event.eventCategory,
        userId: ctx.user?.id || event.userId || undefined,
        sessionId: event.sessionId,
        deviceId: event.deviceId,
        taskId: event.taskId,
        taskCategory: event.taskCategory,
        trustTier: event.trustTier,
        properties: event.properties,
        platform: event.platform,
        appVersion: event.appVersion,
        abTestId: event.abTestId,
        abVariant: event.abVariant,
        eventTimestamp: event.eventTimestamp ? new Date(event.eventTimestamp) : undefined,
      }));
      
      const result = await AnalyticsService.trackBatch(events);
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // READ OPERATIONS
  // --------------------------------------------------------------------------
  
  /**
   * Get events for the authenticated user (with privacy checks)
   */
  getUserEvents: protectedProcedure
    .input(z.object({
      eventTypes: z.array(z.string()).optional(), // Optional filter by event types
      limit: z.number().int().min(1).max(100).default(100),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      const result = await AnalyticsService.getUserEvents(
        ctx.user.id,
        input.eventTypes as EventType[] | undefined,
        input.limit,
        input.offset
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
   * Get events for a task (protected - must be task participant or admin)
   * 
   * CONSTITUTIONAL: Only task poster, worker, or admin can access task analytics
   */
  getTaskEvents: protectedProcedure
    .input(z.object({
      taskId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(100),
    }))
    .query(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      // Verify user is task participant (poster or worker) or admin
      const taskResult = await db.query<{ poster_id: string; worker_id: string | null }>(
        'SELECT poster_id, worker_id FROM tasks WHERE id = $1',
        [input.taskId]
      );
      
      if (taskResult.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Task not found',
        });
      }
      
      const task = taskResult.rows[0];
      const isPoster = task.poster_id === ctx.user.id;
      const isWorker = task.worker_id === ctx.user.id;
      
      // Check if user is admin
      let isAdmin = false;
      if (!isPoster && !isWorker) {
        const adminResult = await db.query(
          'SELECT 1 FROM admin_roles WHERE user_id = $1 LIMIT 1',
          [ctx.user.id]
        );
        isAdmin = adminResult.rows.length > 0;
      }
      
      // Only allow if user is task participant or admin
      if (!isPoster && !isWorker && !isAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Access denied: Must be task participant (poster or worker) or admin',
        });
      }
      
      const result = await AnalyticsService.getTaskEvents(
        input.taskId,
        input.limit
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // CONVERSION FUNNELS (Admin only)
  // --------------------------------------------------------------------------
  
  /**
   * Calculate conversion funnel
   * 
   * ANALYTICS_SPEC.md §2: Track conversion rates through multi-step processes
   */
  calculateFunnel: adminProcedure
    .input(z.object({
      funnelName: z.string().min(1),
      steps: z.array(z.string()).min(2), // At least 2 steps required
      timeWindowDays: z.number().int().min(1).max(365).default(30),
    }))
    .query(async ({ input }) => {
      const result = await AnalyticsService.calculateFunnel(
        input.funnelName,
        input.steps as EventType[],
        input.timeWindowDays
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // COHORT ANALYSIS (Admin only)
  // --------------------------------------------------------------------------
  
  /**
   * Calculate cohort retention rates
   * 
   * ANALYTICS_SPEC.md §3: Track user cohorts and retention
   */
  calculateCohortRetention: adminProcedure
    .input(z.object({
      cohortMonth: z.string().regex(/^\d{4}-\d{2}$/), // Format: "2025-01"
    }))
    .query(async ({ input }) => {
      const result = await AnalyticsService.calculateCohortRetention(
        input.cohortMonth
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // A/B TESTING
  // --------------------------------------------------------------------------
  
  /**
   * Track A/B test assignment and conversion
   * 
   * ANALYTICS_SPEC.md §4: A/B testing framework
   * 
   * Note: sessionId and deviceId should be provided by the client for proper tracking.
   * If not provided, the service will generate them (not ideal for cross-device tracking).
   */
  trackABTest: protectedProcedure
    .input(z.object({
      testName: z.string().min(1),
      variant: z.enum(['A', 'B', 'control']),
      conversionEvent: z.string().optional(), // Optional conversion event to track
      sessionId: z.string().uuid().optional(), // Optional: Should be provided by client
      deviceId: z.string().uuid().optional(), // Optional: Should be provided by client
      platform: z.enum(['ios', 'android', 'web']).optional(), // Client platform
    }))
    .mutation(async ({ input, ctx }) => {
      if (!ctx.user) {
        throw new TRPCError({
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        });
      }
      
      // Note: sessionId, deviceId, and platform are provided by the client.
      // iOS client sends these from device info. Web clients can use fingerprinting.
      // Future: Add these to tRPC context via middleware for automatic injection.
      const result = await AnalyticsService.trackABTest(
        ctx.user.id,
        input.testName,
        input.variant,
        input.conversionEvent as EventType | undefined,
        input.sessionId,
        input.deviceId,
        input.platform || 'ios' // Default to iOS since primary client is native app
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
  
  // --------------------------------------------------------------------------
  // AGGREGATIONS (Admin only)
  // --------------------------------------------------------------------------
  
  /**
   * Get event counts by type (for dashboards)
   */
  getEventCounts: adminProcedure
    .input(z.object({
      eventTypes: z.array(z.string()).min(1),
      timeWindowDays: z.number().int().min(1).max(365).default(30),
    }))
    .query(async ({ input }) => {
      const result = await AnalyticsService.getEventCounts(
        input.eventTypes as EventType[],
        input.timeWindowDays
      );
      
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      
      return result.data;
    }),
});
