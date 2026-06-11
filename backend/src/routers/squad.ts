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
import { router, protectedProcedure, hustlerProcedure, posterProcedure, Schemas } from '../trpc.js';
import { db } from '../db.js';
import { ComplianceGuardianService } from '../services/ComplianceGuardianService.js';
import { TaskService } from '../services/TaskService.js'; // AUDIT FIX M2
import { logger } from '../logger.js';

const squadLog = logger.child({ router: 'squad' });

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
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).default(0).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = Math.min(input?.limit ?? 50, 100);
      const offset = input?.offset ?? 0;
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
         WHERE s.status = 'active'
         ORDER BY s.last_active_at DESC
         LIMIT $2 OFFSET $3`,
        [ctx.user.id, limit, offset]
      );

      return result.rows.map(s => ({
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
      }));
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

      const inviteeTier = Number(invitee.rows[0].trust_tier);
      if (isNaN(inviteeTier) || inviteeTier < REQUIRED_TRUST_TIER) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Invitee does not meet Elite trust tier requirement' });
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

  respondToInvite: hustlerProcedure
    .input(z.object({
      inviteId: Schemas.uuid,
      accept: z.boolean(),
    }))
    .mutation(async ({ ctx, input }) => {
      return await db.transaction(async (query) => {
        // Get and validate invite (R-01: also reject expired invites)
        const invite = await query<{
          id: string; squad_id: string; invitee_id: string; status: string;
        }>(
          `SELECT * FROM squad_invites WHERE id = $1 AND invitee_id = $2 AND status = 'pending' AND expires_at > NOW()`,
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
          // R-05: Verify squad is still active
          const squadResult = await query<{ status: string; max_members: number }>(
            `SELECT status, max_members FROM squads WHERE id = $1`,
            [inv.squad_id]
          );
          if (squadResult.rows[0]?.status !== 'active') {
            throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Squad is no longer active' });
          }

          // R-02: Check squad capacity under transaction lock
          const countResult = await query<{ cnt: string }>(
            `SELECT COUNT(*) as cnt FROM squad_members WHERE squad_id = $1`,
            [inv.squad_id]
          );
          const currentCount = parseInt(countResult.rows[0].cnt, 10);
          if (currentCount >= squadResult.rows[0].max_members) {
            throw new TRPCError({ code: 'CONFLICT', message: 'Squad is full' });
          }

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

  listInvites: hustlerProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).default(0).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const limit = Math.min(input?.limit ?? 50, 100);
      const offset = input?.offset ?? 0;
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
         ORDER BY si.sent_at DESC
         LIMIT $2 OFFSET $3`,
        [ctx.user.id, limit, offset]
      );

      return result.rows.map(i => ({
        id: i.id,
        squadId: i.squad_id,
        squadName: i.squad_name,
        squadEmoji: i.squad_emoji,
        inviterName: i.inviter_name,
        sentAt: i.sent_at,
        expiresAt: i.expires_at,
      }));
    }),

  // --------------------------------------------------------------------------
  // LEAVE SQUAD
  // --------------------------------------------------------------------------

  leave: hustlerProcedure
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

      return await db.transaction(async (query) => {
        const activeTasksResult = await query<{ cnt: string }>(
          `SELECT COUNT(*) as cnt FROM squad_task_assignments WHERE squad_id = $1 AND status NOT IN ('completed', 'cancelled')`,
          [input.squadId]
        );
        if (parseInt(activeTasksResult.rows[0].cnt, 10) > 0) {
          throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Cannot disband squad with active tasks — complete or cancel all tasks first' });
        }

        await query(
          `UPDATE squads SET status = 'disbanded', updated_at = NOW() WHERE id = $1`,
          [input.squadId]
        );

        return { success: true };
      });
    }),

  // --------------------------------------------------------------------------
  // CREATE TEAM TASK (organizer posts a task for the squad)
  // --------------------------------------------------------------------------

  createTeamTask: posterProcedure
    .input(z.object({
      squadId: Schemas.uuid,
      title: z.string().min(3).max(255),
      description: z.string().min(10).max(5000),
      totalPriceCents: z.number().int().min(500),
      requiredWorkers: z.number().int().min(2).max(20).default(2),
      paymentSplit: z.enum(['equal', 'weighted']).default('equal'),
      location: z.string().max(500).optional(),
      category: z.string().max(100).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertEliteTier(ctx.user.trust_tier);

      // AUDIT FIX M2 (2026-06-11): this previously did a raw
      // `INSERT INTO tasks ... risk_level='LOW'` inside the transaction —
      // bypassing TaskService.create entirely (no price validation, no
      // plan-gating, no XP computation, no outbox event) and force-labelling
      // every squad task LOW-risk. It also held an external AI compliance call
      // open INSIDE a DB transaction. Restructured: reads + compliance + task
      // creation (which owns its own atomicity) happen first; the squad link +
      // assignment insert stay atomic in one transaction.
      const organizerCheck = await db.query<{ id: string }>(
        `SELECT s.id FROM squads s
         JOIN squad_members sm ON sm.squad_id = s.id AND sm.user_id = $2
         WHERE s.id = $1 AND s.status = 'active' AND sm.role = 'organizer'`,
        [input.squadId, ctx.user.id]
      );
      if (organizerCheck.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the squad organizer can create team tasks' });
      }

      const perWorkerCents = Math.floor(input.totalPriceCents / input.requiredWorkers);
      if (perWorkerCents < 100) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Total price too low for required workers (min $1 per worker)',
        });
      }

      // Run compliance check — hard blocks throw before any DB write
      const compliance = await ComplianceGuardianService.evaluate({
        description: input.description,
        userId: ctx.user.id,
        templateSlug: 'standard_physical',
      });
      if (compliance.tier === 'hard_block') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Task blocked by compliance check. HustleXP only allows legal IRL tasks.',
        });
      }

      // Create through the owning service (validation, plan-gating, XP, outbox).
      // Risk: non-clean compliance results raise the floor to MEDIUM instead of
      // the old hardcoded LOW.
      const createResult = await TaskService.create({
        posterId: ctx.user.id,
        title: input.title,
        description: input.description,
        price: input.totalPriceCents,
        location: input.location,
        category: input.category,
        riskLevel: compliance.tier === 'clean' ? 'LOW' : 'MEDIUM',
      });
      if (!createResult.success) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: `Could not create squad task: ${createResult.error.message}` });
      }
      const taskId = createResult.data.id;

      // REVIEW FIX (PR242): TaskService.create commits the task before this
      // transaction. If the link/assignment tx fails, the old code's atomicity
      // meant no task existed — the restructured flow would have left an
      // orphaned, publicly-claimable OPEN task with no squad economics.
      // COMPENSATION: on tx failure, cancel the just-created task (guarded
      // OPEN→CANCELLED via the owning service) and rethrow. A brief window
      // where the task is OPEN-but-unlinked remains (ms-scale, claim requires
      // matching/accept flow) — documented residual, strictly narrower than an
      // orphan that lives forever.
      try {
        return await db.transaction(async (query) => {
          try {
            await query(
              `UPDATE tasks SET squad_id = $1 WHERE id = $2`,
              [input.squadId, taskId]
            );
          } catch (linkErr) {
            // squad_id column may not exist if migration not run; continue — but
            // LOUDLY (AUDIT FIX M2: this was a silent swallow).
            squadLog.warn(
              { taskId, squadId: input.squadId, err: linkErr instanceof Error ? linkErr.message : String(linkErr) },
              'createTeamTask: could not link task to squad (squad_id column missing?) — task created unlinked'
            );
          }

          const assignResult = await query<{ id: string }>(
            `INSERT INTO squad_task_assignments (squad_id, task_id, required_workers, payment_split_mode, per_worker_payment_cents, status)
             VALUES ($1, $2, $3, $4, $5, 'recruiting')
             RETURNING id`,
            [input.squadId, taskId, input.requiredWorkers, input.paymentSplit, perWorkerCents]
          );

          return {
            id: assignResult.rows[0].id,
            taskId,
            squadId: input.squadId,
            requiredWorkers: input.requiredWorkers,
            perWorkerPaymentCents: perWorkerCents,
            status: 'recruiting',
          };
        });
      } catch (txErr) {
        // Compensate: the squad assignment failed — the task must not survive
        // as a claimable solo task with wrong economics.
        const cancelResult = await TaskService.cancel(taskId, ctx.user.id).catch((cancelErr: unknown) => ({
          success: false as const,
          error: { code: 'CANCEL_THREW', message: cancelErr instanceof Error ? cancelErr.message : String(cancelErr) },
        }));
        if (!cancelResult.success) {
          squadLog.error(
            { taskId, squadId: input.squadId, cancelError: cancelResult.error },
            'CRITICAL: squad assignment failed AND compensation cancel failed — orphaned OPEN task requires manual cleanup'
          );
        } else {
          squadLog.warn(
            { taskId, squadId: input.squadId },
            'createTeamTask: assignment tx failed — compensated by cancelling the created task'
          );
        }
        throw txErr;
      }
    }),

  // --------------------------------------------------------------------------
  // LIST SQUAD TASKS
  // --------------------------------------------------------------------------

  listTasks: protectedProcedure
    .input(z.object({
      squadId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).default(0).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const limit = Math.min(input.limit ?? 50, 100);
      const offset = input.offset ?? 0;

      // Verify membership
      const member = await db.query(
        `SELECT id FROM squad_members WHERE squad_id = $1 AND user_id = $2`,
        [input.squadId, ctx.user.id]
      );
      if (member.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
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
         WHERE sta.squad_id = $1
         GROUP BY sta.id, t.id
         ORDER BY sta.created_at DESC
         LIMIT $2 OFFSET $3`,
        [input.squadId, limit, offset]
      );

      return result.rows.map(r => ({
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
      }));
    }),

  // --------------------------------------------------------------------------
  // GET TEAM TASK (single assignment with task + workers)
  // --------------------------------------------------------------------------

  getTeamTask: protectedProcedure
    .input(z.object({ squadTaskId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      // Step 1: Resolve squad_id from the task assignment.
      // If the assignment doesn't exist we still throw FORBIDDEN (not NOT_FOUND)
      // to avoid leaking whether the squadTaskId exists at all.
      const assignSquad = await db.query<{ squad_id: string }>(
        `SELECT squad_id FROM squad_task_assignments WHERE id = $1`,
        [input.squadTaskId]
      );
      if (assignSquad.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
      }

      // Step 2: Verify the caller is a member of that squad.
      const member = await db.query(
        `SELECT 1 FROM squad_members WHERE squad_id = $1 AND user_id = $2`,
        [assignSquad.rows[0].squad_id, ctx.user.id]
      );
      if (member.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
      }

      const assign = await db.query<{
        id: string; task_id: string; squad_id: string; required_workers: number;
        payment_split_mode: string; per_worker_payment_cents: number; status: string; created_at: string;
        t_title: string; t_description: string; t_price: number; t_location: string | null; t_category: string | null; t_state: string;
      }>(
        `SELECT sta.id, sta.task_id, sta.squad_id, sta.required_workers, sta.payment_split_mode,
                sta.per_worker_payment_cents, sta.status, sta.created_at,
                t.title as t_title, t.description as t_description, t.price as t_price,
                t.location as t_location, t.category as t_category, t.state as t_state
         FROM squad_task_assignments sta
         JOIN tasks t ON t.id = sta.task_id
         WHERE sta.id = $1`,
        [input.squadTaskId]
      );
      if (assign.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Team task not found' });
      }
      const a = assign.rows[0];

      const workers = await db.query<{ worker_id: string; full_name: string | null; accepted_at: string; completed_at: string | null }>(
        `SELECT stw.worker_id, u.full_name, stw.accepted_at, stw.completed_at
         FROM squad_task_workers stw
         JOIN users u ON u.id = stw.worker_id
         WHERE stw.squad_task_id = $1`,
        [input.squadTaskId]
      );

      return {
        id: a.id,
        taskId: a.task_id,
        squadId: a.squad_id,
        task: {
          title: a.t_title,
          description: a.t_description,
          payment: a.t_price / 100,
          location: a.t_location,
          category: a.t_category,
          state: a.t_state,
        },
        requiredWorkers: a.required_workers,
        paymentSplit: a.payment_split_mode,
        perWorkerPaymentCents: a.per_worker_payment_cents,
        status: a.status,
        createdAt: a.created_at,
        workers: workers.rows.map(w => ({
          workerId: w.worker_id,
          workerName: w.full_name,
          acceptedAt: w.accepted_at,
          completedAt: w.completed_at,
        })),
      };
    }),

  // --------------------------------------------------------------------------
  // START TEAM TASK (organizer moves ready → in_progress)
  // --------------------------------------------------------------------------

  startTeamTask: posterProcedure
    .input(z.object({ squadTaskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const organizer = await db.query(
        `SELECT sta.squad_id FROM squad_task_assignments sta
         JOIN squad_members sm ON sm.squad_id = sta.squad_id AND sm.user_id = $2
         WHERE sta.id = $1 AND sm.role = 'organizer'`,
        [input.squadTaskId, ctx.user.id]
      );
      if (organizer.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the squad organizer can start a team task' });
      }

      const result = await db.query(
        `UPDATE squad_task_assignments SET status = 'in_progress', updated_at = NOW()
         WHERE id = $1 AND status = 'ready'
         RETURNING id`,
        [input.squadTaskId]
      );
      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Team task not found or not ready (must be fully recruited)',
        });
      }
      return { success: true, status: 'in_progress' };
    }),

  // --------------------------------------------------------------------------
  // WITHDRAW FROM TEAM TASK (worker removes themselves before start)
  // --------------------------------------------------------------------------

  withdrawFromTeamTask: hustlerProcedure
    .input(z.object({ squadTaskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      // Verify caller is a member of the squad containing this task
      const membershipCheck = await db.query(
        `SELECT 1 FROM squad_members sm
         JOIN squad_task_assignments sta ON sta.squad_id = sm.squad_id
         WHERE sta.id = $1 AND sm.user_id = $2`,
        [input.squadTaskId, ctx.user.id]
      );
      if (!membershipCheck.rows[0]) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
      }

      const assignment = await db.query<{ id: string; status: string; required_workers: number }>(
        `SELECT id, status, required_workers FROM squad_task_assignments WHERE id = $1`,
        [input.squadTaskId]
      );
      if (assignment.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Team task not found' });
      }
      if (assignment.rows[0].status !== 'recruiting' && assignment.rows[0].status !== 'ready') {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Can only withdraw from a task that has not started',
        });
      }

      const deleted = await db.query(
        `DELETE FROM squad_task_workers WHERE squad_task_id = $1 AND worker_id = $2 RETURNING id`,
        [input.squadTaskId, ctx.user.id]
      );
      if (deleted.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'You are not assigned to this team task' });
      }

      const countResult = await db.query<{ count: string }>(
        `SELECT COUNT(*) as count FROM squad_task_workers WHERE squad_task_id = $1`,
        [input.squadTaskId]
      );
      const count = parseInt(countResult.rows[0].count, 10);
      if (count < assignment.rows[0].required_workers) {
        await db.query(
          `UPDATE squad_task_assignments SET status = 'recruiting', updated_at = NOW() WHERE id = $1`,
          [input.squadTaskId]
        );
      }

      return { success: true };
    }),

  // --------------------------------------------------------------------------
  // ACCEPT SQUAD TASK
  // --------------------------------------------------------------------------

  acceptTask: hustlerProcedure
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

        // 3. Self-dealing guard: organizer cannot accept their own squad task
        const taskCreatorResult = await query<{ poster_id: string }>(
          `SELECT t.poster_id FROM tasks t
           JOIN squad_task_assignments sta ON sta.task_id = t.id
           WHERE sta.id = $1`,
          [input.squadTaskId]
        );
        if (taskCreatorResult.rows.length > 0 && taskCreatorResult.rows[0].poster_id === ctx.user.id) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Organizer cannot accept their own squad task',
          });
        }

        // 4. Insert worker (UNIQUE constraint prevents duplicates)
        const workerResult = await query(
          `INSERT INTO squad_task_workers (squad_task_id, worker_id)
           VALUES ($1, $2)
           RETURNING id, accepted_at`,
          [input.squadTaskId, ctx.user.id]
        );

        // 5. Check if now fully recruited → update status to 'ready'
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
    .input(z.void())
    .query(async () => {
      const result = await db.query<LeaderboardRow>(
        `SELECT
           ROW_NUMBER() OVER (ORDER BY s.squad_xp DESC) as rank,
           s.id, s.name, s.emoji, s.tagline,
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
