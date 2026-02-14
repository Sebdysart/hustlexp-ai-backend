/**
 * Beta Dashboard Router v1.0.0
 *
 * Admin-only dashboard for the Seattle beta experiment.
 *
 * 6 Core Metrics:
 *   1. Tasks created
 *   2. Tasks completed
 *   3. GMV (Gross Merchandise Volume)
 *   4. Platform fee revenue
 *   5. Dispute rate
 *   6. Conversion to paid (subscription upgrades)
 *
 * Extended:
 *   - Kill signals (auto-detect beta failure conditions)
 *   - Beta status (caps, guardrails, remaining capacity)
 *   - Revenue ledger integrity
 *   - Daily time-series for charting
 *   - User activity feed
 *
 * @see BetaService.ts
 * @see config.ts (beta section)
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, adminProcedure, protectedProcedure } from '../trpc';
import { BetaService } from '../services/BetaService';
import { RevenueService } from '../services/RevenueService';
import { ChargebackService } from '../services/ChargebackService';
import { db } from '../db';
import { config } from '../config';

export const betaDashboardRouter = router({
  // ==========================================================================
  // CORE: 6 Metrics + Status
  // ==========================================================================

  /**
   * Get all 6 core beta metrics + extended behavioral data.
   * This is the primary admin dashboard endpoint.
   */
  getMetrics: adminProcedure
    .input(z.object({
      windowDays: z.number().int().min(1).max(365).default(30),
    }).optional())
    .query(async ({ input }) => {
      const result = await BetaService.getBetaMetrics(input?.windowDays || 30);
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Get beta status — caps, guardrails, remaining capacity.
   */
  getStatus: adminProcedure
    .query(async () => {
      const result = await BetaService.getBetaStatus();
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Get kill signals — conditions that indicate beta should be stopped.
   */
  getKillSignals: adminProcedure
    .query(async () => {
      const result = await BetaService.getKillSignals();
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  // ==========================================================================
  // FINANCIAL: Revenue + Disputes
  // ==========================================================================

  /**
   * Get revenue summary by event type (last N days).
   */
  getRevenueSummary: adminProcedure
    .input(z.object({
      days: z.number().int().min(1).max(365).default(30),
    }).optional())
    .query(async ({ input }) => {
      const result = await RevenueService.getRevenueSummary(input?.days || 30);
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Get monthly P&L from the revenue ledger.
   */
  getMonthlyPnl: adminProcedure
    .input(z.object({
      months: z.number().int().min(1).max(24).default(6),
    }).optional())
    .query(async ({ input }) => {
      const result = await RevenueService.getMonthlyPnl(input?.months || 6);
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Verify revenue ledger financial integrity.
   * SUM(gross) - SUM(net) should = SUM(platform_fee) for platform_fee events.
   */
  verifyLedgerIntegrity: adminProcedure
    .query(async () => {
      const result = await RevenueService.verifyLedgerIntegrity();
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  /**
   * Get platform dispute rate (30d + 90d rolling windows).
   */
  getDisputeRate: adminProcedure
    .query(async () => {
      const result = await ChargebackService.getPlatformDisputeRate();
      if (!result.success) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return result.data;
    }),

  // ==========================================================================
  // TIME SERIES: Daily metrics for charts
  // ==========================================================================

  /**
   * Get daily task creation & completion counts for charting.
   */
  getDailyTaskCounts: adminProcedure
    .input(z.object({
      days: z.number().int().min(1).max(90).default(30),
    }).optional())
    .query(async ({ input }) => {
      const days = input?.days || 30;
      const result = await db.query<{
        day: string;
        created: string;
        completed: string;
        cancelled: string;
      }>(
        `SELECT
           date_trunc('day', d.day) AS day,
           COUNT(t.id) FILTER (WHERE date_trunc('day', t.created_at) = d.day) as created,
           COUNT(t.id) FILTER (WHERE date_trunc('day', t.completed_at) = d.day AND t.state = 'COMPLETED') as completed,
           COUNT(t.id) FILTER (WHERE date_trunc('day', t.updated_at) = d.day AND t.state = 'CANCELLED') as cancelled
         FROM generate_series(
           date_trunc('day', NOW()) - make_interval(days => $1),
           date_trunc('day', NOW()),
           '1 day'::interval
         ) d(day)
         LEFT JOIN tasks t ON
           date_trunc('day', t.created_at) = d.day OR
           date_trunc('day', t.completed_at) = d.day OR
           date_trunc('day', t.updated_at) = d.day
         GROUP BY d.day
         ORDER BY d.day ASC`,
        [days]
      );

      return result.rows.map(r => ({
        day: r.day,
        created: parseInt(r.created, 10),
        completed: parseInt(r.completed, 10),
        cancelled: parseInt(r.cancelled, 10),
      }));
    }),

  /**
   * Get daily revenue time series (from revenue_report_daily view).
   */
  getDailyRevenue: adminProcedure
    .input(z.object({
      days: z.number().int().min(1).max(90).default(30),
    }).optional())
    .query(async ({ input }) => {
      const days = input?.days || 30;
      const result = await db.query<{
        day: string;
        event_type: string;
        total_amount_cents: string;
        event_count: string;
      }>(
        `SELECT
           day,
           event_type,
           total_amount_cents,
           event_count
         FROM revenue_report_daily
         WHERE day > NOW() - make_interval(days => $1)
         ORDER BY day ASC, event_type`,
        [days]
      );

      return result.rows.map(r => ({
        day: r.day,
        eventType: r.event_type,
        totalAmountCents: parseInt(r.total_amount_cents, 10),
        eventCount: parseInt(r.event_count, 10),
      }));
    }),

  // ==========================================================================
  // ACTIVITY FEED: Recent events for manual oversight
  // ==========================================================================

  /**
   * Get recent activity feed for manual oversight.
   * Shows latest tasks, escrows, disputes, and revenue events.
   */
  getActivityFeed: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50),
    }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit || 50;

      const result = await db.query<{
        event_time: string;
        event_type: string;
        entity_type: string;
        entity_id: string;
        user_id: string;
        user_email: string;
        detail: string;
        amount_cents: string | null;
      }>(
        `(
           SELECT
             t.created_at as event_time,
             'task_created' as event_type,
             'task' as entity_type,
             t.id as entity_id,
             t.poster_id as user_id,
             u.email as user_email,
             t.title as detail,
             t.price::TEXT as amount_cents
           FROM tasks t
           JOIN users u ON u.id = t.poster_id
           ORDER BY t.created_at DESC
           LIMIT $1
         )
         UNION ALL
         (
           SELECT
             e.funded_at as event_time,
             'escrow_funded' as event_type,
             'escrow' as entity_type,
             e.id as entity_id,
             t.poster_id as user_id,
             u.email as user_email,
             'Escrow funded for: ' || t.title as detail,
             e.amount::TEXT as amount_cents
           FROM escrows e
           JOIN tasks t ON t.id = e.task_id
           JOIN users u ON u.id = t.poster_id
           WHERE e.funded_at IS NOT NULL
           ORDER BY e.funded_at DESC
           LIMIT $1
         )
         UNION ALL
         (
           SELECT
             rl.created_at as event_time,
             rl.event_type as event_type,
             'revenue' as entity_type,
             rl.id as entity_id,
             rl.user_id as user_id,
             u.email as user_email,
             rl.event_type || ': ' || rl.amount_cents || ' cents' as detail,
             rl.amount_cents::TEXT as amount_cents
           FROM revenue_ledger rl
           JOIN users u ON u.id = rl.user_id
           ORDER BY rl.created_at DESC
           LIMIT $1
         )
         ORDER BY event_time DESC
         LIMIT $1`,
        [limit]
      );

      return result.rows.map(r => ({
        eventTime: r.event_time,
        eventType: r.event_type,
        entityType: r.entity_type,
        entityId: r.entity_id,
        userId: r.user_id,
        userEmail: r.user_email,
        detail: r.detail,
        amountCents: r.amount_cents ? parseInt(r.amount_cents, 10) : null,
      }));
    }),

  // ==========================================================================
  // USER MANAGEMENT: Beta-specific user ops
  // ==========================================================================

  /**
   * List all beta users with their stats.
   */
  listUsers: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(100),
      sortBy: z.enum(['created_at', 'xp_total', 'tasks_posted', 'tasks_completed']).default('created_at'),
    }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit || 100;
      const result = await db.query<{
        id: string;
        email: string;
        full_name: string;
        default_mode: string;
        subscription_tier: string;
        trust_tier: number;
        xp_total: number;
        created_at: string;
        tasks_posted: string;
        tasks_completed: string;
        total_earned_cents: string;
        total_spent_cents: string;
      }>(
        `SELECT
           u.id,
           u.email,
           u.full_name,
           u.default_mode,
           COALESCE(u.subscription_tier, 'free') as subscription_tier,
           u.trust_tier,
           u.xp_total,
           u.created_at,
           (SELECT COUNT(*) FROM tasks WHERE poster_id = u.id) as tasks_posted,
           (SELECT COUNT(*) FROM tasks WHERE worker_id = u.id AND state = 'COMPLETED') as tasks_completed,
           COALESCE((SELECT SUM(amount_cents) FROM revenue_ledger WHERE user_id = u.id AND event_type = 'platform_fee'), 0) as total_earned_cents,
           COALESCE((SELECT SUM(amount) FROM escrows e JOIN tasks t ON t.id = e.task_id WHERE t.poster_id = u.id AND e.state != 'REFUNDED'), 0) as total_spent_cents
         FROM users u
         ORDER BY u.created_at DESC
         LIMIT $1`,
        [limit]
      );

      return result.rows.map(r => ({
        id: r.id,
        email: r.email,
        fullName: r.full_name,
        defaultMode: r.default_mode,
        subscriptionTier: r.subscription_tier,
        trustTier: r.trust_tier,
        xpTotal: r.xp_total,
        createdAt: r.created_at,
        tasksPosted: parseInt(r.tasks_posted, 10),
        tasksCompleted: parseInt(r.tasks_completed, 10),
        totalEarnedCents: parseInt(r.total_earned_cents, 10),
        totalSpentCents: parseInt(r.total_spent_cents, 10),
      }));
    }),

  // ==========================================================================
  // BETA CONFIG: Read-only view of beta settings
  // ==========================================================================

  /**
   * Get beta configuration (public — used by iOS for geo-fence display).
   */
  getBetaConfig: protectedProcedure
    .query(async () => {
      return {
        enabled: config.beta.enabled,
        region: config.beta.regionName,
        bounds: config.beta.bounds,
        center: config.beta.center,
        radiusMiles: config.beta.radiusMiles,
        startDate: config.beta.startDate,
        endDate: config.beta.endDate,
      };
    }),

  // ==========================================================================
  // KILL SWITCH: Admin-controlled beta toggle with audit logging
  // ==========================================================================

  /**
   * Toggle the beta kill switch.
   *
   * IMPORTANT: This does NOT mutate config at runtime (config is frozen).
   * It logs the admin's intent to the audit table. The actual toggle
   * requires setting BETA_ENABLED env var and redeploying.
   *
   * This ensures:
   *   1. Kill switch changes are traceable
   *   2. No accidental toggles via API
   *   3. Deploy-gated — requires explicit action
   */
  requestKillSwitchToggle: adminProcedure
    .input(z.object({
      action: z.enum(['ENABLE', 'DISABLE']),
      reason: z.string().min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const currentState = config.beta.enabled;
      const requestedState = input.action === 'ENABLE';

      // Log to audit table
      await BetaService.logBetaStateChange(
        ctx.user.id,
        requestedState ? 'BETA_ENABLED' : 'BETA_DISABLED',
        {
          previousState: currentState,
          requestedState,
          reason: input.reason,
          adminEmail: ctx.user.email,
          requiresRedeploy: true,
        }
      );

      return {
        logged: true,
        currentState,
        requestedState,
        message: currentState === requestedState
          ? `Beta is already ${input.action === 'ENABLE' ? 'enabled' : 'disabled'}. No change needed.`
          : `Kill switch toggle logged. Set BETA_ENABLED=${requestedState} in environment and redeploy to apply.`,
        requiresRedeploy: currentState !== requestedState,
      };
    }),

  /**
   * Get kill switch audit history — all beta state changes.
   */
  getKillSwitchHistory: adminProcedure
    .query(async () => {
      const result = await db.query<{
        admin_user_id: string;
        action_type: string;
        action_details: string;
        created_at: string;
      }>(
        `SELECT admin_user_id, action_type, action_details, created_at
         FROM admin_actions
         WHERE action_type IN ('BETA_ENABLED', 'BETA_DISABLED', 'BETA_STATE_STARTUP')
         ORDER BY created_at DESC
         LIMIT 50`
      );

      return result.rows.map(r => ({
        adminUserId: r.admin_user_id,
        actionType: r.action_type,
        details: typeof r.action_details === 'string' ? JSON.parse(r.action_details) : r.action_details,
        createdAt: r.created_at,
      }));
    }),
});
