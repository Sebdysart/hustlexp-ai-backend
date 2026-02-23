/**
 * Incidents Router v1.0.0
 *
 * Admin-only tRPC procedures for incident management.
 * List, inspect, and resolve incidents detected by AnomalyDetectionService.
 *
 * @see AnomalyDetectionService
 * @see migrations/20260222_008_incident_events.sql
 */

import { TRPCError } from '@trpc/server';
import { router, adminProcedure } from '../trpc';
import { db } from '../db';
import { z } from 'zod';

// ============================================================================
// ROUTER
// ============================================================================

export const incidentsRouter = router({
  /**
   * List incidents with optional filters
   */
  list: adminProcedure
    .input(z.object({
      eventType: z.string().max(50).optional(),
      severity: z.enum(['info', 'warning', 'critical']).optional(),
      resolved: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (input.eventType) {
        conditions.push(`event_type = $${paramIndex}`);
        params.push(input.eventType);
        paramIndex++;
      }

      if (input.severity) {
        conditions.push(`severity = $${paramIndex}`);
        params.push(input.severity);
        paramIndex++;
      }

      if (input.resolved === true) {
        conditions.push('resolved_at IS NOT NULL');
      } else if (input.resolved === false) {
        conditions.push('resolved_at IS NULL');
      }

      params.push(input.limit, input.offset);

      const result = await db.readQuery<{
        id: string;
        event_type: string;
        severity: string;
        service: string;
        details: Record<string, unknown>;
        diagnosis: Record<string, unknown> | null;
        resolved_at: string | null;
        resolved_by: string | null;
        resolution_notes: string | null;
        created_at: string;
      }>(
        `SELECT id, event_type, severity, service, details, diagnosis,
                resolved_at, resolved_by, resolution_notes, created_at
         FROM incident_events
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        params
      );

      const countResult = await db.readQuery<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM incident_events WHERE ${conditions.join(' AND ')}`,
        params.slice(0, -2)
      );

      return {
        incidents: result.rows,
        total: parseInt(countResult.rows[0]?.count || '0', 10),
      };
    }),

  /**
   * Get a single incident by ID
   */
  get: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
    }))
    .query(async ({ input }) => {
      const result = await db.readQuery<{
        id: string;
        event_type: string;
        severity: string;
        service: string;
        details: Record<string, unknown>;
        diagnosis: Record<string, unknown> | null;
        resolved_at: string | null;
        resolved_by: string | null;
        resolution_notes: string | null;
        created_at: string;
      }>(
        `SELECT id, event_type, severity, service, details, diagnosis,
                resolved_at, resolved_by, resolution_notes, created_at
         FROM incident_events WHERE id = $1`,
        [input.id]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Incident not found' });
      }

      return result.rows[0];
    }),

  /**
   * Resolve an incident with notes
   */
  resolve: adminProcedure
    .input(z.object({
      id: z.string().uuid(),
      notes: z.string().min(1).max(2000),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query<{
        id: string;
        resolved_at: string;
        resolved_by: string;
      }>(
        `UPDATE incident_events
         SET resolved_at = NOW(), resolved_by = $1, resolution_notes = $2
         WHERE id = $3 AND resolved_at IS NULL
         RETURNING id, resolved_at, resolved_by`,
        [ctx.user.id, input.notes, input.id]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Incident not found or already resolved',
        });
      }

      return result.rows[0];
    }),
});

export type IncidentsRouter = typeof incidentsRouter;
