/**
 * Health Router v1.0.0
 * 
 * System health and status endpoints
 */

import { router, publicProcedure } from '../trpc';
import { db } from '../db';
import { config } from '../config';
import { StripeService } from '../services/StripeService';

export const healthRouter = router({
  /**
   * Basic health check
   */
  ping: publicProcedure
    .query(() => ({ status: 'ok', timestamp: new Date().toISOString() })),
  
  /**
   * Full system health check
   */
  status: publicProcedure
    .query(async () => {
      const dbHealth = await db.healthCheck();
      
      return {
        status: dbHealth.connected ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        services: {
          database: {
            connected: dbHealth.connected,
            schemaVersion: dbHealth.schemaVersion,
            latencyMs: dbHealth.latencyMs,
          },
          stripe: {
            configured: StripeService.isConfigured(),
          },
          firebase: {
            configured: !!config.firebase.projectId,
          },
          redis: {
            configured: !!config.redis.url,
          },
        },
        environment: config.app.env,
      };
    }),
  
  /**
   * Database schema verification
   */
  verifySchema: publicProcedure
    .query(async () => {
      const health = await db.healthCheck();
      
      if (!health.connected) {
        return {
          valid: false,
          error: 'Database not connected',
        };
      }
      
      // Verify expected tables exist (constitutional schema v1.1.0: 33 total = 1 schema_versions + 32 domain tables)
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables 
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
         ORDER BY table_name`
      );
      
      // Expected tables from constitutional schema v1.1.0 (33 total)
      const expectedTables = [
        // Schema version tracking
        'schema_versions',
        // Core domain tables (18)
        'users',
        'tasks',
        'escrows',
        'proofs',
        'proof_photos',
        'xp_ledger',
        'trust_ledger',
        'badges',
        'disputes',
        'stripe_events',
        'ai_events',
        'ai_jobs',
        'ai_proposals',
        'ai_decisions',
        'evidence',
        'admin_roles',
        'admin_actions',
        'live_sessions',
        'live_broadcasts',
        'poster_ratings',
        'session_forecasts',
        // Critical gap tables (14) - Phase 0 additions
        'task_matching_scores',
        'saved_searches',
        'task_messages',
        'notifications',
        'notification_preferences',
        'task_ratings',
        'analytics_events',
        'fraud_risk_scores',
        'fraud_patterns',
        'content_moderation_queue',
        'content_reports',
        'content_appeals',
        'gdpr_data_requests',
        'user_consents',
      ];
      
      const actualTables = tables.rows.map(r => r.table_name);
      const missingTables = expectedTables.filter(t => !actualTables.includes(t));
      
      // Verify triggers exist (constitutional schema v1.1.0)
      const triggers = await db.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname`
      );
      
      const expectedTriggers = [
        'task_terminal_guard',
        'escrow_terminal_guard',
        'escrow_amount_immutable',
        'xp_requires_released_escrow',
        'xp_ledger_no_delete',
        'badge_no_delete',
        'escrow_released_requires_completed_task',
        'task_completed_requires_accepted_proof',
        'trust_tier_audit',
        'admin_actions_no_delete',
        'live_task_escrow_check',
        'live_task_price_check',
        'users_updated_at',
        'tasks_updated_at',
        'escrows_updated_at',
        'proofs_updated_at',
        'disputes_updated_at',
        'ai_jobs_updated_at',
        'evidence_updated_at',
      ];
      
      const actualTriggers = triggers.rows.map(r => r.tgname);
      const missingTriggers = expectedTriggers.filter(t => !actualTriggers.includes(t));
      
      // Also check for views (constitutional schema v1.1.0: 3 views)
      const views = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.views 
         WHERE table_schema = 'public' ORDER BY table_name`
      );
      
      const expectedViews = [
        'poster_reputation',      // Section 10.7.4 - Poster reputation view
        'money_timeline',         // Section 10.7.6 - Money timeline view
        'user_rating_summary',    // Section 11.5 - User rating summary view
      ];
      
      const actualViews = views.rows.map(r => r.table_name);
      const missingViews = expectedViews.filter(v => !actualViews.includes(v));
      
      return {
        valid: missingTables.length === 0 && missingTriggers.length === 0 && missingViews.length === 0,
        schemaVersion: health.schemaVersion || 'unknown',
        tables: {
          expected: expectedTables.length, // 33 total
          actual: actualTables.length,
          missing: missingTables,
        },
        triggers: {
          expected: expectedTriggers.length, // 19 total
          actual: actualTriggers.length,
          missing: missingTriggers,
        },
        views: {
          expected: expectedViews.length, // 3 total
          actual: actualViews.length,
          missing: missingViews,
        },
      };
    }),
});

export type HealthRouter = typeof healthRouter;
