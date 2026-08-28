import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { db } from '../db.js';
import { logger } from '../logger.js';
import { posterProcedure, Schemas } from '../trpc.js';
import { ComplianceGuardianService } from '../services/ComplianceGuardianService.js';
import { TaskService } from '../services/TaskService.js';
import { assertEliteTier } from './squadPolicy.js';

const log = logger.child({ router: 'squad' });

async function compensateTask(taskId: string, squadId: string, posterId: string): Promise<void> {
  const result = await TaskService.cancel(taskId, posterId).catch((error: unknown) => ({
    success: false as const,
    error: {
      code: 'CANCEL_THREW',
      message: error instanceof Error ? error.message : String(error),
    },
  }));
  if (!result.success) {
    log.error(
      { taskId, squadId, cancelError: result.error },
      'CRITICAL: squad assignment failed AND compensation cancel failed — orphaned OPEN task requires manual cleanup',
    );
    return;
  }
  log.warn(
    { taskId, squadId },
    'createTeamTask: assignment tx failed — compensated by cancelling the created task',
  );
}

export const squadTaskCreateProcedures = {
  createTeamTask: posterProcedure
    .input(z.object({
      squadId: Schemas.uuid,
      title: z.string().min(3).max(255),
      description: z.string().min(10).max(5000),
      totalPriceCents: z.number().int().min(500),
      requiredWorkers: z.number().int().min(2).max(20).default(2),
      paymentSplit: z.enum(['equal', 'weighted']).default('equal'),
      location: z.string().max(500).optional(),
      regionCode: z.string().trim().regex(/^US-[A-Z]{2}$/),
      category: z.string().trim().min(1).max(100),
    }))
    .mutation(async ({ ctx, input }) => {
      assertEliteTier(ctx.user.trust_tier);
      const organizer = await db.query<{ id: string }>(
        `SELECT s.id FROM squads s
         JOIN squad_members sm ON sm.squad_id = s.id AND sm.user_id = $2
         WHERE s.id = $1 AND s.status = 'active' AND sm.role = 'organizer'`,
        [input.squadId, ctx.user.id],
      );
      if (organizer.rows.length === 0) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Only the squad organizer can create team tasks',
        });
      }
      const perWorkerCents = Math.floor(input.totalPriceCents / input.requiredWorkers);
      if (perWorkerCents < 100) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Total price too low for required workers (min $1 per worker)',
        });
      }
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
      const created = await TaskService.create({
        posterId: ctx.user.id,
        title: input.title,
        description: input.description,
        price: input.totalPriceCents,
        location: input.location,
        regionCode: input.regionCode,
        category: input.category,
        riskLevel: compliance.tier === 'clean' ? 'LOW' : 'MEDIUM',
      });
      if (!created.success) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Could not create squad task: ${created.error.message}`,
        });
      }
      const taskId = created.data.id;
      try {
        return await db.transaction(async (query) => {
          try {
            await query('UPDATE tasks SET squad_id = $1 WHERE id = $2', [input.squadId, taskId]);
          } catch (error) {
            log.warn(
              {
                taskId,
                squadId: input.squadId,
                err: error instanceof Error ? error.message : String(error),
              },
              'createTeamTask: could not link task to squad (squad_id column missing?) — task created unlinked',
            );
          }
          const assignment = await query<{ id: string }>(
            `INSERT INTO squad_task_assignments (squad_id, task_id, required_workers, payment_split_mode, per_worker_payment_cents, status)
             VALUES ($1, $2, $3, $4, $5, 'recruiting')
             RETURNING id`,
            [input.squadId, taskId, input.requiredWorkers, input.paymentSplit, perWorkerCents],
          );
          return {
            id: assignment.rows[0].id,
            taskId,
            squadId: input.squadId,
            requiredWorkers: input.requiredWorkers,
            perWorkerPaymentCents: perWorkerCents,
            status: 'recruiting',
          };
        });
      } catch (error) {
        await compensateTask(taskId, input.squadId, ctx.user.id);
        throw error;
      }
    }),
};
