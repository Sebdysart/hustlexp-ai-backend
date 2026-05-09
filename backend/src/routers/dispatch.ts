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

  setGoMode: protectedProcedure
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

  updateLocation: protectedProcedure
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

  getStatus: protectedProcedure
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

  getPrefs: protectedProcedure
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

  setPrefs: protectedProcedure
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
         VALUES ($1, $2, $3, $4, COALESCE($5, false), COALESCE($6, true), NOW())
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

  recordPingEvent: protectedProcedure
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

  confirmClaim: protectedProcedure
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

  // ── Active Ping Polling ────────────────────────────────────────────────────
  // iOS Simulator cannot receive real FCM pushes (no APNs connection).
  // This endpoint lets GoModeManager poll every ~3 s to discover pending pings,
  // making Smart Dispatch testable on Simulator and providing a push fallback
  // on real devices in case FCM delivery is delayed.

  getActivePing: protectedProcedure
    .query(async ({ ctx }) => {
      const hustlerId = ctx.user!.id;
      const log = (await import('../logger.js')).logger.child({ procedure: 'getActivePing', hustlerId });

      // Check 1: Is the hustler online with a fresh location?
      const hustlerRow = await db.query<{
        go_mode: boolean;
        trust_hold: boolean;
        trust_tier: number;
        last_location_lat: number | null;
        location_updated_at: Date | null;
      }>(
        `SELECT go_mode, trust_hold, trust_tier, last_location_lat, location_updated_at
           FROM users WHERE id = $1`,
        [hustlerId]
      );

      const h = hustlerRow.rows[0];
      log.info({
        goMode: h?.go_mode,
        trustHold: h?.trust_hold,
        trustTier: h?.trust_tier,
        hasLocation: h?.last_location_lat !== null,
        locationAge: h?.location_updated_at
          ? `${Math.round((Date.now() - new Date(h.location_updated_at).getTime()) / 1000)}s ago`
          : 'never',
      }, '[getActivePing] Hustler state');

      // Check 2: Any dispatch_events (wave_started) for this hustler in the last 5 min?
      const recentEvents = await db.query<{
        task_id: string;
        event_type: string;
        wave_number: number;
        created_at: Date;
      }>(
        `SELECT task_id, event_type, wave_number, created_at
           FROM dispatch_events
          WHERE hustler_id = $1
            AND created_at > NOW() - INTERVAL '5 minutes'
          ORDER BY created_at DESC
          LIMIT 10`,
        [hustlerId]
      );

      log.info({
        recentEventCount: recentEvents.rowCount,
        events: recentEvents.rows.map(e => ({
          taskId: e.task_id,
          type: e.event_type,
          wave: e.wave_number,
          age: `${Math.round((Date.now() - new Date(e.created_at).getTime()) / 1000)}s ago`,
        })),
      }, '[getActivePing] Recent dispatch_events for hustler');

      // Check 3: Active ping query (30s window)
      const result = await db.query<{
        task_id: string;
        wave_number: number;
        event_created_at: Date;
        title: string;
        price: number;
        location: string | null;
      }>(
        `SELECT de.task_id,
                de.wave_number,
                de.created_at        AS event_created_at,
                t.title,
                t.price,
                t.location
           FROM dispatch_events de
           JOIN tasks t ON t.id = de.task_id
          WHERE de.hustler_id = $1
            AND de.event_type   = 'wave_started'
            AND de.created_at   > NOW() - INTERVAL '30 seconds'
            AND t.state NOT IN  ('ACCEPTED', 'COMPLETED', 'CANCELLED')
            AND NOT EXISTS (
              SELECT 1 FROM dispatch_events de2
               WHERE de2.task_id    = de.task_id
                 AND de2.hustler_id = de.hustler_id
                 AND de2.event_type IN ('ping_accepted','ping_declined','ping_expired','claimed')
            )
          ORDER BY de.created_at DESC
          LIMIT 1`,
        [hustlerId]
      );

      log.info({ found: result.rowCount ?? 0 }, '[getActivePing] Active ping query result');

      if ((result.rowCount ?? 0) === 0) return null;

      const row = result.rows[0];
      const expiresAt = new Date(
        new Date(row.event_created_at).getTime() + 30 * 1000
      ).toISOString();

      log.info({
        taskId: row.task_id,
        waveNumber: row.wave_number,
        expiresAt,
        paymentCents: Math.round(Number(row.price)),
      }, '[getActivePing] Returning active ping');

      return {
        taskId:       row.task_id,
        taskTitle:    row.title,
        paymentCents: Math.round(Number(row.price)),
        location:     row.location ?? null,
        waveNumber:   row.wave_number,
        expiresAt,
      };
    }),

  // ── Ping Debug State ─────────────────────────────────────────────────────
  // Full pipeline snapshot for debugging. Shows everything needed to diagnose
  // why a hustler is or isn't receiving pings.

  getPingDebugState: protectedProcedure
    .query(async ({ ctx }) => {
      const hustlerId = ctx.user!.id;

      // Hustler row
      const hustlerResult = await db.query<{
        go_mode: boolean;
        trust_hold: boolean;
        trust_tier: number;
        default_mode: string;
        account_status: string;
        last_location_lat: number | null;
        last_location_lng: number | null;
        location_updated_at: Date | null;
      }>(
        `SELECT go_mode, trust_hold, trust_tier, default_mode, account_status,
                last_location_lat, last_location_lng, location_updated_at
           FROM users WHERE id = $1`,
        [hustlerId]
      );
      const hustler = hustlerResult.rows[0] ?? null;

      // Last 5 smart_dispatch tasks (any poster)
      const tasks = await db.query<{
        id: string;
        title: string;
        state: string;
        fulfillment_mode: string;
        dispatch_state: string | null;
        created_at: Date;
      }>(
        `SELECT id, title, state, fulfillment_mode,
                COALESCE(dispatch_state,'none') AS dispatch_state, created_at
           FROM tasks
          WHERE fulfillment_mode = 'smart_dispatch'
          ORDER BY created_at DESC
          LIMIT 5`
      );

      // Outbox events for the recent smart_dispatch tasks (any age)
      const taskIds = tasks.rows.map(t => t.id);
      const outbox = await db.query<{
        id: string;
        event_type: string;
        aggregate_id: string;
        status: string;
        attempts: number;
        error_message: string | null;
        created_at: Date;
      }>(
        `SELECT oe.id, oe.event_type, oe.aggregate_id, oe.status,
                oe.attempts, oe.error_message, oe.created_at
           FROM outbox_events oe
          WHERE (
            -- Recent dispatch events (last 10 min)
            (oe.created_at > NOW() - INTERVAL '10 minutes'
             AND oe.event_type IN (
               'task.instant_matching_started',
               'task.instant_available',
               'task.dispatch_ping'
             ))
            OR
            -- All-time events for the specific tasks we found (any age)
            (oe.aggregate_id = ANY($1)
             AND oe.event_type = 'task.instant_matching_started')
          )
          ORDER BY oe.created_at DESC
          LIMIT 20`,
        [taskIds]
      );

      // dispatch_events for this hustler in last 10 min
      const dispatchEvents = await db.query<{
        task_id: string;
        event_type: string;
        wave_number: number;
        created_at: Date;
      }>(
        `SELECT task_id, event_type, wave_number, created_at
           FROM dispatch_events
          WHERE hustler_id = $1
            AND created_at > NOW() - INTERVAL '10 minutes'
          ORDER BY created_at DESC
          LIMIT 20`,
        [hustlerId]
      );

      return {
        hustler: hustler ? {
          goMode: hustler.go_mode,
          trustHold: hustler.trust_hold,
          trustTier: hustler.trust_tier,
          defaultMode: hustler.default_mode,
          accountStatus: hustler.account_status,
          hasLocation: hustler.last_location_lat !== null,
          locationAgeSeconds: hustler.location_updated_at
            ? Math.round((Date.now() - new Date(hustler.location_updated_at).getTime()) / 1000)
            : null,
        } : null,
        recentSmartDispatchTasks: tasks.rows.map(t => ({
          id: t.id,
          title: t.title,
          state: t.state,
          fulfillmentMode: t.fulfillment_mode,
          dispatchState: t.dispatch_state,
          ageSeconds: Math.round((Date.now() - new Date(t.created_at).getTime()) / 1000),
        })),
        outboxEvents: outbox.rows.map(e => ({
          eventType: e.event_type,
          taskId: e.aggregate_id,
          status: e.status,
          attempts: e.attempts,
          error: e.error_message,
          ageSeconds: Math.round((Date.now() - new Date(e.created_at).getTime()) / 1000),
        })),
        myDispatchEvents: dispatchEvents.rows.map(e => ({
          taskId: e.task_id,
          eventType: e.event_type,
          waveNumber: e.wave_number,
          ageSeconds: Math.round((Date.now() - new Date(e.created_at).getTime()) / 1000),
        })),
      };
    }),
});
