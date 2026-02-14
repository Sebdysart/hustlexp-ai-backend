/**
 * BetaService v1.0.0
 *
 * Seattle Beta — Controlled Revenue Validation Test
 *
 * Constraints:
 *   - 100 users max
 *   - 200 tasks max
 *   - $10,000 GMV cap
 *   - 30-day window
 *   - Seattle metro bounding box enforced on task creation + discovery
 *
 * Geo-fence: Tasks MUST have a location within Seattle bounds.
 * Users can be anywhere — but they can only SEE and CREATE tasks inside Seattle.
 *
 * Kill switch: config.beta.enabled = false opens all regions.
 *
 * @see config.ts (beta section)
 */

import { db } from '../db';
import { config } from '../config';
import type { ServiceResult } from '../types';

// ============================================================================
// TYPES
// ============================================================================

interface BetaStatus {
  enabled: boolean;
  region: string;
  bounds: { south: number; west: number; north: number; east: number };
  startDate: string;
  endDate: string;
  daysRemaining: number;
  // Counts vs caps
  users: { current: number; max: number; pct: number };
  tasks: { current: number; max: number; pct: number };
  gmvCents: { current: number; max: number; pct: number };
  // Guardrail status
  canCreateUser: boolean;
  canCreateTask: boolean;
  withinGmvCap: boolean;
  withinDateWindow: boolean;
}

interface BetaMetrics {
  // 6 Core Metrics (from the beta roadmap)
  tasksCreated: number;
  tasksCompleted: number;
  gmvCents: number;          // Gross Merchandise Volume
  platformRevenueCents: number; // Platform fee revenue
  disputeRate: number;        // % of tasks with disputes
  conversionToPaid: number;   // % of users on premium/pro
  // Extended metrics
  avgTaskPriceCents: number;
  avgTimeToAcceptanceMinutes: number;
  p50AcceptanceMinutes: number;  // Median — leading indicator of liquidity
  p95AcceptanceMinutes: number;  // Tail — worst-case user experience
  avgTimeToCompletionMinutes: number;
  repeatPosterRate: number;    // % of posters who posted 2+ tasks
  repeatHustlerRate: number;   // % of hustlers who completed 2+ tasks
  totalUsers: number;
  activeUsers7d: number;       // Users with activity in last 7 days
}

// ============================================================================
// SERVICE
// ============================================================================

export const BetaService = {
  /**
   * Check if a lat/lng is within the Seattle beta bounding box.
   * Used for task creation and task discovery geo-fence.
   */
  isWithinBetaRegion: (lat: number, lng: number): boolean => {
    if (!config.beta.enabled) return true; // Kill switch — all regions allowed

    const { south, west, north, east } = config.beta.bounds;
    return lat >= south && lat <= north && lng >= west && lng <= east;
  },

  /**
   * Check if beta is within its date window.
   */
  isWithinDateWindow: (): boolean => {
    if (!config.beta.enabled) return true;

    const now = new Date();
    const start = new Date(config.beta.startDate);
    const end = new Date(config.beta.endDate);
    return now >= start && now <= end;
  },

  /**
   * Get comprehensive beta status with all caps and current counts.
   */
  getBetaStatus: async (): Promise<ServiceResult<BetaStatus>> => {
    try {
      // Parallel queries for counts
      const [userCount, taskCount, gmvResult] = await Promise.all([
        db.query<{ count: string }>('SELECT COUNT(*) as count FROM users'),
        db.query<{ count: string }>('SELECT COUNT(*) as count FROM tasks'),
        db.query<{ gmv: string }>(
          `SELECT COALESCE(SUM(gross_amount_cents), 0) as gmv
           FROM revenue_ledger
           WHERE event_type = 'platform_fee'`
        ),
      ]);

      const users = parseInt(userCount.rows[0].count, 10);
      const tasks = parseInt(taskCount.rows[0].count, 10);
      const gmvCents = parseInt(gmvResult.rows[0].gmv, 10);

      const now = new Date();
      const end = new Date(config.beta.endDate);
      const daysRemaining = Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));

      return {
        success: true,
        data: {
          enabled: config.beta.enabled,
          region: config.beta.regionName,
          bounds: config.beta.bounds,
          startDate: config.beta.startDate,
          endDate: config.beta.endDate,
          daysRemaining,
          users: {
            current: users,
            max: config.beta.maxUsers,
            pct: Math.round((users / config.beta.maxUsers) * 100),
          },
          tasks: {
            current: tasks,
            max: config.beta.maxTasks,
            pct: Math.round((tasks / config.beta.maxTasks) * 100),
          },
          gmvCents: {
            current: gmvCents,
            max: config.beta.maxGmvCents,
            pct: Math.round((gmvCents / config.beta.maxGmvCents) * 100),
          },
          canCreateUser: users < config.beta.maxUsers,
          canCreateTask: tasks < config.beta.maxTasks,
          withinGmvCap: gmvCents < config.beta.maxGmvCents,
          withinDateWindow: BetaService.isWithinDateWindow(),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'BETA_STATUS_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Enforce beta guardrails before task creation.
   * Returns null if OK, or an error string if blocked.
   */
  enforceTaskCreation: async (
    taskLat?: number,
    taskLng?: number,
    locationString?: string
  ): Promise<string | null> => {
    if (!config.beta.enabled) return null; // Kill switch

    // 1. Date window
    if (!BetaService.isWithinDateWindow()) {
      return 'Beta period has ended. Task creation is paused.';
    }

    // 2. Task cap
    const taskCount = await db.query<{ count: string }>(
      'SELECT COUNT(*) as count FROM tasks'
    );
    if (parseInt(taskCount.rows[0].count, 10) >= config.beta.maxTasks) {
      return `Beta task cap reached (${config.beta.maxTasks}). No new tasks allowed.`;
    }

    // 3. GMV cap
    const gmvResult = await db.query<{ gmv: string }>(
      `SELECT COALESCE(SUM(gross_amount_cents), 0) as gmv
       FROM revenue_ledger WHERE event_type = 'platform_fee'`
    );
    if (parseInt(gmvResult.rows[0].gmv, 10) >= config.beta.maxGmvCents) {
      return `Beta GMV cap reached ($${(config.beta.maxGmvCents / 100).toLocaleString()}). No new tasks allowed.`;
    }

    // 4. Geo-fence (if coordinates provided)
    if (taskLat !== undefined && taskLng !== undefined) {
      if (!BetaService.isWithinBetaRegion(taskLat, taskLng)) {
        return `Tasks must be within the ${config.beta.regionName} metro area during beta. `
          + `Bounds: ${config.beta.bounds.south}°N–${config.beta.bounds.north}°N, `
          + `${config.beta.bounds.west}°W–${config.beta.bounds.east}°W`;
      }
    }

    return null; // All clear
  },

  /**
   * Get the 6 core beta metrics + extended behavioral data.
   */
  getBetaMetrics: async (windowDays: number = 30): Promise<ServiceResult<BetaMetrics>> => {
    try {
      const [
        taskStats,
        revenueStats,
        disputeStats,
        subscriptionStats,
        userStats,
        timingStats,
        repeatStats,
      ] = await Promise.all([
        // Tasks created & completed
        db.query<{ created: string; completed: string; avg_price: string }>(
          `SELECT
             COUNT(*) as created,
             COUNT(*) FILTER (WHERE state = 'COMPLETED') as completed,
             COALESCE(AVG(price), 0) as avg_price
           FROM tasks
           WHERE created_at > NOW() - make_interval(days => $1)`,
          [windowDays]
        ),

        // Revenue (GMV from platform_fee gross, revenue from platform_fee amount)
        db.query<{ gmv: string; revenue: string }>(
          `SELECT
             COALESCE(SUM(gross_amount_cents), 0) as gmv,
             COALESCE(SUM(amount_cents), 0) as revenue
           FROM revenue_ledger
           WHERE event_type = 'platform_fee'
             AND created_at > NOW() - make_interval(days => $1)`,
          [windowDays]
        ),

        // Dispute rate
        db.query<{ total_tasks: string; disputed_tasks: string }>(
          `SELECT
             COUNT(*) as total_tasks,
             COUNT(DISTINCT d.task_id) as disputed_tasks
           FROM tasks t
           LEFT JOIN disputes d ON d.task_id = t.id
           WHERE t.created_at > NOW() - make_interval(days => $1)
             AND t.state IN ('COMPLETED', 'DISPUTED')`,
          [windowDays]
        ),

        // Subscription conversion
        db.query<{ total_users: string; paid_users: string }>(
          `SELECT
             COUNT(*) as total_users,
             COUNT(*) FILTER (WHERE subscription_tier IN ('premium', 'pro')) as paid_users
           FROM users`
        ),

        // User counts (total + 7d active)
        db.query<{ total: string; active_7d: string }>(
          `SELECT
             COUNT(*) as total,
             COUNT(*) FILTER (
               WHERE id IN (
                 SELECT DISTINCT poster_id FROM tasks WHERE created_at > NOW() - INTERVAL '7 days'
                 UNION
                 SELECT DISTINCT worker_id FROM tasks WHERE worker_id IS NOT NULL AND updated_at > NOW() - INTERVAL '7 days'
               )
             ) as active_7d
           FROM users`
        ),

        // Timing: avg/P50/P95 time to acceptance, avg time to completion
        db.query<{ avg_accept_min: string; p50_accept_min: string; p95_accept_min: string; avg_complete_min: string }>(
          `SELECT
             COALESCE(AVG(EXTRACT(EPOCH FROM (accepted_at - created_at)) / 60), 0) as avg_accept_min,
             COALESCE(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (accepted_at - created_at)) / 60), 0) as p50_accept_min,
             COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (accepted_at - created_at)) / 60), 0) as p95_accept_min,
             COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - created_at)) / 60), 0) as avg_complete_min
           FROM tasks
           WHERE state = 'COMPLETED'
             AND created_at > NOW() - make_interval(days => $1)
             AND accepted_at IS NOT NULL
             AND completed_at IS NOT NULL`,
          [windowDays]
        ),

        // Repeat rates
        db.query<{ repeat_posters: string; total_posters: string; repeat_hustlers: string; total_hustlers: string }>(
          `SELECT
             COUNT(*) FILTER (WHERE poster_count >= 2) as repeat_posters,
             COUNT(*) as total_posters,
             0 as repeat_hustlers,
             0 as total_hustlers
           FROM (
             SELECT poster_id, COUNT(*) as poster_count
             FROM tasks
             WHERE created_at > NOW() - make_interval(days => $1)
             GROUP BY poster_id
           ) poster_agg`,
          [windowDays]
        ),
      ]);

      const totalTasks = parseInt(disputeStats.rows[0].total_tasks, 10) || 1;
      const disputedTasks = parseInt(disputeStats.rows[0].disputed_tasks, 10);
      const totalUsers = parseInt(subscriptionStats.rows[0].total_users, 10) || 1;
      const paidUsers = parseInt(subscriptionStats.rows[0].paid_users, 10);
      const totalPosters = parseInt(repeatStats.rows[0].total_posters, 10) || 1;
      const repeatPosters = parseInt(repeatStats.rows[0].repeat_posters, 10);

      // Repeat hustler rate (separate query for workers)
      const hustlerRepeat = await db.query<{ repeat_hustlers: string; total_hustlers: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE worker_count >= 2) as repeat_hustlers,
           COUNT(*) as total_hustlers
         FROM (
           SELECT worker_id, COUNT(*) as worker_count
           FROM tasks
           WHERE worker_id IS NOT NULL
             AND state = 'COMPLETED'
             AND created_at > NOW() - make_interval(days => $1)
           GROUP BY worker_id
         ) worker_agg`,
        [windowDays]
      );

      const totalHustlers = parseInt(hustlerRepeat.rows[0].total_hustlers, 10) || 1;
      const repeatHustlers = parseInt(hustlerRepeat.rows[0].repeat_hustlers, 10);

      return {
        success: true,
        data: {
          // 6 Core Metrics
          tasksCreated: parseInt(taskStats.rows[0].created, 10),
          tasksCompleted: parseInt(taskStats.rows[0].completed, 10),
          gmvCents: parseInt(revenueStats.rows[0].gmv, 10),
          platformRevenueCents: parseInt(revenueStats.rows[0].revenue, 10),
          disputeRate: Math.round((disputedTasks / totalTasks) * 10000) / 100,
          conversionToPaid: Math.round((paidUsers / totalUsers) * 10000) / 100,
          // Extended
          avgTaskPriceCents: Math.round(parseFloat(taskStats.rows[0].avg_price)),
          avgTimeToAcceptanceMinutes: Math.round(parseFloat(timingStats.rows[0].avg_accept_min)),
          p50AcceptanceMinutes: Math.round(parseFloat(timingStats.rows[0].p50_accept_min)),
          p95AcceptanceMinutes: Math.round(parseFloat(timingStats.rows[0].p95_accept_min)),
          avgTimeToCompletionMinutes: Math.round(parseFloat(timingStats.rows[0].avg_complete_min)),
          repeatPosterRate: Math.round((repeatPosters / totalPosters) * 10000) / 100,
          repeatHustlerRate: Math.round((repeatHustlers / totalHustlers) * 10000) / 100,
          totalUsers: parseInt(userStats.rows[0].total, 10),
          activeUsers7d: parseInt(userStats.rows[0].active_7d, 10),
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'BETA_METRICS_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },

  /**
   * Get kill signals — conditions that indicate beta should be stopped.
   */
  getKillSignals: async (): Promise<ServiceResult<{
    signals: { name: string; triggered: boolean; detail: string }[];
    shouldKill: boolean;
  }>> => {
    try {
      const metrics = await BetaService.getBetaMetrics(30);
      if (!metrics.success) {
        return { success: false, error: metrics.error };
      }

      const m = metrics.data;
      const signals: { name: string; triggered: boolean; detail: string }[] = [];

      // ================================================================
      // SAMPLE-SIZE GUARDS: Signals only fire after statistically
      // meaningful volume. Early marketplaces always have noise,
      // incomplete liquidity, and user churn. Reacting to small
      // sample variance kills experiments prematurely.
      // ================================================================

      // Kill signal 1: Posters not returning (repeat rate < 15%)
      // Guard: ≥50 completed tasks (enough to measure retention)
      const lowRepeatPosters = m.repeatPosterRate < 15 && m.tasksCompleted >= 50;
      signals.push({
        name: 'LOW_REPEAT_POSTERS',
        triggered: lowRepeatPosters,
        detail: `Repeat poster rate: ${m.repeatPosterRate}% (threshold: 15%, min sample: 50 completed, have: ${m.tasksCompleted})`,
      });

      // Kill signal 2: Slow task acceptance (avg > 24 hours)
      // Guard: ≥20 completed tasks (need enough accepted→completed cycles)
      const slowAcceptance = m.avgTimeToAcceptanceMinutes > 1440 && m.tasksCompleted >= 20;
      signals.push({
        name: 'SLOW_ACCEPTANCE',
        triggered: slowAcceptance,
        detail: `Avg acceptance time: ${Math.round(m.avgTimeToAcceptanceMinutes / 60)}h (threshold: 24h, min sample: 20 completed, have: ${m.tasksCompleted})`,
      });

      // Kill signal 3: Low average price (< $10)
      // Guard: ≥30 tasks created (small samples skew avg)
      const lowPrice = m.avgTaskPriceCents < 1000 && m.tasksCreated >= 30;
      signals.push({
        name: 'LOW_AVG_PRICE',
        triggered: lowPrice,
        detail: `Avg task price: $${(m.avgTaskPriceCents / 100).toFixed(2)} (threshold: $10.00, min sample: 30 created, have: ${m.tasksCreated})`,
      });

      // Kill signal 4: Rising disputes (> 2%)
      // Guard: ≥30 completed tasks (dispute rate meaningless with <30)
      const highDisputes = m.disputeRate > 2.0 && m.tasksCompleted >= 30;
      signals.push({
        name: 'HIGH_DISPUTE_RATE',
        triggered: highDisputes,
        detail: `Dispute rate: ${m.disputeRate}% (threshold: 2.0%, min sample: 30 completed, have: ${m.tasksCompleted})`,
      });

      // Kill signal 5: No subscription upgrades (0 after 100+ tasks)
      // Guard: ≥100 tasks created (subscription value only apparent after
      // users hit enough volume to feel free-tier friction)
      const noUpgrades = m.conversionToPaid === 0 && m.tasksCreated >= 100;
      signals.push({
        name: 'NO_UPGRADES',
        triggered: noUpgrades,
        detail: `Paid conversion: ${m.conversionToPaid}% with ${m.tasksCreated} tasks created (min sample: 100)`,
      });

      // Kill signal 6: Low completion rate (< 50% of created tasks completed)
      // Guard: ≥100 tasks created (early tasks often exploratory/abandoned)
      const completionRate = m.tasksCreated > 0
        ? (m.tasksCompleted / m.tasksCreated) * 100
        : 100;
      const lowCompletion = completionRate < 50 && m.tasksCreated >= 100;
      signals.push({
        name: 'LOW_COMPLETION',
        triggered: lowCompletion,
        detail: `Completion rate: ${Math.round(completionRate)}% (threshold: 50%, min sample: 100 created, have: ${m.tasksCreated})`,
      });

      // Kill = 3+ signals triggered simultaneously
      const triggeredCount = signals.filter(s => s.triggered).length;

      return {
        success: true,
        data: {
          signals,
          shouldKill: triggeredCount >= 3,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'KILL_SIGNALS_FAILED',
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      };
    }
  },
  // ==========================================================================
  // KILL SWITCH AUDIT LOGGING
  // ==========================================================================

  /**
   * Log a beta state change to the admin audit table.
   * Called on:
   *   - Server startup (records current beta state)
   *   - Admin toggle of kill switch
   *
   * Uses admin_actions table (append-only) for full audit trail.
   */
  logBetaStateChange: async (
    adminUserId: string,
    action: 'BETA_ENABLED' | 'BETA_DISABLED' | 'BETA_STATE_STARTUP',
    details: Record<string, unknown> = {}
  ): Promise<void> => {
    try {
      await db.query(
        `INSERT INTO admin_actions (admin_user_id, admin_role, action_type, action_details, result)
         VALUES ($1, 'admin', $2, $3, 'logged')`,
        [
          adminUserId,
          action,
          JSON.stringify({
            betaEnabled: config.beta.enabled,
            region: config.beta.regionName,
            bounds: config.beta.bounds,
            maxUsers: config.beta.maxUsers,
            maxTasks: config.beta.maxTasks,
            maxGmvCents: config.beta.maxGmvCents,
            startDate: config.beta.startDate,
            endDate: config.beta.endDate,
            timestamp: new Date().toISOString(),
            ...details,
          }),
        ]
      );
    } catch (error) {
      // Audit log failure is non-fatal but should be visible
      console.error('⚠️  Failed to log beta state change:', error instanceof Error ? error.message : error);
    }
  },

  /**
   * Log beta state on server startup.
   * Call this from the main server entry point.
   */
  logStartupState: async (): Promise<void> => {
    try {
      // Use a system user ID for startup events
      // If no admin exists yet, use a well-known system UUID
      const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';
      await BetaService.logBetaStateChange(SYSTEM_USER_ID, 'BETA_STATE_STARTUP', {
        serverStartedAt: new Date().toISOString(),
        nodeEnv: process.env.NODE_ENV || 'development',
      });
      console.log(`📍 Beta state logged: enabled=${config.beta.enabled}, region=${config.beta.regionName}`);
    } catch {
      // Silent on startup — admin_actions table may not exist yet
    }
  },
};

export default BetaService;
