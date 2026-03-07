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
import { router, protectedProcedure, adminProcedure } from '../trpc';
import { db } from '../db';
import { IncidentDiagnosisService } from '../services/IncidentDiagnosisService';

export const incidentsRouter = router({
  /**
   * List incidents with filtering
   */
  list: adminProcedure
    .input(z.object({
      eventType: z.enum(['error_spike', 'latency_spike', 'circuit_breaker_open', 'budget_threshold', 'anomaly_detected', 'manual_report']).optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      service: z.string().optional(),
      resolved: z.boolean().optional(),
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (input.eventType) {
        const idx = params.push(input.eventType);
        conditions.push(`event_type = $${idx}`);
      }

      if (input.severity) {
        const idx = params.push(input.severity);
        conditions.push(`severity = $${idx}`);
      }

      if (input.service) {
        const idx = params.push(input.service);
        conditions.push(`service = $${idx}`);
      }

      if (input.resolved !== undefined) {
        conditions.push(input.resolved ? 'resolved_at IS NOT NULL' : 'resolved_at IS NULL');
      }

      if (input.cursor) {
        const idx = params.push(input.cursor);
        conditions.push(`id > $${idx}`);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limitIdx = params.push(input.limit + 1);

      const result = await db.query<{
        id: string;
        event_type: string;
        severity: string;
        service: string;
        details: unknown;
        diagnosis: Record<string, unknown> | null;
        resolved_at: Date | null;
        created_at: Date;
      }>(
        `SELECT id, event_type, severity, service, details, diagnosis, resolved_at, created_at
         FROM incident_events
         ${whereClause}
         ORDER BY id ASC
         LIMIT $${limitIdx}`,
        params
      );

      const rows = result.rows;
      const hasMore = rows.length > input.limit;
      const page = hasMore ? rows.slice(0, input.limit) : rows;
      const nextCursor = hasMore ? page[page.length - 1].id : null;

      return {
        items: page,
        nextCursor,
      };
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
