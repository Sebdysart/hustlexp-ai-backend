/**
 * Dispatch Router
 *
 * tRPC endpoints for the Smart Dispatch / Ping System.
 *
 * HUSTLER procedures (go_mode, location, dispatch prefs):
 *   dispatch.setGoMode        — enable/disable Go Mode
 *   dispatch.updateLocation   — update GPS position (called by iOS background location)
 *   dispatch.getStatus        — current go_mode + online status
 *   dispatch.getPrefs         — get dispatch preferences
 *   dispatch.setPrefs         — update dispatch preferences
 *   dispatch.recordPingEvent  — record ping_viewed / ping_declined from iOS
 *
 * SHARED procedures:
 *   dispatch.acquireSoftHold  — attempt soft hold when hustler taps Accept
 *   dispatch.releaseSoftHold  — release soft hold (if hustler backs out)
 */

import { z } from 'zod';
import { router } from '../trpc.js';
import { hustlerProcedure, posterProcedure, protectedProcedure } from '../trpc.js';
import { TRPCError } from '@trpc/server';
import { GoModeService } from '../services/GoModeService.js';
import { SoftHoldManager } from '../services/SoftHoldManager.js';
import { DispatchService } from '../services/DispatchService.js';
import { db } from '../db.js';

export const dispatchRouter = router({
  // ── Go Mode ────────────────────────────────────────────────────────────────

  setGoMode: hustlerProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;
      try {
        return await GoModeService.setGoMode(userId, input.enabled);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'Failed to update Go Mode',
        });
      }
    }),

  updateLocation: hustlerProcedure
    .input(z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;
      try {
        return await GoModeService.updateLocation(userId, input.lat, input.lng);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'Failed to update location',
        });
      }
    }),

  getStatus: hustlerProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const userId = ctx.user!.id;
      try {
        return await GoModeService.getStatus(userId);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'Failed to get Go Mode status',
        });
      }
    }),

  // ── Dispatch Preferences ──────────────────────────────────────────────────

  getPrefs: hustlerProcedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const userId = ctx.user!.id;
      const result = await db.query<{
        max_distance_miles: number;
        min_payout_cents: number;
        preferred_categories: string[] | null;
        auto_accept: boolean;
        ping_sound_enabled: boolean;
      }>(
        `SELECT max_distance_miles, min_payout_cents, preferred_categories,
                auto_accept, ping_sound_enabled
           FROM hustler_dispatch_prefs
          WHERE user_id = $1`,
        [userId]
      );

      if (result.rowCount === 0) {
        // Return defaults if no prefs row yet
        return {
          maxDistanceMiles: 10,
          minPayoutCents: 0,
          preferredCategories: [] as string[],
          autoAccept: false,
          pingSoundEnabled: true,
        };
      }

      const row = result.rows[0];
      return {
        maxDistanceMiles: row.max_distance_miles,
        minPayoutCents: row.min_payout_cents,
        preferredCategories: row.preferred_categories ?? [],
        autoAccept: row.auto_accept,
        pingSoundEnabled: row.ping_sound_enabled,
      };
    }),

  setPrefs: hustlerProcedure
    .input(z.object({
      maxDistanceMiles: z.number().int().min(1).max(100).optional(),
      minPayoutCents: z.number().int().min(0).optional(),
      preferredCategories: z.array(z.string()).optional(),
      autoAccept: z.boolean().optional(),
      pingSoundEnabled: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;

      await db.query(
        `INSERT INTO hustler_dispatch_prefs
           (user_id, max_distance_miles, min_payout_cents, preferred_categories,
            auto_accept, ping_sound_enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
           max_distance_miles   = COALESCE($2, hustler_dispatch_prefs.max_distance_miles),
           min_payout_cents     = COALESCE($3, hustler_dispatch_prefs.min_payout_cents),
           preferred_categories = COALESCE($4, hustler_dispatch_prefs.preferred_categories),
           auto_accept          = COALESCE($5, hustler_dispatch_prefs.auto_accept),
           ping_sound_enabled   = COALESCE($6, hustler_dispatch_prefs.ping_sound_enabled),
           updated_at           = NOW()`,
        [
          userId,
          input.maxDistanceMiles ?? null,
          input.minPayoutCents ?? null,
          input.preferredCategories ?? null,
          input.autoAccept ?? null,
          input.pingSoundEnabled ?? null,
        ]
      );

      return { success: true };
    }),

  // ── Ping Events ────────────────────────────────────────────────────────────

  recordPingEvent: hustlerProcedure
    .input(z.object({
      taskId: z.string(),
      eventType: z.enum(['ping_viewed', 'ping_declined']),
      waveNumber: z.number().int().min(1).max(3).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;
      await DispatchService.recordPingEvent(
        input.taskId,
        userId,
        input.eventType,
        input.waveNumber
      );
      return { success: true };
    }),

  // ── Soft Hold ─────────────────────────────────────────────────────────────

  acquireSoftHold: protectedProcedure
    .input(z.object({
      taskId: z.string(),
      ttlSeconds: z.number().int().min(10).max(120).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;
      const result = await SoftHoldManager.acquire(
        input.taskId,
        userId,
        input.ttlSeconds
      );

      if (!result.acquired) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'Task is currently held by another hustler. Please try again shortly.',
        });
      }

      return {
        acquired: true,
        expiresAt: result.expiresAt,
      };
    }),

  releaseSoftHold: protectedProcedure
    .input(z.object({ taskId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.user!.id;
      const released = await SoftHoldManager.release(input.taskId, userId);
      return { released };
    }),

  // ── Claim Conversion ──────────────────────────────────────────────────────

  confirmClaim: hustlerProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const hustlerId = ctx.user!.id;
      try {
        const result = await DispatchService.confirmClaim(input.taskId, hustlerId);

        // Cancel pending wave jobs — non-critical, fire-and-forget
        const { WaveManager } = await import('../services/WaveManager.js');
        WaveManager.cancelWaves(input.taskId).catch(() => {});

        return result;
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('CONFLICT')) {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'This task was just taken. Keep Go Mode on for the next ping!',
          });
        }
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'Failed to confirm claim',
        });
      }
    }),

  // ── Poster: dispatch status ────────────────────────────────────────────────

  getPosterDispatchStatus: posterProcedure
    .input(z.object({ taskId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { taskId } = input;

      const taskResult = await db.query<{
        dispatch_state: string | null;
        wave_number: number | null;
        fulfillment_mode: string | null;
        soft_hold_expires_at: Date | null;
        estimated_arrival_minutes: number | null;
        estimated_arrival_at: Date | null;
      }>(
        `SELECT dispatch_state, wave_number, fulfillment_mode, soft_hold_expires_at,
                estimated_arrival_minutes, estimated_arrival_at
           FROM tasks
          WHERE id = $1 AND poster_id = $2`,
        [taskId, ctx.user!.id]
      );

      if (taskResult.rowCount === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Task not found' });
      }

      const task = taskResult.rows[0];

      const eventsResult = await db.query<{
        event_type: string;
        wave_number: number | null;
        created_at: Date;
      }>(
        `SELECT event_type, wave_number, created_at
           FROM dispatch_events
          WHERE task_id = $1
          ORDER BY created_at DESC
          LIMIT 20`,
        [taskId]
      );

      return {
        dispatchState: task.dispatch_state ?? 'idle',
        waveNumber: task.wave_number ?? 0,
        fulfillmentMode: task.fulfillment_mode ?? 'broadcast',
        softHoldExpiresAt: task.soft_hold_expires_at ?? null,
        estimatedArrivalMinutes: task.estimated_arrival_minutes ?? null,
        estimatedArrivalAt: task.estimated_arrival_at ?? null,
        events: eventsResult.rows.map(r => ({
          eventType: r.event_type,
          waveNumber: r.wave_number ?? 0,
          createdAt: r.created_at,
        })),
      };
    }),
});
