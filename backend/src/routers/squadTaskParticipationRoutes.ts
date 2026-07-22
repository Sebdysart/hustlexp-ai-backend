import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { hustlerProcedure, posterProcedure, Schemas } from '../trpc.js';
import type { SquadTaskRow } from './squadPolicy.js';

export const squadTaskParticipationProcedures = {
  startTeamTask: posterProcedure
    .input(z.object({ squadTaskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const organizer = await db.query(
        `SELECT sta.squad_id FROM squad_task_assignments sta
         JOIN squad_members sm ON sm.squad_id = sta.squad_id AND sm.user_id = $2
         WHERE sta.id = $1 AND sm.role = 'organizer'`,
        [input.squadTaskId, ctx.user.id],
      );
      if (organizer.rows.length === 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the squad organizer can start a team task',
        });
      }
      const result = await db.query(
        `UPDATE squad_task_assignments SET status = 'in_progress', updated_at = NOW()
         WHERE id = $1 AND status = 'ready'
         RETURNING id`,
        [input.squadTaskId],
      );
      if (result.rows.length === 0) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Team task not found or not ready (must be fully recruited)',
        });
      }
      return { success: true, status: 'in_progress' };
    }),

  withdrawFromTeamTask: hustlerProcedure
    .input(z.object({ squadTaskId: Schemas.uuid }))
    .mutation(async ({ ctx, input }) => {
      const member = await db.query(
        `SELECT 1 FROM squad_members sm
         JOIN squad_task_assignments sta ON sta.squad_id = sm.squad_id
         WHERE sta.id = $1 AND sm.user_id = $2`,
        [input.squadTaskId, ctx.user.id],
      );
      if (!member.rows[0]) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
      }
      const assignment = await db.query<{
        id: string;
        status: string;
        required_workers: number;
      }>(
        'SELECT id, status, required_workers FROM squad_task_assignments WHERE id = $1',
        [input.squadTaskId],
      );
      if (assignment.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Team task not found' });
      }
      if (!['recruiting', 'ready'].includes(assignment.rows[0].status)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Can only withdraw from a task that has not started',
        });
      }
      const deleted = await db.query(
        'DELETE FROM squad_task_workers WHERE squad_task_id = $1 AND worker_id = $2 RETURNING id',
        [input.squadTaskId, ctx.user.id],
      );
      if (deleted.rows.length === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'You are not assigned to this team task',
        });
      }
      const count = await db.query<{ count: string }>(
        'SELECT COUNT(*) as count FROM squad_task_workers WHERE squad_task_id = $1',
        [input.squadTaskId],
      );
      if (parseInt(count.rows[0].count, 10) < assignment.rows[0].required_workers) {
        await db.query(
          `UPDATE squad_task_assignments SET status = 'recruiting', updated_at = NOW() WHERE id = $1`,
          [input.squadTaskId],
        );
      }
      return { success: true };
    }),

  acceptTask: hustlerProcedure
    .input(z.object({ squadTaskId: Schemas.uuid }))
    .mutation(({ ctx, input }) => db.transaction(async (query) => {
      const result = await query<SquadTaskRow>(
        `SELECT sta.*, s.id as s_id
         FROM squad_task_assignments sta
         JOIN squads s ON s.id = sta.squad_id
         WHERE sta.id = $1 AND sta.status = 'recruiting'
         FOR UPDATE`,
        [input.squadTaskId],
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Recruiting squad task not found' });
      }
      const squadTask = result.rows[0];
      const member = await query(
        'SELECT id FROM squad_members WHERE squad_id = $1 AND user_id = $2',
        [squadTask.squad_id, ctx.user.id],
      );
      if (member.rows.length === 0) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
      }
      const creator = await query<{ poster_id: string }>(
        `SELECT t.poster_id FROM tasks t
         JOIN squad_task_assignments sta ON sta.task_id = t.id
         WHERE sta.id = $1`,
        [input.squadTaskId],
      );
      if (creator.rows.length > 0 && creator.rows[0].poster_id === ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Organizer cannot accept their own squad task',
        });
      }
      const worker = await query<{ id: string; accepted_at: string }>(
        `INSERT INTO squad_task_workers (squad_task_id, worker_id)
         VALUES ($1, $2)
         RETURNING id, accepted_at`,
        [input.squadTaskId, ctx.user.id],
      );
      const count = await query<{ count: string }>(
        'SELECT COUNT(*) as count FROM squad_task_workers WHERE squad_task_id = $1',
        [input.squadTaskId],
      );
      const ready = parseInt(count.rows[0].count, 10) >= squadTask.required_workers;
      if (ready) {
        await query(
          `UPDATE squad_task_assignments SET status = 'ready', updated_at = NOW()
           WHERE id = $1`,
          [input.squadTaskId],
        );
      }
      return {
        id: worker.rows[0].id,
        squadTaskId: input.squadTaskId,
        workerId: ctx.user.id,
        acceptedAt: worker.rows[0].accepted_at,
        taskStatus: ready ? 'ready' : 'recruiting',
      };
    })),
};
