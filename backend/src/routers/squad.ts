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
    .query(async ({ ctx }) => {
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
         ORDER BY s.last_active_at DESC`,
        [ctx.user.id]
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
    .query(async ({ ctx }) => {
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
         ORDER BY si.sent_at DESC`,
        [ctx.user.id]
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
});

export type SquadRouter = typeof squadRouter;
