import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { checkRateLimit } from '../cache/redis.js';
import { db } from '../db.js';
import { IncidentDiagnosisService } from '../services/IncidentDiagnosisService.js';
import { safetyAdminProcedure } from '../trpc.js';

function incidentListQuery(input: {
  eventType?: string;
  severity?: string;
  service?: string;
  resolved?: boolean;
  limit: number;
  offset: number;
}) {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.eventType) {
    params.push(input.eventType);
    conditions.push(`event_type = $${params.length}`);
  }
  if (input.severity) {
    params.push(input.severity);
    conditions.push(`severity = $${params.length}`);
  }
  if (input.service) {
    params.push(input.service);
    conditions.push(`service = $${params.length}`);
  }
  if (input.resolved !== undefined) {
    conditions.push(input.resolved ? 'resolved_at IS NOT NULL' : 'resolved_at IS NULL');
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(input.limit, input.offset);
  return {
    sql: `SELECT id, event_type, severity, service, details, diagnosis, resolved_at, created_at
          FROM incident_events
          ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  };
}

export const incidentAdminProcedures = {
  list: safetyAdminProcedure
    .input(z.object({
      eventType: z.enum([
        'error_spike',
        'latency_spike',
        'circuit_breaker_open',
        'budget_threshold',
        'anomaly_detected',
        'manual_report',
      ]).optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      service: z.string().optional(),
      resolved: z.boolean().optional(),
      limit: z.number().min(1).max(100).default(50),
      offset: z.number().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const query = incidentListQuery(input);
      const result = await db.query(query.sql, query.params);
      return result.rows;
    }),

  get: safetyAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const result = await db.query(
        `SELECT id, event_type, severity, service, details, diagnosis, resolved_at, created_at, updated_at
         FROM incident_events
         WHERE id = $1`,
        [input.id],
      );
      if (result.rowCount === 0) throw new Error('Incident not found');
      return result.rows[0];
    }),

  resolve: safetyAdminProcedure
    .input(z.object({ id: z.string().uuid(), notes: z.string().optional() }))
    .mutation(async ({ input }) => {
      const existing = await db.query<{
        event_type: string;
        service: string;
        safety_incident_id: string | null;
      }>(
        `SELECT event_type, service, details->>'safety_incident_id' AS safety_incident_id
           FROM incident_events
          WHERE id = $1`,
        [input.id],
      );
      if (existing.rowCount === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Incident not found' });
      }
      const incident = existing.rows[0]!;
      if (incident.event_type === 'manual_report'
          && incident.service === 'trust_safety'
          && incident.safety_incident_id) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Resolve this safety report through the canonical safety case workflow.',
        });
      }
      const result = await db.query(
        `UPDATE incident_events
         SET resolved_at = NOW(),
             details = jsonb_set(details, '{resolution_notes}', $2::jsonb)
         WHERE id = $1
         RETURNING id, event_type, severity, service, resolved_at`,
        [input.id, JSON.stringify(input.notes || 'Resolved')],
      );
      if (result.rowCount === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Incident not found' });
      }
      return result.rows[0];
    }),

  diagnose: safetyAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rateLimit = await checkRateLimit(ctx.user.id, 'incident_diagnose', 20, 60);
      if (!rateLimit.allowed) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'Diagnosis rate limit exceeded. Maximum 20 diagnoses per minute.',
        });
      }
      const result = await IncidentDiagnosisService.diagnoseIncident(input.id);
      if (!result.success) throw new Error(result.error?.message || 'Diagnosis failed');
      return result.data;
    }),

  stats: safetyAdminProcedure
    .input(z.object({ timeRange: z.enum(['24h', '7d', '30d']).default('24h') }))
    .query(async ({ input }) => {
      const interval = input.timeRange === '24h'
        ? '1 day'
        : input.timeRange === '7d' ? '7 days' : '30 days';
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
        [interval],
      );
      return result.rows[0];
    }),
};
