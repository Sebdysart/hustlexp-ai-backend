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
        const result = await GoModeService.setGoMode(userId, input.enabled);

        // When a hustler goes online, immediately re-dispatch any OPEN smart_dispatch
        // tasks that expired (waves ran while hustler was offline). Fire-and-forget
        // so the response is not delayed.
        if (input.enabled) {
          redispatchExpiredTasksForHustler(userId).catch(err => {
            import('../logger.js').then(({ logger }) =>
              logger.warn({ hustlerId: userId, err: err instanceof Error ? err.message : String(err) }, 'redispatch on go-mode failed (non-fatal)')
            );
          });
        }

        return result;
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
        // Detect first GPS push while go_mode=true (location_updated_at was NULL).
        // This is the offline→online transition — re-dispatch any tasks that expired
        // while the hustler had no location.
        const prev = await db.query<{ go_mode: boolean; location_updated_at: Date | null }>(
          `SELECT go_mode, location_updated_at FROM users WHERE id = $1`,
          [userId]
        );
        const isFirstLocationWhileOnline =
          prev.rows[0]?.go_mode === true && prev.rows[0]?.location_updated_at === null;

        const result = await GoModeService.updateLocation(userId, input.lat, input.lng);

        if (isFirstLocationWhileOnline) {
          redispatchExpiredTasksForHustler(userId).catch(err => {
            import('../logger.js').then(({ logger }) =>
              logger.warn(
                { hustlerId: userId, err: err instanceof Error ? err.message : String(err) },
                'redispatch on first-location-push failed (non-fatal)'
              )
            );
          });
        }

        return result;
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
      eventType: z.enum(['ping_viewed', 'ping_accepted', 'ping_declined', 'ping_expired']),
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

      // Check 3: Active ping query.
      // Window is 2 minutes so Simulator polling (no FCM) can still find pings
      // that fired before the app launched. expiresAt is always NOW()+30s so the
      // hustler always gets a fresh 30-second countdown from the moment of receipt.
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
            AND de.created_at   > NOW() - INTERVAL '2 minutes'
            AND t.state NOT IN  ('ACCEPTED', 'COMPLETED', 'CANCELLED')
            AND NOT EXISTS (
              SELECT 1 FROM dispatch_events de2
               WHERE de2.task_id    = de.task_id
                 AND de2.hustler_id = de.hustler_id
                 AND de2.event_type IN ('ping_accepted','ping_declined','ping_expired','claimed')
                 AND de2.created_at > de.created_at
            )
            AND NOT EXISTS (
              SELECT 1 FROM tasks active
               WHERE active.worker_id = $1
                 AND active.state = 'ACCEPTED'
            )
          ORDER BY de.created_at DESC
          LIMIT 1`,
        [hustlerId]
      );

      log.info({ found: result.rowCount ?? 0 }, '[getActivePing] Active ping query result');

      if ((result.rowCount ?? 0) === 0) return null;

      const row = result.rows[0];
      // Always give the hustler 30 seconds from NOW (the moment the poll finds the ping),
      // not from event_created_at — ensures a full countdown even on Simulator polling.
      const expiresAt = new Date(Date.now() + 30 * 1000).toISOString();

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

      // FCM token status — tells us whether real device push can actually be delivered
      const fcmTokenResult = await db.query<{
        token_count: string;
        last_registered_at: Date | null;
      }>(
        `SELECT COUNT(*)::text AS token_count, MAX(created_at) AS last_registered_at
           FROM device_tokens
          WHERE user_id = $1 AND is_active = true`,
        [hustlerId]
      );
      const fcmTokenRow = fcmTokenResult.rows[0];

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
        fcmTokens: {
          activeCount: parseInt(fcmTokenRow?.token_count ?? '0', 10),
          lastRegisteredAgeSeconds: fcmTokenRow?.last_registered_at
            ? Math.round((Date.now() - new Date(fcmTokenRow.last_registered_at).getTime()) / 1000)
            : null,
        },
      };
    }),
});

// ── Go-Mode Re-dispatch Helper ────────────────────────────────────────────────
//
// When a hustler enables Go Mode, find any OPEN smart_dispatch tasks that are
// expired or stuck mid-dispatch (waves ran while this hustler was offline).
// Reset them to 'idle' and re-trigger the outbox so wave 1 runs immediately.
// This ensures hustlers never miss tasks just because they were offline when
// the original waves fired.

async function redispatchExpiredTasksForHustler(hustlerId: string): Promise<void> {
  const log = (await import('../logger.js')).logger.child({ fn: 'redispatchExpiredTasksForHustler', hustlerId });

  // ── Case 1: Tasks this hustler was NEVER dispatched for ───────────────────
  // Reset to idle and run the full wave sequence (candidate selection + FCM).
  const neverDispatched = await db.query<{ id: string }>(
    `SELECT t.id
       FROM tasks t
      WHERE t.fulfillment_mode = 'smart_dispatch'
        AND t.state NOT IN ('ACCEPTED', 'COMPLETED', 'CANCELLED')
        AND t.dispatch_state NOT IN ('fulfilled', 'claimed', 'soft_hold_active')
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_events de
           WHERE de.task_id    = t.id
             AND de.hustler_id = $1
        )
      LIMIT 10`,
    [hustlerId]
  );

  log.info({ count: neverDispatched.rowCount ?? 0 }, 'Case 1: tasks never dispatched to this hustler');

  for (const { id: taskId } of neverDispatched.rows) {
    try {
      await db.query(`UPDATE tasks SET dispatch_state = 'idle', updated_at = NOW() WHERE id = $1`, [taskId]);
      const { WaveManager } = await import('../services/WaveManager.js');
      await WaveManager.initiateDispatch(taskId);
      log.info({ taskId }, 'Re-dispatched (never-seen) on go-mode enable');
    } catch (err) {
      log.warn({ taskId, err: err instanceof Error ? err.message : String(err) }, 'Case 1 re-dispatch failed (non-fatal)');
    }
  }

  // ── Case 2: Tasks where ping expired (wave_started exists, no accept/decline) ──
  // The hustler saw the ping but the 30s timer ran out without a response.
  // Insert a fresh wave_started event and send FCM directly — bypassing the outbox
  // so the idempotency key collision on the old processed event doesn't silently drop it.
  const expiredPings = await db.query<{ id: string; location: string | null }>(
    `SELECT t.id, t.location
       FROM tasks t
      WHERE t.fulfillment_mode = 'smart_dispatch'
        AND t.state NOT IN ('ACCEPTED', 'COMPLETED', 'CANCELLED')
        AND t.dispatch_state NOT IN ('fulfilled', 'claimed', 'soft_hold_active')
        AND EXISTS (
          SELECT 1 FROM dispatch_events de
           WHERE de.task_id    = t.id
             AND de.hustler_id = $1
             AND de.event_type = 'wave_started'
        )
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_events de
           WHERE de.task_id    = t.id
             AND de.hustler_id = $1
             AND de.event_type IN ('ping_accepted', 'ping_declined', 'claimed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_events de
           WHERE de.task_id    = t.id
             AND de.hustler_id = $1
             AND de.event_type = 'wave_started'
             AND de.created_at > NOW() - INTERVAL '2 minutes'
        )
      LIMIT 10`,
    [hustlerId]
  );

  log.info({ count: expiredPings.rowCount ?? 0 }, 'Case 2: tasks with expired pings for this hustler');

  for (const task of expiredPings.rows) {
    try {
      // Insert a fresh wave_started so getActivePing finds it within the 2-minute window
      await db.query(
        `INSERT INTO dispatch_events (task_id, hustler_id, event_type, wave_number, dispatch_score)
         VALUES ($1, $2, 'wave_started', 1, 0.5)`,
        [task.id, hustlerId]
      );
      // Send FCM ping directly (skips outbox to avoid idempotency key collision with the
      // already-processed task.dispatch_ping event from the original wave)
      const { sendDispatchPing } = await import('../jobs/dispatch-ping-worker.js');
      await sendDispatchPing(
        { taskId: task.id, hustlerId, waveNumber: 1, location: task.location ?? null },
        `redispatch:${task.id}:${hustlerId}:${Date.now()}`
      );
      log.info({ taskId: task.id }, 'Re-pinged (expired ping) on go-mode enable');
    } catch (err) {
      log.warn({ taskId: task.id, err: err instanceof Error ? err.message : String(err) }, 'Case 2 re-ping failed (non-fatal)');
    }
  }
}
