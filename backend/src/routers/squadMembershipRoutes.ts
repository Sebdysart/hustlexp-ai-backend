import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { hustlerProcedure, protectedProcedure, Schemas } from '../trpc.js';
import { REQUIRED_TRUST_TIER } from './squadPolicy.js';

export const squadMembershipProcedures = {
  invite: protectedProcedure
    .input(z.object({ squadId: Schemas.uuid, inviteeId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const organizer = await db.query(
        `SELECT 1 FROM squad_members WHERE squad_id = $1 AND user_id = $2 AND role = 'organizer'`,
        [input.squadId, ctx.user.id],
      );
      if (organizer.rows.length === 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the organizer can invite members',
        });
      }
      const capacity = await db.query<{ count: string; max_members: number }>(
        `SELECT
           (SELECT COUNT(*) FROM squad_members WHERE squad_id = $1)::text as count,
           (SELECT max_members FROM squads WHERE id = $1) as max_members`,
        [input.squadId],
      );
      const current = parseInt(capacity.rows[0]?.count || '0', 10);
      const max = capacity.rows[0]?.max_members || 5;
      if (current >= max) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Squad is full' });
      const invitee = await db.query<{ trust_tier: string }>(
        'SELECT trust_tier FROM users WHERE id = $1',
        [input.inviteeId],
      );
      if (invitee.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'User not found' });
      }
      const tier = Number(invitee.rows[0].trust_tier);
      if (Number.isNaN(tier) || tier < REQUIRED_TRUST_TIER) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Invitee does not meet Elite trust tier requirement',
        });
      }
      const result = await db.query<{ id: string; status: string; expires_at: Date }>(
        `INSERT INTO squad_invites (squad_id, inviter_id, invitee_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (squad_id, invitee_id, status) DO NOTHING
         RETURNING id, status, expires_at`,
        [input.squadId, ctx.user.id, input.inviteeId],
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

  respondToInvite: hustlerProcedure
    .input(z.object({ inviteId: Schemas.uuid, accept: z.boolean() }))
    .mutation(({ ctx, input }) => db.transaction(async (query) => {
      const result = await query<{
        id: string;
        squad_id: string;
        invitee_id: string;
        status: string;
      }>(
        `SELECT * FROM squad_invites WHERE id = $1 AND invitee_id = $2 AND status = 'pending' AND expires_at > NOW()`,
        [input.inviteId, ctx.user.id],
      );
      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'Invite not found or already responded',
        });
      }
      const invite = result.rows[0];
      const newStatus = input.accept ? 'accepted' : 'declined';
      await query(
        'UPDATE squad_invites SET status = $1, responded_at = NOW() WHERE id = $2',
        [newStatus, invite.id],
      );
      if (input.accept) {
        const squad = await query<{ status: string; max_members: number }>(
          'SELECT status, max_members FROM squads WHERE id = $1',
          [invite.squad_id],
        );
        if (squad.rows[0]?.status !== 'active') {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Squad is no longer active',
          });
        }
        const count = await query<{ cnt: string }>(
          'SELECT COUNT(*) as cnt FROM squad_members WHERE squad_id = $1',
          [invite.squad_id],
        );
        if (parseInt(count.rows[0].cnt, 10) >= squad.rows[0].max_members) {
          throw new TRPCError({ code: 'CONFLICT', message: 'Squad is full' });
        }
        await query(
          `INSERT INTO squad_members (squad_id, user_id, role)
           VALUES ($1, $2, 'member')
           ON CONFLICT DO NOTHING`,
          [invite.squad_id, ctx.user.id],
        );
      }
      return { status: newStatus };
    })),

  listInvites: hustlerProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).max(500).default(0).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const result = await db.query<{
        id: string;
        squad_id: string;
        squad_name: string;
        squad_emoji: string;
        inviter_name: string;
        sent_at: Date;
        expires_at: Date;
      }>(
        `SELECT si.id, si.squad_id, s.name as squad_name, s.emoji as squad_emoji,
           u.full_name as inviter_name, si.sent_at, si.expires_at
         FROM squad_invites si
         JOIN squads s ON s.id = si.squad_id
         JOIN users u ON u.id = si.inviter_id
         WHERE si.invitee_id = $1 AND si.status = 'pending' AND si.expires_at > NOW()
         ORDER BY si.sent_at DESC
         LIMIT $2 OFFSET $3`,
        [ctx.user.id, Math.min(input?.limit ?? 50, 100), input?.offset ?? 0],
      );
      return result.rows.map((invite) => ({
        id: invite.id,
        squadId: invite.squad_id,
        squadName: invite.squad_name,
        squadEmoji: invite.squad_emoji,
        inviterName: invite.inviter_name,
        sentAt: invite.sent_at,
        expiresAt: invite.expires_at,
      }));
    }),

  leave: hustlerProcedure
    .input(z.object({ squadId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const member = await db.query<{ role: string }>(
        'SELECT role FROM squad_members WHERE squad_id = $1 AND user_id = $2',
        [input.squadId, ctx.user.id],
      );
      if (member.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Not a member of this squad' });
      }
      if (member.rows[0].role === 'organizer') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Organizers cannot leave. Disband the squad instead.',
        });
      }
      await db.query(
        'DELETE FROM squad_members WHERE squad_id = $1 AND user_id = $2',
        [input.squadId, ctx.user.id],
      );
      return { success: true };
    }),
};
