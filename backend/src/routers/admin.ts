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
import { router, adminProcedure, Schemas } from '../trpc';
import { db } from '../db';
import { z } from 'zod';

// ============================================================================
// ROUTER
// ============================================================================

export const adminRouter = router({
  // --------------------------------------------------------------------------
  // USER MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * List users with cursor-based pagination and optional filters.
   *
   * Returns { items, nextCursor } where nextCursor is the id of the last
   * item on the current page, or null when there are no more pages.
   * Pass nextCursor as `cursor` on the next call to advance the page.
   */
  listUsers: adminProcedure
    .input(z.object({
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      role: z.enum(['hustler', 'poster', 'admin']).optional(),
      search: z.string().max(255).optional(),
      trustTier: z.string().max(20).optional(),
      isBanned: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      const { cursor, limit, role, search, trustTier, isBanned } = input;
      const conditions: string[] = [];
      const params: unknown[] = [limit + 1]; // $1 = fetch limit+1 to detect next page

      if (cursor) {
        conditions.push(`u.id > $${params.push(cursor)}`);
      }
      if (role) {
        conditions.push(`u.role = $${params.push(role)}`);
      }
      if (search) {
        const searchParam = `%${search}%`;
        const searchIdx = params.push(searchParam); // push once, capture index
        conditions.push(`(u.email ILIKE $${searchIdx} OR u.full_name ILIKE $${searchIdx})`);
      }
      if (trustTier) {
        conditions.push(`u.trust_tier = $${params.push(trustTier)}`);
      }
      if (isBanned !== undefined) {
        conditions.push(`u.is_banned = $${params.push(isBanned)}`);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
        stripe_connect_id: string | null;
      }>(
        `SELECT u.id, u.full_name, u.email, u.trust_tier, u.xp_total,
                u.is_verified, COALESCE(u.is_banned, false) AS is_banned,
                u.default_mode, u.created_at, u.stripe_connect_id
         FROM users u
         ${whereClause}
         ORDER BY u.id ASC
         LIMIT $1`,
        params
      );

      const items = result.rows.slice(0, limit);
      const nextCursor =
        result.rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;

      return { items, nextCursor };
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
    .mutation(async ({ input }) => {
      const result = await db.query<{ id: string; is_banned: boolean }>(
        `UPDATE users SET is_banned = $1, updated_at = NOW() WHERE id = $2 RETURNING id, is_banned`,
        [input.banned, input.userId]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      return result.rows[0];
    }),

  // --------------------------------------------------------------------------
  // TASK & DISPUTE LISTING
  // --------------------------------------------------------------------------

  /**
   * List tasks with cursor-based pagination and optional filters.
   *
   * Returns { items, nextCursor } where nextCursor is the id of the last
   * item on the current page, or null when there are no more pages.
   * Pass nextCursor as `cursor` on the next call to advance the page.
   */
  listTasks: adminProcedure
    .input(z.object({
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      state: z.string().max(30).optional(),
    }))
    .query(async ({ input }) => {
      const { cursor, limit, state } = input;
      const conditions: string[] = [];
      const params: unknown[] = [limit + 1]; // $1 = fetch limit+1 to detect next page

      if (cursor) {
        conditions.push(`t.id > $${params.push(cursor)}`);
      }
      if (state) {
        conditions.push(`t.state = $${params.push(state)}`);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await db.query<{
        id: string;
        title: string;
        state: string;
        price: number;
        poster_id: string;
        worker_id: string | null;
        created_at: Date;
        poster_name: string | null;
        worker_name: string | null;
      }>(
        `SELECT t.id, t.title, t.state, t.price, t.poster_id, t.worker_id, t.created_at,
                p.full_name as poster_name, w.full_name as worker_name
         FROM tasks t
         LEFT JOIN users p ON p.id = t.poster_id
         LEFT JOIN users w ON w.id = t.worker_id
         ${whereClause}
         ORDER BY t.id ASC
         LIMIT $1`,
        params
      );

      const items = result.rows.slice(0, limit);
      const nextCursor =
        result.rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;

      return { items, nextCursor };
    }),

  /**
   * List disputes with cursor-based pagination and optional filters.
   *
   * Returns { items, nextCursor } where nextCursor is the id of the last
   * item on the current page, or null when there are no more pages.
   * Pass nextCursor as `cursor` on the next call to advance the page.
   */
  listDisputes: adminProcedure
    .input(z.object({
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(100).default(20),
      status: z.string().max(30).optional(),
    }))
    .query(async ({ input }) => {
      const { cursor, limit, status } = input;
      const conditions: string[] = [];
      const params: unknown[] = [limit + 1]; // $1 = fetch limit+1 to detect next page

      if (cursor) {
        conditions.push(`d.id > $${params.push(cursor)}`);
      }
      if (status) {
        conditions.push(`d.status = $${params.push(status)}`);
      }

      const whereClause =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

      const result = await db.query<{
        id: string;
        task_id: string;
        status: string;
        reason: string;
        created_at: Date;
        task_title: string;
      }>(
        `SELECT d.id, d.task_id, d.status, d.reason, d.created_at,
                t.title as task_title
         FROM disputes d
         JOIN tasks t ON t.id = d.task_id
         ${whereClause}
         ORDER BY d.id ASC
         LIMIT $1`,
        params
      );

      const items = result.rows.slice(0, limit);
      const nextCursor =
        result.rows.length > limit ? (items[items.length - 1]?.id ?? null) : null;

      return { items, nextCursor };
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
   * Admin override: force release or refund an escrow
   */
  escrowOverride: adminProcedure
    .input(z.object({
      escrowId: Schemas.uuid,
      action: z.enum(['force_release', 'force_refund']),
      reason: z.string().min(1).max(500),
    }))
    .mutation(async ({ ctx, input }) => {
      const newState = input.action === 'force_release' ? 'RELEASED' : 'REFUNDED';

      const result = await db.query<{ id: string; state: string; amount: number }>(
        `UPDATE escrows SET
           state = $1,
           released_at = CASE WHEN $1 = 'RELEASED' THEN NOW() ELSE released_at END,
           refunded_at = CASE WHEN $1 = 'REFUNDED' THEN NOW() ELSE refunded_at END,
           admin_override_by = $2,
           admin_override_reason = $3,
           updated_at = NOW()
         WHERE id = $4 AND state IN ('FUNDED', 'DISPUTED')
         RETURNING id, state, amount`,
        [newState, ctx.user.id, input.reason, input.escrowId]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Escrow not found or not in overridable state (must be FUNDED or DISPUTED)',
        });
      }

      return result.rows[0];
    }),
});

export type AdminRouter = typeof adminRouter;
