/**
 * Incidents Router v1.0.0
 *
 * Admin-only tRPC procedures for incident management:
 * - incidents.list: Query with filtering
 * - incidents.get: Full detail with diagnosis
 * - incidents.resolve: Mark resolved
 * - incidents.diagnose: Trigger AI diagnosis
 *
 * @see backend/src/services/AnomalyDetectionService.ts
 * @see backend/src/services/IncidentDiagnosisService.ts
 */

import { z } from 'zod';
import { router, protectedProcedure } from '../trpc';
import { db } from '../db';
import { IncidentDiagnosisService } from '../services/IncidentDiagnosisService';

export const incidentsRouter = router({
  /**
   * List incidents with filtering
   */
  list: protectedProcedure
    .input(z.object({
      eventType: z.enum(['error_spike', 'latency_spike', 'circuit_breaker_open', 'budget_threshold', 'anomaly_detected', 'manual_report']).optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      service: z.string().optional(),
      resolved: z.boolean().optional(),
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (input.eventType) {
        conditions.push(`event_type = $${paramIndex++}`);
        params.push(input.eventType);
      }

      if (input.severity) {
        conditions.push(`severity = $${paramIndex++}`);
        params.push(input.severity);
      }

      if (input.service) {
        conditions.push(`service = $${paramIndex++}`);
        params.push(input.service);
      }

      if (input.resolved !== undefined) {
        conditions.push(input.resolved ? 'resolved_at IS NOT NULL' : 'resolved_at IS NULL');
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await db.query(
        `SELECT id, event_type, severity, service, details, diagnosis, resolved_at, created_at
         FROM incident_events
         ${whereClause}
         ORDER BY created_at DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
        [...params, input.limit, input.offset]
      );

      return result.rows;
    }),

  /**
   * Get incident by ID
   */
  get: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      const result = await db.query(
        `SELECT id, event_type, severity, service, details, diagnosis, resolved_at, created_at, updated_at
         FROM incident_events
         WHERE id = $1`,
        [input.id]
      );

      if (result.rowCount === 0) {
        throw new Error('Incident not found');
      }

      return result.rows[0];
    }),

  /**
   * Resolve incident
   */
  resolve: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const result = await db.query(
        `UPDATE incident_events
         SET resolved_at = NOW(),
             details = jsonb_set(details, '{resolution_notes}', $2::jsonb)
         WHERE id = $1
         RETURNING id, event_type, severity, service, resolved_at`,
        [input.id, JSON.stringify(input.notes || 'Resolved')]
      );

      if (result.rowCount === 0) {
        throw new Error('Incident not found');
      }

      return result.rows[0];
    }),

  /**
   * Trigger AI diagnosis
   */
  diagnose: protectedProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .mutation(async ({ input }) => {
      const diagnosisResult = await IncidentDiagnosisService.diagnoseIncident(input.id);

      if (!diagnosisResult.success) {
        throw new Error(diagnosisResult.error?.message || 'Diagnosis failed');
      }

      return diagnosisResult.data;
    }),

  /**
   * Get incident statistics
   */
  stats: protectedProcedure
    .input(z.object({
      timeRange: z.enum(['24h', '7d', '30d']).default('24h'),
    }))
    .query(async ({ input }) => {
      const interval = input.timeRange === '24h' ? '1 day' : input.timeRange === '7d' ? '7 days' : '30 days';

      const result = await db.query(
        `SELECT
           COUNT(*) as total,
           COUNT(*) FILTER (WHERE severity = 'critical') as critical_count,
           COUNT(*) FILTER (WHERE severity = 'warning') as warning_count,
           COUNT(*) FILTER (WHERE severity = 'info') as info_count,
           COUNT(*) FILTER (WHERE resolved_at IS NOT NULL) as resolved_count,
           AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))) FILTER (WHERE resolved_at IS NOT NULL) as avg_resolution_time_seconds
         FROM incident_events
         WHERE created_at >= NOW() - $1::interval`,
        [interval]
      );

      return result.rows[0];
    }),
});

export default incidentsRouter;
