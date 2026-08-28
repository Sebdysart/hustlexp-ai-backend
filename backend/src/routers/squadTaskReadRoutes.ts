import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { protectedProcedure, Schemas } from '../trpc.js';
import type { ListTaskRow } from './squadPolicy.js';

function membershipFailure(): never {
  throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this squad' });
}

export const squadTaskReadProcedures = {
  listTasks: protectedProcedure
    .input(z.object({
      squadId: Schemas.uuid,
      limit: z.number().int().min(1).max(100).default(50).optional(),
      offset: z.number().int().min(0).max(500).default(0).optional(),
    }))
    .query(async ({ ctx, input }) => {
      const member = await db.query(
        'SELECT id FROM squad_members WHERE squad_id = $1 AND user_id = $2',
        [input.squadId, ctx.user.id],
      );
      if (member.rows.length === 0) return membershipFailure();
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
        [input.squadId, Math.min(input.limit ?? 50, 100), input.offset ?? 0],
      );
      return result.rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        squadId: row.squad_id,
        task: {
          id: row.t_id,
          title: row.t_title,
          description: row.t_description,
          payment: row.t_price / 100,
          location: row.t_location,
          category: row.t_category,
          state: row.t_state,
          createdAt: row.t_created_at,
          updatedAt: row.t_updated_at,
        },
        requiredWorkers: row.required_workers,
        acceptedWorkers: row.accepted_workers || [],
        paymentSplit: row.payment_split_mode,
        perWorkerPayment: row.per_worker_payment_cents / 100,
        status: row.status,
        createdAt: row.created_at,
      }));
    }),

  getTeamTask: protectedProcedure
    .input(z.object({ squadTaskId: Schemas.uuid }))
    .query(async ({ ctx, input }) => {
      const assignmentSquad = await db.query<{ squad_id: string }>(
        'SELECT squad_id FROM squad_task_assignments WHERE id = $1',
        [input.squadTaskId],
      );
      if (assignmentSquad.rows.length === 0) return membershipFailure();
      const member = await db.query(
        'SELECT 1 FROM squad_members WHERE squad_id = $1 AND user_id = $2',
        [assignmentSquad.rows[0].squad_id, ctx.user.id],
      );
      if (member.rows.length === 0) return membershipFailure();
      const result = await db.query<{
        id: string;
        task_id: string;
        squad_id: string;
        required_workers: number;
        payment_split_mode: string;
        per_worker_payment_cents: number;
        status: string;
        created_at: string;
        t_title: string;
        t_description: string;
        t_price: number;
        t_location: string | null;
        t_category: string | null;
        t_state: string;
      }>(
        `SELECT sta.id, sta.task_id, sta.squad_id, sta.required_workers, sta.payment_split_mode,
                sta.per_worker_payment_cents, sta.status, sta.created_at,
                t.title as t_title, t.description as t_description, t.price as t_price,
                t.location as t_location, t.category as t_category, t.state as t_state
         FROM squad_task_assignments sta
         JOIN tasks t ON t.id = sta.task_id
         WHERE sta.id = $1`,
        [input.squadTaskId],
      );
      if (result.rows.length === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Team task not found' });
      }
      const assignment = result.rows[0];
      const workers = await db.query<{
        worker_id: string;
        full_name: string | null;
        accepted_at: string;
        completed_at: string | null;
      }>(
        `SELECT stw.worker_id, u.full_name, stw.accepted_at, stw.completed_at
         FROM squad_task_workers stw
         JOIN users u ON u.id = stw.worker_id
         WHERE stw.squad_task_id = $1`,
        [input.squadTaskId],
      );
      return {
        id: assignment.id,
        taskId: assignment.task_id,
        squadId: assignment.squad_id,
        task: {
          title: assignment.t_title,
          description: assignment.t_description,
          payment: assignment.t_price / 100,
          location: assignment.t_location,
          category: assignment.t_category,
          state: assignment.t_state,
        },
        requiredWorkers: assignment.required_workers,
        paymentSplit: assignment.payment_split_mode,
        perWorkerPaymentCents: assignment.per_worker_payment_cents,
        status: assignment.status,
        createdAt: assignment.created_at,
        workers: workers.rows.map((worker) => ({
          workerId: worker.worker_id,
          workerName: worker.full_name,
          acceptedAt: worker.accepted_at,
          completedAt: worker.completed_at,
        })),
      };
    }),
};
