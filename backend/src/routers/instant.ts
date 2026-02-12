/**
 * Instant Execution Mode Router (v0 - Minimal)
 *
 * Temporary endpoints for testing instant mode.
 * Uses tasks with mode='LIVE' and state='OPEN' as instant-available tasks.
 * Not production-ready UI.
 */

import { router, protectedProcedure } from '../trpc';
import { TaskService } from '../services/TaskService';
import { db } from '../db';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';

export const instantRouter = router({
  /**
   * List available instant tasks (for hustlers)
   * v0: Simple list, no filtering
   * Uses mode='LIVE' + state='OPEN' as proxy for instant tasks
   */
  listAvailable: protectedProcedure.query(async ({ ctx }) => {
    const result = await db.query<{
      id: string;
      title: string;
      description: string;
      price: number;
      location: string | null;
      created_at: Date;
    }>(
      `SELECT id, title, description, price, location, created_at
       FROM tasks
       WHERE mode = 'LIVE'
         AND state = 'OPEN'
         AND worker_id IS NULL
       ORDER BY created_at DESC
       LIMIT 20`
    );

    return result.rows.map(task => ({
      id: task.id,
      title: task.title,
      description: task.description,
      price: task.price,
      location: task.location,
      createdAt: task.created_at,
      // Calculate time waiting (for display)
      waitingSeconds: Math.floor((Date.now() - task.created_at.getTime()) / 1000),
    }));
  }),

  /**
   * Accept instant task (one-tap)
   * v0: Direct accept, no validation beyond DB
   */
  accept: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const result = await TaskService.accept({
        taskId: input.taskId,
        workerId: ctx.user.id,
      });

      if (!result.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: result.error.message,
        });
      }

      // Calculate time-to-accept using created_at → accepted_at
      const task = result.data;
      let timeToAcceptSeconds: number | null = null;

      if (task.created_at && task.accepted_at) {
        timeToAcceptSeconds = Math.floor(
          (task.accepted_at.getTime() - task.created_at.getTime()) / 1000
        );
      }

      return {
        task: result.data,
        timeToAcceptSeconds,
      };
    }),

  /**
   * Dismiss instant task notification
   * Notification Urgency Design v1: Track dismissals for metrics
   */
  dismiss: protectedProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Mark notification as dismissed (read) for this user
      const result = await db.query(
        `UPDATE notifications
         SET read_at = NOW(),
             metadata = jsonb_set(
               COALESCE(metadata, '{}'::jsonb),
               '{dismissed}',
               'true'::jsonb
             )
         WHERE user_id = $1
           AND task_id = $2
           AND category = 'instant_task_available'
           AND read_at IS NULL
         RETURNING id`,
        [ctx.user.id, input.taskId]
      );

      if (result.rowCount === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Notification not found or already dismissed',
        });
      }

      return { dismissed: true };
    }),

  /**
   * Get instant task metrics (for testing)
   * Notification Urgency Design v1: Includes notification-to-accept latency
   */
  metrics: protectedProcedure.query(async () => {
    // Time-to-accept (created_at → accepted_at for LIVE mode tasks)
    const timeToAcceptResult = await db.query<{
      created_at: Date;
      accepted_at: Date | null;
    }>(
      `SELECT created_at, accepted_at
       FROM tasks
       WHERE mode = 'LIVE'
         AND accepted_at IS NOT NULL
       ORDER BY accepted_at DESC
       LIMIT 100`
    );

    const timeToAccept = timeToAcceptResult.rows
      .map(row => {
        if (!row.created_at || !row.accepted_at) return null;
        return Math.floor(
          (row.accepted_at.getTime() - row.created_at.getTime()) / 1000
        );
      })
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b);

    // Notification-to-accept latency (notification created → task accepted)
    const notificationLatencyResult = await db.query<{
      notification_created_at: Date;
      task_accepted_at: Date;
    }>(
      `SELECT n.created_at as notification_created_at, t.accepted_at as task_accepted_at
       FROM notifications n
       JOIN tasks t ON n.task_id = t.id
       WHERE n.category = 'instant_task_available'
         AND t.mode = 'LIVE'
         AND t.accepted_at IS NOT NULL
         AND t.worker_id = n.user_id
       ORDER BY t.accepted_at DESC
       LIMIT 100`
    );

    const notificationLatency = notificationLatencyResult.rows
      .map(row => {
        if (!row.notification_created_at || !row.task_accepted_at) return null;
        return Math.floor(
          (row.task_accepted_at.getTime() - row.notification_created_at.getTime()) / 1000
        );
      })
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b);

    // Dismiss rate
    const dismissStats = await db.query<{
      total: string;
      dismissed: string;
    }>(
      `SELECT
         COUNT(*) as total,
         COUNT(*) FILTER (WHERE read_at IS NOT NULL AND metadata->>'dismissed' = 'true') as dismissed
       FROM notifications
       WHERE category = 'instant_task_available'
         AND created_at > NOW() - INTERVAL '24 hours'`
    );

    const total = parseInt(dismissStats.rows[0]?.total || '0', 10);
    const dismissed = parseInt(dismissStats.rows[0]?.dismissed || '0', 10);
    const dismissRate = total > 0 ? dismissed / total : 0;

    const calculateStats = (times: number[]) => {
      if (times.length === 0) {
        return { median: null, p90: null, min: null, max: null };
      }
      return {
        median: times[Math.floor(times.length / 2)],
        p90: times[Math.floor(times.length * 0.9)],
        min: times[0],
        max: times[times.length - 1],
      };
    };

    return {
      timeToAccept: {
        count: timeToAccept.length,
        ...calculateStats(timeToAccept),
        all: timeToAccept,
      },
      notificationLatency: {
        count: notificationLatency.length,
        ...calculateStats(notificationLatency),
        all: notificationLatency,
      },
      dismissRate: Math.round(dismissRate * 100) / 100,
      dismissStats: {
        total,
        dismissed,
      },
    };
  }),
});
