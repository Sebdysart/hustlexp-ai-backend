import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { protectedProcedure, Schemas } from '../trpc.js';
import {
  assertEliteTier,
  type LeaderboardRow,
} from './squadPolicy.js';

export const squadLifecycleProcedures = {
  create: protectedProcedure
    .input(z.object({
      name: z.string().min(2).max(100),
      emoji: z.string().max(10).default('⚡️'),
      tagline: z.string().max(200).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      assertEliteTier(ctx.user.trust_tier);
      const existing = await db.query<{ id: string }>(
        `SELECT s.id FROM squads s
         JOIN squad_members sm ON sm.squad_id = s.id
         WHERE sm.user_id = $1 AND sm.role = 'organizer' AND s.status = 'active'`,
        [ctx.user.id],
      );
      if (existing.rows.length > 0) {
        throw new TRPCError({
          code: 'CONFLICT',
          message: 'You already organize an active squad. Disband it first.',
        });
      }
      return db.transaction(async (query) => {
        const result = await query<{
          id: string;
          name: string;
          emoji: string;
          tagline: string | null;
          max_members: number;
          status: string;
          created_at: Date;
        }>(
          `INSERT INTO squads (name, emoji, tagline, organizer_id)
           VALUES ($1, $2, $3, $4)
           RETURNING *`,
          [input.name, input.emoji, input.tagline || null, ctx.user.id],
        );
        const squad = result.rows[0];
        await query(
          `INSERT INTO squad_members (squad_id, user_id, role)
           VALUES ($1, $2, 'organizer')`,
          [squad.id, ctx.user.id],
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

  listMine: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).max(500).default(0).optional(),
    }).optional())
    .query(async ({ ctx, input }) => {
      const result = await db.query<{
        id: string;
        name: string;
        emoji: string;
        tagline: string | null;
        status: string;
        squad_xp: number;
        squad_level: number;
        total_tasks_completed: number;
        member_count: string;
        my_role: string;
      }>(
        `SELECT s.*,
           (SELECT COUNT(*) FROM squad_members sm WHERE sm.squad_id = s.id)::text as member_count,
           (SELECT sm2.role FROM squad_members sm2 WHERE sm2.squad_id = s.id AND sm2.user_id = $1) as my_role
         FROM squads s
         JOIN squad_members sm ON sm.squad_id = s.id AND sm.user_id = $1
         WHERE s.status = 'active'
         ORDER BY s.last_active_at DESC
         LIMIT $2 OFFSET $3`,
        [ctx.user.id, Math.min(input?.limit ?? 50, 100), input?.offset ?? 0],
      );
      return result.rows.map((squad) => ({
        id: squad.id,
        name: squad.name,
        emoji: squad.emoji,
        tagline: squad.tagline,
        status: squad.status,
        squadXp: squad.squad_xp,
        squadLevel: squad.squad_level,
        totalTasksCompleted: squad.total_tasks_completed,
        memberCount: parseInt(squad.member_count, 10),
        myRole: squad.my_role,
      }));
    }),

  getById: protectedProcedure
    .input(z.object({ squadId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const membership = await db.query(
        'SELECT 1 FROM squad_members WHERE squad_id = $1 AND user_id = $2',
        [input.squadId, ctx.user.id],
      );
      if (membership.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
      }
      const result = await db.query<{
        id: string;
        name: string;
        emoji: string;
        tagline: string | null;
        organizer_id: string;
        max_members: number;
        status: string;
        total_tasks_completed: number;
        total_earnings_cents: number;
        average_rating: string;
        squad_xp: number;
        squad_level: number;
        created_at: Date;
      }>('SELECT * FROM squads WHERE id = $1', [input.squadId]);
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Squad not found' });
      }
      const members = await db.query<{
        user_id: string;
        role: string;
        joined_at: Date;
        full_name: string;
        avatar_url: string | null;
        trust_tier: string;
        xp_total: number;
      }>(
        `SELECT sm.user_id, sm.role, sm.joined_at,
           u.full_name, u.avatar_url, u.trust_tier, u.xp_total
         FROM squad_members sm
         JOIN users u ON u.id = sm.user_id
         WHERE sm.squad_id = $1
         ORDER BY sm.role = 'organizer' DESC, sm.joined_at ASC`,
        [input.squadId],
      );
      const squad = result.rows[0];
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
        members: members.rows.map((member) => ({
          userId: member.user_id,
          role: member.role,
          joinedAt: member.joined_at,
          name: member.full_name,
          avatarUrl: member.avatar_url,
          trustTier: member.trust_tier,
          xp: member.xp_total,
        })),
      };
    }),

  disband: protectedProcedure
    .input(z.object({ squadId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const organizer = await db.query(
        `SELECT 1 FROM squad_members WHERE squad_id = $1 AND user_id = $2 AND role = 'organizer'`,
        [input.squadId, ctx.user.id],
      );
      if (organizer.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Only the organizer can disband' });
      }
      return db.transaction(async (query) => {
        const active = await query<{ cnt: string }>(
          `SELECT COUNT(*) as cnt FROM squad_task_assignments WHERE squad_id = $1 AND status NOT IN ('completed', 'cancelled')`,
          [input.squadId],
        );
        if (parseInt(active.rows[0].cnt, 10) > 0) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: 'Cannot disband squad with active tasks — complete or cancel all tasks first',
          });
        }
        await query(
          'UPDATE squads SET status = \'disbanded\', updated_at = NOW() WHERE id = $1',
          [input.squadId],
        );
        return { success: true };
      });
    }),

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
         LIMIT 50`,
      );
      return result.rows.map((squad) => ({
        id: squad.id,
        name: squad.name,
        emoji: squad.emoji,
        tagline: squad.tagline,
        organizerName: squad.organizer_name,
        status: squad.status,
        maxMembers: squad.max_members,
        memberCount: squad.member_count,
        totalTasksCompleted: squad.total_tasks_completed,
        totalEarnings: squad.total_earnings_cents / 100,
        squadXP: squad.squad_xp,
        squadLevel: squad.squad_level,
        averageRating: parseFloat(squad.average_rating) || 0,
        createdAt: squad.created_at,
        lastActiveAt: squad.last_active_at,
        members: [],
      }));
    }),
};
