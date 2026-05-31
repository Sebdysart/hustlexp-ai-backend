/**
 * Admin Dashboard Router v1.0.0
 *
 * CONSTITUTIONAL: Admin-only endpoints for platform management.
 *
 * All procedures use adminProcedure (requires admin_roles table entry).
 *
 * Handles:
 * - User management (list, ban/unban)
 * - Task & dispute listing
 * - Revenue breakdown
 * - AI cost summary
 * - Escrow override
 *
 * @see ARCHITECTURE.md §1
 */

import { TRPCError } from '@trpc/server';
import { router, adminProcedure, Schemas, invalidateAuthCacheForUser } from '../trpc.js';
import { db } from '../db.js';
import { z } from 'zod';
import { EscrowService } from '../services/EscrowService.js';
import { ComplianceGuardianService } from '../services/ComplianceGuardianService.js';
import { TEMPLATE_SLUGS } from '../services/TaskTemplateRegistry.js';
import { forceDisconnectUser } from '../realtime/connection-registry.js';

// ============================================================================
// BUSINESS LEAD REVIEW (Roadmap E4) — admin-only review queue constants
// ============================================================================

// Statuses an admin may *set* via reviewBusinessLead. Deliberately excludes
// 'NEW' (intake-only) and 'CONVERTED' (E5 — account creation, out of scope).
const BUSINESS_LEAD_REVIEW_STATUSES = ['REVIEWED', 'APPROVED', 'REJECTED'] as const;

// Full lifecycle set, used only to validate the list filter input.
const BUSINESS_LEAD_STATUSES = ['NEW', 'REVIEWED', 'APPROVED', 'REJECTED', 'CONVERTED'] as const;

// approvedTemplates must be known task-template slugs (TaskTemplateRegistry).
const TEMPLATE_SLUG_VALUES = Object.values(TEMPLATE_SLUGS) as [string, ...string[]];

// ============================================================================
// ROUTER
// ============================================================================

export const adminRouter = router({
  // --------------------------------------------------------------------------
  // USER MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * List users with pagination and optional filters
   */
  listUsers: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      search: z.string().max(255).optional(),
      trustTier: z.string().max(20).optional(),
      isBanned: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (input.search) {
        // Escape LIKE metacharacters so user input cannot craft wildcard patterns.
        const safeLike = input.search.replace(/%/g, '\\%').replace(/_/g, '\\_');
        conditions.push(`(u.full_name ILIKE $${paramIndex} OR u.email ILIKE $${paramIndex})`);
        params.push(`%${safeLike}%`);
        paramIndex++;
      }

      if (input.trustTier) {
        conditions.push(`u.trust_tier = $${paramIndex}`);
        params.push(input.trustTier);
        paramIndex++;
      }

      if (input.isBanned !== undefined) {
        conditions.push(`u.is_banned = $${paramIndex}`);
        params.push(input.isBanned);
        paramIndex++;
      }

      params.push(input.limit, input.offset);

      const result = await db.query<{
        id: string;
        full_name: string;
        email: string;
        trust_tier: string;
        xp_total: number;
        is_verified: boolean;
        is_banned: boolean;
        default_mode: string;
        created_at: Date;
      }>(
        `SELECT u.id, u.full_name, u.email, u.trust_tier, u.xp_total,
                u.is_verified, COALESCE(u.is_banned, false) as is_banned, u.default_mode, u.created_at
         FROM users u
         WHERE ${conditions.join(' AND ')}
         ORDER BY u.created_at DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        params
      );

      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM users u WHERE ${conditions.join(' AND ')}`,
        params.slice(0, -2) // exclude limit/offset
      );

      return {
        users: result.rows,
        total: parseInt(countResult.rows[0]?.count || '0', 10),
      };
    }),

  /**
   * Ban or unban a user
   */
  setUserBan: adminProcedure
    .input(z.object({
      userId: Schemas.uuid,
      banned: z.boolean(),
      reason: z.string().max(500).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query<{ id: string; is_banned: boolean }>(
        `UPDATE users SET is_banned = $1, updated_at = NOW() WHERE id = $2 RETURNING id, is_banned`,
        [input.banned, input.userId]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      await db.query(
        `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          ctx.user.id,
          input.banned ? 'user_ban' : 'user_unban',
          input.userId,
          input.reason ?? null,
          JSON.stringify({ banned: input.banned }),
        ]
      );

      // Evict any cached auth entries for this user so the ban takes effect
      // immediately rather than waiting up to 5 minutes for the cache TTL to expire.
      invalidateAuthCacheForUser(input.userId);

      // Bug 1 fix: if the user was just banned, immediately close any open SSE
      // connections so the stream does not persist after the ban is applied.
      if (input.banned) {
        forceDisconnectUser(input.userId);

        // FIX: Refund all FUNDED escrows where the banned user is poster or worker,
        // and cancel their OPEN tasks — otherwise workers are left with stranded funds.
        const fundedEscrows = await db.query<{ id: string }>(
          `SELECT e.id FROM escrows e
           JOIN tasks t ON t.id = e.task_id
           WHERE (t.poster_id = $1 OR t.worker_id = $1)
           AND e.state = 'FUNDED'`,
          [input.userId]
        );
        for (const escrow of fundedEscrows.rows) {
          await EscrowService.refund({ escrowId: escrow.id });
        }

        // Cancel any OPEN tasks belonging to the banned user (poster or worker)
        await db.query(
          `UPDATE tasks
           SET state = 'CANCELLED', updated_at = NOW()
           WHERE (poster_id = $1 OR worker_id = $1)
           AND state = 'OPEN'`,
          [input.userId]
        );
      }

      return result.rows[0];
    }),

  // --------------------------------------------------------------------------
  // TASK & DISPUTE LISTING
  // --------------------------------------------------------------------------

  /**
   * List tasks with pagination and optional filters
   */
  listTasks: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      state: z.string().max(30).optional(),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (input.state) {
        conditions.push(`t.state = $${paramIndex}`);
        params.push(input.state);
        paramIndex++;
      }

      params.push(input.limit, input.offset);

      const result = await db.query(
        `SELECT t.id, t.title, t.state, t.price, t.poster_id, t.worker_id, t.created_at,
                p.full_name as poster_name, w.full_name as worker_name
         FROM tasks t
         LEFT JOIN users p ON p.id = t.poster_id
         LEFT JOIN users w ON w.id = t.worker_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY t.created_at DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        params
      );

      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM tasks t WHERE ${conditions.join(' AND ')}`,
        params.slice(0, -2)
      );

      return {
        tasks: result.rows,
        total: parseInt(countResult.rows[0]?.count || '0', 10),
      };
    }),

  /**
   * List disputes with pagination
   */
  listDisputes: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      status: z.string().max(30).optional(),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (input.status) {
        conditions.push(`d.status = $${paramIndex}`);
        params.push(input.status);
        paramIndex++;
      }

      params.push(input.limit, input.offset);

      const result = await db.query(
        `SELECT d.id, d.task_id, d.status, d.reason, d.created_at,
                t.title as task_title
         FROM disputes d
         JOIN tasks t ON t.id = d.task_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY d.created_at DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        params
      );

      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM disputes d WHERE ${conditions.join(' AND ')}`,
        params.slice(0, -2)
      );

      return {
        disputes: result.rows,
        total: parseInt(countResult.rows[0]?.count || '0', 10),
      };
    }),

  // --------------------------------------------------------------------------
  // REVENUE & COSTS
  // --------------------------------------------------------------------------

  /**
   * Revenue breakdown by time period
   */
  revenueBreakdown: adminProcedure
    .input(z.object({
      days: z.number().int().min(1).max(365).default(30),
    }))
    .query(async ({ input }) => {
      const result = await db.query<{
        total_escrow_funded: string;
        total_escrow_released: string;
        total_platform_fees: string;
        task_count: string;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN e.state IN ('FUNDED','RELEASED') THEN e.amount ELSE 0 END), 0)::text as total_escrow_funded,
           COALESCE(SUM(CASE WHEN e.state = 'RELEASED' THEN e.amount ELSE 0 END), 0)::text as total_escrow_released,
           COALESCE(SUM(CASE WHEN e.state = 'RELEASED' THEN e.platform_fee ELSE 0 END), 0)::text as total_platform_fees,
           COUNT(DISTINCT e.task_id)::text as task_count
         FROM escrows e
         WHERE e.created_at >= NOW() - ($1 || ' days')::INTERVAL`,
        [input.days]
      );

      const row = result.rows[0];
      return {
        totalEscrowFunded: parseInt(row.total_escrow_funded, 10),
        totalEscrowReleased: parseInt(row.total_escrow_released, 10),
        totalPlatformFees: parseInt(row.total_platform_fees, 10),
        taskCount: parseInt(row.task_count, 10),
        periodDays: input.days,
      };
    }),

  /**
   * AI cost summary - aggregated AI decision costs
   */
  aiCostSummary: adminProcedure
    .input(z.object({
      days: z.number().int().min(1).max(365).default(30),
    }))
    .query(async ({ input }) => {
      const result = await db.query<{
        total_cost_cents: string;
        total_requests: string;
        avg_cost_cents: string;
        model_breakdown: Record<string, unknown>[];
      }>(
        `SELECT
           COALESCE(SUM(cost_cents), 0)::text as total_cost_cents,
           COUNT(*)::text as total_requests,
           COALESCE(AVG(cost_cents), 0)::text as avg_cost_cents
         FROM ai_decisions
         WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL`,
        [input.days]
      );

      // Model breakdown
      const modelResult = await db.query<{
        model: string;
        request_count: string;
        total_cost: string;
      }>(
        `SELECT
           model,
           COUNT(*)::text as request_count,
           COALESCE(SUM(cost_cents), 0)::text as total_cost
         FROM ai_decisions
         WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
         GROUP BY model
         ORDER BY total_cost DESC`,
        [input.days]
      );

      const row = result.rows[0];
      return {
        totalCostCents: parseInt(row.total_cost_cents, 10),
        totalRequests: parseInt(row.total_requests, 10),
        avgCostCents: parseFloat(row.avg_cost_cents),
        periodDays: input.days,
        modelBreakdown: modelResult.rows.map(m => ({
          model: m.model,
          requestCount: parseInt(m.request_count, 10),
          totalCost: parseInt(m.total_cost, 10),
        })),
      };
    }),

  // --------------------------------------------------------------------------
  // ESCROW OVERRIDE
  // --------------------------------------------------------------------------

  /**
   * Admin override: force release or refund an escrow.
   *
   * v2.9.8 fixes:
   *   - force_release now calls EscrowService.release() with adminOverride=true:
   *       runs full fee/XP/insurance pipeline, skips KYC gate only.
   *   - force_refund now calls EscrowService.refund() (correct state name: LOCKED_DISPUTE).
   *   - Both actions write to admin_actions audit table.
   */
  escrowOverride: adminProcedure
    .input(z.object({
      escrowId: Schemas.uuid,
      action: z.enum(['force_release', 'force_refund']),
      reason: z.string().min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      let serviceResult;

      if (input.action === 'force_release') {
        serviceResult = await EscrowService.release({
          escrowId: input.escrowId,
          adminOverride: true,
          reason: input.reason,
        });
      } else {
        serviceResult = await EscrowService.refund({
          escrowId: input.escrowId,
          adminOverride: true,
          reason: input.reason,
        });
      }

      if (!serviceResult.success) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: serviceResult.error.message,
        });
      }

      await db.query(
        `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          ctx.user.id,
          'escrow_override',
          input.escrowId,
          input.reason,
          JSON.stringify({ override_type: input.action }),
        ]
      );

      return serviceResult.data;
    }),

  // --------------------------------------------------------------------------
  // BUSINESS LEAD REVIEW QUEUE (Roadmap E4)
  // --------------------------------------------------------------------------
  //
  // Admin-only surface over `business_leads` (populated by the public E3
  // `business.submitLead` intake). Scope is deliberately narrow:
  //   - list + filter leads
  //   - mark a lead REVIEWED / APPROVED / REJECTED with admin notes
  //   - optionally record approved task-template slugs
  // It must NOT: create accounts, set CONVERTED (E5), auto-approve, or touch
  // any consumer funnel. Every review writes an admin_actions audit row in the
  // same transaction as the lead update, so a review never commits without its
  // audit record.

  /**
   * List business leads with pagination and optional filters (newest first).
   */
  listBusinessLeads: adminProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(20),
      offset: z.number().int().min(0).default(0),
      status: z.enum(BUSINESS_LEAD_STATUSES).optional(),
      requiresReview: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = ['1=1'];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (input.status) {
        conditions.push(`status = $${paramIndex}`);
        params.push(input.status);
        paramIndex++;
      }

      if (input.requiresReview !== undefined) {
        conditions.push(`requires_review = $${paramIndex}`);
        params.push(input.requiresReview);
        paramIndex++;
      }

      params.push(input.limit, input.offset);

      // Admin-gated surface: contact PII is intentionally returned so an admin
      // can act on the lead. ip_hash and compliance_notes are omitted to keep
      // the list payload lean.
      const result = await db.query(
        `SELECT id, business_name, contact_name, email, phone, business_type, city, zip,
                recurring_task_types, expected_frequency, avg_budget_cents, urgency, notes,
                risk_flags, contact_preference, status, compliance_score, requires_review,
                admin_notes, reviewed_at, reviewed_by, approved_templates, created_at
         FROM business_leads
         WHERE ${conditions.join(' AND ')}
         ORDER BY created_at DESC
         LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
        params
      );

      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM business_leads WHERE ${conditions.join(' AND ')}`,
        params.slice(0, -2)
      );

      return {
        leads: result.rows,
        total: parseInt(countResult.rows[0]?.count || '0', 10),
      };
    }),

  /**
   * Review a business lead: set status (REVIEWED/APPROVED/REJECTED), attach
   * admin notes, optionally record approved template slugs. Stamps reviewed_at
   * and reviewed_by. The lead UPDATE and the admin_actions audit INSERT run in
   * a single transaction — if either fails, neither is applied.
   */
  reviewBusinessLead: adminProcedure
    .input(z.object({
      leadId: Schemas.uuid,
      status: z.enum(BUSINESS_LEAD_REVIEW_STATUSES),
      adminNotes: z.string().max(2000).optional(),
      approvedTemplates: z.array(z.enum(TEMPLATE_SLUG_VALUES)).max(TEMPLATE_SLUG_VALUES.length).optional(),
      override: z.boolean().optional().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      return db.transaction(async (query) => {
        const current = await query<{ id: string; status: string; compliance_score: number | null }>(
          `SELECT id, status, compliance_score FROM business_leads WHERE id = $1 FOR UPDATE`,
          [input.leadId]
        );

        if (current.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Business lead not found' });
        }

        const lead = current.rows[0];

        // E5 guard: a converted lead has graduated past review. Never re-review
        // (and never set CONVERTED here — that transition belongs to E5).
        if (lead.status === 'CONVERTED') {
          throw new TRPCError({
            code: 'CONFLICT',
            message: 'Lead already converted; cannot re-review in E4',
          });
        }

        // Compliance guard: approving a compliance-flagged lead requires an
        // explicit override. Reuses the ComplianceGuardianService threshold
        // (score >= 21 => soft_flag) rather than a magic number. Hard-block
        // leads were never inserted by E3, so this gates soft-flag approvals.
        if (input.status === 'APPROVED') {
          const tier = ComplianceGuardianService._scoreTotier(lead.compliance_score ?? 0);
          if (tier !== 'clean' && !input.override) {
            throw new TRPCError({
              code: 'PRECONDITION_FAILED',
              message: 'Lead is compliance-flagged; pass override:true to approve',
            });
          }
        }

        const updated = await query<{
          id: string;
          status: string;
          reviewed_at: Date;
          reviewed_by: string;
          approved_templates: unknown;
          admin_notes: string | null;
        }>(
          `UPDATE business_leads
              SET status = $1,
                  admin_notes = $2,
                  approved_templates = COALESCE($3::jsonb, approved_templates),
                  reviewed_at = NOW(),
                  reviewed_by = $4,
                  updated_at = NOW()
            WHERE id = $5
            RETURNING id, status, reviewed_at, reviewed_by, approved_templates, admin_notes`,
          [
            input.status,
            input.adminNotes ?? null,
            input.approvedTemplates ? JSON.stringify(input.approvedTemplates) : null,
            ctx.user.id,
            input.leadId,
          ]
        );

        // Audit row — live-valid admin_actions shape (admin_user_id, admin_role,
        // action_type, action_details, result). The lead id lives in
        // action_details because target_user_id FKs to users(id), not leads.
        await query(
          `INSERT INTO admin_actions (admin_user_id, admin_role, action_type, action_details, result)
           VALUES ($1, 'admin', 'business_lead_review', $2::jsonb, 'success')`,
          [
            ctx.user.id,
            JSON.stringify({
              leadId: input.leadId,
              status: input.status,
              approvedTemplates: input.approvedTemplates ?? null,
              override: input.override,
              hadAdminNotes: Boolean(input.adminNotes),
            }),
          ]
        );

        return updated.rows[0];
      });
    }),
});

export type AdminRouter = typeof adminRouter;
