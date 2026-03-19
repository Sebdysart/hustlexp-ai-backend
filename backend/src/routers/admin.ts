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
import { forceDisconnectUser } from '../realtime/connection-registry.js';
import { revokeUserSessions } from '../auth/middleware.js';
import { writeToOutbox } from '../lib/outbox-helpers.js';

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

      // Look up firebase_uid so the Redis revocation marker uses the same key
      // namespace that trpc.ts and auth/middleware.ts read (auth:revoked:<firebaseUid>).
      // BUG GG1 FIX: previously the marker was keyed on the DB UUID which trpc.ts
      // never looked up, so banned users remained authenticated across replicas.
      const fbRow = await db.query<{ firebase_uid: string }>(
        'SELECT firebase_uid FROM users WHERE id = $1',
        [input.userId]
      );
      const firebaseUid = fbRow.rows[0]?.firebase_uid;

      // Evict any cached auth entries for this user so the ban takes effect
      // immediately rather than waiting up to 5 minutes for the cache TTL to expire.
      // BUG GG3 FIX: await the call (was fire-and-forget) so Redis errors surface.
      await invalidateAuthCacheForUser(input.userId, firebaseUid);

      // BUG GG2 FIX: call revokeUserSessions so Firebase refresh tokens are
      // revoked and the Redis revocation marker is also written for the Hono
      // middleware path.  This was never called on ban/suspend, meaning users
      // could re-authenticate immediately after being banned.
      if (input.banned && firebaseUid) {
        await revokeUserSessions(firebaseUid).catch(err => {
          // Log but do not fail the ban operation if Firebase revocation errors.
          const msg = err instanceof Error ? err.message : String(err);
          void msg; // consumed below
          console.error(`[admin.setUserBan] revokeUserSessions failed for uid=${firebaseUid}:`, err);
        });
      }

      // Bug 1 fix: if the user was just banned, immediately close any open SSE
      // connections so the stream does not persist after the ban is applied.
      if (input.banned) {
        forceDisconnectUser(input.userId);

        // LL6 FIX: Split FUNDED escrows into two buckets based on task state.
        //
        // Bucket A — task is idle (OPEN/PENDING/CANCELLED): safe to refund immediately
        //   because no worker has started meaningful work.
        //
        // Bucket B — task is active (ACCEPTED/IN_PROGRESS/PROOF_SUBMITTED/COMPLETED):
        //   a worker has done (or is doing) real work. Refunding them $0 is wrong.
        //   Instead, lock the escrow as LOCKED_DISPUTE with reason='user_banned' and
        //   emit an outbox event so an admin can adjudicate the correct payout.

        // Bucket A: idle tasks — refund
        const refundableEscrows = await db.query<{ id: string }>(
          `SELECT e.id
           FROM escrows e
           JOIN tasks t ON t.id = e.task_id
           WHERE (e.poster_id = $1 OR e.worker_id = $1)
             AND e.state = 'FUNDED'
             AND t.state NOT IN ('ACCEPTED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED')`,
          [input.userId]
        );
        for (const escrow of refundableEscrows.rows) {
          await EscrowService.refund({ escrowId: escrow.id });
        }

        // Bucket B: active tasks — lock for dispute and emit outbox event for admin review
        const activeEscrows = await db.query<{ id: string }>(
          `SELECT e.id
           FROM escrows e
           JOIN tasks t ON t.id = e.task_id
           WHERE (e.poster_id = $1 OR e.worker_id = $1)
             AND e.state = 'FUNDED'
             AND t.state IN ('ACCEPTED', 'IN_PROGRESS', 'PROOF_SUBMITTED', 'COMPLETED')`,
          [input.userId]
        );
        for (const escrow of activeEscrows.rows) {
          const lockResult = await EscrowService.lockForDispute(escrow.id, { adminOverride: true });
          if (lockResult.success) {
            await writeToOutbox({
              eventType: 'escrow.locked_on_ban',
              aggregateType: 'escrow',
              aggregateId: escrow.id,
              eventVersion: 1,
              payload: {
                escrow_id: escrow.id,
                banned_user_id: input.userId,
                reason: 'user_banned',
                admin_id: ctx.user.id,
              },
              queueName: 'critical_payments',
            });
          }
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
  // ADMIN ROLE MANAGEMENT
  // --------------------------------------------------------------------------

  /**
   * Grant an admin role to a user.
   *
   * KK2 FIX: After inserting the admin_roles row the auth cache is invalidated
   * so the next request picks up the new is_admin=true status immediately
   * rather than waiting up to 5 minutes for the in-process TTL.
   */
  grantAdminRole: adminProcedure
    .input(z.object({
      userId: Schemas.uuid,
      role: z.string().min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      // Upsert so a duplicate grant is idempotent
      await db.query(
        `INSERT INTO admin_roles (user_id, role)
         VALUES ($1, $2)
         ON CONFLICT (user_id, role) DO NOTHING`,
        [input.userId, input.role]
      );

      await db.query(
        `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, metadata)
         VALUES ($1, 'admin_role_grant', $2, NULL, $3)`,
        [ctx.user.id, input.userId, JSON.stringify({ role: input.role })]
      );

      // KK2 FIX: Invalidate the auth cache so the granted role takes effect
      // immediately — the cached is_admin value would otherwise persist for
      // up to 5 minutes.
      const fbRow = await db.query<{ firebase_uid: string }>(
        'SELECT firebase_uid FROM users WHERE id = $1',
        [input.userId]
      );
      const firebaseUid = fbRow.rows[0]?.firebase_uid;
      await invalidateAuthCacheForUser(input.userId, firebaseUid);

      return { userId: input.userId, role: input.role };
    }),

  /**
   * Revoke an admin role from a user.
   *
   * KK2 FIX: After deleting the admin_roles row the auth cache is invalidated
   * so the revoked role takes effect immediately — without this, a removed
   * admin retains adminOverride=true access for up to 5 minutes.
   */
  revokeAdminRole: adminProcedure
    .input(z.object({
      userId: Schemas.uuid,
      role: z.string().min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = await db.query<{ user_id: string }>(
        `DELETE FROM admin_roles WHERE user_id = $1 AND role = $2 RETURNING user_id`,
        [input.userId, input.role]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Admin role not found for this user' });
      }

      await db.query(
        `INSERT INTO admin_actions (admin_id, action_type, target_id, reason, metadata)
         VALUES ($1, 'admin_role_revoke', $2, NULL, $3)`,
        [ctx.user.id, input.userId, JSON.stringify({ role: input.role })]
      );

      // KK2 FIX: Invalidate the auth cache immediately after role removal so
      // the revoked admin cannot continue to trigger adminOverride=true paths
      // until the 5-minute TTL expires.
      const fbRow = await db.query<{ firebase_uid: string }>(
        'SELECT firebase_uid FROM users WHERE id = $1',
        [input.userId]
      );
      const firebaseUid = fbRow.rows[0]?.firebase_uid;
      await invalidateAuthCacheForUser(input.userId, firebaseUid);

      return { userId: input.userId, role: input.role };
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
         WHERE e.created_at >= NOW() - ($1 * INTERVAL '1 day')`,
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
         WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')`,
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
         WHERE created_at >= NOW() - ($1 * INTERVAL '1 day')
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

      // Bug 3 fix: if the escrow was LOCKED_DISPUTE, close any open dispute row so
      // it does not remain as an orphaned open dispute after the admin override.
      await db.query(
        `UPDATE disputes
         SET state = 'RESOLVED',
             resolved_at = NOW(),
             resolution_notes = CONCAT('Admin override: escrow ', $2)
         WHERE escrow_id = $1
           AND state != 'RESOLVED'`,
        [input.escrowId, input.action]
      );

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
});

export type AdminRouter = typeof adminRouter;
