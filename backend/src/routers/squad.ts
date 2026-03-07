/**
 * Squad Router v1.0.0
 *
 * Multi-worker task coordination ("Squads Mode").
 * Gated to Elite trust tier (tier 4).
 *
 * Features:
 * - Create / disband squads
 * - Invite / accept / decline members
 * - List squads and members
 * - Get squad stats
 *
 * @see PRODUCT_SPEC §11 (Squads)
 * @see add_squads_and_recurring_tasks.sql
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, protectedProcedure, Schemas } from '../trpc';
import { db } from '../db';

// Trust tier gate: Only Elite (tier 4) can create/join squads
const REQUIRED_TRUST_TIER = 4;

// ── Row Types for typed DB queries ────────────────────────────────────────

interface ListTaskRow {
  id: string;
  task_id: string;
  squad_id: string;
  required_workers: number;
  payment_split_mode: string;
  per_worker_payment_cents: number;
  status: string;
  created_at: string;
  t_id: string;
  t_title: string;
  t_description: string;
  t_price: number;
  t_location: string | null;
  t_category: string | null;
  t_state: string;
  t_created_at: string;
  t_updated_at: string;
  accepted_workers: string[];
}

interface SquadTaskRow {
  id: string;
  squad_id: string;
  task_id: string;
  required_workers: number;
  status: string;
  s_id: string;
}

interface CountRow {
  count: string; // PostgreSQL COUNT returns bigint serialized as string
}

interface LeaderboardRow {
  rank: string;
  id: string;
  name: string;
  emoji: string;
  tagline: string | null;
  organizer_id: string;
  organizer_name: string;
  status: string;
  total_tasks_completed: number;
  total_earnings_cents: number;
  squad_xp: number;
  squad_level: number;
  average_rating: string; // NUMERIC serialized as string
  max_members: number;
  created_at: string;
  last_active_at: string | null;
  member_count: number;
}

function assertEliteTier(trustTier: number | string): void {
  const tierNum = typeof trustTier === 'number' ? trustTier : parseInt(trustTier, 10);
  if (isNaN(tierNum) || tierNum < REQUIRED_TRUST_TIER) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Squads Mode requires Elite trust tier (Tier 4)',
    });
  }
}

export const squadRouter = router({
  // --------------------------------------------------------------------------
  // CREATE SQUAD
  // --------------------------------------------------------------------------

  create: protectedProcedure
    .input(z.object({
      name: z.string().min(2).max(100),
      emoji: z.string().max(10).default('⚡️'),
      tagline: z.string().max(200).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertEliteTier(ctx.user.trust_tier);

      // Check user isn't already an organizer of an active squad
      const existing = await db.query<{ id: string }>(
        `SELECT s.id FROM squads s
         JOIN squad_members sm ON sm.squad_id = s.id
         WHERE sm.user_id = $1 AND sm.role = 'organizer' AND s.status = 'active'`,
        [ctx.user.id]
      );

      if (existing.rows.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'You already organize an active squad. Disband it first.',
        });
      }

      return await db.transaction(async (query) => {
        // Create squad
        const squadResult = await query<{
          id: string; name: string; emoji: string; tagline: string | null;
          max_members: number; status: string; created_at: Date;
        }>(
          `INSERT INTO squads (name, emoji, tagline, organizer_id)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [input.name, input.emoji, input.tagline || null, ctx.user.id]
        );

        const squad = squadResult.rows[0];

        // Auto-add organizer as member
        await query(
          `INSERT INTO squad_members (squad_id, user_id, role)
           VALUES ($1, $2, 'organizer')`,
          [squad.id, ctx.user.id]
        );

        return {
          id: squad.id,
          name: squad.name,
          emoji: squad.emoji,
          tagline: squad.tagline,
          maxMembers: squad.max_members,
          status: squad.status,
          createdAt: squad.created_at,
          memberCount: 1,
        };
      });
    }),

  // --------------------------------------------------------------------------
  // LIST MY SQUADS
  // --------------------------------------------------------------------------

  listMine: protectedProcedure
    .input(z.object({
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 20;
      const cursor = input?.cursor;

      const params: unknown[] = [ctx.user.id, limit + 1];
      let cursorClause = '';
      if (cursor) {
        const cursorIdx = params.push(cursor);
        cursorClause = `AND s.id > $${cursorIdx}`;
      }

      const result = await db.query<{
        id: string; name: string; emoji: string; tagline: string | null;
        status: string; squad_xp: number; squad_level: number;
        total_tasks_completed: number; member_count: string; my_role: string;
      }>(
        `SELECT s.*,
           (SELECT COUNT(*) FROM squad_members sm WHERE sm.squad_id = s.id)::text as member_count,
           (SELECT sm2.role FROM squad_members sm2 WHERE sm2.squad_id = s.id AND sm2.user_id = $1) as my_role
         FROM squads s
         JOIN squad_members sm ON sm.squad_id = s.id AND sm.user_id = $1
         WHERE s.status = 'active' ${cursorClause}
         ORDER BY s.id ASC
         LIMIT $2`,
        params
      );

      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].id : null;

      return {
        items: items.map(s => ({
          id: s.id,
          name: s.name,
          emoji: s.emoji,
          tagline: s.tagline,
          status: s.status,
          squadXp: s.squad_xp,
          squadLevel: s.squad_level,
          totalTasksCompleted: s.total_tasks_completed,
          memberCount: parseInt(s.member_count, 10),
          myRole: s.my_role,
        })),
        nextCursor,
      };
    }),

  // --------------------------------------------------------------------------
  // GET SQUAD DETAILS
  // --------------------------------------------------------------------------

  getById: protectedProcedure
    .input(z.object({ squadId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      // Verify membership
      const memberCheck = await db.query(
        'SELECT 1 FROM squad_members WHERE squad_id = $1 AND user_id = $2',
        [input.squadId, ctx.user.id]
      );

      if (memberCheck.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
      }

      // Get squad with members
      const squadResult = await db.query<{
        id: string; name: string; emoji: string; tagline: string | null;
        organizer_id: string; max_members: number; status: string;
        total_tasks_completed: number; total_earnings_cents: number;
        average_rating: string; squad_xp: number; squad_level: number;
        created_at: Date;
      }>(
        'SELECT * FROM squads WHERE id = $1',
        [input.squadId]
      );

      if (squadResult.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Squad not found' });
      }

      const squad = squadResult.rows[0];

      // Get members with user info (single JOIN query, no N+1)
      const membersResult = await db.query<{
        user_id: string; role: string; joined_at: Date;
        full_name: string; avatar_url: string | null; trust_tier: string; xp_total: number;
      }>(
        `SELECT sm.user_id, sm.role, sm.joined_at,
           u.full_name, u.avatar_url, u.trust_tier, u.xp_total
         FROM squad_members sm
         JOIN users u ON u.id = sm.user_id
         WHERE sm.squad_id = $1
         ORDER BY sm.role = 'organizer' DESC, sm.joined_at ASC`,
        [input.squadId]
      );

      return {
        id: squad.id,
        name: squad.name,
        emoji: squad.emoji,
        tagline: squad.tagline,
        organizerId: squad.organizer_id,
        maxMembers: squad.max_members,
        status: squad.status,
        totalTasksCompleted: squad.total_tasks_completed,
        totalEarningsCents: squad.total_earnings_cents,
        averageRating: parseFloat(squad.average_rating || '0'),
        squadXp: squad.squad_xp,
        squadLevel: squad.squad_level,
        createdAt: squad.created_at,
        members: membersResult.rows.map(m => ({
          userId: m.user_id,
          role: m.role,
          joinedAt: m.joined_at,
          name: m.full_name,
          avatarUrl: m.avatar_url,
          trustTier: m.trust_tier,
          xp: m.xp_total,
        })),
      };
    }),

  // --------------------------------------------------------------------------
  // INVITE MEMBER
  // --------------------------------------------------------------------------

  invite: protectedProcedure
    .input(z.object({
      squadId: Schemas.uuid,
      inviteeId: Schemas.uuid,
    }))
    .mutation(async ({ ctx, input }) => {
      // Must be organizer
      const orgCheck = await db.query(
        `SELECT 1 FROM squad_members WHERE squad_id = $1 AND user_id = $2 AND role = 'organizer'`,
        [input.squadId, ctx.user.id]
      );

      if (orgCheck.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the organizer can invite members' });
      }

      // Check squad not full
      const countResult = await db.query<{ count: string; max_members: number }>(
        `SELECT
           (SELECT COUNT(*) FROM squad_members WHERE squad_id = $1)::text as count,
           (SELECT max_members FROM squads WHERE id = $1) as max_members`,
        [input.squadId]
      );

      const current = parseInt(countResult.rows[0]?.count || '0', 10);
      const max = countResult.rows[0]?.max_members || 5;
      if (current >= max) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Squad is full' });
      }

      // Check invitee exists and has Elite tier
      const invitee = await db.query<{ trust_tier: string }>(
        'SELECT trust_tier FROM users WHERE id = $1',
        [input.inviteeId]
      );

      if (invitee.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }

      const result = await db.query<{ id: string; status: string; expires_at: Date }>(
        `INSERT INTO squad_invites (squad_id, inviter_id, invitee_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (squad_id, invitee_id, status) DO NOTHING
         RETURNING id, status, expires_at`,
        [input.squadId, ctx.user.id, input.inviteeId]
      );

      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'CONFLICT', message: 'Invite already pending' });
      }

      return {
        inviteId: result.rows[0].id,
        status: result.rows[0].status,
        expiresAt: result.rows[0].expires_at,
      };
    }),

  // --------------------------------------------------------------------------
  // RESPOND TO INVITE
  // --------------------------------------------------------------------------

  respondToInvite: protectedProcedure
    .input(z.object({
      inviteId: Schemas.uuid,
      accept: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      return await db.transaction(async (query) => {
        // Get and validate invite
        const invite = await query<{
          id: string; squad_id: string; invitee_id: string; status: string;
        }>(
          `SELECT * FROM squad_invites WHERE id = $1 AND invitee_id = $2 AND status = 'pending'`,
          [input.inviteId, ctx.user.id]
        );

        if (invite.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Invite not found or already responded' });
        }

        const inv = invite.rows[0];
        const newStatus = input.accept ? 'accepted' : 'declined';

        // Update invite status
        await query(
          `UPDATE squad_invites SET status = $1, responded_at = NOW() WHERE id = $2`,
          [newStatus, inv.id]
        );

        if (input.accept) {
          // Add as member
          await query(
            `INSERT INTO squad_members (squad_id, user_id, role)
             VALUES ($1, $2, 'member')
             ON CONFLICT DO NOTHING`,
            [inv.squad_id, ctx.user.id]
          );
        }

        return { status: newStatus };
      });
    }),

  // --------------------------------------------------------------------------
  // LIST PENDING INVITES
  // --------------------------------------------------------------------------

  listInvites: protectedProcedure
    .input(z.object({
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? 20;
      const cursor = input?.cursor;

      const params: unknown[] = [ctx.user.id, limit + 1];
      let cursorClause = '';
      if (cursor) {
        const cursorIdx = params.push(cursor);
        cursorClause = `AND si.id > $${cursorIdx}`;
      }

      const result = await db.query<{
        id: string; squad_id: string; squad_name: string; squad_emoji: string;
        inviter_name: string; sent_at: Date; expires_at: Date;
      }>(
        `SELECT si.id, si.squad_id, s.name as squad_name, s.emoji as squad_emoji,
           u.full_name as inviter_name, si.sent_at, si.expires_at
         FROM squad_invites si
         JOIN squads s ON s.id = si.squad_id
         JOIN users u ON u.id = si.inviter_id
         WHERE si.invitee_id = $1 AND si.status = 'pending' AND si.expires_at > NOW()
           ${cursorClause}
         ORDER BY si.id ASC
         LIMIT $2`,
        params
      );

      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].id : null;

      return {
        items: items.map(i => ({
          id: i.id,
          squadId: i.squad_id,
          squadName: i.squad_name,
          squadEmoji: i.squad_emoji,
          inviterName: i.inviter_name,
          sentAt: i.sent_at,
          expiresAt: i.expires_at,
        })),
        nextCursor,
      };
    }),

  // --------------------------------------------------------------------------
  // LEAVE SQUAD
  // --------------------------------------------------------------------------

  leave: protectedProcedure
    .input(z.object({ squadId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      // Can't leave if you're the organizer (must disband)
      const memberCheck = await db.query<{ role: string }>(
        'SELECT role FROM squad_members WHERE squad_id = $1 AND user_id = $2',
        [input.squadId, ctx.user.id]
      );

      if (memberCheck.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Not a member of this squad' });
      }

      if (memberCheck.rows[0].role === 'organizer') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Organizers cannot leave. Disband the squad instead.',
        });
      }

      await db.query(
        'DELETE FROM squad_members WHERE squad_id = $1 AND user_id = $2',
        [input.squadId, ctx.user.id]
      );

      return { success: true };
    }),

  // --------------------------------------------------------------------------
  // DISBAND SQUAD (organizer only)
  // --------------------------------------------------------------------------

  disband: protectedProcedure
    .input(z.object({ squadId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const orgCheck = await db.query(
        `SELECT 1 FROM squad_members WHERE squad_id = $1 AND user_id = $2 AND role = 'organizer'`,
        [input.squadId, ctx.user.id]
      );

      if (orgCheck.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the organizer can disband' });
      }

      await db.query(
        `UPDATE squads SET status = 'disbanded', updated_at = NOW() WHERE id = $1`,
        [input.squadId]
      );

      return { success: true };
    }),

  // --------------------------------------------------------------------------
  // LIST SQUAD TASKS
  // --------------------------------------------------------------------------

  listTasks: protectedProcedure
    .input(z.object({
      squadId: Schemas.uuid,
      cursor: z.string().uuid().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ ctx, input }) => {
      const limit = input.limit;
      const cursor = input.cursor;

      // Verify membership
      const member = await db.query(
        `SELECT id FROM squad_members WHERE squad_id = $1 AND user_id = $2`,
        [input.squadId, ctx.user.id]
      );
      if (member.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
      }

      const params: unknown[] = [input.squadId, limit + 1];
      let cursorClause = '';
      if (cursor) {
        const cursorIdx = params.push(cursor);
        cursorClause = `AND sta.id > $${cursorIdx}`;
      }

      const result = await db.query<ListTaskRow>(
        `SELECT sta.*,
           t.id as t_id, t.title as t_title, t.description as t_description,
           t.price as t_price, t.location as t_location,
           t.category as t_category, t.state as t_state,
           t.created_at as t_created_at, t.updated_at as t_updated_at,
           COALESCE(
             ARRAY_AGG(stw.worker_id) FILTER (WHERE stw.worker_id IS NOT NULL),
             '{}'
           ) as accepted_workers
         FROM squad_task_assignments sta
         JOIN tasks t ON t.id = sta.task_id
         LEFT JOIN squad_task_workers stw ON stw.squad_task_id = sta.id
         WHERE sta.squad_id = $1 ${cursorClause}
         GROUP BY sta.id, t.id
         ORDER BY sta.id ASC
         LIMIT $2`,
        params
      );

      const rows = result.rows;
      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? items[items.length - 1].id : null;

      return {
        items: items.map(r => ({
          id: r.id,
          taskId: r.task_id,
          squadId: r.squad_id,
          task: {
            id: r.t_id,
            title: r.t_title,
            description: r.t_description,
            payment: r.t_price / 100,
            location: r.t_location,
            category: r.t_category,
            state: r.t_state,
            createdAt: r.t_created_at,
            updatedAt: r.t_updated_at,
          },
          requiredWorkers: r.required_workers,
          acceptedWorkers: r.accepted_workers || [],
          paymentSplit: r.payment_split_mode,
          perWorkerPayment: r.per_worker_payment_cents / 100,
          status: r.status,
          createdAt: r.created_at,
        })),
        nextCursor,
      };
    }),

  // --------------------------------------------------------------------------
  // ACCEPT SQUAD TASK
  // --------------------------------------------------------------------------

  acceptTask: protectedProcedure
    .input(z.object({ squadTaskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      return await db.transaction(async (query) => {
        // 1. Get the squad task and verify it's recruiting
        const taskResult = await query<SquadTaskRow>(
          `SELECT sta.*, s.id as s_id
           FROM squad_task_assignments sta
           JOIN squads s ON s.id = sta.squad_id
           WHERE sta.id = $1 AND sta.status = 'recruiting'
           FOR UPDATE`,
          [input.squadTaskId]
        );
        if (taskResult.rows.length === 0) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Recruiting squad task not found' });
        }
        const squadTask = taskResult.rows[0];

        // 2. Verify user is member of squad
        const memberResult = await query(
          `SELECT id FROM squad_members WHERE squad_id = $1 AND user_id = $2`,
          [squadTask.squad_id, ctx.user.id]
        );
        if (memberResult.rows.length === 0) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
        }

        // 3. Insert worker (UNIQUE constraint prevents duplicates)
        const workerResult = await query(
          `INSERT INTO squad_task_workers (squad_task_id, worker_id)
           VALUES ($1, $2)
           RETURNING id, accepted_at`,
          [input.squadTaskId, ctx.user.id]
        );

        // 4. Check if now fully recruited → update status to 'ready'
        const countResult = await query<CountRow>(
          `SELECT COUNT(*) as count FROM squad_task_workers WHERE squad_task_id = $1`,
          [input.squadTaskId]
        );
        const workerCount = parseInt(countResult.rows[0].count, 10);
        let updatedStatus = 'recruiting';
        if (workerCount >= squadTask.required_workers) {
          await query(
            `UPDATE squad_task_assignments SET status = 'ready', updated_at = NOW()
             WHERE id = $1`,
            [input.squadTaskId]
          );
          updatedStatus = 'ready';
        }

        return {
          id: workerResult.rows[0].id,
          squadTaskId: input.squadTaskId,
          workerId: ctx.user.id,
          acceptedAt: workerResult.rows[0].accepted_at,
          taskStatus: updatedStatus,
        };
      });
    }),

  // --------------------------------------------------------------------------
  // LEADERBOARD
  // --------------------------------------------------------------------------

  leaderboard: protectedProcedure
    .query(async () => {
      const result = await db.query<LeaderboardRow>(
        `SELECT
           ROW_NUMBER() OVER (ORDER BY s.squad_xp DESC) as rank,
           s.id, s.name, s.emoji, s.tagline, s.organizer_id,
           u.full_name as organizer_name,
           s.status, s.total_tasks_completed, s.total_earnings_cents,
           s.squad_xp, s.squad_level, s.average_rating,
           s.max_members, s.created_at, s.last_active_at,
           COUNT(DISTINCT sm.user_id)::int as member_count
         FROM squads s
         JOIN users u ON u.id = s.organizer_id
         LEFT JOIN squad_members sm ON sm.squad_id = s.id
         WHERE s.status = 'active'
         GROUP BY s.id, u.id
         ORDER BY s.squad_xp DESC
         LIMIT 50`
      );

      return result.rows.map(s => ({
        id: s.id,
        name: s.name,
        emoji: s.emoji,
        tagline: s.tagline,
        organizerId: s.organizer_id,
        organizerName: s.organizer_name,
        status: s.status,
        maxMembers: s.max_members,
        memberCount: s.member_count,
        totalTasksCompleted: s.total_tasks_completed,
        totalEarnings: s.total_earnings_cents / 100,
        squadXP: s.squad_xp,
        squadLevel: s.squad_level,
        averageRating: parseFloat(s.average_rating) || 0,
        createdAt: s.created_at,
        lastActiveAt: s.last_active_at,
        members: [], // Not populated in leaderboard view
      }));
    }),
});

export type SquadRouter = typeof squadRouter;
