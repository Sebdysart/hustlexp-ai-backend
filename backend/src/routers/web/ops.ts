/**
 * Ops Router
 *
 * Replaces Supabase edge functions:
 *   task-admin, task-quote-admin, supply-admin (hustler roster + skills)
 *
 * Read procedures require a named Firebase operator whose current role grants
 * can_manage_operations. Broad historical direct writes remain held; the only
 * write rail here is stepped-up, versioned, audited, and two-person.
 */

import { z } from 'zod';
import {
  heldOperationsAdminProcedure,
  operationsAdminProcedure,
  operationsStepUpProcedure,
  publicProcedure,
  router,
} from '../../trpc.js';
import { db } from '../../db.js';
import { TRPCError } from '@trpc/server';
import { AutomationLifecycleService } from '../../services/AutomationLifecycleService.js';
import { OperatorAuthorityService } from '../../services/OperatorAuthorityService.js';

const LEGACY_MUTATION_HELD_MESSAGE =
  'Legacy Operations writes are held. Use a separately approved, versioned two-person command path.';

function holdLegacyMutation(): never {
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: LEGACY_MUTATION_HELD_MESSAGE });
}

const UpsertHustlerSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  home_zip: z.string().optional(),
  radius_miles: z.number().optional(),
  vehicle: z.string().default('none'),
  max_lift_lbs: z.number().optional(),
  status: z.string().default('new_applicant'),
  available: z.boolean().default(true),
  availability_note: z.string().optional(),
  notes: z.string().optional(),
  skills: z.array(z.string()).default([]),
});

export const webOpsRouter = router({

  // ── Canonical engine lifecycle (E1) ────────────────────────────────────────

  listEngineTasks: operationsAdminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      cursor: z.string().max(512).nullish(),
    }))
    .query(async ({ input }) => {
      const result = await AutomationLifecycleService.listTasks({
        limit: input.limit,
        cursor: input.cursor,
      });
      if (!result.success) {
        throw new TRPCError({
          code: result.error.code === 'INVALID_CURSOR' ? 'BAD_REQUEST' : 'INTERNAL_SERVER_ERROR',
          message: result.error.message,
        });
      }
      return { ok: true, ...result.data };
    }),

  // ── Task Drafts ─────────────────────────────────────────────────────────────

  listTaskDrafts: operationsAdminProcedure
    .input(z.object({
      status: z.string().optional(),
      limit: z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      const conditions = input.status ? `WHERE status = $1` : '';
      const params = input.status ? [input.status, input.limit] : [input.limit];
      const limitIdx = params.length;

      const result = await db.query(
        `SELECT id, submission_id, category, title, scope_summary,
                est_price_min_cents, est_price_max_cents, photo_count,
                zip, region, status, source, lead_id, poster_user_id,
                claimed_at, quote_id, quote_send_ready_at, created_at, updated_at
         FROM task_drafts ${conditions}
         ORDER BY created_at DESC LIMIT $${limitIdx}`,
        params
      );
      return { ok: true, drafts: result.rows };
    }),

  getTaskDraft: operationsAdminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const result = await db.query(
        `SELECT d.*, q.id as quote_id_linked,
                qv.status as quote_status, qv.total_cents
         FROM task_drafts d
         LEFT JOIN quotes q ON q.task_draft_id = d.id
         LEFT JOIN quote_versions qv ON qv.id = q.active_version_id
         WHERE d.id = $1`,
        [input.id]
      );
      if (result.rows.length === 0) throw new TRPCError({ code: 'NOT_FOUND' });
      return { ok: true, draft: result.rows[0] };
    }),

  // ── Quotes ──────────────────────────────────────────────────────────────────

  createQuote: heldOperationsAdminProcedure
    .input(z.object({
      task_draft_id: z.string().uuid(),
      customer_description: z.string().min(1),
      subtotal_cents: z.number().min(0),
      service_fee_cents: z.number().min(0).default(0),
      materials_cents: z.number().min(0).default(0),
      discount_cents: z.number().min(0).default(0),
      internal_notes: z.string().optional(),
      minimum_acceptable_price_cents: z.number().optional(),
      hustler_payout_cents: z.number().optional(),
      scope_json: z.record(z.unknown()).default({}),
    }))
    .mutation(holdLegacyMutation),

  markQuoteSendReady: heldOperationsAdminProcedure
    .input(z.object({ task_draft_id: z.string().uuid() }))
    .mutation(holdLegacyMutation),

  // ── Hustler roster ──────────────────────────────────────────────────────────

  listHustlers: operationsAdminProcedure
    .input(z.object({
      status: z.string().optional(),
      available: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (input.status) conditions.push(`status = $${params.push(input.status)}`);
      if (input.available !== undefined) conditions.push(`available = $${params.push(input.available)}`);

      // leads.skills is a text[] column — no join needed
      const baseWhere = conditions.length
        ? `WHERE lead_type = 'hustler' AND ${conditions.join(' AND ')}`
        : `WHERE lead_type = 'hustler'`;

      const result = await db.query(
        `SELECT id, name, phone, email, home_zip, radius_miles, vehicle,
                max_lift_lbs, trust_tier, checkr_status, status, available,
                availability_note, completed_jobs, cancel_count, rating_avg,
                response_minutes, notes, skills, user_id, created_at, updated_at
         FROM leads ${baseWhere}
         ORDER BY created_at DESC`,
        params
      );
      return { ok: true, hustlers: result.rows };
    }),

  upsertHustler: heldOperationsAdminProcedure
    .input(UpsertHustlerSchema)
    .mutation(holdLegacyMutation),

  // ── Feature flags ────────────────────────────────────────────────────────────

  getPublicFlags: publicProcedure
    .input(z.object({}).optional())
    .query(async () => {
      const result = await db.query<{ key: string; enabled: boolean; version: number }>(
        `SELECT name AS key, enabled, version FROM feature_flags ORDER BY name`
      );
      return result.rows;
    }),

  listFeatureFlagTargets: operationsStepUpProcedure
    .input(z.object({}))
    .query(async () => {
      const result = await db.query<{ key: string; enabled: boolean; version: number }>(
        `SELECT name AS key, enabled, version
           FROM feature_flags
          ORDER BY name`,
      );
      return { flags: result.rows };
    }),

  updateFlag: operationsStepUpProcedure
    .input(z.object({
      key: z.string(),
      enabled: z.literal(false),
      expectedVersion: z.number().int().positive(),
      idempotencyKey: z.string().uuid(),
      reason: z.string().trim().min(10).max(500),
    }))
    .mutation(({ ctx, input }) => OperatorAuthorityService.request(ctx, {
      operationType: 'DISABLE_FEATURE_FLAG',
      targetId: input.key,
      targetExpectedVersion: input.expectedVersion,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    })),

  listPendingCommands: operationsStepUpProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .query(({ ctx, input }) => OperatorAuthorityService.listPending(ctx, input.limit)),

  listCommandHistory: operationsStepUpProcedure
    .input(z.object({ limit: z.number().int().min(1).max(100).default(50) }))
    .query(({ ctx, input }) => OperatorAuthorityService.listHistory(ctx, input.limit)),

  approveCommand: operationsStepUpProcedure
    .input(z.object({
      commandId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      idempotencyKey: z.string().uuid(),
      reason: z.string().trim().min(10).max(500),
    }))
    .mutation(({ ctx, input }) => OperatorAuthorityService.approve(ctx, {
      commandId: input.commandId,
      expectedCommandVersion: input.expectedVersion,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    })),

  rejectCommand: operationsStepUpProcedure
    .input(z.object({
      commandId: z.string().uuid(),
      expectedVersion: z.number().int().positive(),
      idempotencyKey: z.string().uuid(),
      reason: z.string().trim().min(10).max(500),
    }))
    .mutation(({ ctx, input }) => OperatorAuthorityService.reject(ctx, {
      commandId: input.commandId,
      expectedCommandVersion: input.expectedVersion,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
    })),
});
