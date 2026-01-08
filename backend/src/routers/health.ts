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
      
      // Verify expected tables exist
      const tables = await db.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables 
         WHERE table_schema = 'public' ORDER BY table_name`
      );
      
      const expectedTables = [
        'admin_actions', 'admin_roles', 'ai_decisions', 'ai_events', 
        'ai_jobs', 'ai_proposals', 'badges', 'disputes', 'escrows',
        'evidence', 'processed_stripe_events', 'proof_photos', 'proofs',
        'schema_versions', 'tasks', 'trust_ledger', 'users', 'xp_ledger'
      ];
      
      const actualTables = tables.rows.map(r => r.table_name);
      const missingTables = expectedTables.filter(t => !actualTables.includes(t));
      
      // Verify triggers exist
      const triggers = await db.query<{ tgname: string }>(
        `SELECT tgname FROM pg_trigger WHERE NOT tgisinternal`
      );
      
      const expectedTriggers = [
        'xp_requires_released_escrow',
        'escrow_released_requires_completed_task',
        'task_completed_requires_accepted_proof',
        'escrow_amount_immutable',
        'task_terminal_guard',
        'escrow_terminal_guard',
        'xp_ledger_no_delete',
        'badge_no_delete',
      ];
      
      const actualTriggers = triggers.rows.map(r => r.tgname);
      const missingTriggers = expectedTriggers.filter(t => !actualTriggers.includes(t));
      
      return {
        valid: missingTables.length === 0 && missingTriggers.length === 0,
        schemaVersion: health.schemaVersion,
        tables: {
          expected: expectedTables.length,
          actual: actualTables.length,
          missing: missingTables,
        },
        triggers: {
          expected: expectedTriggers.length,
          actual: actualTriggers.length,
          missing: missingTriggers,
        },
      };
    }),
});

export type HealthRouter = typeof healthRouter;
